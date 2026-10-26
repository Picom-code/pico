"""/lean — slim the user's profile (Hermes memory: USER.md + MEMORY.md) and prove the speedup.

Flow: measure a real request with the current profile -> ask the model to compact it -> back up and
rewrite the profile -> measure again -> report token + latency deltas. Each measurement is a plain
OpenAI-compatible POST (like a curl) with a random nonce up front so prefix caching can't flatter
either side. Runs off the event loop; yields human-readable progress lines.
"""
from __future__ import annotations

import json
import re
import shutil
import statistics
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Callable, Optional

BENCH_Q = "In one short sentence, what do you know about me?"
RUNS = 4  # per side; interleaved A/B, median

COMPACT_SYS = (
    "You compress a personal assistant's memory about a user. Rewrite the notes below into the fewest "
    "short facts that keep everything that changes how the assistant should help: identity, preferences, "
    "standing rules, ongoing projects, key people, constraints. Merge duplicates, keep the newer fact on "
    "conflict, drop trivia and anything stale or one-off. Each fact <= 20 words, plain, no filler. "
    'Reply with JSON only: {"user": [..facts about the person..], "memory": [..working notes/conventions..]}'
)


def _tok(s: str) -> int:
    return max(1, len(s) // 4)


def _post(base_url: str, key: str, body: dict, timeout: float = 120) -> tuple[dict, float]:
    req = urllib.request.Request(base_url.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key or 'x'}"})
    t = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read())
    return d, time.perf_counter() - t


def profile_text(user: list[str], memory: list[str]) -> str:
    out = []
    if user:
        out.append("About the user:\n" + "\n".join(f"- {e}" for e in user))
    if memory:
        out.append("Notes:\n" + "\n".join(f"- {e}" for e in memory))
    return "\n\n".join(out)


def _one(rt, profile: str) -> tuple[float, int]:
    sys = f"[{uuid.uuid4().hex}] You are Pico, a helpful assistant.\n\n{profile}"
    body = {"model": rt.model, "max_tokens": 24, "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "system", "content": sys}, {"role": "user", "content": BENCH_Q}]}
    d, s = _post(rt.base_url, rt.api_key, body)
    return s, (d.get("usage") or {}).get("prompt_tokens") or _tok(sys + BENCH_Q)


def measure_ab(rt, before: str, after: str) -> tuple[dict, dict]:
    """Warm up once, then alternate before/after so server load and cold starts hit both sides equally."""
    _one(rt, after)
    res = {"b": ([], []), "a": ([], [])}
    for i in range(RUNS * 2):
        k = "b" if i % 2 == 0 else "a"
        s, t = _one(rt, before if k == "b" else after)
        res[k][0].append(s); res[k][1].append(t)
    pack = lambda k: {"seconds": statistics.median(res[k][0]), "prompt_tokens": int(statistics.median(res[k][1]))}
    return pack("b"), pack("a")


def compact(rt, user: list[str], memory: list[str]) -> tuple[list[str], list[str]]:
    body = {"model": rt.model, "max_tokens": 1500, "temperature": 0.2,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "system", "content": COMPACT_SYS},
                         {"role": "user", "content": json.dumps({"user": user, "memory": memory}, ensure_ascii=False)}]}
    d, _ = _post(rt.base_url, rt.api_key, body, timeout=180)
    txt = (d["choices"][0]["message"].get("content") or "").strip()
    m = re.search(r"\{.*\}", txt, re.S)
    if not m:
        raise ValueError("model didn't return JSON")
    j = json.loads(m.group(0))
    clean = lambda xs: [re.sub(r"\s+", " ", str(x)).strip() for x in (xs or []) if str(x).strip()]
    nu, nm = clean(j.get("user")), clean(j.get("memory"))
    if not nu and not nm:
        raise ValueError("model returned an empty profile; nothing changed")
    return nu, nm


def run(rt, store, memories_dir: Path, emit: Callable[[str], None]) -> dict:
    user, memory = list(store.user_entries), list(store.memory_entries)
    if not user and not memory:
        emit("Your profile is empty, nothing to slim yet. It fills up as Pico learns about you.\n")
        return {"skipped": True}
    before_txt = profile_text(user, memory)
    emit(f"profile  {len(user) + len(memory)} notes · ~{_tok(before_txt):,} tok\n")
    emit("compacting  ")
    nu, nm = compact(rt, user, memory)
    after_txt = profile_text(nu, nm)
    emit(f"{len(user) + len(memory)} → {len(nu) + len(nm)} notes\n")
    emit(f"benchmarking  {RUNS} runs each, alternating…\n")
    b, a = measure_ab(rt, before_txt, after_txt)
    emit(f"  before  {b['prompt_tokens']:,} tok · {b['seconds']:.2f}s\n")
    emit(f"  after   {a['prompt_tokens']:,} tok · {a['seconds']:.2f}s\n\n")

    # back up, then rewrite through Hermes' own store so its format/locks stay valid
    bak = memories_dir / f"backup-{time.strftime('%Y%m%d-%H%M%S')}"
    bak.mkdir(parents=True, exist_ok=True)
    for f in ("USER.md", "MEMORY.md"):
        if (memories_dir / f).exists():
            shutil.copy2(memories_dir / f, bak / f)
    for target, old, new in (("user", user, nu), ("memory", memory, nm)):
        for e in old:
            store.remove(target, e, matched_entry=e)
        for e in new:
            store.add(target, e)

    tok_pct = 100 * (b["prompt_tokens"] - a["prompt_tokens"]) / max(1, b["prompt_tokens"])
    spd_pct = 100 * (b["seconds"] - a["seconds"]) / max(1e-6, b["seconds"])
    emit(f"✓ profile {tok_pct:.0f}% smaller · {spd_pct:+.0f}% faster per request\n")
    if abs(spd_pct) < 5:
        emit("  (speed change is within noise; the token savings add up over long chats)\n")
    emit(f"  backup: {bak}\n")
    return {"before": b, "after": a, "token_pct": round(tok_pct, 1), "speed_pct": round(spd_pct, 1),
            "notes_before": len(user) + len(memory), "notes_after": len(nu) + len(nm), "backup": str(bak)}
