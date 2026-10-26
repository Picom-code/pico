"""Rich turn events layered on the Hermes bridge (docs/API.md "Rich events").

* tool labels (`tool_start.label`), per-call file diffs + seconds (`tool_end.diff/seconds`)
* live terminal output tails (`tool_progress`), throttled
* subagent lifecycle (`subagent_start/progress/end`) from Hermes' delegation progress relay
* per-turn file checkpoints (pre-images) via `checkpoints.CheckpointStore`
* `compacted {before, after}` on Hermes auto-compaction
* `notice {kind, text}` when memory or skills are written (hooked at Hermes' storage layer)

The bridge callbacks call `tool_start_extra` / `tool_end_extra` / `progress_callback`; the server opens a
`TurnTracker` per model turn with `begin_turn` and closes it with `end_turn`. Trackers are looked up by session
id, so there's no race with the worker thread starting before the server sees the Turn object.
"""
from __future__ import annotations

import asyncio
import contextlib
import contextvars
import difflib
import json
import logging
import os
import shlex
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("pico.events")

MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024  # bigger files are not snapshotted/diffed (disk is tight)
MAX_DIFF_LINES = 200
TAIL_LINES = 6
PROGRESS_MIN_INTERVAL = 0.25  # ≤4/s
PROGRESS_AFTER_S = 1.5
STREAMING_TOOLS = {"terminal", "execute_code", "process"}
MUTATING_TOOLS = {"write_file", "patch", "edit_file", "str_replace", "apply_patch", "create_file"}
SIDE_EFFECT_TOOLS = {"terminal", "execute_code", "process"}

TRACKERS: dict[str, "TurnTracker"] = {}
_current_sid: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("pico_sid", default=None)
_quiet_notices: contextvars.ContextVar[bool] = contextvars.ContextVar("pico_quiet_notices", default=False)
_last_sid: Optional[str] = None
_hub_publish: Optional[Callable[[str, dict], None]] = None
_hub_loop: Optional[asyncio.AbstractEventLoop] = None


# ── labels ───────────────────────────────────────────────────────────────────

def _short(s: Any, n: int = 60) -> str:
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _rel(path: str, cwd: Optional[str]) -> str:
    if not path:
        return ""
    try:
        p = Path(os.path.expanduser(path))
        if cwd and p.is_absolute():
            r = os.path.relpath(p, cwd)
            if not r.startswith(".."):
                return r
    except (ValueError, OSError):
        pass
    return path


def tool_label(name: str, args: Any, cwd: Optional[str] = None) -> str:
    a = args if isinstance(args, dict) else {}
    if name == "terminal":
        return f"terminal `{_short(a.get('command'), 70)}`"
    if name in ("write_file", "create_file"):
        return f"write {_rel(a.get('path', ''), cwd)}"
    if name == "patch" or name in ("edit_file", "str_replace", "apply_patch"):
        paths = _patch_paths(a)
        if paths:
            more = f" +{len(paths) - 1}" if len(paths) > 1 else ""
            return f"edit {_rel(paths[0], cwd)}{more}"
        return "edit files"
    if name == "read_file":
        return f"read {_rel(a.get('path', ''), cwd)}"
    if name == "search_files":
        return f'search "{_short(a.get("pattern"), 40)}"'
    if name == "web_search":
        return f'web search "{_short(a.get("query"), 50)}"'
    if name == "web_extract":
        urls = a.get("urls") or []
        return f"open {_short(urls[0] if urls else '', 60)}" + (f" +{len(urls) - 1}" if len(urls) > 1 else "")
    if name == "memory":
        return f"memory {a.get('action') or ''}".strip()
    if name in ("todo", "todo_list"):
        return "update checklist"
    if name == "skill_view":
        return f"open skill {a.get('name', '')}"
    if name == "skill_manage":
        return f"{a.get('action', 'edit')} skill {a.get('name', '')}".strip()
    if name == "skills_list":
        return "list skills"
    if name == "session_search":
        return f'search past chats "{_short(a.get("query"), 40)}"'
    if name == "delegate_task":
        tasks = a.get("tasks") or []
        if tasks:
            return f"delegate {len(tasks)} subagent{'s' if len(tasks) != 1 else ''}"
        return f"delegate “{_short(a.get('goal'), 50)}”"
    if name == "execute_code":
        return "run code"
    return name.replace("_", " ")


# ── paths touched by mutating tools ──────────────────────────────────────────

