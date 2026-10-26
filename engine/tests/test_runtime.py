"""Unit tests for pico.runtime / pico.downloads (no real network)."""
import asyncio
import io
import json
import os
import sys
import tarfile
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pico import downloads as dl  # noqa: E402
from pico import runtime as rt  # noqa: E402
from pico.runtime import Platform, select_assets, model_parts  # noqa: E402

TAG = "b11882"
ASSETS = [
    "cudart-llama-b11882-bin-ubuntu-cuda-12.8-x64.tar.gz",
    "cudart-llama-b11882-bin-ubuntu-cuda-13.4-x64.tar.gz",
    "cudart-llama-bin-win-cuda-12.4-x64.zip",
    "cudart-llama-bin-win-cuda-13.4-arm64.zip",
    "cudart-llama-bin-win-cuda-13.4-x64.zip",
    f"llama-{TAG}-bin-macos-arm64.tar.gz",
    f"llama-{TAG}-bin-macos-x64.tar.gz",
    f"llama-{TAG}-bin-ubuntu-arm64.tar.gz",
    f"llama-{TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz",
    f"llama-{TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz",
    f"llama-{TAG}-bin-ubuntu-rocm-10.0-x64.tar.gz",
    f"llama-{TAG}-bin-ubuntu-vulkan-arm64.tar.gz",
    f"llama-{TAG}-bin-ubuntu-vulkan-x64.tar.gz",
    f"llama-{TAG}-bin-ubuntu-x64.tar.gz",
    f"llama-{TAG}-bin-win-cpu-arm64.zip",
    f"llama-{TAG}-bin-win-cpu-x64.zip",
    f"llama-{TAG}-bin-win-cuda-12.4-x64.zip",
    f"llama-{TAG}-bin-win-cuda-13.4-x64.zip",
    f"llama-{TAG}-bin-win-vulkan-x64.zip",
    f"llama-{TAG}-bin-win-vulkan-arm64.zip",
    f"llama-{TAG}-xcframework.zip",
]


# ------------------------------------------------------------ asset selection

@pytest.mark.parametrize("plat,backend,assets", [
    (Platform("macos", "arm64", "apple"), "metal", [f"llama-{TAG}-bin-macos-arm64.tar.gz"]),
    (Platform("macos", "x64"), "cpu", [f"llama-{TAG}-bin-macos-x64.tar.gz"]),
    (Platform("windows", "x64", "nvidia", (13, 6)), "cuda-13.4",
     [f"llama-{TAG}-bin-win-cuda-13.4-x64.zip", "cudart-llama-bin-win-cuda-13.4-x64.zip"]),
    (Platform("windows", "x64", "nvidia", (12, 8)), "cuda-12.4",
     [f"llama-{TAG}-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-12.4-x64.zip"]),
    (Platform("windows", "x64", "nvidia", (11, 8)), "vulkan", [f"llama-{TAG}-bin-win-vulkan-x64.zip"]),
    (Platform("windows", "x64", "amd"), "vulkan", [f"llama-{TAG}-bin-win-vulkan-x64.zip"]),
    (Platform("windows", "x64", None), "cpu", [f"llama-{TAG}-bin-win-cpu-x64.zip"]),
    (Platform("windows", "arm64", None), "cpu", [f"llama-{TAG}-bin-win-cpu-arm64.zip"]),
    (Platform("linux", "x64", "nvidia", (13, 4)), "cuda-13.4",
     [f"llama-{TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz", "cudart-llama-b11882-bin-ubuntu-cuda-13.4-x64.tar.gz"]),
    (Platform("linux", "x64", "nvidia", (12, 9)), "cuda-12.8",
     [f"llama-{TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz", "cudart-llama-b11882-bin-ubuntu-cuda-12.8-x64.tar.gz"]),
    (Platform("linux", "x64", "amd"), "vulkan", [f"llama-{TAG}-bin-ubuntu-vulkan-x64.tar.gz"]),
    (Platform("linux", "x64", None), "cpu", [f"llama-{TAG}-bin-ubuntu-x64.tar.gz"]),
    (Platform("linux", "arm64", None), "cpu", [f"llama-{TAG}-bin-ubuntu-arm64.tar.gz"]),
])
def test_select_assets(plat, backend, assets):
    sel = select_assets(ASSETS, plat)
    assert sel["backend"] == backend
    assert sel["assets"] == assets


