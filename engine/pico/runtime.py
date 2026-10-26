"""Pico local model runtime: installs and supervises llama.cpp's ``llama-server``.

Layout under ``home`` (``~/.pico`` or ``$PICO_HOME``)::

    runtime/llama.cpp/VERSION          pinned release tag, e.g. b11669
    runtime/llama.cpp/install.json     {tag, asset, backend, server}
    runtime/llama.cpp/<tag>/...        extracted binaries
    models/<org>__<name>/<file>.gguf   model files (``.part`` while downloading)
    logs/llama-server.log

Interface used by the engine::

    rt = LocalRuntime(home)
    await rt.install(recipe, progress)   # progress(step, label, pct, bytes, total)
    base_url = await rt.start(recipe)    # http://127.0.0.1:PORT/v1
    rt.status(); await rt.bench(); await rt.stop()

Pinned runtime is never auto-updated; ``check_runtime_update()`` only reports.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from . import downloads as dl

GITHUB_API = "https://api.github.com/repos/ggml-org/llama.cpp"
HF_BASE = "https://huggingface.co"
HEALTH_TIMEOUT_S = 900          # big models can take minutes to mmap/load
MAX_RESTARTS = 3
PROGRESS_INTERVAL_S = 0.25
IS_WINDOWS = os.name == "nt"
SERVER_EXE = "llama-server.exe" if IS_WINDOWS else "llama-server"
_SPLIT_RE = re.compile(r"^(?P<stem>.+)-(?P<idx>\d{5})-of-(?P<n>\d{5})\.gguf$")


class RuntimeErrorPico(RuntimeError):
    pass


# ======================================================================
# Platform / GPU detection
# ======================================================================

@dataclass
class Platform:
    os: str                       # 'macos' | 'windows' | 'linux'
    arch: str                     # 'arm64' | 'x64'
    gpu_vendor: Optional[str] = None   # 'nvidia' | 'amd' | 'intel' | 'apple' | None
    cuda_version: Optional[tuple] = None  # max CUDA supported by driver, e.g. (12, 4)
    extra: dict = field(default_factory=dict)


def _norm_arch(m: str) -> str:
    m = m.lower()
    if m in ("arm64", "aarch64", "armv8", "arm64e"):
        return "arm64"
    if m in ("x86_64", "amd64", "x64"):
        return "x64"
    return m


def _nvidia_smi_cuda() -> Optional[tuple]:
    exe = shutil.which("nvidia-smi")
    if not exe and IS_WINDOWS:
        cand = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "nvidia-smi.exe"
        exe = str(cand) if cand.exists() else None
    if not exe:
        return None
    try:
        out = subprocess.run([exe], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return None
    m = re.search(r"CUDA Version:\s*(\d+)\.(\d+)", out)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    return (0, 0) if "NVIDIA" in out else None


def detect_platform() -> Platform:
    sysname = platform.system().lower()
    os_name = {"darwin": "macos", "windows": "windows"}.get(sysname, "linux")
    arch = _norm_arch(platform.machine())
    if os_name == "macos" and arch == "x64":
        # Rosetta python on Apple Silicon still wants the arm64 build.
        try:
            if subprocess.run(["sysctl", "-n", "hw.optional.arm64"], capture_output=True,
                              text=True, timeout=5).stdout.strip() == "1":
                arch = "arm64"
        except Exception:
            pass
    p = Platform(os=os_name, arch=arch)
    if os_name == "macos":
        p.gpu_vendor = "apple" if arch == "arm64" else None
        return p
    # Prefer pico.hwscan if a sibling module provides it (lazy, optional).
    try:
        from . import hwscan  # type: ignore
        scan = getattr(hwscan, "scan", None) or getattr(hwscan, "scan_system", None)
        info = scan() if callable(scan) else None
        if inspect.isawaitable(info):
            info = None  # can't await here; fall through to nvidia-smi
        for g in (info or {}).get("gpus", []) if isinstance(info, dict) else []:
            v = str(g.get("vendor", "")).lower()
            if v in ("nvidia", "amd", "intel"):
                p.gpu_vendor = p.gpu_vendor or v
    except Exception:
        pass
    cuda = _nvidia_smi_cuda()
    if cuda is not None:
        p.gpu_vendor, p.cuda_version = "nvidia", cuda
    return p


# ======================================================================
# Release asset selection (pure; unit tested)
# ======================================================================

def _cuda_builds(names: list[str], prefix: str, suffix: str) -> list[tuple[tuple, str]]:
    """Find '<prefix>cuda-<maj>.<min>-<suffix>' assets -> [((maj,min), name)] sorted desc."""
    out = []
    rx = re.compile(re.escape(prefix) + r"cuda-(\d+)\.(\d+)-" + re.escape(suffix) + "$")
    for n in names:
        m = rx.search(n)
        if m and not n.startswith("cudart-"):
            out.append(((int(m.group(1)), int(m.group(2))), n))
    return sorted(out, reverse=True)


def select_assets(asset_names: list[str], plat: Platform) -> dict:
    """Pick the llama.cpp release asset(s) for this machine.

    Returns {'backend': str, 'assets': [main, (cudart)], 'note': str}.
    Raises RuntimeErrorPico if nothing fits.
    """
    names = list(asset_names)
    tagged = [n for n in names if n.startswith("llama-") and "-bin-" in n]

    def find(pattern: str) -> Optional[str]:
        rx = re.compile(r"^llama-[^/]*-bin-" + pattern + "$")
        for n in tagged:
            if rx.match(n):
                return n
        return None

    def pick_cuda(os_tag: str, ext: str) -> Optional[dict]:
        if plat.gpu_vendor != "nvidia":
            return None
        builds = _cuda_builds(tagged, f"-bin-{os_tag}-", f"{plat.arch}{ext}")
        drv = plat.cuda_version or (0, 0)
        ok = [b for b in builds if drv == (0, 0) or b[0] <= drv]
        if not ok:
            return None
        ver, main = ok[0]
        vs = f"{ver[0]}.{ver[1]}"
        cudart = next((n for n in names if n.startswith("cudart-") and f"cuda-{vs}-{plat.arch}{ext}" in n
                       and os_tag in n), None)
        assets = [main] + ([cudart] if cudart else [])
        return {"backend": f"cuda-{vs}", "assets": assets,
                "note": f"NVIDIA GPU (driver CUDA {drv[0]}.{drv[1]}) -> CUDA {vs} build"}

    if plat.os == "macos":
        a = find(rf"macos-{plat.arch}\.tar\.gz") or find(rf"macos-{plat.arch}\.zip")
        if a:
            return {"backend": "metal" if plat.arch == "arm64" else "cpu", "assets": [a],
                    "note": "Apple Silicon Metal build" if plat.arch == "arm64" else "Intel Mac build"}
    elif plat.os == "windows":
        c = pick_cuda("win", ".zip")
        if c:
            return c
        if plat.gpu_vendor in ("nvidia", "amd", "intel"):
            a = find(rf"win-vulkan-{plat.arch}\.zip")
            if a:
                return {"backend": "vulkan", "assets": [a], "note": f"{plat.gpu_vendor} GPU -> Vulkan build"}
        a = find(rf"win-cpu-{plat.arch}\.zip")
        if a:
            return {"backend": "cpu", "assets": [a], "note": "no supported GPU -> CPU build"}
    else:  # linux
        c = pick_cuda("ubuntu", ".tar.gz")
        if c:
            return c
        note_cuda = ("NVIDIA GPU but no matching prebuilt CUDA build; using Vulkan/CPU. "
                     "LocalRuntime.build_from_source('cuda') can build a CUDA binary.") \
            if plat.gpu_vendor == "nvidia" else ""
        if plat.gpu_vendor in ("nvidia", "amd", "intel"):
            a = find(rf"ubuntu-vulkan-{plat.arch}\.tar\.gz")
            if a:
                return {"backend": "vulkan", "assets": [a],
                        "note": note_cuda or f"{plat.gpu_vendor} GPU -> Vulkan build"}
        a = find(rf"ubuntu-{plat.arch}\.tar\.gz")
        if a:
            return {"backend": "cpu", "assets": [a], "note": note_cuda or "CPU build"}
        a = find(rf"ubuntu-vulkan-{plat.arch}\.tar\.gz")
        if a:  # vulkan build still runs on CPU-only boxes via llvmpipe; better than nothing
            return {"backend": "vulkan", "assets": [a], "note": note_cuda or "Vulkan build (no CPU build found)"}
    raise RuntimeErrorPico(f"No prebuilt llama.cpp for {plat.os}/{plat.arch} in this release")


def model_parts(file: str) -> list[str]:
    """'x-00001-of-00003.gguf' -> all three part names; plain files -> [file]."""
    name = file.rsplit("/", 1)[-1]
    prefix = file[: len(file) - len(name)]
    m = _SPLIT_RE.match(name)
    if not m:
        return [file]
    n = int(m.group("n"))
    return [f"{prefix}{m.group('stem')}-{i:05d}-of-{n:05d}.gguf" for i in range(1, n + 1)]


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if not IS_WINDOWS:  # match llama-server (httplib sets SO_REUSEADDR); ignores TIME_WAIT leftovers
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


# ======================================================================
# Progress plumbing: worker threads write state, the loop emits throttled events
# ======================================================================

class _Cancelled(Exception):
    """Raised inside worker threads when the owning install() task was cancelled."""


class _Progress:
    def __init__(self, cb: Optional[Callable]):
        self.cb = cb
        self._last_t = 0.0
        self._last_key = None

    async def emit(self, step, label, pct, nbytes=None, total=None, force=False):
        if self.cb is None:
            return
        now = time.monotonic()
        key = (step, label, round(pct, 1))
        if not force and (now - self._last_t < PROGRESS_INTERVAL_S or key == self._last_key):
            return
        self._last_t, self._last_key = now, key
        r = self.cb(step, label, round(float(pct), 2), nbytes, total)
        if inspect.isawaitable(r):
            await r

    async def run_thread(self, step, label_fn, fn, *args, **kwargs):
        """Run blocking fn(*args, on_bytes=..., **kwargs) in a thread; relay byte progress."""
        state = {"done": 0, "total": None, "cancel": False}

        def on_bytes(done, total):
            if state["cancel"]:  # abort the worker thread at the next chunk (.part is kept for resume)
                raise _Cancelled()
            state["done"], state["total"] = done, total

        task = asyncio.ensure_future(asyncio.to_thread(fn, *args, on_bytes=on_bytes, **kwargs))
        while not task.done():
            try:
                await asyncio.wait({task}, timeout=PROGRESS_INTERVAL_S)
            except asyncio.CancelledError:
                state["cancel"] = True
                raise
            d, t = state["done"], state["total"]
            label, pct = label_fn(d, t)
            await self.emit(step, label, pct, d, t)
        return task.result()


def _fmt_gb(n: Optional[int]) -> str:
    return "?" if n is None else f"{n / 1e9:.2f} GB"


# ======================================================================
# LocalRuntime
# ======================================================================

class LocalRuntime:
    def __init__(self, home: Path):
        self.home = Path(home).expanduser()
        self.rt_dir = self.home / "runtime" / "llama.cpp"
        self.models_dir = self.home / "models"
        self.logs_dir = self.home / "logs"
        self.log_path = self.logs_dir / "llama-server.log"
        self._proc: Optional[subprocess.Popen] = None
        self._state = "stopped"
        self._error: Optional[str] = None
        self._port: Optional[int] = None
        self._model_id: Optional[str] = None
        self._recipe: Optional[dict] = None
        self._supervisor: Optional[asyncio.Task] = None
        self._stopping = False
        self._restarts = 0
        self._log_fh = None
        self._started_at: Optional[float] = None
        self.last_start_seconds: Optional[float] = None

    # ------------------------------------------------------------ paths
    @property
    def base_url(self) -> Optional[str]:
        return f"http://127.0.0.1:{self._port}/v1" if self._port else None

    def _hf_headers(self) -> dict:
        tok = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        return {"Authorization": f"Bearer {tok}"} if tok else {}

    def _gh_headers(self) -> dict:
        h = {"Accept": "application/vnd.github+json"}
        tok = os.environ.get("GITHUB_TOKEN")
        if tok:
            h["Authorization"] = f"Bearer {tok}"
        return h

    def model_dir(self, recipe: dict) -> Path:
        return self.models_dir / recipe["model"]["repo"].replace("/", "__")

    def model_path(self, recipe: dict) -> Path:
        """Path passed to -m (first part for split models)."""
        return self.model_dir(recipe) / model_parts(recipe["model"]["file"])[0].rsplit("/", 1)[-1]

    def server_path(self) -> Optional[Path]:
        meta = self.rt_dir / "install.json"
        if meta.exists():
            try:
                p = Path(json.loads(meta.read_text())["server"])
                if p.exists():
                    return p
            except Exception:
                pass
        return None

    def installed_version(self) -> Optional[str]:
        v = self.rt_dir / "VERSION"
        return v.read_text().strip() if v.exists() else None

    # ------------------------------------------------------------ release discovery
    def _gh_json(self, path: str):
        hdrs = self._gh_headers()
        try:
            return json.loads(dl.http_get_bytes(f"{GITHUB_API}{path}", hdrs))
        except urllib.error.HTTPError as e:
            if e.code == 401 and "Authorization" in hdrs:  # stale GITHUB_TOKEN: public API works anonymously
                hdrs.pop("Authorization")
                return json.loads(dl.http_get_bytes(f"{GITHUB_API}{path}", hdrs))
            if e.code in (403, 429):
                raise RuntimeErrorPico("GitHub API rate limit hit while looking up llama.cpp; "
                                       "try again later or set GITHUB_TOKEN") from e
            raise

    def resolve_release(self, plat: Optional[Platform] = None) -> dict:
        """Latest release that actually carries a binary for this platform.

        ggml-org publishes a 'vX.Y.Z' "latest" release whose only asset may be
        ``nightly-tag.txt`` pointing at the matching bNNNN build; nightly bNNNN
        builds are marked prerelease and can be mid-upload (incomplete assets)."""
        plat = plat or detect_platform()
        latest = self._gh_json("/releases/latest")
        candidates = [latest]
        names = [a["name"] for a in latest.get("assets", [])]
        if "nightly-tag.txt" in names:
            url = next(a["browser_download_url"] for a in latest["assets"] if a["name"] == "nightly-tag.txt")
            try:
                tag = dl.http_get_bytes(url).decode().strip()
                candidates.insert(0, self._gh_json(f"/releases/tags/{tag}"))
            except Exception:
                pass
        for rel in candidates:
            try:
                sel = select_assets([a["name"] for a in rel.get("assets", [])], plat)
            except RuntimeErrorPico:
                continue
            return self._release_result(rel, sel)
        # Fall back to recent builds; skip the newest (may still be uploading).
        for rel in self._gh_json("/releases?per_page=8")[1:]:
            try:
                sel = select_assets([a["name"] for a in rel.get("assets", [])], plat)
            except RuntimeErrorPico:
                continue
            return self._release_result(rel, sel)
        raise RuntimeErrorPico(f"No llama.cpp release with a prebuilt binary for {plat.os}/{plat.arch}")

    @staticmethod
    def _release_result(rel: dict, sel: dict) -> dict:
        by_name = {a["name"]: a for a in rel["assets"]}
        return {"tag": rel["tag_name"], "backend": sel["backend"], "note": sel["note"],
                "assets": [{"name": n, "url": by_name[n]["browser_download_url"],
                            "size": by_name[n].get("size")} for n in sel["assets"]]}

    def check_runtime_update(self) -> dict:
        """Report (never apply) a newer llama.cpp build."""
        cur = self.installed_version()
        rel = self.resolve_release()
        return {"current": cur, "latest": rel["tag"], "available": bool(cur and rel["tag"] != cur)}

    # ------------------------------------------------------------ install
    async def install(self, recipe: dict, progress=None) -> None:
        pg = _Progress(progress)
        for d in (self.rt_dir, self.models_dir, self.logs_dir):
            d.mkdir(parents=True, exist_ok=True)
        await self._install_runtime(pg)
        files = await self._install_model(recipe, pg)
        await self._verify(recipe, files, pg)

    async def _install_runtime(self, pg: _Progress) -> None:
        if self.server_path() and self.installed_version():
            await pg.emit("runtime", f"llama.cpp {self.installed_version()} already installed", 100, force=True)
            return
        await pg.emit("runtime", "Finding the right llama.cpp build", 0, force=True)
        plat = await asyncio.to_thread(detect_platform)
        rel = await asyncio.to_thread(self.resolve_release, plat)
        tag = rel["tag"]
        total = sum(a["size"] or 0 for a in rel["assets"]) or None
        await asyncio.to_thread(dl.check_disk_space, self.rt_dir, (total or 0) * 3)
        dl_dir = self.rt_dir / "_downloads"
        target = self.rt_dir / tag
        done_before = 0
        for a in rel["assets"]:
            base = done_before

            def label_fn(d, t, a=a, base=base):
                cur = base + d
                pct = 100.0 * cur / total if total else 0.0
                return f"Downloading llama.cpp {tag} ({rel['backend']}) {_fmt_gb(cur)} / {_fmt_gb(total)}", min(pct, 99.0)

            path = await pg.run_thread("runtime", label_fn, dl.download_file, a["url"],
                                       dl_dir / a["name"], expected_size=a["size"])
            done_before += a["size"] or 0
            await pg.emit("runtime", f"Unpacking {a['name']}", 99, done_before, total, force=True)
            await asyncio.to_thread(dl.safe_extract, path, target)
        server = next((p for p in target.rglob(SERVER_EXE) if p.is_file()), None)
        if not server:
            raise RuntimeErrorPico(f"{SERVER_EXE} not found in {rel['assets'][0]['name']}")
        # cudart zip extracts next to target root; make sure DLLs sit beside the exe.
        if IS_WINDOWS and server.parent != target:
            for dll in target.glob("*.dll"):
                if not (server.parent / dll.name).exists():
                    shutil.move(str(dll), server.parent / dll.name)
        if not IS_WINDOWS:
            for p in server.parent.iterdir():
                if p.is_file() and not p.is_symlink() and (p.name.startswith(("llama-", "ggml-", "rpc-"))
                                                            or p.suffix in (".so", ".dylib") or ".so." in p.name):
                    p.chmod(p.stat().st_mode | 0o755)
        if sys.platform == "darwin" and shutil.which("xattr"):
            subprocess.run(["xattr", "-dr", "com.apple.quarantine", str(target)],
                           capture_output=True, timeout=60)
        (self.rt_dir / "install.json").write_text(json.dumps({
            "tag": tag, "backend": rel["backend"], "note": rel["note"],
            "assets": [a["name"] for a in rel["assets"]], "server": str(server),
            "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}, indent=2))
        (self.rt_dir / "VERSION").write_text(tag + "\n")
        shutil.rmtree(dl_dir, ignore_errors=True)
        await pg.emit("runtime", f"llama.cpp {tag} ready ({rel['backend']})", 100, total, total, force=True)

    async def _install_model(self, recipe: dict, pg: _Progress) -> list[tuple[Path, Optional[str]]]:
        repo, file = recipe["model"]["repo"], recipe["model"]["file"]
        parts = model_parts(file)
        mdir = self.model_dir(recipe)
        mdir.mkdir(parents=True, exist_ok=True)
        hdr = self._hf_headers()
        await pg.emit("model", f"Checking {file}", 0, force=True)
        infos = []
        for part in parts:
            url = f"{HF_BASE}/{repo}/resolve/main/{part}"
            try:
                info = await asyncio.to_thread(dl.head_info, url, hdr)
            except dl.DownloadError as e:
                if "401" in str(e) or "403" in str(e):
                    raise RuntimeErrorPico(f"{repo} needs a Hugging Face token (set HF_TOKEN) or license acceptance") from e
                if "404" in str(e):
                    raise RuntimeErrorPico(f"Model file not found: {repo}/{part}") from e
                raise
            infos.append((part, url, info))
        sizes = [i["size"] for _, _, i in infos]
        total = sum(s for s in sizes if s) or (int(recipe["file_gb"] * 1e9) if recipe.get("file_gb") else None)
        have = 0
        for part, _, info in infos:
            p = mdir / part.rsplit("/", 1)[-1]
            if p.exists() and p.stat().st_size == info["size"]:
                have += p.stat().st_size
            elif p.with_name(p.name + ".part").exists():
                have += p.with_name(p.name + ".part").stat().st_size
        if total:
            await asyncio.to_thread(dl.check_disk_space, mdir, max(total - have, 0))
        out: list[tuple[Path, Optional[str]]] = []
        done_before = 0
        for idx, (part, url, info) in enumerate(infos):
            dest = mdir / part.rsplit("/", 1)[-1]
            base = done_before
            tag = f" (part {idx + 1}/{len(infos)})" if len(infos) > 1 else ""

            def label_fn(d, t, base=base, tag=tag):
                cur = base + d
                pct = 100.0 * cur / total if total else 0.0
                return f"Downloading {recipe.get('id') or file}{tag} {_fmt_gb(cur)} / {_fmt_gb(total)}", min(pct, 99.9)

            await pg.run_thread("model", label_fn, dl.download_file, url, dest, headers=hdr,
                                expected_size=info["size"])
            done_before += dest.stat().st_size
            out.append((dest, info.get("sha256")))
        await pg.emit("model", f"Model downloaded ({_fmt_gb(done_before)})", 100, done_before, total or done_before, force=True)
        return out

    async def _verify(self, recipe: dict, files: list[tuple[Path, Optional[str]]], pg: _Progress) -> None:
        want = recipe["model"].get("sha256")
        wants: list[Optional[str]]
        if isinstance(want, list):
            wants = list(want)
        elif isinstance(want, str) and len(files) == 1:
            wants = [want]
        else:  # fall back to the hashes Hugging Face reports (X-Linked-Etag)
            wants = [h for _, h in files]
        total = sum(p.stat().st_size for p, _ in files)
        done_before = 0
        for (path, _), expected in zip(files, wants):
            stamp = path.with_name(path.name + ".sha256")
            if expected:
                expected = expected.lower()
                if stamp.exists() and stamp.read_text().strip() == expected:
                    done_before += path.stat().st_size
                    continue
                base = done_before

                def label_fn(d, t, base=base, name=path.name):
                    return f"Verifying {name}", 100.0 * (base + d) / total if total else 0.0

                got = await pg.run_thread("verify", label_fn, dl.sha256_file, path)
                if got != expected:
                    bad = path.with_name(path.name + ".corrupt")
                    os.replace(path, bad)
                    raise RuntimeErrorPico(f"Checksum mismatch for {path.name} (got {got[:12]}…, expected "
                                           f"{expected[:12]}…). Moved to {bad.name}; run setup again to re-download.")
                stamp.write_text(expected + "\n")
            done_before += path.stat().st_size
        server = self.server_path()
        if not server:
            raise RuntimeErrorPico("llama-server missing after install")
        await pg.emit("verify", "Checking llama-server runs", 99, force=True)
        r = await asyncio.to_thread(subprocess.run, [str(server), "--version"], capture_output=True,
                                    text=True, timeout=60, cwd=str(server.parent))
        if r.returncode != 0:
            raise RuntimeErrorPico(f"llama-server failed to run: {(r.stderr or r.stdout).strip()[-500:]}")
        await pg.emit("verify", "Ready", 100, force=True)

    # ------------------------------------------------------------ launch / supervise
    def _command(self, recipe: dict, port: int) -> list[str]:
        server = self.server_path()
        if not server:
            raise RuntimeErrorPico("llama.cpp is not installed; run install() first")
        model = self.model_path(recipe)
        if not model.exists():
            raise RuntimeErrorPico(f"Model not downloaded: {model}")
        cmd = [str(server), "-m", str(model), "--host", "127.0.0.1", "--port", str(port),
               "-c", str(int(recipe.get("ctx") or 8192)), "--jinja",
               "--alias", str(recipe.get("id") or model.stem)]
        flags = [str(f) for f in recipe.get("flags") or []]
        blocked = {"--host", "--port", "-m", "--model"}
        i = 0
        while i < len(flags):  # never let a recipe rebind host/port/model
            f = flags[i]
            if f.split("=", 1)[0] in blocked:
                i += 1 if "=" in f else 2
                continue
            cmd.append(f)
            i += 1
        return cmd

    def _spawn(self, keep_port: bool = False) -> None:
        assert self._recipe is not None
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        if not (keep_port and self._port and _port_free(self._port)):
            self._port = _free_port()
        cmd = self._command(self._recipe, self._port)
        if self._log_fh is None or self._log_fh.closed:
            self._log_fh = open(self.log_path, "ab", buffering=0)
        self._log_fh.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} pico start: {' '.join(cmd)}\n".encode())
        kw: dict[str, Any] = {}
        if IS_WINDOWS:
            kw["creationflags"] = (getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)
                                   | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000))
        else:
            kw["start_new_session"] = True
        self._proc = subprocess.Popen(cmd, stdout=self._log_fh, stderr=subprocess.STDOUT,
                                      stdin=subprocess.DEVNULL, cwd=str(Path(cmd[0]).parent), **kw)
        self._started_at = time.monotonic()

    def _health_ok(self) -> bool:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self._port}/health", timeout=3) as r:
                body = json.loads(r.read() or b"{}")
                return r.status == 200 and body.get("status", "ok") == "ok"
        except (urllib.error.URLError, OSError, ValueError):
            return False

    async def _wait_healthy(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._proc is None or self._proc.poll() is not None:
                code = None if self._proc is None else self._proc.returncode
                raise RuntimeErrorPico(f"llama-server exited during startup (code {code}).\n{self._tail(15)}")
            if await asyncio.to_thread(self._health_ok):
                return
            await asyncio.sleep(0.5)
        raise RuntimeErrorPico(f"llama-server not healthy after {int(timeout)}s.\n{self._tail(15)}")

    async def start(self, recipe: dict, timeout: float = HEALTH_TIMEOUT_S) -> str:
        if self._proc and self._proc.poll() is None:
            if self._recipe and self._recipe.get("id") == recipe.get("id") and self._state == "running":
                return self.base_url  # type: ignore[return-value]
            await self.stop()
        self._recipe, self._model_id = recipe, recipe.get("id") or recipe["model"]["file"]
        self._stopping, self._restarts, self._error = False, 0, None
        self._state = "starting"
        t0 = time.monotonic()
        try:
            self._spawn()
            await self._wait_healthy(timeout)
        except Exception as e:
            self._state, self._error = "error", str(e)
            await self._kill()
            raise
        self.last_start_seconds = round(time.monotonic() - t0, 2)
        self._state = "running"
        self._supervisor = asyncio.ensure_future(self._supervise())
        return self.base_url  # type: ignore[return-value]

    async def _supervise(self) -> None:
        """Restart llama-server if it dies unexpectedly (backoff 2/4/8s, max 3)."""
        while not self._stopping:
            await asyncio.sleep(1.0)
            proc = self._proc
            if self._stopping or proc is None or proc.poll() is None:
                continue
            code = proc.returncode
            if self._restarts >= MAX_RESTARTS:
                self._state = "error"
                self._error = f"llama-server crashed {self._restarts + 1} times (last code {code}); giving up"
                return
            self._restarts += 1
            self._state = "starting"
            await asyncio.sleep(2 ** self._restarts)
            if self._stopping:
                return
            try:
                self._spawn(keep_port=True)  # same base_url for clients if the port is still free
                await self._wait_healthy(HEALTH_TIMEOUT_S)
                self._state = "running"
            except Exception as e:
                self._error = str(e)  # loop again; poll() shows it dead -> next attempt

    async def _kill(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None or proc.poll() is not None:
            return
        await asyncio.to_thread(kill_tree, proc)

    async def stop(self) -> None:
        self._stopping = True
        sup, self._supervisor = self._supervisor, None
        if sup and not sup.done():
            sup.cancel()
            try:
                await sup
            except (asyncio.CancelledError, Exception):
                pass
        await self._kill()
        if self._log_fh and not self._log_fh.closed:
            self._log_fh.close()
        self._state, self._port = "stopped", None

    def _tail(self, n: int = 20) -> str:
        try:
            with open(self.log_path, "rb") as f:
                f.seek(0, 2)
                f.seek(max(0, f.tell() - 64 * 1024))
                lines = f.read().decode("utf-8", "replace").splitlines()
            return "\n".join(deque(lines, maxlen=n))
        except OSError:
            return ""

    def status(self) -> dict:
        state = self._state
        if state == "running" and (self._proc is None or self._proc.poll() is not None):
            state = "starting" if not self._stopping and self._restarts < MAX_RESTARTS else "error"
        return {"state": state, "pid": self._proc.pid if self._proc and self._proc.poll() is None else None,
                "base_url": self.base_url if state in ("running", "starting") else None,
                "model": self._model_id, "port": self._port, "restarts": self._restarts,
                "error": self._error, "version": self.installed_version(), "log_tail": self._tail(20)}

    # ------------------------------------------------------------ bench
    def _post(self, path: str, body: dict, timeout: float = 300) -> dict:
        req = urllib.request.Request(f"http://127.0.0.1:{self._port}{path}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())

    async def chat(self, prompt: str, max_tokens: int = 64, think: bool = False) -> dict:
        if self._state != "running":
            raise RuntimeErrorPico("runtime not running")
        body = {"messages": [{"role": "user", "content": prompt}], "max_tokens": max_tokens,
                "stream": False, "chat_template_kwargs": {"enable_thinking": think}}
        return await asyncio.to_thread(self._post, "/v1/chat/completions", body)

    async def bench(self, n_tokens: int = 128) -> dict:
        """Real decode + prompt throughput through the running server."""
        if self._state != "running":
            raise RuntimeErrorPico("runtime not running")
        # ~500-token prompt so prompt tok/s is meaningful; nonce defeats the prompt cache.
        filler = " ".join(f"item{i} is a small grey stone." for i in range(80))
        prompt = (f"[{uuid.uuid4().hex}] Here is a list: {filler}\n"
                  "Now write a long, detailed story about a lighthouse keeper.")
        body = {"messages": [{"role": "user", "content": prompt}], "max_tokens": int(n_tokens),
                "stream": False, "cache_prompt": False, "temperature": 0.7,
                "chat_template_kwargs": {"enable_thinking": False}}
        t0 = time.monotonic()
        r = await asyncio.to_thread(self._post, "/v1/chat/completions", body)
        wall = time.monotonic() - t0
        t = r.get("timings") or {}
        usage = r.get("usage") or {}
        return {"decode_tps": round(float(t.get("predicted_per_second") or 0), 2),
                "prompt_tps": round(float(t.get("prompt_per_second") or 0), 2),
                "decode_tokens": t.get("predicted_n") or usage.get("completion_tokens"),
                "prompt_tokens": t.get("prompt_n") or usage.get("prompt_tokens"),
                "wall_s": round(wall, 2), "model": self._model_id}

    # ------------------------------------------------------------ source build (never automatic)
    def build_from_source_plan(self, backend: str = "cuda") -> list[list[str]]:
        src = self.rt_dir / "src"
        flag = {"cuda": "-DGGML_CUDA=ON", "vulkan": "-DGGML_VULKAN=ON", "rocm": "-DGGML_HIP=ON",
                "metal": "-DGGML_METAL=ON", "cpu": "-DGGML_NATIVE=ON"}[backend]
        return [["git", "clone", "--depth", "1", "https://github.com/ggml-org/llama.cpp", str(src)],
                ["cmake", "-S", str(src), "-B", str(src / "build"), flag, "-DCMAKE_BUILD_TYPE=Release",
                 "-DLLAMA_CURL=OFF"],
                ["cmake", "--build", str(src / "build"), "--config", "Release", "-j", "--target", "llama-server"]]

    async def build_from_source(self, backend: str = "cuda", progress=None) -> Path:
        """Build llama-server locally (needs git, cmake, a compiler and e.g. the CUDA toolkit).
        Only runs when explicitly called; installs nothing system-wide."""
        pg = _Progress(progress)
        missing = [t for t in ("git", "cmake") if not shutil.which(t)]
        if missing:
            raise RuntimeErrorPico(f"Building llama.cpp needs {', '.join(missing)} installed")
        src = self.rt_dir / "src"
        if src.exists():
            shutil.rmtree(src)
        plan = self.build_from_source_plan(backend)
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        with open(self.logs_dir / "llama-build.log", "ab") as log:
            for i, cmd in enumerate(plan):
                await pg.emit("runtime", f"Building llama.cpp ({backend}): {cmd[0]} {cmd[1]}",
                              100.0 * i / len(plan), force=True)
                r = await asyncio.to_thread(subprocess.run, cmd, stdout=log, stderr=subprocess.STDOUT)
                if r.returncode != 0:
                    raise RuntimeErrorPico(f"Build step failed: {' '.join(cmd)} (see logs/llama-build.log)")
        server = next(p for p in (src / "build").rglob(SERVER_EXE) if p.is_file())
        tag = f"source-{backend}"
        (self.rt_dir / "install.json").write_text(json.dumps(
            {"tag": tag, "backend": backend, "assets": [], "server": str(server)}, indent=2))
        (self.rt_dir / "VERSION").write_text(tag + "\n")
        await pg.emit("runtime", f"llama.cpp built from source ({backend})", 100, force=True)
        return server


def kill_tree(proc: subprocess.Popen, grace: float = 10.0) -> None:
    """Terminate a process and all its children (Windows: taskkill /T)."""
    if proc.poll() is not None:
        return
    if IS_WINDOWS:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        try:
            proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            proc.kill()
        return
    try:
        pgid = os.getpgid(proc.pid)
    except ProcessLookupError:
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=5)