def _patch_paths(a: dict) -> list[str]:
    if a.get("mode") == "patch" or (a.get("patch") and not a.get("path")):
        out = []
        for line in str(a.get("patch") or "").splitlines():
            s = line.strip().lstrip("*").strip()
            for pre in ("Update File:", "Add File:", "Delete File:", "Move to:"):
                if s.startswith(pre):
                    p = s[len(pre):].strip()
                    if p and p not in out:
                        out.append(p)
        return out
    p = a.get("path") or a.get("file_path") or a.get("filename")
    return [p] if p else []


def mutated_paths(name: str, args: Any, cwd: Optional[str]) -> list[str]:
    if name not in MUTATING_TOOLS or not isinstance(args, dict):
        return []
    out = []
    for p in _patch_paths(args):
        out.append(abspath(p, cwd))
    return out


def abspath(p: str, cwd: Optional[str]) -> str:
    p = os.path.expanduser(str(p))
    if not os.path.isabs(p):
        p = os.path.join(cwd or os.getcwd(), p)
    return os.path.normpath(p)


def read_bytes(path: str) -> Optional[bytes]:
    """File content, b"" never means missing: None = did not exist. Raises ValueError when too large."""
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return None
    except OSError:
        return None
    if not os.path.isfile(path):
        return None
    if st.st_size > MAX_SNAPSHOT_BYTES:
        raise ValueError("too large")
    with open(path, "rb") as f:
        return f.read()


def diff_stats(before: Optional[bytes], after: Optional[bytes], label: str) -> dict:
    """{added, removed, unified, created, deleted} between two byte images (None = missing)."""
    def lines(b: Optional[bytes]) -> Optional[list[str]]:
        if b is None:
            return []
        try:
            return b.decode("utf-8").splitlines(keepends=True)
        except UnicodeDecodeError:
            return None
    a, b = lines(before), lines(after)
    if a is None or b is None:
        return {"added": 0, "removed": 0, "unified": "(binary file changed)", "created": before is None,
                "deleted": after is None, "binary": True}
    ud = list(difflib.unified_diff(a, b, fromfile=f"a/{label}" if before is not None else "/dev/null",
                                   tofile=f"b/{label}" if after is not None else "/dev/null", n=3))
    added = sum(1 for ln in ud if ln.startswith("+") and not ln.startswith("+++"))
    removed = sum(1 for ln in ud if ln.startswith("-") and not ln.startswith("---"))
    out_lines = [ln if ln.endswith("\n") else ln + "\n" for ln in ud]
    if len(out_lines) > MAX_DIFF_LINES:
        extra = len(out_lines) - MAX_DIFF_LINES
        out_lines = out_lines[:MAX_DIFF_LINES] + [f"… {extra} more diff lines\n"]
    return {"added": added, "removed": removed, "unified": "".join(out_lines), "created": before is None,
            "deleted": after is None}


# ── per-turn tracker ─────────────────────────────────────────────────────────

class TurnTracker:
    def __init__(self, sid: str, turn_id: str, cwd: Optional[str], out: Optional[asyncio.Queue],
                 loop: Optional[asyncio.AbstractEventLoop], ckpt: Any = None):
        self.sid, self.turn_id, self.cwd = sid, turn_id, cwd
        self.out, self.loop, self.ckpt = out, loop, ckpt
        self.lock = threading.RLock()
        self.started: dict[str, float] = {}       # call_id -> start time
        self.call_pre: dict[str, dict[str, Optional[bytes]]] = {}  # call_id -> {path: bytes|None}
        self.skipped: set[str] = set()            # too large to snapshot
        self.tool_count = 0
        self.side_effects = False
        self.compacted: list[dict] = []
        self.last_progress: dict[str, float] = {}
        self.subagents: dict[str, dict] = {}
        self.closed = False

    # emit straight to the client stream (thread-safe)
    def emit(self, event: str, data: dict) -> None:
        if self.closed or not (self.out and self.loop):
            return
        try:
            self.loop.call_soon_threadsafe(self.out.put_nowait, (event, data))
        except RuntimeError:
            pass

    def cwd_or_default(self) -> str:
        return self.cwd or os.getcwd()

    def on_start(self, call_id: str, name: str, args: Any) -> dict:
        with self.lock:
            self.started[call_id] = time.time()
            self.tool_count += 1
            if name in SIDE_EFFECT_TOOLS:
                self.side_effects = True
                if self.ckpt:
                    self.ckpt.mark_side_effects(self.sid, self.turn_id)
            pre: dict[str, Optional[bytes]] = {}
            for p in mutated_paths(name, args, self.cwd_or_default()):
                try:
                    b = read_bytes(p)
                except ValueError:
                    self.skipped.add(p)
                    continue
                pre[p] = b
                if self.ckpt:
                    self.ckpt.snapshot(self.sid, self.turn_id, p, b)
            if pre:
                self.call_pre[call_id] = pre
        return {"label": tool_label(name, args, self.cwd_or_default())}

    def on_end(self, call_id: str, name: str, args: Any) -> dict:
        with self.lock:
            t0 = self.started.pop(call_id, None)
            pre = self.call_pre.pop(call_id, None)
            self.last_progress.pop(call_id, None)
        out: dict = {"seconds": round(time.time() - t0, 2) if t0 else None}
        if pre is None and name in MUTATING_TOOLS:
            # tool_start may have lacked args (or a lean harness); best effort: no pre-image → skip diff
            pre = {}
        if pre:
            diffs = []
            for p, before in pre.items():
                try:
                    after = read_bytes(p)
                except ValueError:
                    continue
                if after == before:
                    continue
                d = diff_stats(before, after, _rel(p, self.cwd_or_default()))
                diffs.append({"path": _rel(p, self.cwd_or_default()), "abs_path": p, **d})
            if diffs:
                out["diff"] = diffs[0]
                if len(diffs) > 1:
                    out["diffs"] = diffs
        return out

    def progress_ok(self, call_id: str) -> bool:
        now = time.time()
        with self.lock:
            t0 = self.started.get(call_id)
            if t0 is None or now - t0 < PROGRESS_AFTER_S:
                return False
            if now - self.last_progress.get(call_id, 0) < PROGRESS_MIN_INTERVAL:
                return False
            self.last_progress[call_id] = now
            return True

    def files_changed(self) -> list[dict]:
        if not self.ckpt:
            return []
        return [{**f, "path": _rel(f["path"], self.cwd_or_default()), "abs_path": f["path"]}
                for f in self.ckpt.finalize(self.sid, self.turn_id)]