def test_linux_nvidia_without_cuda_build_falls_back_with_note():
    names = [n for n in ASSETS if "cuda" not in n]
    sel = select_assets(names, Platform("linux", "x64", "nvidia", (12, 4)))
    assert sel["backend"] == "vulkan"
    assert "build_from_source" in sel["note"]


def test_select_assets_none():
    with pytest.raises(rt.RuntimeErrorPico):
        select_assets(["nightly-tag.txt"], Platform("macos", "arm64", "apple"))


def test_model_parts():
    assert model_parts("x-Q4_K_M.gguf") == ["x-Q4_K_M.gguf"]
    assert model_parts("Q4/x-00001-of-00003.gguf") == [
        "Q4/x-00001-of-00003.gguf", "Q4/x-00002-of-00003.gguf", "Q4/x-00003-of-00003.gguf"]


def test_resolve_release_follows_nightly_tag(monkeypatch, tmp_path):
    r = rt.LocalRuntime(tmp_path)
    latest = {"tag_name": "v0.7.0", "assets": [
        {"name": "nightly-tag.txt", "browser_download_url": "https://x/nightly-tag.txt", "size": 7}]}
    build = {"tag_name": "b11669", "assets": [
        {"name": n.replace(TAG, "b11669"), "browser_download_url": f"https://x/{n}", "size": 10} for n in ASSETS]}
    monkeypatch.setattr(r, "_gh_json", lambda p: latest if p.endswith("latest") else build)
    monkeypatch.setattr(dl, "http_get_bytes", lambda url, headers=None: b"b11669\n")
    res = r.resolve_release(Platform("macos", "arm64", "apple"))
    assert res["tag"] == "b11669"
    assert res["assets"][0]["name"] == "llama-b11669-bin-macos-arm64.tar.gz"


def test_command_strips_dangerous_flags(tmp_path):
    r = rt.LocalRuntime(tmp_path)
    server = tmp_path / "llama-server"
    server.write_text("")
    (r.rt_dir).mkdir(parents=True)
    (r.rt_dir / "install.json").write_text(json.dumps({"server": str(server)}))
    recipe = {"id": "m", "model": {"repo": "o/n-GGUF", "file": "n.gguf"}, "ctx": 4096,
              "flags": ["-ngl", "99", "--port", "1", "--host=0.0.0.0", "-fa", "on"]}
    r.model_path(recipe).parent.mkdir(parents=True)
    r.model_path(recipe).write_text("")
    cmd = r._command(recipe, 5555)
    assert cmd.count("--port") == 1 and "0.0.0.0" not in " ".join(cmd) and "--host=0.0.0.0" not in cmd
    assert cmd[-4:] == ["-ngl", "99", "-fa", "on"]
    assert "--jinja" in cmd and cmd[cmd.index("-c") + 1] == "4096"


# ------------------------------------------------------------ safe extraction

def _tar(path, entries):
    with tarfile.open(path, "w:gz") as tf:
        for e in entries:
            ti = tarfile.TarInfo(e["name"])
            if e.get("sym"):
                ti.type, ti.linkname = tarfile.SYMTYPE, e["sym"]
                tf.addfile(ti)
            else:
                data = e.get("data", b"x")
                ti.size, ti.mode = len(data), e.get("mode", 0o644)
                tf.addfile(ti, io.BytesIO(data))


def test_tar_extract_ok_with_internal_symlink(tmp_path):
    a = tmp_path / "a.tar.gz"
    _tar(a, [{"name": "d/llama-server", "mode": 0o755}, {"name": "d/lib.1.dylib"},
             {"name": "d/lib.dylib", "sym": "lib.1.dylib"}])
    out = dl.safe_extract(a, tmp_path / "out")
    assert (out / "d" / "llama-server").exists()
    assert os.readlink(out / "d" / "lib.dylib") == "lib.1.dylib"


