"""Model recipes: catalog loading, fit math, persona-weighted recommendation, update offers.

Stdlib only. Public API:
    load_catalog()                    -> catalog dict (bundled recipes/catalog.json or newer ~/.pico/catalog.json)
    fetch_catalog(url)                -> catalog dict or None (writes ~/.pico/catalog.json; never required)
    recommend(system, persona)        -> {recommended, alternatives, companions, catalog_version}
    get(recipe_id)                    -> raw catalog recipe or None
    updates(system, current_recipe_id, persona="general", current=None) -> [ {kind, from, to, delta, why} ]
    estimate(recipe, system, ctx=None)-> fit/speed dict (used by recommend and by recipes/build_catalog.py)

Nothing here downloads models or changes config; updates are offers only.
"""
from __future__ import annotations

import copy
import json
import math
import os
import re
import tempfile
import urllib.request
from pathlib import Path
from typing import Any, Optional

PERSONAS = ("engineer", "business", "creative", "marketing", "student", "general")

# Persona weights over normalized axes (0..1). "ctx" rewards long context, "vision" image input.
WEIGHTS: dict[str, dict[str, float]] = {
    "engineer":  {"coding": 0.62, "reasoning": 0.10, "speed": 0.18, "ctx": 0.10},
    "business":  {"speed": 0.40, "writing": 0.32, "reasoning": 0.13, "vision": 0.05, "ctx": 0.10},
    "creative":  {"writing": 0.62, "speed": 0.20, "vision": 0.10, "reasoning": 0.08},
    "marketing": {"writing": 0.58, "speed": 0.24, "vision": 0.10, "reasoning": 0.08},
    "student":   {"reasoning": 0.30, "speed": 0.28, "writing": 0.17, "coding": 0.15, "vision": 0.10},
    "general":   {"reasoning": 0.28, "speed": 0.30, "writing": 0.20, "coding": 0.14, "vision": 0.08},
}
# Context each persona wants before we start shrinking it (tokens) and the floor we accept.
CTX_WANT = {"engineer": 65536, "business": 32768, "creative": 32768, "marketing": 32768,
            "student": 32768, "general": 32768}
CTX_FLOOR = {"engineer": 32768}  # agent system prompt + tools + repo context needs >= 32K
# Speed each persona wants; below it a pick is penalized (agents burn many tokens per answer).
SPEED_FLOOR = {"engineer": 20.0, "business": 25.0, "creative": 15.0, "marketing": 15.0,
               "student": 15.0, "general": 15.0}
MIN_TPS = 6.0           # below this a pick is unusable for chat
GOOD_TPS = 60.0         # speed axis saturates (log scale) here
OS_RAM_RESERVE_GB = 6.0  # RAM kept for OS + apps when experts live in system RAM
# Decode-speed model: tok/s ≈ efficiency × bandwidth ÷ active bytes per token (+ fixed per-token cost).
# Efficiencies calibrated against measured llama.cpp tg numbers cited in the catalog (e.g. Qwen3.8-27B
# Q4_K_M 40.4 tok/s on a 3090, Qwen3.5-9B Q5_K_M 15.6 tok/s on an M3 Pro).
GPU_EFF = 0.78
UNIFIED_EFF = 0.70
RAM_EFF = 0.60
CPU_EFF = 0.55
TOKEN_OVERHEAD_S = 0.0025  # kernel launch/sync floor; caps tiny-model estimates at a few hundred tok/s

GiB = 1024 ** 3


# ====================================================================== loading
def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def pico_home() -> Path:
    return Path(os.environ.get("PICO_HOME") or (Path.home() / ".pico"))


def bundled_catalog_path() -> Path:
    env = os.environ.get("PICO_CATALOG")
    if env:
        return Path(env)
    for p in (_repo_root() / "recipes" / "catalog.json", Path(__file__).with_name("catalog.json")):
        if p.exists():
            return p
    return _repo_root() / "recipes" / "catalog.json"


def user_catalog_path() -> Path:
    return pico_home() / "catalog.json"