def begin_turn(sid: str, turn_id: str, cwd: Optional[str], out: Optional[asyncio.Queue], ckpt: Any = None) -> TurnTracker:
    global _last_sid
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    tr = TurnTracker(sid, turn_id, cwd, out, loop, ckpt)
    TRACKERS[sid] = tr
    _current_sid.set(sid)  # copied into the worker context by Bridge.run_turn (copy_context)
    _last_sid = sid
    return tr


def end_turn(sid: str) -> None:
    tr = TRACKERS.pop(sid, None)
    if tr:
        tr.closed = True


def tool_start_extra(sid: str, call_id: str, name: str, args: Any) -> dict:
    tr = TRACKERS.get(sid)
    try:
        return tr.on_start(call_id, name, args) if tr else {"label": tool_label(name, args)}
    except Exception:  # noqa: BLE001  — never break a tool call over UI sugar
        log.debug("tool_start_extra failed", exc_info=True)
        return {"label": tool_label(name, args)}


def tool_end_extra(sid: str, call_id: str, name: str, args: Any, result: Any = None) -> dict:
    tr = TRACKERS.get(sid)
    if not tr:
        return {}
    try:
        return tr.on_end(call_id, name, args)
    except Exception:  # noqa: BLE001
        log.debug("tool_end_extra failed", exc_info=True)
        return {}


# ── Hermes tool_progress_callback: terminal tails + subagents ─────────────────

_FAIL = {"failed", "error", "timeout", "interrupted", "cancelled"}


