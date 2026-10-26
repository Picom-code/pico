"""Auto-compaction settings + history splitting, and the profile-context size report.

Config (`compaction` in config.json, GET/PATCH /api/config):
  auto: bool            compact before a turn once the last turn's context use crosses `at_pct`
  at_pct: 50-95         threshold, percent of the *effective* context max
  keep_recent: 2-20     newest messages kept verbatim (the cut snaps back to a user message)
  mode: summary | trim  trim = blank the oldest tool outputs first, summarize only if still over
  notify: bool          also emit a user-visible `notice {kind:"compact"}`
  max_ctx_override: null | int  context size used for the percentage (null = model ctx, capped at 256k)

Token counts are estimates (chars/4) — no tokenizer ships in the venv; reports say `estimate: true`.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

log = logging.getLogger("pico.compaction")

DEFAULTS: dict[str, Any] = {"auto": True, "at_pct": 80, "keep_recent": 6, "mode": "summary", "notify": True,
                            "max_ctx_override": None}
MODES = ("summary", "trim")
SANE_MAX_CTX = 256_000          # provider-reported 1M windows are not what a local box can actually use well
CHARS_PER_TOKEN = 4
TRIMMED = "[older tool output trimmed to save context]"
TRIM_MIN_CHARS = 240             # tool outputs shorter than this aren't worth trimming


def estimate_tokens(text: Any) -> int:
    if not text:
        return 0
    if not isinstance(text, str):
        text = json.dumps(text, default=str)
    return (len(text) + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN


def history_tokens(msgs: list) -> int:
    """Same rough measure as server._rough_tokens (content + tool calls)."""
    n = 0
    for m in msgs or []:
        n += len(json.dumps(m.get("content") or "", default=str))
        if m.get("tool_calls"):
            n += len(json.dumps(m["tool_calls"], default=str))
    return n // CHARS_PER_TOKEN


def normalize(patch: Any, current: Optional[dict] = None) -> dict:
    if not isinstance(patch, dict):
        raise ValueError("compaction must be an object")
    out = {**DEFAULTS, **(current or {})}
    unknown = set(patch) - set(DEFAULTS)
    if unknown:
        raise ValueError(f"compaction: unknown field(s) {sorted(unknown)}")
    for k in ("auto", "notify"):
        if k in patch:
            if not isinstance(patch[k], bool):
                raise ValueError(f"compaction.{k} must be true or false")
            out[k] = patch[k]
    for k, lo, hi in (("at_pct", 50, 95), ("keep_recent", 2, 20)):
        if k in patch:
            v = patch[k]
            if isinstance(v, bool) or not isinstance(v, (int, float)) or int(v) != v or not lo <= v <= hi:
                raise ValueError(f"compaction.{k} must be a whole number {lo}-{hi}")
            out[k] = int(v)
    if "mode" in patch:
        if patch["mode"] not in MODES:
            raise ValueError(f"compaction.mode must be one of {MODES}")
        out["mode"] = patch["mode"]
    if "max_ctx_override" in patch:
        v = patch["max_ctx_override"]
        if v is not None and (isinstance(v, bool) or not isinstance(v, int) or not 1000 <= v <= 2_000_000):
            raise ValueError("compaction.max_ctx_override must be null or a whole number 1000-2000000")
        out["max_ctx_override"] = v
    return out


def settings(cfg: dict) -> dict:
    try:
        return normalize({}, cfg.get("compaction") or {})
    except ValueError:
        return dict(DEFAULTS)


def effective_max(model_max: Optional[int], s: dict) -> int:
    """Context size the threshold percentage is measured against."""
    m = int(model_max or 128_000)
    ov = s.get("max_ctx_override")
    return min(m, int(ov)) if ov else min(m, SANE_MAX_CTX)


def over_threshold(ctx: dict, s: dict) -> bool:
    used = int((ctx or {}).get("used") or 0)
    return bool(s.get("auto")) and used > 0 and used * 100 >= s["at_pct"] * effective_max(ctx.get("max"), s)


# ── splitting stored rows ────────────────────────────────────────────────────

def row_hermes(m: dict) -> list[dict]:
    meta = m.get("meta") or {}
    if "hermes" in meta:
        return list(meta["hermes"] or [])
    if m.get("role") in ("user", "assistant") and not meta.get("display_only"):
        return [{"role": m["role"], "content": m.get("content") or ""}]
    return []


def split_rows(rows: list[dict], keep_recent: int) -> int:
    """Index of the first stored row to keep verbatim: the latest user-message row such that at least
    `keep_recent` model-visible messages follow from it. 0 = nothing older to compact. Cutting on a user row
    never orphans a tool result from its tool call."""
    count = 0
    for i in range(len(rows) - 1, -1, -1):
        h = row_hermes(rows[i])
        count += len(h)
        if count >= keep_recent and h and h[0].get("role") == "user" and rows[i]["role"] == "user":
            return i
    return 0


def trim_tool_outputs(msgs: list[dict]) -> tuple[list[dict], int]:
    """Blank long tool results (oldest first, all of them in the older part). Returns (msgs, how many)."""
    out, n = [], 0
    for m in msgs:
        if m.get("role") == "tool" and len(str(m.get("content") or "")) > TRIM_MIN_CHARS \
                and m.get("content") != TRIMMED:
            m = {**m, "content": TRIMMED}
            n += 1
        out.append(m)
    return out, n


def summary_prompt(base: str, focus: str = "", goal: Optional[str] = None, todos: Optional[list] = None) -> str:
    p = base
    if goal:
        p += f" The chat has this goal (keep it, verbatim): {goal}."
    if todos:
        open_ = [t.get("content") or t.get("text") for t in todos if (t.get("status") or "") != "completed"]
        if open_:
            p += " Open steps: " + "; ".join(str(x) for x in open_[:12]) + "."
    if focus:
        p += f" Focus especially on: {focus.strip()[:300]}."
    return p


# ── profile context ──────────────────────────────────────────────────────────

def profile_context(harness: str = "lean", cwd: Optional[str] = None) -> dict:
    """What the user's standing context costs per turn: injected memory, skills index, project file."""
    from . import lean as L
    out: dict[str, Any] = {"harness": harness, "estimate": True, "tokenizer": "chars/4"}
    if harness == "lean":
        notes = L.safe_notes()
        core, left = L.core_memory(notes)
        block = ""
        if core:
            block = "## What you know about the user\n" + "\n".join(f"- {c}" for c in core)
            if left:
                block += f"\n({left} more saved notes: use recall)"
        elif left:
            block = f"## What you know about the user\n({left} saved notes: use recall)"
        out.update(tokens=estimate_tokens(block), budget=L.CORE_MEMORY_CHARS // CHARS_PER_TOKEN,
                   notes=len(core), notes_recall_only=left,
                   user_notes=sum(1 for t, _ in notes if t == "user"),
                   memory_notes=sum(1 for t, _ in notes if t == "memory"),
                   skills_index_tokens=estimate_tokens(L.skills_index(L.safe_skills())),
                   agents_md_tokens=estimate_tokens(L.context_file(cwd)))
    else:
        tokens = budget = un = mn = 0
        try:
            from .agent_bridge import ensure_hermes
            ensure_hermes()
            from tools.memory_tool import load_on_disk_store
            s = load_on_disk_store()
            un, mn = len([e for e in s.user_entries if e]), len([e for e in s.memory_entries if e])
            blocks = [s._render_block(t, [e for e in ents if e]) for t, ents in
                      (("memory", s.memory_entries if s.memory_enabled else []),
                       ("user", s.user_entries if s.user_profile_enabled else []))]
            tokens = estimate_tokens("\n\n".join(b for b in blocks if b))
            budget = (s.memory_char_limit + s.user_char_limit) // CHARS_PER_TOKEN
        except Exception as e:  # noqa: BLE001
            log.debug("hermes memory size failed: %s", e)
        skills = 0
        try:
            from agent.prompt_builder import build_skills_system_prompt
            skills = estimate_tokens(build_skills_system_prompt())
        except Exception as e:  # noqa: BLE001
            log.debug("hermes skills index size failed: %s", e)
        out.update(tokens=tokens, budget=budget, notes=un + mn, notes_recall_only=0, user_notes=un, memory_notes=mn,
                   skills_index_tokens=skills, agents_md_tokens=0)  # Pico runs Hermes with skip_context_files
    out["total_standing_tokens"] = out["tokens"] + out["skills_index_tokens"] + out["agents_md_tokens"]
    return out


def profile_brief(p: dict) -> dict:
    return {"tokens": p.get("tokens", 0), "budget": p.get("budget", 0), "estimate": p.get("estimate", True)}