@pytest.mark.parametrize("entry", [
    {"name": "../evil"}, {"name": "/abs/evil"}, {"name": "d/../../evil"},
    {"name": "d/link", "sym": "../../etc/passwd"}, {"name": "d/link", "sym": "/etc/passwd"},
])
def test_tar_traversal_rejected(tmp_path, entry):
    a = tmp_path / "a.tar.gz"
    _tar(a, [entry])
    with pytest.raises(dl.UnsafeArchiveError):
        dl.safe_extract(a, tmp_path / "out")
    assert not (tmp_path / "evil").exists()


def test_zip_extract_and_traversal(tmp_path):
    good = tmp_path / "g.zip"
    with zipfile.ZipFile(good, "w") as zf:
        zf.writestr("llama-server.exe", b"MZ")
        zf.writestr("ggml-cuda.dll", b"x")
    out = dl.safe_extract(good, tmp_path / "o")
    assert (out / "llama-server.exe").read_bytes() == b"MZ"
    for bad_name in ("../evil.dll", "..\\evil.dll", "C:/Windows/evil.dll", "/etc/evil"):
        bad = tmp_path / "b.zip"
        with zipfile.ZipFile(bad, "w") as zf:
            zf.writestr(bad_name, b"x")
        with pytest.raises(dl.UnsafeArchiveError):
            dl.safe_extract(bad, tmp_path / "o2")
    assert not (tmp_path / "evil.dll").exists()


# ------------------------------------------------------------ resumable download against a local server

PAYLOAD = os.urandom(3 * 1024 * 1024 + 123)


class _Handler(BaseHTTPRequestHandler):
    log_message = lambda *a: None  # noqa: E731
    seen_ranges: list = []
    honor_range = True
    fail_after = None  # bytes then drop connection (first request only)

    def do_HEAD(self):
        self.send_response(302)
        self.send_header("Location", "/blob")
        self.send_header("X-Linked-Size", str(len(PAYLOAD)))
        import hashlib
        self.send_header("X-Linked-Etag", '"%s"' % hashlib.sha256(PAYLOAD).hexdigest())
        self.end_headers()

    def do_GET(self):
        rng = self.headers.get("Range")
        type(self).seen_ranges.append(rng)
        start = 0
        if rng and type(self).honor_range:
            start = int(rng.split("=")[1].split("-")[0])
            if start >= len(PAYLOAD):
                self.send_response(416)
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(PAYLOAD) - 1}/{len(PAYLOAD)}")
        else:
            self.send_response(200)
        body = PAYLOAD[start:]
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        fa = type(self).fail_after
        if fa is not None:
            type(self).fail_after = None
            self.wfile.write(body[:fa])
            self.wfile.flush()
            self.connection.shutdown(2)
            return
        self.wfile.write(body)


@pytest.fixture
def server():
    _Handler.seen_ranges, _Handler.honor_range, _Handler.fail_after = [], True, None
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def test_resume_from_part(server, tmp_path):
    dest = tmp_path / "m.gguf"
    (tmp_path / "m.gguf.part").write_bytes(PAYLOAD[:1_000_000])
    seen = []
    dl.download_file(server + "/blob", dest, expected_size=len(PAYLOAD), on_bytes=lambda d, t: seen.append((d, t)))
    assert dest.read_bytes() == PAYLOAD
    assert _Handler.seen_ranges == ["bytes=1000000-"]
    assert seen[0] == (1_000_000, len(PAYLOAD)) and seen[-1] == (len(PAYLOAD), len(PAYLOAD))
    assert not (tmp_path / "m.gguf.part").exists()


