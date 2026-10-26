"""Usage accounting: one row per finished model turn (store.usage), aggregated for GET /api/usage and /usage."""
from __future__ import annotations

import datetime as dt
import time
from typing import Optional

from .store import _median


def _date(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def _zero() -> dict:
    return {"turns": 0, "input": 0, "output": 0, "cached": 0, "seconds": 0.0, "tools": 0}


def _add(acc: dict, r: dict) -> None:
    acc["turns"] += 1
    for k in ("input", "output", "cached", "tools"):
        acc[k] += int(r.get(k) or 0)
    acc["seconds"] = round(acc["seconds"] + float(r.get("seconds") or 0), 2)


def _cache_pct(input_tokens: int, cached: int) -> Optional[float]:
    """Share of prompt tokens served from cache. `input` excludes cache reads (Hermes' canonical buckets)."""
    total = input_tokens + cached
    return round(100.0 * cached / total, 1) if total else None


def aggregate(rows: list[dict], days: int = 30, now: Optional[float] = None) -> dict:
    now = now or time.time()
    since = now - days * 86400
    rows = [r for r in rows if (r.get("created") or 0) >= since]
    totals = _zero()
    by_day: dict[str, dict] = {}
    by_model: dict[str, dict] = {}
    by_harness: dict[str, dict] = {}
    model_tps: dict[str, list] = {}
    harness_tps: dict[str, list] = {}
    today_key = _date(now)
    for r in rows:
        _add(totals, r)
        _add(by_day.setdefault(_date(r["created"]), _zero()), r)
        _add(by_model.setdefault(r.get("model") or "unknown", _zero()), r)
        _add(by_harness.setdefault(r.get("harness") or "unknown", _zero()), r)
        if r.get("tps"):
            model_tps.setdefault(r.get("model") or "unknown", []).append(r["tps"])
            harness_tps.setdefault(r.get("harness") or "unknown", []).append(r["tps"])
    # every calendar day in range, oldest first, zero-filled (charts want a continuous axis)
    day_list = []
    start = dt.date.fromtimestamp(since) + dt.timedelta(days=1)
    for i in range(days):
        d = (start + dt.timedelta(days=i)).strftime("%Y-%m-%d")
        b = by_day.get(d, _zero())
        day_list.append({"date": d, "turns": b["turns"], "input": b["input"], "output": b["output"], "cached": b["cached"]})

    def group(src: dict, tps: dict, key: str) -> list[dict]:
        out = [{key: k, "turns": v["turns"], "input": v["input"], "output": v["output"], "cached": v["cached"],
                "seconds": v["seconds"], "tools": v["tools"], "tps": _median(tps.get(k, [])[-20:])}
               for k, v in src.items()]
        return sorted(out, key=lambda x: -x["turns"])

    return {"days_requested": days, "totals": totals, "cache_hit_pct": _cache_pct(totals["input"], totals["cached"]),
            "days": day_list, "by_model": group(by_model, model_tps, "model"),
            "by_harness": group(by_harness, harness_tps, "harness"),
            "today": {**by_day.get(today_key, _zero()), "date": today_key}}


def _k(n: int) -> str:
    return f"{n / 1e6:.1f}M" if n >= 1_000_000 else f"{n / 1e3:.1f}k" if n >= 1000 else str(n)


def summary_text(rep: dict) -> str:
    t, td = rep["totals"], rep["today"]
    lines = [f"Usage, last {rep['days_requested']} days: {t['turns']} turns · {_k(t['input'])} in · {_k(t['output'])} out"
             + (f" · cache hit {rep['cache_hit_pct']:.0f}%" if rep.get("cache_hit_pct") is not None else ""),
             f"Today: {td['turns']} turns · {_k(td['input'])} in · {_k(td['output'])} out"]
    for m in rep["by_model"][:4]:
        lines.append(f"  {m['model']}: {m['turns']} turns, {_k(m['output'])} out" + (f", ~{m['tps']:.0f} tok/s" if m.get("tps") else ""))
    if len(rep["by_harness"]) > 1:
        lines.append("Harness: " + ", ".join(f"{h['harness']} {h['turns']}" for h in rep["by_harness"]))
    return "\n".join(lines)


def backfill(store) -> int:
    """One-time import of turns recorded before the usage table existed (assistant message meta.usage)."""
    if store.kv_get("usage_backfilled"):
        return 0
    n = 0
    rows = store._q("SELECT id, session_id, meta, created FROM messages WHERE role='assistant' AND meta LIKE '%\"usage\"%'")
    import json
    for r in rows:
        try:
            meta = json.loads(r["meta"] or "{}")
        except ValueError:
            continue
        u = meta.get("usage") or {}
        if not (u.get("input") or u.get("output")):
            continue
        summ = meta.get("summary") or {}
        store.add_usage({"session_id": r["session_id"], "model": meta.get("model") or "unknown",
                         "harness": meta.get("harness") or "unknown", "input": u.get("input"), "output": u.get("output"),
                         "cached": u.get("cached") or (meta.get("context") or {}).get("cached") or 0,
                         "seconds": summ.get("seconds") or 0, "tools": summ.get("tools") or 0, "tps": meta.get("tps"),
                         "created": r["created"], "message_id": r["id"]})
        n += 1
    store.kv_set("usage_backfilled", True)
    return n
