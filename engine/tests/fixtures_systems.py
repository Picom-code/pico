"""Fixture systems in the exact /api/system shape (as hwscan.scan() would return them)."""
from pico import hwscan


def _mk(os_, arch, cpu, ram, gpus, unified=False, accel=None):
    s = {"os": os_, "arch": arch, "cpu": {"name": cpu, "cores": 8}, "ram_gb": ram, "gpus": gpus,
         "unified_memory": unified, "disk_free_gb": 400.0,
         "accelerators": accel or ["cpu"],
         "runtimes": {"llama_cpp": None, "ollama": None, "lmstudio": None, "vllm": None}}
    s["usable_vram_gb"] = hwscan.usable_vram_gb(s)
    s["mem_bandwidth_gbps"] = hwscan.mem_bandwidth(s)
    s["tier"] = hwscan.tier(s)
    return s


def _nv(name, vram, cc="8.9"):
    return {"vendor": "nvidia", "name": name, "vram_gb": vram, "driver": "581.57", "compute": f"cuda {cc}"}


SYSTEMS = {
    "m3pro_18": _mk("macos", "arm64", "Apple M3 Pro", 18.0,
                    [{"vendor": "apple", "name": "Apple M3 Pro", "vram_gb": 18.0, "driver": None,
                      "compute": "metal 4 (14-core)"}], unified=True, accel=["metal", "cpu"]),
    "rtx4070s_12_64": _mk("windows", "x64", "AMD Ryzen 7 9800X3D 8-Core Processor", 63.6,
                          [_nv("NVIDIA GeForce RTX 4070 SUPER", 12.0)], accel=["cuda", "vulkan", "cpu"]),
    "rtx4090_24": _mk("linux", "x64", "AMD Ryzen 9 7950X", 64.0, [_nv("NVIDIA GeForce RTX 4090", 24.0)],
                      accel=["cuda", "vulkan", "cpu"]),
    "rtx3060_8": _mk("windows", "x64", "Intel Core i5-12400F", 32.0, [_nv("NVIDIA GeForce RTX 3060", 8.0, "8.6")],
                     accel=["cuda", "vulkan", "cpu"]),
    "cpu_16": _mk("linux", "x64", "Intel Core i7-1165G7", 16.0,
                  [{"vendor": "intel", "name": "Intel Iris Xe Graphics", "vram_gb": 0.0, "driver": None,
                    "compute": None}], accel=["vulkan", "cpu"]),
    "dgx_spark_128": _mk("linux", "arm64", "NVIDIA Grace (Cortex-X925)", 119.7,
                         [_nv("NVIDIA GB10", 119.7, "12.1")], unified=True, accel=["cuda", "cpu"]),
    "mac_studio_128": _mk("macos", "arm64", "Apple M4 Max", 128.0,
                          [{"vendor": "apple", "name": "Apple M4 Max", "vram_gb": 128.0, "driver": None,
                            "compute": "metal 4 (40-core)"}], unified=True, accel=["metal", "cpu"]),
}