def progress_callback(sid: str, emit_cur: Callable[[str, dict], None]) -> Callable:
    """Build the `tool_progress_callback` for an AIAgent. `emit_cur(event, data)` emits into the session's
    current turn queue (the bridge's Turn.emit)."""

    def cb(event_type, tool_name=None, preview=None, args=None, **kw):
        try:
            tr = TRACKERS.get(sid)
            if event_type == "tool.progress":
                cid = kw.get("tool_call_id") or ""
                if tr and cid and preview and tr.progress_ok(cid):
                    tail = [ln for ln in str(preview).splitlines()
                            if ln.strip() and "__HERMES_CWD_" not in ln][-TAIL_LINES:]
                    if tail:
                        emit_cur("tool_progress", {"id": cid, "tail": tail})
                return
            if not str(event_type or "").startswith("subagent"):
                return
            sub_id = kw.get("subagent_id") or f"sa-{kw.get('task_index', 0)}"
            state = tr.subagents.setdefault(sub_id, {}) if tr else {}
            if event_type == "subagent.start":
                state["t0"] = time.time()
                emit_cur("subagent_start", {"id": sub_id, "goal": _short(kw.get("goal") or preview, 300),
                                            "model": kw.get("model")})
            elif event_type == "subagent.complete":
                status = kw.get("status") or "completed"
                tokens = int(kw.get("input_tokens") or 0) + int(kw.get("output_tokens") or 0)
                secs = kw.get("duration_seconds")
                if secs is None and state.get("t0"):
                    secs = time.time() - state["t0"]
                summary = str(kw.get("summary") or preview or "")
                emit_cur("subagent_end", {"id": sub_id, "ok": status not in _FAIL,
                                          "summary": summary[:400], "seconds": round(float(secs or 0), 1),
                                          "tokens": tokens, "status": status})
            elif event_type in ("subagent.tool", "subagent.progress", "subagent.thinking", "subagent_progress"):
                now = time.time()
                if now - state.get("last", 0) < 0.5:
                    return
                state["last"] = now
                if event_type == "subagent.tool":
                    label = tool_label(tool_name or "", args if isinstance(args, dict) else {})
                    data = {"id": sub_id, "label": label}
                    if preview:
                        data["tail"] = [_short(preview, 160)]
                elif event_type == "subagent.thinking":
                    txt = str(preview or tool_name or "").strip()
                    if len(txt) < 40 and txt.endswith("..."):  # Hermes' kaomoji spinner placeholder
                        data = {"id": sub_id, "label": "thinking"}
                    else:
                        data = {"id": sub_id, "label": "thinking", "tail": [_short(txt, 160)]}
                else:
                    data = {"id": sub_id, "label": _short(preview or tool_name, 120)}
                emit_cur("subagent_progress", data)
        except Exception:  # noqa: BLE001
            log.debug("progress callback failed", exc_info=True)

    return cb


# ── turn-end context + summary ────────────────────────────────────────────────

DEFAULT_CTX = 128_000


def context_info(agent: Any, result: dict, cfg_ctx: Optional[int] = None) -> dict:
    lu = getattr(agent, "_last_turn_usage", None) or {}
    used = int(lu.get("prompt_tokens") or result.get("last_prompt_tokens") or 0)
    comp = getattr(agent, "context_compressor", None)
    mx = getattr(comp, "context_length", None) if comp is not None else None
    mx = int(mx or cfg_ctx or DEFAULT_CTX)
    out = {"used": used, "max": mx}
    cached = lu.get("cache_read_tokens")
    if cached:
        out["cached"] = int(cached)
    return out


# ── Hermes hooks: compaction, memory + skill notices, terminal streaming ──────

_installed = False


def set_hub(publish: Callable[[str, dict], None]) -> None:
    global _hub_publish, _hub_loop
    _hub_publish = publish
    try:
        _hub_loop = asyncio.get_running_loop()
    except RuntimeError:
        _hub_loop = None


@contextlib.contextmanager
def quiet_notices():
    """Suppress notices for writes the user made themselves (Pico's memory API)."""
    tok = _quiet_notices.set(True)
    try:
        yield
    finally:
        _quiet_notices.reset(tok)


_profile_gen = 0


def profile_generation() -> int:
    """Bumped on every memory/skill write (also user writes); keys the engine's profile-size cache."""
    return _profile_gen


def bump_profile() -> None:
    global _profile_gen
    _profile_gen += 1


_profile_fn: Optional[Callable[[], dict]] = None


def set_profile_fn(fn: Optional[Callable[[], dict]]) -> None:
    """Engine hook: returns the current `{tokens, budget, estimate}`; attached to memory notices."""
    global _profile_fn
    _profile_fn = fn


def notice(kind: str, text: str) -> None:
    if kind in ("memory", "skill"):
        bump_profile()
    if _quiet_notices.get():
        return
    extra: dict = {}
    if kind == "memory" and _profile_fn:
        with contextlib.suppress(Exception):
            extra["profile"] = _profile_fn()
    sid = _current_sid.get() or _last_sid
    tr = TRACKERS.get(sid) if sid else None
    if tr and not tr.closed and _current_sid.get() == sid:
        tr.emit("notice", {"kind": kind, "text": text, **extra})
        return
    if _hub_publish:
        data = {"session_id": sid, "kind": kind, "text": text, **extra}
        if _hub_loop:
            try:
                _hub_loop.call_soon_threadsafe(_hub_publish, "notice", data)
                return
            except RuntimeError:
                pass
        with contextlib.suppress(Exception):
            _hub_publish("notice", data)


def _tracker_for_agent(agent: Any) -> Optional[TurnTracker]:
    sid = _current_sid.get()
    if sid and sid in TRACKERS:
        return TRACKERS[sid]
    for k in (getattr(agent, "_inflight_turn_session_id", None), getattr(agent, "session_id", None)):
        if k and k in TRACKERS:
            return TRACKERS[k]
    return None