def _vkey(v: str) -> tuple:
    return tuple(int(x) if x.isdigit() else x for x in re.split(r"[.\-]", str(v or "0")))


def _valid(cat: Any) -> bool:
    return (isinstance(cat, dict) and isinstance(cat.get("version"), str)
            and isinstance(cat.get("recipes"), list) and all(isinstance(r, dict) and r.get("id") for r in cat["recipes"]))


_CACHE: dict[str, Any] = {}


def load_catalog(refresh: bool = False) -> dict:
    """Bundled catalog, replaced by ~/.pico/catalog.json when that one is valid and newer."""
    if _CACHE.get("cat") is not None and not refresh:
        return _CACHE["cat"]
    best: Optional[dict] = None
    for p in (bundled_catalog_path(), user_catalog_path()):
        try:
            cat = json.loads(p.read_text())
        except Exception:
            continue
        if _valid(cat) and (best is None or _vkey(cat["version"]) > _vkey(best["version"])):
            cat["_path"] = str(p)
            best = cat
    if best is None:
        best = {"version": "0", "schema": 1, "recipes": [], "companions": [], "_path": None}
    _CACHE["cat"] = best
    return best


def fetch_catalog(url: str, timeout: float = 10.0, dest: Optional[Path] = None) -> Optional[dict]:
    """Download a catalog; keep it only if valid and newer than what we have. Never raises."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "pico-engine"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            cat = json.loads(r.read().decode("utf-8"))
        if not _valid(cat):
            return None
        cur = load_catalog()
        if _vkey(cat["version"]) <= _vkey(cur.get("version", "0")):
            return cur
        dest = dest or user_catalog_path()
        dest.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(dest.parent), prefix=".catalog.", suffix=".json")
        with os.fdopen(fd, "w") as f:
            json.dump(cat, f, indent=1)
        os.replace(tmp, dest)
        return load_catalog(refresh=True)
    except Exception:
        return None


def get(recipe_id: str) -> Optional[dict]:
    for r in load_catalog().get("recipes", []):
        if r.get("id") == recipe_id:
            return copy.deepcopy(r)
    return None


# ====================================================================== system helpers
def _gpus(system: dict) -> list[dict]:
    try:
        from . import hwscan
        integ = hwscan._is_integrated
    except Exception:  # pragma: no cover
        integ = lambda g: False  # noqa: E731
    return [g for g in system.get("gpus", []) if not integ(g) and g.get("vendor") != "other"
            and float(g.get("vram_gb") or 0) >= 3.5]


def _usable(system: dict) -> float:
    if system.get("usable_vram_gb") is not None:
        return float(system["usable_vram_gb"])
    try:
        from . import hwscan
        return hwscan.usable_vram_gb(system)
    except Exception:
        return 0.0


def _bw(system: dict) -> float:
    if system.get("mem_bandwidth_gbps"):
        return float(system["mem_bandwidth_gbps"])
    try:
        from . import hwscan
        return hwscan.mem_bandwidth(system) or 0.0
    except Exception:
        return 0.0


def _ram_bw(system: dict) -> float:
    if system.get("ram_bandwidth_gbps"):
        return float(system["ram_bandwidth_gbps"])
    try:
        from . import hwscan
        return hwscan.system_ram_bandwidth(system)
    except Exception:
        return 45.0


def _gpu_names(system: dict) -> str:
    return " | ".join(str(g.get("name", "")) for g in system.get("gpus", [])).lower()


def _mode(system: dict) -> str:
    if system.get("unified_memory"):
        return "unified"
    return "gpu" if _gpus(system) else "cpu"


# ====================================================================== fit + speed
def kv_gb(recipe: dict, ctx: int) -> float:
    """KV-cache (+ fixed recurrent/SWA state) in GB for ctx tokens, honoring q8_0 cache flags."""
    flags = " ".join(map(str, recipe.get("flags", [])))
    q8 = "q8_0" in flags
    per_tok = float(recipe.get("kv_kib_per_token") or 64) * 1024 * (0.53 if q8 else 1.0)
    return per_tok * ctx / 1e9 + float(recipe.get("kv_fixed_gb") or 0.0)


def _overhead_gb(weights: float) -> float:
    return 0.8 + 0.02 * weights


def _draft_gb(recipe: dict) -> float:
    spec = recipe.get("spec") or {}
    return float(spec.get("draft_gb") or 0.0)


def need_gb(recipe: dict, ctx: int) -> float:
    w = float(recipe["file_gb"])
    return w + _draft_gb(recipe) + kv_gb(recipe, ctx) + _overhead_gb(w)


def _speed_unified_or_gpu(active_gb: float, bw: float, eff: float = GPU_EFF) -> float:
    return 1.0 / (max(active_gb, 0.05) / (bw * eff) + TOKEN_OVERHEAD_S)


def _qkey(q: Any) -> str:
    """'MXFP4 (native)' -> 'mxfp4'; 'UD-Q4_K_XL' -> 'ud-q4_k_xl'."""
    return re.split(r"[\s(]", str(q or "").strip().lower(), maxsplit=1)[0]


def _measured_anchor(recipe: dict, system: dict, spec_on: bool = False) -> Optional[dict]:
    """A measured speed for this GPU/chip (exact quant -> 'measured'; other quant -> scaled 'est')."""
    names = _gpu_names(system) + " | " + str((system.get("cpu") or {}).get("name", "")).lower()
    best = None
    for s in recipe.get("speeds", []):
        if s.get("source") != "measured" or bool(s.get("spec")) != spec_on:
            continue
        key = str(s.get("match") or s.get("hw", "")).lower()
        if not key or key not in names:
            continue
        same_quant = not s.get("quant") or _qkey(s["quant"]) == _qkey(recipe.get("quant"))
        cand = dict(s, _exact=same_quant)
        if best is None or (cand["_exact"] and not best["_exact"]):
            best = cand
    return best


def estimate(recipe: dict, system: dict, ctx: Optional[int] = None, ctx_floor: int = 8192) -> dict:
    """Decide if/how a recipe runs on `system` and how fast.

    Returns {fits, mode: gpu|unified|offload|cpu, ctx, need_gb, usable_gb, n_cpu_moe, est_tps,
             tps_source, tps_note, reason}.
    Fit rule: weights + draft + KV(ctx) + overhead <= usable accelerator memory. MoE models that
    don't fit may park routed experts in system RAM (--n-cpu-moe), at a speed cost. Dense models
    are never partially offloaded (decode collapses), except on CPU-only machines.
    """
    out: dict[str, Any] = {"fits": False, "mode": None, "ctx": 0, "need_gb": None, "usable_gb": None,
                           "n_cpu_moe": 0, "est_tps": 0.0, "tps_source": "est", "tps_note": "", "reason": ""}
    if recipe.get("status", "available") != "available":
        out["reason"] = recipe.get("status_note") or "not runnable in llama.cpp yet"
        return out
    w = float(recipe["file_gb"])
    params = float(recipe.get("params_b") or 1)
    active = float(recipe.get("active_b") or params)
    moe = bool(recipe.get("moe")) or active < params * 0.7
    # bytes read per token; recipes may override when params include sparse lookup tables (n-gram/Engram)
    active_gb = float(recipe.get("active_gb") or (w * active / params))
    mode = _mode(system)
    ram = float(system.get("ram_gb") or 0)
    want = int(ctx or recipe.get("ctx") or 32768)
    want = min(want, int(recipe.get("ctx_max") or want))
    floor = max(int(recipe.get("ctx_min") or 0), int(ctx_floor))
    floor = min(floor, want)
    ladder = [c for c in (want, 131072, 98304, 65536, 49152, 32768, 24576, 16384, 12288, 8192, 4096)
              if c <= want and c >= floor]
    ladder = sorted(set(ladder), reverse=True) or [want]

    if mode == "cpu":
        usable = max(0.0, ram - OS_RAM_RESERVE_GB)
        bw = _ram_bw(system)
        out["usable_gb"] = round(usable, 1)
        for c in ladder:
            n = need_gb(recipe, c) - _overhead_gb(w) + 0.5
            if n <= usable:
                tps = _speed_unified_or_gpu(active_gb, bw, eff=CPU_EFF)
                out.update(fits=True, mode="cpu", ctx=c, need_gb=round(n, 1))
                return _finish(out, recipe, system, tps)
        out["need_gb"] = round(need_gb(recipe, ladder[-1]), 1)
        out["reason"] = f"needs ~{out['need_gb']} GB RAM, have ~{usable:.0f} GB free for models"
        return out

    usable = _usable(system)
    bw = _bw(system) or 100.0
    out["usable_gb"] = round(usable, 1)
    for c in ladder:  # 1) fully resident
        n = need_gb(recipe, c)
        if n <= usable:
            out.update(fits=True, mode="unified" if mode == "unified" else "gpu", ctx=c, need_gb=round(n, 1))
            return _finish(out, recipe, system, _speed_unified_or_gpu(active_gb, bw, GPU_EFF if mode == "gpu" else UNIFIED_EFF))
    # 2) MoE expert offload to system RAM (discrete GPU only; unified memory has nowhere else to go)
    if mode == "gpu" and moe:
        dense_frac = float(recipe.get("dense_frac") or 0.1)
        layers = int(recipe.get("n_layers") or 48)
        experts_gb = w * (1 - dense_frac)
        ram_free = ram * 0.85 - OS_RAM_RESERVE_GB  # leave the OS, browser and IDE real headroom
        for c in ladder:
            fixed = w * dense_frac + _draft_gb(recipe) + kv_gb(recipe, c) + _overhead_gb(w) + 0.3
            room = usable - fixed
            if room < 0:
                continue
            on_cpu = max(0.0, experts_gb - room)
            if on_cpu > ram_free:
                continue
            frac = on_cpu / experts_gb if experts_gb else 0.0
            n_cpu = min(layers, max(1, math.ceil(layers * frac)))
            frac = n_cpu / layers
            # bytes read per token: attention/shared part always on GPU, routed experts split GPU/RAM
            act_dense = active_gb * float(recipe.get("active_dense_frac") or 0.35)
            act_exp = active_gb - act_dense
            t = ((act_dense + act_exp * (1 - frac)) / (bw * GPU_EFF)
                 + (act_exp * frac) / (_ram_bw(system) * RAM_EFF) + TOKEN_OVERHEAD_S)
            out.update(fits=True, mode="offload", ctx=c,
                       n_cpu_moe=n_cpu if recipe.get("n_layers") else 0,
                       need_gb=round(usable, 1), ram_gb_used=round(on_cpu, 1))
            return _finish(out, recipe, system, 1.0 / t)
        out["reason"] = "doesn't fit in GPU memory + system RAM"
    else:
        out["reason"] = (f"needs ~{need_gb(recipe, ladder[-1]):.1f} GB, have ~{usable:.1f} GB usable"
                         + (" (dense model; not offloaded)" if mode == "gpu" else ""))
    out["need_gb"] = round(need_gb(recipe, ladder[-1]), 1)
    return out


def _finish(out: dict, recipe: dict, system: dict, tps: float) -> dict:
    note = "bandwidth estimate"
    spec = recipe.get("spec") or {}
    spec_on = bool(spec.get("enabled"))  # runtime sets this once it wires the draft model
    if spec.get("gain") and spec_on:
        tps *= float(spec["gain"])
        note += f" incl. x{spec['gain']} speculative decoding"
    anchor = _measured_anchor(recipe, system, spec_on) if out["mode"] in ("gpu", "unified", "cpu") else None
    if anchor:
        if anchor["_exact"]:
            tps, out["tps_source"] = float(anchor["tps"]), "measured"
            note = f"measured: {anchor.get('hw')} ({anchor.get('note') or anchor.get('url') or ''})".strip()
        else:
            # same model + hardware, different quant: scale by file size, stays an estimate
            ratio = float(anchor.get("file_gb") or recipe["file_gb"]) / float(recipe["file_gb"])
            tps = float(anchor["tps"]) * ratio
            note = f"scaled from measured {anchor.get('quant')} on {anchor.get('hw')}"
    out["est_tps"] = round(tps, 1)
    out["tps_note"] = note
    if out["mode"] == "offload":
        out["tps_note"] = note + f"; {out['n_cpu_moe']} layers of experts in system RAM"
    return out


# ====================================================================== scoring
def _features(recipe: dict) -> dict:
    sc = recipe.get("scores") or {}
    return {k: float(sc.get(k, 0)) / 100.0 for k in ("coding", "writing", "reasoning")} | {
        "vision": 1.0 if "vision" in recipe.get("strengths", []) else 0.0}


def score(recipe: dict, est: dict, persona: str) -> float:
    wts = WEIGHTS.get(persona, WEIGHTS["general"])
    f = _features(recipe)
    tps = float(est.get("est_tps") or 0)
    f["speed"] = max(0.0, min(1.0, math.log(max(tps, 1)) / math.log(GOOD_TPS)))
    f["ctx"] = max(0.0, min(1.0, math.log2(max(est.get("ctx") or 4096, 4096) / 4096) / 5))  # 128K -> 1
    s = sum(wts.get(k, 0) * v for k, v in f.items())
    floor = SPEED_FLOOR.get(persona, 15.0)
    if tps < MIN_TPS:
        s *= 0.35
    elif tps < floor:
        s *= 0.6 + 0.4 * (tps / floor)
    return round(s, 4)


def _public(recipe: dict, est: dict, persona: str, why: str) -> dict:
    """API.md Recipe shape (+ a few extra keys clients may ignore)."""
    flags = [str(x) for x in recipe.get("flags", [])]
    if est.get("mode") == "offload" and est.get("n_cpu_moe"):
        flags += ["--n-cpu-moe", str(est["n_cpu_moe"])]
    if est.get("mode") == "cpu":
        flags = [x for i, x in enumerate(flags) if x not in ("-ngl",) and not (i and flags[i - 1] == "-ngl")]
        flags = ["-ngl", "0"] + flags
    m = recipe.get("model", {})
    return {
        "id": recipe["id"], "name": recipe.get("name", recipe["id"]),
        "model": {k: m[k] for k in ("repo", "file", "sha256", "mmproj") if k in m},
        "family": recipe.get("family"), "params_b": recipe.get("params_b"), "active_b": recipe.get("active_b"),
        "quant": recipe.get("quant"), "file_gb": recipe.get("file_gb"), "ctx": est.get("ctx") or recipe.get("ctx"),
        "runtime": recipe.get("runtime", "llama.cpp"), "flags": flags,
        "est_tps": est.get("est_tps"), "tps_source": est.get("tps_source", "est"),
        "strengths": recipe.get("strengths", []), "fits": bool(est.get("fits")), "why": why,
        "license": recipe.get("license"), "spec": recipe.get("spec"),
        "fit": {k: est.get(k) for k in ("mode", "need_gb", "usable_gb", "n_cpu_moe", "tps_note")},
        "benchmarks": recipe.get("benchmarks"),
    }


def _bench_blurb(recipe: dict, persona: str) -> str:
    b = recipe.get("benchmarks") or {}
    if persona == "engineer":
        for k in ("Terminal-Bench 2.1", "SWE-bench Verified", "SWE-bench Pro", "LiveCodeBench v6"):
            if k in b:
                return f"{k} {b[k]} (self-reported)"
    for k in ("GPQA Diamond", "MMLU-Pro"):
        if k in b:
            return f"{k} {b[k]} (self-reported)"
    return ""


def _why(recipe: dict, est: dict, persona: str, rank_reason: str) -> str:
    bits = [rank_reason]
    bl = _bench_blurb(recipe, persona)
    if bl:
        bits.append(bl)
    src = "measured" if est.get("tps_source") == "measured" else "est"
    bits.append(f"~{est['est_tps']:.0f} tok/s {src}")
    bits.append(f"{(est.get('ctx') or 0) // 1024}K context")
    if est.get("mode") == "offload":
        bits.append("experts partly in system RAM")
    return "; ".join(bits)


_ROLE = {
    "engineer": "Smartest coding model that fits",
    "business": "Fast, clear writer that fits",
    "creative": "Best writer that fits",
    "marketing": "Best writer that fits",
    "student": "Best all-rounder that fits",
    "general": "Best all-rounder that fits",
}


def _candidates(system: dict, persona: str) -> list[tuple[float, dict, dict]]:
    cat = load_catalog()
    want = CTX_WANT.get(persona, 32768)
    floor = CTX_FLOOR.get(persona, 8192)
    out = []
    for r in cat.get("recipes", []):
        if r.get("kind", "llm") != "llm":
            continue
        e = estimate(r, system, ctx=min(want, int(r.get("ctx") or want)), ctx_floor=floor)
        if not e["fits"]:
            continue
        out.append((score(r, e, persona), r, e))
    out.sort(key=lambda t: (-t[0], -t[2]["est_tps"]))
    return out


def recommend(system: dict, persona: str = "general") -> dict:
    persona = persona if persona in WEIGHTS else "general"
    cands = _candidates(system, persona)
    cat = load_catalog()
    res: dict[str, Any] = {"recommended": None, "alternatives": [], "companions": companions(system, persona),
                           "catalog_version": cat.get("version"), "persona": persona}
    if not cands:
        return res
    top_s, top_r, top_e = cands[0]
    res["recommended"] = _public(top_r, top_e, persona, _why(top_r, top_e, persona, _ROLE[persona]))
    alts: list[dict] = []
    seen = {top_r["id"]}
    fams = {top_r.get("family")}
    # fastest usable pick, if it isn't the top one
    good = [c for c in cands if c[0] >= 0.8 * top_s] or cands
    fastest = max(good, key=lambda t: t[2]["est_tps"])
    if fastest[1]["id"] not in seen:
        alts.append(_public(fastest[1], fastest[2], persona, _why(fastest[1], fastest[2], persona, "Fastest option")))
        seen.add(fastest[1]["id"]); fams.add(fastest[1].get("family"))
    # smartest for this persona's main axis regardless of speed (still >= MIN_TPS)
    axis = "coding" if persona == "engineer" else "writing" if persona in ("creative", "marketing", "business") else "reasoning"
    smart = [c for c in cands if c[2]["est_tps"] >= MIN_TPS]
    if smart:
        sm = max(smart, key=lambda t: (t[1].get("scores", {}).get(axis, 0), t[2]["est_tps"]))
        if sm[1]["id"] not in seen:
            alts.append(_public(sm[1], sm[2], persona, _why(sm[1], sm[2], persona, f"Highest {axis} quality that runs")))
            seen.add(sm[1]["id"]); fams.add(sm[1].get("family"))
    for s, r, e in cands[1:]:
        if len(alts) >= 4:
            break
        if r["id"] in seen or r.get("family") in fams:
            continue
        alts.append(_public(r, e, persona, _why(r, e, persona, "Also a good fit")))
        seen.add(r["id"]); fams.add(r.get("family"))
    res["alternatives"] = alts
    return res


# ====================================================================== companions (voice / image / video)
def companions(system: dict, persona: str = "general") -> dict:
    """Pick STT / TTS / image / video companion models for this box. Image on by default for
    creative/marketing; video only where the GPU can realistically do it."""
    cat = load_catalog()
    mode = _mode(system)
    usable = _usable(system) if mode != "cpu" else max(0.0, float(system.get("ram_gb") or 0) - OS_RAM_RESERVE_GB)
    accel = set(system.get("accelerators") or [])
    picks: dict[str, Any] = {"stt": None, "tts": None, "image": None, "video": None}
    for kind in picks:
        best = None
        for c in cat.get("companions", []):
            if c.get("kind") != kind:
                continue
            req = c.get("requires") or {}
            if float(req.get("min_mem_gb", 0)) > usable:
                continue
            if req.get("accelerators") and not (set(req["accelerators"]) & accel):
                continue
            if req.get("gpu_only") and mode == "cpu":
                continue
            if best is None or float(c.get("rank", 0)) > float(best.get("rank", 0)):
                best = c
        if best:
            picks[kind] = {k: best.get(k) for k in ("id", "name", "model", "runtime", "size_gb", "license", "why",
                                                    "requires", "speed")}
    picks["enable"] = {
        "voice": True,
        "image": persona in ("creative", "marketing") and picks["image"] is not None,
        "video": persona in ("creative", "marketing") and picks["video"] is not None,
    }
    return picks


# ====================================================================== updates
def _quality(recipe: dict, persona: str) -> float:
    axis = "coding" if persona == "engineer" else "writing" if persona in ("creative", "marketing", "business") else "reasoning"
    return float((recipe.get("scores") or {}).get(axis, 0))


def updates(system: dict, current_recipe_id: Optional[str], persona: str = "general",
            current: Optional[dict] = None) -> list[dict]:
    """Better options that fit this machine. Offers only; never applied here.

    kind="model": a different recipe scores higher for this persona.
    kind="config": same model, but the catalog now allows more context or a faster setup
                   (compare against current={'ctx':..., 'flags':[...]} if given).
    """
    persona = persona if persona in WEIGHTS else "general"
    cur = get(current_recipe_id) if current_recipe_id else None
    out: list[dict] = []
    cands = _candidates(system, persona)
    if cur is None:
        if cands:
            s, r, e = cands[0]
            out.append({"kind": "model", "from": current_recipe_id, "to": r["id"],
                        "delta": {"tps": round(e["est_tps"]), "ctx": e["ctx"], "quality": "new pick"},
                        "why": _why(r, e, persona, _ROLE[persona])})
        return out
    cur_est = estimate(cur, system, ctx=min(CTX_WANT.get(persona, 32768), int(cur.get("ctx") or 32768)),
                       ctx_floor=CTX_FLOOR.get(persona, 8192))
    cur_score = score(cur, cur_est, persona) if cur_est["fits"] else 0.0
    cur_q = _quality(cur, persona)
    axis = "coding" if persona == "engineer" else "writing" if persona in ("creative", "marketing", "business") else "reasoning"

    # config update for the same model
    if current and cur_est["fits"]:
        dctx = int(cur_est["ctx"]) - int(current.get("ctx") or cur_est["ctx"])
        cur_flags = [str(x) for x in current.get("flags") or []]
        new_flags = _public(cur, cur_est, persona, "")["flags"]
        if dctx > 0 or (cur_flags and cur_flags != new_flags):
            out.append({"kind": "config", "from": cur["id"], "to": cur["id"],
                        "delta": {"tps": 0, "ctx": max(0, dctx), "quality": "same model"},
                        "why": "Updated recipe for your hardware" + (f": +{dctx // 1024}K context" if dctx > 0 else
                                                                     ": tuned runtime flags")})
    for s, r, e in cands:
        if r["id"] == cur["id"] or s <= cur_score + 0.02:
            continue
        dq = _quality(r, persona) - cur_q
        dtps = e["est_tps"] - (cur_est["est_tps"] if cur_est["fits"] else 0)
        dctx = e["ctx"] - (cur_est["ctx"] if cur_est["fits"] else 0)
        if dq <= 0 and dtps <= 0 and dctx <= 0:
            continue
        if dq < -8 or dtps < -0.5 * max(cur_est["est_tps"], 1):  # don't offer big regressions as upgrades
            continue
        if dq > 0:
            qtxt = f"+{dq:.0f} {axis} score"
            b_new, b_old = (r.get("benchmarks") or {}), (cur.get("benchmarks") or {})
            for k in ("Terminal-Bench 2.1", "SWE-bench Verified", "GPQA Diamond"):
                if k in b_new and k in b_old:
                    qtxt = f"{b_new[k] - b_old[k]:+.1f} {k}"
                    break
        else:
            qtxt = "similar" if dq == 0 else f"{dq:.0f} {axis} score"
        out.append({"kind": "model", "from": cur["id"], "to": r["id"],
                    "delta": {"tps": round(dtps), "ctx": int(dctx), "quality": qtxt},
                    "why": _why(r, e, persona, "Better fit for you")})
        if len([o for o in out if o["kind"] == "model"]) >= 3:
            break
    return out