def test_resume_when_server_ignores_range(server, tmp_path):
    _Handler.honor_range = False
    dest = tmp_path / "m.gguf"
    (tmp_path / "m.gguf.part").write_bytes(b"garbage" * 1000)
    dl.download_file(server + "/blob", dest, expected_size=len(PAYLOAD))
    assert dest.read_bytes() == PAYLOAD


def test_retry_after_dropped_connection(server, tmp_path, monkeypatch):
    monkeypatch.setattr(dl.time, "sleep", lambda s: None)
    _Handler.fail_after = 500_000
    dest = tmp_path / "m.gguf"
    dl.download_file(server + "/blob", dest, expected_size=len(PAYLOAD))
    assert dest.read_bytes() == PAYLOAD
    assert _Handler.seen_ranges[0] is None and _Handler.seen_ranges[1].startswith("bytes=")


def test_complete_part_gets_416_and_finishes(server, tmp_path):
    (tmp_path / "m.gguf.part").write_bytes(PAYLOAD)
    dl.download_file(server + "/blob", tmp_path / "m.gguf", expected_size=None)
    assert (tmp_path / "m.gguf").read_bytes() == PAYLOAD


def test_head_info_reads_hf_headers(server):
    import hashlib
    info = dl.head_info(server + "/resolve/main/x.gguf")
    assert info == {"size": len(PAYLOAD), "sha256": hashlib.sha256(PAYLOAD).hexdigest()}


def test_disk_space_error(tmp_path):
    with pytest.raises(dl.DiskSpaceError, match="Not enough disk space"):
        dl.check_disk_space(tmp_path, 10 ** 15)


def test_install_model_and_verify_end_to_end(server, tmp_path, monkeypatch):
    """Model step + sha256 verify through install helpers, with progress events."""
    import hashlib
    monkeypatch.setattr(rt, "HF_BASE", server)
    _real_check = dl.check_disk_space
    monkeypatch.setattr(dl, "check_disk_space", lambda p, n, reserve_bytes=0: _real_check(p, n, 0))
    r = rt.LocalRuntime(tmp_path)
    fake_server = tmp_path / "llama-server"
    fake_server.write_text("#!/bin/sh\necho version: 1\n")
    fake_server.chmod(0o755)
    r.rt_dir.mkdir(parents=True)
    (r.rt_dir / "install.json").write_text(json.dumps({"server": str(fake_server)}))
    events = []
    recipe = {"id": "t", "model": {"repo": "o/n-GGUF", "file": "n.gguf",
                                   "sha256": hashlib.sha256(PAYLOAD).hexdigest()}, "file_gb": 0.003}
    pg = rt._Progress(lambda *a: events.append(a))

    async def go():
        files = await r._install_model(recipe, pg)
        await r._verify(recipe, files, pg)

    asyncio.run(go())
    assert r.model_path(recipe).read_bytes() == PAYLOAD
    steps = [e[0] for e in events]
    assert "model" in steps and steps[-1] == "verify" and events[-1][2] == 100
    # wrong checksum -> clear error and file quarantined
    recipe2 = dict(recipe, model=dict(recipe["model"], sha256="0" * 64))
    r.model_path(recipe).with_name("n.gguf.sha256").unlink()
    with pytest.raises(rt.RuntimeErrorPico, match="Checksum mismatch"):
        asyncio.run(r._verify(recipe2, [(r.model_path(recipe), None)], pg))


def test_cancel_stops_worker_thread_and_keeps_part(tmp_path):
    """Cancelling install() must stop the download thread at the next chunk."""
    import time as _t
    calls = {"n": 0}

    def slow_dl(on_bytes=None):
        for i in range(1000):
            on_bytes(i, 1000)
            calls["n"] = i
            _t.sleep(0.01)
        return "finished"

    async def go():
        pg = rt._Progress(None)
        task = asyncio.ensure_future(pg.run_thread("model", lambda d, t: ("x", 0), slow_dl))
        await asyncio.sleep(0.3)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        n = calls["n"]
        await asyncio.sleep(0.3)
        return n, calls["n"]

    n1, n2 = asyncio.run(go())
    assert n2 - n1 <= 2 and n2 < 100
