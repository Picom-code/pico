"""Hardware scan for Pico (stdlib only, cross-platform, never raises).

scan() returns the exact /api/system shape from docs/API.md:

    {os, arch, cpu:{name,cores}, ram_gb, gpus:[{vendor,name,vram_gb,driver,compute}],
     unified_memory, disk_free_gb, accelerators, runtimes:{llama_cpp, ollama, lmstudio, vllm}}

Extra keys (clients may ignore them): usable_vram_gb, mem_bandwidth_gbps, tier.

Every probe is wrapped and time-limited (~5 s); a failed probe just leaves defaults.
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

TIMEOUT = 5.0
GiB = 1024 ** 3

# Approximate memory bandwidth (GB/s) for decode-speed estimates. Keyed by lowercase substring;
# first match wins, so more specific names come first.
_BANDWIDTH = [
    # Apple Silicon (unified)
    ("m1 ultra", 800), ("m2 ultra", 800), ("m3 ultra", 819), ("m4 ultra", 1092),
    ("m1 max", 400), ("m2 max", 400), ("m3 max", 400), ("m4 max", 546), ("m5 max", 614),
    ("m1 pro", 200), ("m2 pro", 200), ("m3 pro", 150), ("m4 pro", 273), ("m5 pro", 307),
    ("apple m1", 68), ("apple m2", 100), ("apple m3", 100), ("apple m4", 120), ("apple m5", 153),
    # NVIDIA
    ("gb10", 273), ("dgx spark", 273), ("rtx pro 6000", 1792), ("h100", 3350), ("a100", 2039),
    ("rtx 5090", 1792), ("rtx 5080", 960), ("rtx 5070 ti", 896), ("rtx 5070", 672),
    ("rtx 5060 ti", 448), ("rtx 5060", 448),
    ("rtx 4090", 1008), ("rtx 4080", 717), ("rtx 4070 ti super", 672), ("rtx 4070 ti", 504),
    ("rtx 4070 super", 504), ("rtx 4070", 504), ("rtx 4060 ti", 288), ("rtx 4060", 272),
    ("rtx 3090", 936), ("rtx 3080 ti", 912), ("rtx 3080", 760), ("rtx 3070", 448),
    ("rtx 3060 ti", 448), ("rtx 3060", 360), ("rtx a6000", 768), ("rtx 6000 ada", 960),
    ("rtx 2080", 448), ("rtx 2070", 448), ("rtx 2060", 336), ("gtx 1080", 320),
    # AMD
    ("7900 xtx", 960), ("7900 xt", 800), ("7800 xt", 624), ("7700 xt", 432), ("7600", 288),
    ("9070 xt", 640), ("9070", 640), ("r9700", 640), ("8060s", 256), ("strix halo", 256),
    ("6900 xt", 512), ("6800 xt", 512), ("mi300", 5300),
    # Intel
    ("arc pro b70", 608), ("arc b580", 456), ("arc b570", 380), ("arc a770", 560), ("arc a750", 512),
]


def _run(cmd: list[str], timeout: float = TIMEOUT) -> str:
    """Run a command, return stdout ('' on any failure). Never raises."""
    try:
        exe = shutil.which(cmd[0]) or (cmd[0] if os.path.isabs(cmd[0]) and os.path.exists(cmd[0]) else None)
        if not exe:
            return ""
        kw: dict[str, Any] = {}
        if sys.platform == "win32":
            kw["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        r = subprocess.run([exe, *cmd[1:]], capture_output=True, text=True, timeout=timeout,
                           errors="replace", **kw)
        return r.stdout or ""
    except Exception:
        return ""


def _powershell(script: str) -> str:
    for ps in ("powershell", "pwsh"):
        out = _run([ps, "-NoProfile", "-NonInteractive", "-Command", script], timeout=TIMEOUT + 3)
        if out.strip():
            return out
    return ""


def _r1(x: float) -> float:
    return round(float(x), 1)


def _norm_os() -> str:
    s = sys.platform
    if s == "darwin":
        return "macos"
    if s.startswith("win"):
        return "windows"
    if s.startswith("linux"):
        return "linux"
    return s


def _norm_arch(m: str) -> str:
    m = (m or "").lower()
    if m in ("x86_64", "amd64", "x64"):
        return "x64"
    if m in ("arm64", "aarch64", "armv8", "arm64e"):
        return "arm64"
    return m or "unknown"


# ---------------------------------------------------------------- CPU / RAM
def _cpu(osn: str) -> dict:
    name, cores = "", os.cpu_count() or 1
    try:
        if osn == "macos":
            name = _run(["sysctl", "-n", "machdep.cpu.brand_string"]).strip()
            pc = _run(["sysctl", "-n", "hw.physicalcpu"]).strip()
            cores = int(pc) if pc.isdigit() else cores
        elif osn == "linux":
            txt = Path("/proc/cpuinfo").read_text(errors="ignore")
            m = re.search(r"^(model name|Model|Hardware)\s*:\s*(.+)$", txt, re.M)
            name = m.group(2).strip() if m else ""
            if not name:  # ARM boards: lscpu has the vendor/model
                lo = _run(["lscpu"])
                m = re.search(r"Model name:\s*(.+)", lo)
                name = m.group(1).strip() if m else ""
        elif osn == "windows":
            out = _powershell("(Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores | ConvertTo-Json)")
            d = json.loads(out) if out.strip() else {}
            name = (d.get("Name") or "").strip()
            cores = int(d.get("NumberOfCores") or cores)
    except Exception:
        pass
    return {"name": name or platform.processor() or platform.machine(), "cores": int(cores)}


def _ram_gb(osn: str) -> float:
    try:
        if osn == "macos":
            v = _run(["sysctl", "-n", "hw.memsize"]).strip()
            return _r1(int(v) / GiB) if v.isdigit() else 0.0
        if osn == "linux":
            m = re.search(r"MemTotal:\s+(\d+)\s*kB", Path("/proc/meminfo").read_text())
            return _r1(int(m.group(1)) * 1024 / GiB) if m else 0.0
        if osn == "windows":
            try:
                import ctypes

                class MS(ctypes.Structure):
                    _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                                ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
                ms = MS()
                ms.dwLength = ctypes.sizeof(MS)
                if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms)):  # type: ignore[attr-defined]
                    return _r1(ms.ullTotalPhys / GiB)
            except Exception:
                pass
            out = _powershell("(Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum")
            v = out.strip()
            return _r1(int(v) / GiB) if v.isdigit() else 0.0
    except Exception:
        pass
    return 0.0


# ---------------------------------------------------------------- GPUs
def _nvidia_smi() -> list[dict]:
    out = _run(["nvidia-smi", "--query-gpu=name,memory.total,memory.used,driver_version,compute_cap",
                "--format=csv,noheader,nounits"])
    if not out.strip() and sys.platform == "win32":
        p = r"C:\Windows\System32\nvidia-smi.exe"
        if os.path.exists(p):
            out = _run([p, "--query-gpu=name,memory.total,memory.used,driver_version,compute_cap",
                        "--format=csv,noheader,nounits"])
    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            continue
        name = parts[0]
        def num(s: str) -> Optional[float]:
            try:
                return float(s)
            except Exception:
                return None
        total, used = num(parts[1]), num(parts[2])
        g = {"vendor": "nvidia", "name": name,
             "vram_gb": _r1(total / 1024) if total else 0.0,
             "driver": parts[3] or None,
             "compute": ("cuda " + parts[4]) if len(parts) > 4 and parts[4] not in ("", "[N/A]") else "cuda",
             "_used_gb": (used / 1024) if used is not None else None}
        # GB10 (DGX Spark) reports memory.total as N/A: it shares system LPDDR5X.
        if "gb10" in name.lower() or (not total and "grace" in name.lower()):
            g["_unified"] = True
        gpus.append(g)
    return gpus


def _rocm_smi() -> list[dict]:
    out = _run(["rocm-smi", "--showproductname", "--showmeminfo", "vram", "--showdriverversion", "--json"])
    gpus: list[dict] = []
    try:
        d = json.loads(out) if out.strip() else {}
    except Exception:
        d = {}
    drv = None
    for k, v in d.items():
        if not isinstance(v, dict):
            continue
        if k.lower() == "system":
            drv = v.get("Driver version")
            continue
        name = v.get("Card Series") or v.get("Card series") or v.get("Card model") or "AMD GPU"
        tot = v.get("VRAM Total Memory (B)")
        used = v.get("VRAM Total Used Memory (B)")
        try:
            vram = _r1(int(tot) / GiB) if tot else 0.0
        except Exception:
            vram = 0.0
        gpus.append({"vendor": "amd", "name": str(name), "vram_gb": vram, "driver": None,
                     "compute": "rocm " + str(v.get("GFX Version", "")).strip() if v.get("GFX Version") else "rocm",
                     "_used_gb": (int(str(used)) / GiB) if str(used or "").isdigit() else None})
    for g in gpus:
        g["driver"] = drv
    return gpus


def _lspci_gpus() -> list[dict]:
    out = _run(["lspci", "-mm"])
    gpus = []
    for line in out.splitlines():
        if not re.search(r'"(VGA compatible controller|3D controller|Display controller)"', line):
            continue
        low = line.lower()
        vendor = "nvidia" if "nvidia" in low else "amd" if ("amd" in low or "ati" in low) else \
            "intel" if "intel" in low else "other"
        fields = re.findall(r'"([^"]*)"', line)
        name = fields[2] if len(fields) > 2 else line
        gpus.append({"vendor": vendor, "name": name.strip(), "vram_gb": 0.0, "driver": None, "compute": None})
    # Try sysfs for AMD/Intel VRAM size
    try:
        for card in sorted(Path("/sys/class/drm").glob("card[0-9]*/device/mem_info_vram_total")):
            b = int(card.read_text().strip())
            for g in gpus:
                if g["vendor"] in ("amd", "intel") and not g["vram_gb"]:
                    g["vram_gb"] = _r1(b / GiB)
                    break
    except Exception:
        pass
    return gpus


def _mac_gpus(ram_gb: float, arch: str) -> list[dict]:
    out = _run(["system_profiler", "SPDisplaysDataType", "-json"], timeout=TIMEOUT + 3)
    gpus = []
    try:
        items = json.loads(out).get("SPDisplaysDataType", []) if out.strip() else []
    except Exception:
        items = []
    for it in items:
        name = it.get("sppci_model") or it.get("_name") or "GPU"
        vendor_raw = (it.get("spdisplays_vendor") or "").lower()
        vendor = "apple" if ("apple" in vendor_raw or name.lower().startswith("apple")) else \
            "amd" if ("amd" in vendor_raw or "ati" in vendor_raw) else \
            "intel" if "intel" in vendor_raw else "nvidia" if "nvidia" in vendor_raw else "other"
        metal = it.get("spdisplays_mtlgpufamilysupport") or ""
        cores = it.get("sppci_cores")
        compute = "metal" + (" " + metal.replace("spdisplays_metal", "") if metal else "")
        if cores:
            compute += f" ({cores}-core)"
        if vendor == "apple":
            vram = ram_gb  # unified; usable share computed separately
        else:
            v = it.get("spdisplays_vram") or it.get("spdisplays_vram_shared") or ""
            m = re.search(r"(\d+)\s*(GB|MB)", str(v))
            vram = (int(m.group(1)) / (1024 if m and m.group(2) == "MB" else 1)) if m else 0.0
        gpus.append({"vendor": vendor, "name": name, "vram_gb": _r1(vram), "driver": None, "compute": compute.strip()})
    if not gpus and arch == "arm64":
        chip = _run(["sysctl", "-n", "machdep.cpu.brand_string"]).strip() or "Apple Silicon"
        gpus.append({"vendor": "apple", "name": chip, "vram_gb": _r1(ram_gb), "driver": None, "compute": "metal"})
    return gpus


def _win_gpus() -> list[dict]:
    """Win32_VideoController + registry qwMemorySize (AdapterRAM is a uint32 that caps at 4 GB)."""
    ps = (
        "$r=@();"
        "Get-CimInstance Win32_VideoController | ForEach-Object {"
        " $r += [pscustomobject]@{Name=$_.Name; AdapterRAM=$_.AdapterRAM; Driver=$_.DriverVersion; PNP=$_.PNPDeviceID} };"
        "$q=@(); Get-ChildItem 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue |"
        " ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue;"
        "  if ($p.'HardwareInformation.qwMemorySize') { $q += [pscustomobject]@{Desc=$p.DriverDesc; Mem=[uint64]$p.'HardwareInformation.qwMemorySize'} } };"
        "[pscustomobject]@{vc=$r; reg=$q} | ConvertTo-Json -Depth 4 -Compress"
    )
    out = _powershell(ps)
    gpus = []
    try:
        d = json.loads(out) if out.strip() else {}
    except Exception:
        d = {}
    vcs = d.get("vc") or []
    regs = d.get("reg") or []
    if isinstance(vcs, dict):
        vcs = [vcs]
    if isinstance(regs, dict):
        regs = [regs]
    for vc in vcs:
        name = (vc.get("Name") or "").strip()
        low = name.lower()
        if not name or "basic display" in low or "remote" in low or "virtual" in low or "parsec" in low:
            continue
        vendor = "nvidia" if "nvidia" in low else "amd" if ("amd" in low or "radeon" in low) else \
            "intel" if "intel" in low else "other"
        mem = 0
        for rg in regs:
            if (rg.get("Desc") or "").strip().lower() == low:
                mem = max(mem, int(rg.get("Mem") or 0))
        if not mem:
            try:
                mem = int(vc.get("AdapterRAM") or 0)
            except Exception:
                mem = 0
        gpus.append({"vendor": vendor, "name": name, "vram_gb": _r1(mem / GiB), "driver": vc.get("Driver"),
                     "compute": None})
    return gpus


def _merge(primary: list[dict], extra: list[dict]) -> list[dict]:
    """Keep primary (vendor tools); add non-duplicate entries from extra (generic probes)."""
    vendors = {g["vendor"] for g in primary}
    return primary + [g for g in extra if g["vendor"] not in vendors]


def _is_integrated(g: dict) -> bool:
    n = g.get("name", "").lower()
    if g.get("vendor") == "intel" and "arc" not in n:
        return True
    if g.get("vendor") == "amd" and re.search(r"radeon\(tm\) graphics|radeon graphics$|vega \d+ graphics|\b(610m|660m|680m|760m|780m|880m|890m)\b", n):
        return True
    return False


# ---------------------------------------------------------------- disk / runtimes
def pico_home() -> Path:
    return Path(os.environ.get("PICO_HOME") or (Path.home() / ".pico"))


def _disk_free_gb() -> float:
    try:
        p = pico_home()
        while not p.exists() and p != p.parent:
            p = p.parent
        return _r1(shutil.disk_usage(str(p)).free / GiB)
    except Exception:
        return 0.0


def _ver(out: str) -> Optional[str]:
    out = (out or "").strip()
    if not out:
        return None
    m = re.search(r"version:?\s*([0-9][\w.\-+]*)(?:\s*\(([0-9a-f]{6,})\))?", out, re.I)
    if m:
        return m.group(1)
    m = re.search(r"\b(b?\d+\.\d+(?:\.\d+)?[\w.\-+]*)\b", out)
    return m.group(1) if m else out.splitlines()[0][:40]


def _runtimes() -> dict:
    rt: dict[str, Optional[str]] = {"llama_cpp": None, "ollama": None, "lmstudio": None, "vllm": None}
    try:
        cands = [shutil.which("llama-server")]
        own = pico_home() / "bin"
        for nm in ("llama-server", "llama-server.exe"):
            cands += [str(p) for p in own.rglob(nm)] if own.exists() else []
        for c in cands:
            if c:
                try:
                    r = subprocess.run([c, "--version"], capture_output=True, text=True, timeout=TIMEOUT,
                                       errors="replace", cwd=str(Path(c).parent))
                    txt = (r.stdout or "") + (r.stderr or "")
                    m = re.search(r"version:\s*(\d+)\s*\(([0-9a-f]+)\)", txt)
                    rt["llama_cpp"] = ("b" + m.group(1)) if m else (_ver(txt) or "installed")
                    break
                except Exception:
                    rt["llama_cpp"] = "installed"
    except Exception:
        pass
    try:
        if shutil.which("ollama"):
            rt["ollama"] = _ver(_run(["ollama", "--version"])) or "installed"
    except Exception:
        pass
    try:
        lms = shutil.which("lms") or next((str(p) for p in [Path.home() / ".lmstudio" / "bin" / "lms",
                                                             Path.home() / ".cache" / "lm-studio" / "bin" / "lms"]
                                           if p.exists()), None)
        if lms:
            rt["lmstudio"] = _ver(_run([lms, "version"])) or "installed"
        elif Path("/Applications/LM Studio.app").exists():
            rt["lmstudio"] = "installed"
    except Exception:
        pass
    try:
        if shutil.which("vllm"):
            rt["vllm"] = _ver(_run(["vllm", "--version"], timeout=TIMEOUT + 5)) or "installed"
    except Exception:
        pass
    return rt


# ---------------------------------------------------------------- derived helpers
def bandwidth_gbps(name: str, default: float = 0.0) -> float:
    n = (name or "").lower()
    for key, bw in _BANDWIDTH:
        if key in n:
            return float(bw)
    return default


def usable_vram_gb(system: dict) -> float:
    """Memory a model can occupy on the accelerator (GB).

    Apple Silicon: macOS caps GPU wired memory at ~2/3 of RAM up to 36 GB and ~3/4 above; we use
    0.70 (<=36 GB) / 0.75 (>36 GB) minus nothing else. GB10/unified Linux: RAM - 8 GB OS reserve.
    Discrete GPUs: sum of VRAM minus ~0.6 GB (driver/CUDA context) per card, minus what is already
    in use beyond that when nvidia-smi told us (desktop compositor etc.).
    """
    try:
        ram = float(system.get("ram_gb") or 0)
        if system.get("unified_memory"):
            if any(g.get("vendor") == "apple" for g in system.get("gpus", [])) or system.get("os") == "macos":
                frac = 0.70 if ram <= 36 else 0.75
                return _r1(ram * frac)
            return _r1(max(0.0, ram - 8.0))  # DGX Spark / Strix Halo style
        total = 0.0
        for g in system.get("gpus", []):
            if _is_integrated(g) or g.get("vendor") == "other":
                continue
            v = float(g.get("vram_gb") or 0)
            if v <= 0:
                continue
            used = g.get("_used_gb")
            reserve = max(0.6, float(used) if used is not None else 0.6)
            total += max(0.0, v - min(reserve, v * 0.25))
        return _r1(total)
    except Exception:
        return 0.0


def mem_bandwidth(system: dict) -> float:
    """Best-guess bandwidth (GB/s) of the memory the model mostly lives in."""
    gpus = [g for g in system.get("gpus", []) if not _is_integrated(g)]
    if gpus:
        bws = [bandwidth_gbps(g.get("name", "")) for g in gpus]
        bws = [b for b in bws if b]
        if bws:
            return min(bws) if len(bws) > 1 else bws[0]
    cpu = (system.get("cpu") or {}).get("name", "")
    b = bandwidth_gbps(cpu)
    if b:
        return b
    return system_ram_bandwidth(system)


def system_ram_bandwidth(system: dict) -> float:
    """System RAM bandwidth for CPU / expert-offload paths (GB/s), rough by platform."""
    if system.get("unified_memory"):
        return mem_bandwidth({"gpus": system.get("gpus", []), "cpu": system.get("cpu", {})}) or 100.0
    return 60.0 if float(system.get("ram_gb") or 0) >= 32 else 45.0  # dual-channel DDR5 / DDR4-ish


def tier(system: dict) -> str:
    """Human tier label used by recipes, e.g. 'mac-18', 'gpu-12', 'spark-128', 'cpu-16', 'multi-gpu-48'."""
    try:
        ram = float(system.get("ram_gb") or 0)
        gpus = [g for g in system.get("gpus", []) if not _is_integrated(g) and g.get("vendor") != "other"]
        names = " ".join(g.get("name", "").lower() for g in gpus)
        if "gb10" in names or "dgx spark" in names:
            return "spark-128" if ram >= 100 else f"spark-{int(round(ram))}"
        if system.get("unified_memory") and system.get("os") == "macos":
            return f"mac-{int(round(ram))}"
        if system.get("unified_memory"):
            return f"unified-{int(round(ram))}"
        vram = sum(float(g.get("vram_gb") or 0) for g in gpus)
        if not gpus or vram < 3.5:
            return f"cpu-{int(round(ram))}"
        prefix = "multi-gpu" if len([g for g in gpus if (g.get("vram_gb") or 0) >= 4]) > 1 else "gpu"
        return f"{prefix}-{int(round(vram))}"
    except Exception:
        return "unknown"


# ---------------------------------------------------------------- main
def scan() -> dict:
    osn = _norm_os()
    arch = _norm_arch(platform.machine())
    if osn == "macos" and arch == "x64" and _run(["sysctl", "-n", "hw.optional.arm64"]).strip() == "1":
        arch = "arm64"  # Rosetta python on Apple Silicon
    sysd: dict[str, Any] = {
        "os": osn, "arch": arch, "cpu": {"name": "", "cores": os.cpu_count() or 1}, "ram_gb": 0.0,
        "gpus": [], "unified_memory": False, "disk_free_gb": 0.0, "accelerators": ["cpu"],
        "runtimes": {"llama_cpp": None, "ollama": None, "lmstudio": None, "vllm": None},
    }
    try:
        sysd["cpu"] = _cpu(osn)
    except Exception:
        pass
    try:
        sysd["ram_gb"] = _ram_gb(osn)
    except Exception:
        pass
    gpus: list[dict] = []
    try:
        if osn == "macos":
            gpus = _mac_gpus(sysd["ram_gb"], arch)
        elif osn == "linux":
            gpus = _merge(_merge(_nvidia_smi(), _rocm_smi()), _lspci_gpus())
        elif osn == "windows":
            nv = _nvidia_smi()
            gpus = _merge(nv, _win_gpus())
    except Exception:
        pass
    unified = False
    if osn == "macos" and arch == "arm64":
        unified = True
    if any(g.pop("_unified", False) for g in gpus):
        unified = True
        for g in gpus:
            if g["vendor"] == "nvidia" and not g.get("vram_gb"):
                g["vram_gb"] = sysd["ram_gb"]
    if osn == "linux" and not unified:
        cpu_l = sysd["cpu"]["name"].lower()
        if re.search(r"ryzen ai max|strix halo", cpu_l) and any(g["vendor"] == "amd" for g in gpus):
            unified = True
    sysd["unified_memory"] = unified
    acc: list[str] = []
    vendors = {g["vendor"] for g in gpus}
    if "apple" in vendors:
        acc.append("metal")
    if "nvidia" in vendors and any((g.get("compute") or "").startswith("cuda") for g in gpus):
        acc.append("cuda")
    if "amd" in vendors and (osn == "linux" and (shutil.which("rocm-smi") or Path("/opt/rocm").exists())):
        acc.append("rocm")
    if osn in ("linux", "windows") and any(v in vendors for v in ("amd", "intel", "nvidia")):
        acc.append("vulkan")
    acc.append("cpu")
    sysd["accelerators"] = acc
    sysd["disk_free_gb"] = _disk_free_gb()
    try:
        sysd["runtimes"] = _runtimes()
    except Exception:
        pass
    sysd["gpus"] = gpus
    sysd["usable_vram_gb"] = usable_vram_gb(sysd)
    sysd["mem_bandwidth_gbps"] = mem_bandwidth(sysd)
    sysd["tier"] = tier(sysd)
    for g in gpus:  # internal fields out of the public shape
        g.pop("_used_gb", None)
    return sysd


if __name__ == "__main__":
    print(json.dumps(scan(), indent=2))