def install() -> None:
    """Idempotently wrap Hermes internals. Safe to call before every turn; failures are logged, not raised."""
    global _installed
    if _installed:
        return
    _installed = True
    try:
        from .agent_bridge import ensure_hermes
        ensure_hermes()
    except Exception:  # noqa: BLE001
        log.debug("ensure_hermes failed in events install", exc_info=True)
        return
    _hook_compaction()
    _hook_memory()
    _hook_skills()
    _hook_terminal_stream()
    _hook_delegation_sync()


def _hook_compaction() -> None:
    try:
        import agent.conversation_compression_telemetry as tel
    except Exception:  # noqa: BLE001
        return
    orig = tel.publish_attempt

    def publish_attempt(agent, record, *a, **kw):
        with contextlib.suppress(Exception):
            committed = record.get("history_rewritten") is True or record.get("commit_status") == "committed"
            tr = _tracker_for_agent(agent)
            if committed and tr:
                ev = {"before": int(record.get("tokens_before") or 0), "after": int(record.get("tokens_after") or 0),
                      "auto": True}
                tr.compacted.append(ev)
                tr.emit("compacted", ev)
        return orig(agent, record, *a, **kw)

    tel.publish_attempt = publish_attempt


def _hook_memory() -> None:
    try:
        from tools.memory_tool_store import MemoryStore
    except Exception:  # noqa: BLE001
        return
    orig = MemoryStore.__dict__.get("_write_file")
    fn = orig.__func__ if isinstance(orig, staticmethod) else orig
    if fn is None:
        return

    def _write_file(path, entries):
        before: list[str] = []
        with contextlib.suppress(Exception):
            raw = Path(path).read_text(encoding="utf-8")
            before = [e.strip() for e in raw.split("\n§\n") if e.strip()]
        res = fn(path, entries)
        with contextlib.suppress(Exception):
            new = [e for e in (x.strip() for x in entries) if e and e not in before]
            gone = [e for e in before if e not in [x.strip() for x in entries]]
            who = "about you" if Path(path).name.upper().startswith("USER") else ""
            if new:
                notice("memory", f"Remembered{(' ' + who) if who else ''}: {_short(new[0], 160)}"
                       + (f" (+{len(new) - 1} more)" if len(new) > 1 else ""))
            elif gone:
                notice("memory", f"Forgot: {_short(gone[0], 160)}")
        return res

    MemoryStore._write_file = staticmethod(_write_file)


def _hook_skills() -> None:
    try:
        import tools.skill_manager_tool as smt
    except Exception:  # noqa: BLE001
        return
    orig = smt._guarded_write

    def _guarded_write(name, skill_dir, target, action, label, content):
        existed = Path(target).exists()
        res = orig(name, skill_dir, target, action, label, content)
        if res is None:  # success
            verb = "created" if (action == "create" and not existed) else "updated"
            notice("skill", f"Skill {verb}: {name}")
        return res

    smt._guarded_write = _guarded_write


def _hook_delegation_sync() -> None:
    """Pico has no gateway to deliver detached subagent results after the turn ends, so for Pico turns take
    Hermes' own finite-session path: delegate_task runs its children synchronously and returns their results
    in the same tool call (subagent_* events stream meanwhile)."""
    try:
        import tools.delegate_tool_dispatch as dd
    except Exception:  # noqa: BLE001
        return
    orig = dd._resolve_async_wake_sid

    def _resolve_async_wake_sid(*a, **kw):
        if _current_sid.get():
            return None
        return orig(*a, **kw)

    dd._resolve_async_wake_sid = _resolve_async_wake_sid


def _hook_terminal_stream() -> None:
    """Tee terminal output into the running call's Hermes progress reporter (→ tool.progress → tool_progress)."""
    try:
        import tools.environments.base as base
        from agent.tool_progress_relay import current_tool_progress
    except Exception:  # noqa: BLE001
        return
    orig = base._new_output_collector

    def _new_output_collector(proc, bounded_capture, *a, **kw):
        coll = orig(proc, bounded_capture, *a, **kw)
        rep = current_tool_progress()
        if rep is None:
            return coll
        buf: list[str] = [""]
        lock = threading.Lock()
        o_append = coll.append

        def append(text):
            o_append(text)
            if not text:
                return
            with contextlib.suppress(Exception):
                with lock:
                    buf[0] = (buf[0] + text)[-4000:]
                    tail = "\n".join([ln for ln in buf[0].splitlines() if "__HERMES_CWD_" not in ln][-TAIL_LINES:])
                rep(0.0, None, tail)

        coll.append = append
        return coll

    base._new_output_collector = _new_output_collector
