import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from pico import hwscan  # noqa: E402
from fixtures_systems import SYSTEMS  # noqa: E402

KEYS = {"os", "arch", "cpu", "ram_gb", "gpus", "unified_memory", "disk_free_gb", "accelerators", "runtimes"}


def _shape_ok(s):
    assert KEYS <= set(s)
    assert set(s["cpu"]) >= {"name", "cores"}
    assert set(s["runtimes"]) == {"llama_cpp", "ollama", "lmstudio", "vllm"}
    for g in s["gpus"]:
        assert set(g) == {"vendor", "name", "vram_gb", "driver", "compute"}, g
    assert s["accelerators"][-1] == "cpu"
    json.dumps(s)


def test_scan_real_machine_shape():
    s = hwscan.scan()
    _shape_ok(s)
    assert s["ram_gb"] > 0
    assert isinstance(s["tier"], str) and s["tier"]
    if sys.platform == "darwin" and s["arch"] == "arm64":
        assert s["unified_memory"] is True
        assert "metal" in s["accelerators"]
        assert 0.6 * s["ram_gb"] <= s["usable_vram_gb"] <= 0.76 * s["ram_gb"]


def test_scan_never_raises_when_all_probes_fail(monkeypatch):
    def boom(*a, **k):
        raise OSError("nope")
    monkeypatch.setattr(subprocess, "run", boom)
    monkeypatch.setattr(hwscan.shutil, "which", lambda *_: None)
    s = hwscan.scan()
    _shape_ok(s)


def test_nvidia_smi_parse(monkeypatch):
    out = "NVIDIA GeForce RTX 4070 SUPER, 12282, 1130, 581.57, 8.9\n"
    monkeypatch.setattr(hwscan, "_run", lambda cmd, timeout=5: out if cmd[0].endswith("nvidia-smi") else "")
    g = hwscan._nvidia_smi()
    assert g[0]["vram_gb"] == 12.0 and g[0]["compute"] == "cuda 8.9" and g[0]["driver"] == "581.57"
    sysd = {"os": "windows", "ram_gb": 64, "unified_memory": False, "gpus": g}
    # Windows desktop already holds ~1.1 GB on that card: usable drops accordingly
    assert 10.5 <= hwscan.usable_vram_gb(sysd) <= 11.0


def test_gb10_detected_as_unified(monkeypatch):
    out = "NVIDIA GB10, [N/A], [N/A], 580.95.05, 12.1\n"
    monkeypatch.setattr(hwscan, "_run", lambda cmd, timeout=5: out if cmd[0].endswith("nvidia-smi") else "")
    g = hwscan._nvidia_smi()
    assert g[0].get("_unified") is True


def test_tiers_and_usable():
    t = {k: v["tier"] for k, v in SYSTEMS.items()}
    assert t["m3pro_18"] == "mac-18"
    assert t["rtx4070s_12_64"] == "gpu-12"
    assert t["rtx4090_24"] == "gpu-24"
    assert t["rtx3060_8"] == "gpu-8"
    assert t["cpu_16"] == "cpu-16"  # Iris Xe is integrated -> CPU tier
    assert t["dgx_spark_128"] == "spark-128"
    assert t["mac_studio_128"] == "mac-128"
    assert SYSTEMS["m3pro_18"]["usable_vram_gb"] == 12.6       # 0.70 x 18
    assert SYSTEMS["mac_studio_128"]["usable_vram_gb"] == 96.0  # 0.75 x 128
    assert SYSTEMS["dgx_spark_128"]["usable_vram_gb"] > 100
    assert SYSTEMS["cpu_16"]["usable_vram_gb"] == 0.0


def test_bandwidth_table():
    assert hwscan.bandwidth_gbps("NVIDIA GeForce RTX 4070 SUPER") == 504
    assert hwscan.bandwidth_gbps("NVIDIA GeForce RTX 4070 Ti SUPER") == 672
    assert hwscan.bandwidth_gbps("Apple M3 Pro") == 150
    assert hwscan.bandwidth_gbps("NVIDIA GB10") == 273
