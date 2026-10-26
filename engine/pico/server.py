"""Pico engine HTTP+SSE server (docs/API.md).

Run:  PICO_HOME=~/.pico python -m pico.server        (or the `pico-engine` console script)
Env:  PICO_HOST (127.0.0.1), PICO_PORT (7878), PICO_HOME, PICO_HERMES_PATH, PICO_PUBLIC_URL, PICO_WEB_DIST
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from aiohttp import web

from . import __version__
from . import compaction as CP
from . import config as C
from . import slash as S
from .agent_bridge import Bridge, NotConfigured, ensure_hermes, preview, sync_hermes_config
from .checkins import Scheduler, normalize_schedule, view as checkin_view
from . import events_extra as X
from . import loops as LP
from . import schedules as SC
from . import usage as U
from .checkpoints import CheckpointStore, undo_last_turn
from .store import Store, new_id

log = logging.getLogger("pico")

ENGINE_KEY: "web.AppKey[Engine]" = web.AppKey("engine")
PUBLIC = {("GET", "/api/health"), ("POST", "/api/pair/claim")}


# ── optional sibling modules (hwscan / recipes / runtime) with stubs ─────────

def _hw_scan() -> dict:
    try:
        from . import hwscan
        return hwscan.scan()
    except Exception as e:  # noqa: BLE001
        import platform
        return {"os": platform.system().lower(), "arch": platform.machine(), "cpu": {"name": platform.processor(), "cores": os.cpu_count()},
                "ram_gb": None, "gpus": [], "unified_memory": False, "disk_free_gb": None, "accelerators": ["cpu"],
                "runtimes": {}, "stub": True, "stub_reason": str(e)}


def _recipes():
    try:
        from . import recipes
        return recipes
    except Exception:  # noqa: BLE001
        return None


def _make_runtime(home: Path):
    try:
        from .runtime import LocalRuntime
        return LocalRuntime(home)
    except Exception as e:  # noqa: BLE001
        log.warning("local runtime unavailable: %s", e)
        return None


# ── SSE helpers ──────────────────────────────────────────────────────────────

async def sse_open(request: web.Request) -> web.StreamResponse:
    resp = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache",
                                       "X-Accel-Buffering": "no", "Connection": "keep-alive"})
    await resp.prepare(request)
    return resp


def turn_tps(output_tokens: int, wall_s: float, tool_s: float = 0.0, stream_s: float = 0.0) -> Optional[float]:
    """Output tokens per second of *model* time for a whole turn.

    `output_tokens` is cumulative over every model call in the turn, so the denominator must be too:
    wall time minus time spent running tools. If tokens visibly streamed for most of that window,
    use the streaming span (closer to decode speed). Never time from the final answer's first delta
    alone — a burst-emitted answer after tool calls made that ~0s and tps absurd (30k tok/s)."""
    if not output_tokens or output_tokens <= 0:
        return None
    model_s = max(0.0, wall_s - max(0.0, tool_s))
    if stream_s >= 0.5 * model_s and stream_s > 0:
        model_s = stream_s
    if model_s < 0.05:  # too short to measure meaningfully
        return None
    return round(output_tokens / model_s, 1)


def sse_frame(event: str, data: Any) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n".encode()


class Hub:
    """Fan-out for GET /api/events."""

    def __init__(self):
        self.subs: set[asyncio.Queue] = set()

    def publish(self, event: str, data: dict) -> None:
        for q in list(self.subs):
            q.put_nowait((event, data))


class TurnQueue(asyncio.Queue):
    """A turn's event queue. Fills in yolo/model/harness on every `done` and relays every event to the
    session's watchers (GET /api/sessions/{id}/stream), so engine-started turns (loop, cron, steer
    follow-ups) are visible to clients that didn't start them."""

    def __init__(self, eng: "Engine", sid: str, harness: Optional[str] = None, model: Optional[str] = None):
        super().__init__()
        self.eng, self.sid, self.harness, self.model = eng, sid, harness, model

    def put_nowait(self, item) -> None:
        ev, data = item
        if ev == "done" and isinstance(data, dict):
            data.setdefault("yolo", self.eng.approval_mode(self.sid) == "yolo")
            if not data.get("harness"):
                data["harness"] = self.harness
            if not data.get("model"):
                data["model"] = self.model or self.eng.current_model(self.sid)
        super().put_nowait(item)
        self.eng.relay(self.sid, ev, data)


GO_WORDS = re.compile(r"^\s*(go|yes|y|yep|yeah|ok|okay|sure|proceed|do it|go ahead|lgtm|ship it|run it|continue|"
                      r"sounds good|let'?s go|execute|start)\b[\s.!]*$", re.I)


def plan_steps(todos: list[dict]) -> list[dict]:
    m = {"pending": "pending", "in_progress": "active", "completed": "done"}
    return [{"text": t.get("text") or t.get("content") or "", "status": m.get(t.get("status") or "pending", "pending")}
            for t in todos or [] if (t.get("status") or "pending") != "cancelled"]


def plan_steps_from_text(text: str) -> list[dict]:
    """Fallback when the model wrote its plan as a numbered/bulleted list instead of calling todo_list."""
    steps = [m.group(2).strip() for m in re.finditer(r"(?m)^\s*(\d+[.)]|[-*•]\s*\[ \])\s+(.+)$", text or "")]
    return [{"text": s[:200], "status": "pending"} for s in steps[:30]]


def tools_touched_todo(tools: dict) -> bool:
    return any((t.get("name") in ("todo_list", "todo")) for t in (tools or {}).values())


GOAL_DONE_RE = re.compile(r"(?m)^\s*\**GOAL_DONE\**\s*$")


class Job:
    def __init__(self, kind: str):
        self.id = new_id("j_")
        self.kind = kind
        self.events: list[tuple[str, dict]] = []
        self.subs: set[asyncio.Queue] = set()
        self.done = False

    def emit(self, event: str, data: dict) -> None:
        self.events.append((event, data))
        if event in ("done", "error"):
            self.done = True
        for q in list(self.subs):
            q.put_nowait((event, data))


# ── the engine ───────────────────────────────────────────────────────────────

class Engine:
    def __init__(self, bridge: Optional[Bridge] = None, runtime: Any = "auto"):
        C.ensure_dirs()
        self.token = C.load_or_create_token()
        self.yolo: set[str] = set()  # session ids with /yolo on (in-memory; resets on engine restart)
        self.store = Store(C.db_path())
        self.bridge = bridge or Bridge()
        self.hub = Hub()
        self.jobs: dict[str, Job] = {}
        self.pending: dict[str, dict] = {}  # lazily-created sessions
        self.state = "setup"
        self.error: Optional[str] = None
        self.runtime = _make_runtime(C.pico_home()) if runtime == "auto" else runtime
        self.scheduler = Scheduler(self.store, self._run_checkin)
        self.openai_login: dict = {"state": "idle"}
        self.host, self.port = "127.0.0.1", 7878
        self.memory_pass_model = None  # tests inject a fake (rt, messages) -> str
        self._bg: set[asyncio.Task] = set()
        self.ckpt = CheckpointStore()
        self._starting: set[str] = set()  # sessions whose turn task is running (covers slash commands too)
        self.session_subs: dict[str, set[asyncio.Queue]] = {}  # GET /api/sessions/{id}/stream watchers
        self.steer_rows: dict[str, list[dict]] = {}  # sid -> [{text, mid, applied}] for the running turn
        self.plans: dict[str, dict] = {}  # sid -> {title, phase: planning|awaiting|executing}
        self.cron_model = None  # tests inject a fake (text) -> cron line
        self.compact_model = None  # tests inject a fake (history, prompt) -> summary
        self.compact_futile: set[str] = set()  # sessions already told auto-compaction can't help
        self.loops = LP.LoopManager(self._loop_iteration, self._loop_event)
        try:
            n = U.backfill(self.store)
            if n:
                log.info("usage: backfilled %d past turns", n)
        except Exception as e:  # noqa: BLE001
            log.warning("usage backfill failed: %s", e)

    # session watchers / prefs ------------------------------------------------
    def relay(self, sid: str, ev: str, data: Any) -> None:
        subs = self.session_subs.get(sid)
        if not subs:
            return
        if isinstance(data, dict) and "final" in data and data["final"] is None:
            data = {k: v for k, v in data.items() if k != "final"}
        for q in list(subs):
            q.put_nowait((ev, data))

    def session_prefs(self, sid: str) -> dict:
        return self.store.kv_get(f"sprefs:{sid}", {}) or {}

    def set_session_prefs(self, sid: str, **kw) -> dict:
        p = {**self.session_prefs(sid), **{k: v for k, v in kw.items() if v is not None}}
        self.store.kv_set(f"sprefs:{sid}", p)
        return p

    def current_model(self, sid: Optional[str] = None) -> Optional[str]:
        if sid:
            m = self.session_prefs(sid).get("model")
            if m:
                return m
        cfg = C.load_config()
        prov = cfg.get("provider") or {}
        if prov.get("kind") == "local":
            return prov.get("recipe_id") or cfg.get("model")
        return prov.get("model") or cfg.get("model")

    def goal_state(self, sid: str) -> dict:
        row = self.store.get_session_row(sid) if sid not in self.pending else self.pending[sid]
        row = row or {}
        text = row.get("goal")
        status = row.get("goal_status") or ("active" if text else "cleared")
        if not text:
            status = "cleared"
        todos = [{"text": t.get("text", ""), "done": bool(t.get("done"))} for t in (row.get("todos") or [])
                 if t.get("status") != "cancelled"]
        progress = {"done": sum(1 for t in todos if t["done"]), "total": len(todos)} if (text and todos) else None
        return {"text": text, "status": status, "progress": progress, "todos": todos if text else []}

    # steering ---------------------------------------------------------------
    def steer(self, sid: str, text: str) -> str:
        """Inject `text` into the running turn ('steer') or hold it for right after it ('queued')."""
        ok = self.bridge.steer(sid, text)
        mid = self.store.add_message(sid, "user", text, {"display_only": True, "steer": True})
        self.steer_rows.setdefault(sid, []).append({"text": text, "mid": mid, "applied": False, "accepted": ok})
        return "steer" if ok else "queued"

    def _steer_applied(self, sid: str, injected: str) -> None:
        for r in self.steer_rows.get(sid, []):
            if not r["applied"] and r["text"].strip() in (injected or ""):
                r["applied"] = True

    # loops ------------------------------------------------------------------
    def _loop_event(self, st: "LP.LoopState", n: int) -> None:
        data = {"session_id": st.session_id, "n": n, "next_at": st.next_at if st.state == "waiting" else None,
                "state": st.state, "runs": st.runs, "max_runs": st.max_runs}
        self.hub.publish("loop", data)
        self.relay(st.session_id, "loop", data)

    async def _loop_iteration(self, sid: str, n: int, prompt: str, st: "LP.LoopState") -> Optional[str]:
        if self.bridge.busy(sid):
            return None
        model_prompt = prompt + (LP.UNTIL_DONE_SUFFIX if st.until_done else "")
        try:
            q = await self.start_chat(sid, prompt, source="loop", user_meta={"loop": {"n": n}},
                                      model_prompt=model_prompt)
        except web.HTTPConflict:
            return None
        while True:
            ev, data = await q.get()
            if ev == "done":
                mid = data.get("message_id")
                msg = next((m for m in reversed(self.store.messages(sid)) if m["id"] == mid), None)
                return (msg or {}).get("content") or ""
            if ev == "error":
                raise RuntimeError(data.get("message") or "turn failed")

    def spawn(self, coro) -> asyncio.Task:
        t = asyncio.create_task(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)
        return t

    # state -----------------------------------------------------------------
    def compute_state(self) -> str:
        cfg = C.load_config()
        kind = (cfg.get("provider") or {}).get("kind")
        if not kind:
            return "setup"
        if self.error:
            return "error"
        if kind == "local":
            st = (self.runtime.status() if self.runtime else {"state": "error"}).get("state")
            if st == "running" and self.runtime.base_url:
                self.bridge.runtime_base_url = self.runtime.base_url
                return "ready"
            return "error" if st == "error" else "starting_model"
        return "ready"

    def set_state(self, state: str) -> None:
        if state != self.state:
            self.state = state
            self.hub.publish("model", {"state": state})

    async def start_local_model(self) -> None:
        cfg = C.load_config()
        rid = (cfg.get("provider") or {}).get("recipe_id")
        rec = _recipes()
        recipe = rec.get(rid) if rec and rid else None
        if not (self.runtime and recipe):
            self.error = "local recipe or runtime missing"
            self.set_state("error")
            return
        self.set_state("starting_model")
        try:
            self.bridge.runtime_base_url = await self.runtime.start(recipe)
            self.error = None
            self.bridge.drop_all()
        except Exception as e:  # noqa: BLE001
            self.error = f"local model failed to start: {e}"
        self.set_state(self.compute_state())

    # sessions --------------------------------------------------------------
    def session_view(self, sid: str) -> Optional[dict]:
        if sid in self.pending:
            p = self.pending[sid]
            return {**p, "messages": [], "context": {"used": 0, "max": self._ctx_max_hint() or X.DEFAULT_CTX},
                    "yolo": self.approval_mode(sid) == "yolo", "goal_state": self.goal_state(sid),
                    "loop": self.loops.status(sid), **self._prefs_view(sid), "busy": False}
        row = self.store.get_session_row(sid)
        if not row:
            return None
        msgs = []
        for m in self.store.messages(sid):
            meta = m["meta"]
            out = {"id": m["id"], "role": m["role"], "content": m["content"], "created": m["created"]}
            if meta.get("reasoning"):
                out["reasoning"] = meta["reasoning"]
            if meta.get("tool"):
                out["tool"] = meta["tool"]
            if meta.get("usage"):
                out["usage"] = meta["usage"]
            if meta.get("kind"):
                out["kind"] = meta["kind"]
            for k in ("context", "summary", "steer", "loop", "plan", "model", "harness"):
                if meta.get(k):
                    out[k] = meta[k]
            msgs.append(out)
        return {"id": sid, "title": row["title"], "goal": row["goal"], "pinned": row["pinned"],
                "todos": row["todos"], "cwd": row["cwd"], "created": row["created"], "updated": row["updated"],
                "messages": msgs, "context": self.session_context(sid), "yolo": self.approval_mode(sid) == "yolo",
                "goal_state": self.goal_state(sid), "loop": self.loops.status(sid), **self._prefs_view(sid),
                "busy": self.bridge.busy(sid)}

    def _prefs_view(self, sid: str) -> dict:
        p = self.session_prefs(sid)
        return {"model": p.get("model") or self.current_model(), "effort": p.get("effort"), "harness": p.get("harness")}

    def ensure_persisted(self, sid: str) -> dict:
        if sid in self.pending:
            self.store.create_session(self.pending.pop(sid))
        row = self.store.get_session_row(sid)
        if not row:
            raise KeyError(sid)
        return row

    def hermes_history(self, sid: str) -> list[dict]:
        hist: list[dict] = []
        for m in self.store.messages(sid):
            meta = m["meta"]
            if "hermes" in meta:
                hist.extend(meta["hermes"])
            elif m["role"] in ("user", "assistant") and not meta.get("display_only"):
                hist.append({"role": m["role"], "content": m["content"]})
        return hist

    # chat pipeline ---------------------------------------------------------
    async def start_chat(self, sid: str, text: str, effort: Optional[str] = None,
                         attachments: Optional[list] = None, headless: bool = False,
                         harness: Optional[str] = None, source: str = "chat", user_meta: Optional[dict] = None,
                         model_prompt: Optional[str] = None, approvals: Optional[str] = None) -> asyncio.Queue:
        """Kick off a turn; returns a queue of (event, data) ending with done/error. Persistence runs
        in a background task, so a client disconnect never loses the reply.
        source: chat | loop | cron | steer (engine-started turns); model_prompt replaces the text sent to
        the model (the stored user message stays `text`)."""
        if self.bridge.busy(sid) or sid in self._starting:
            raise web.HTTPConflict(text=json.dumps({"error": "this chat is still answering — stop it first"}),
                                   content_type="application/json")
        row = self.ensure_persisted(sid)
        cfg = C.load_config()
        prefs = self.session_prefs(sid)
        effort = C.normalize_effort(effort) or C.normalize_effort(prefs.get("effort")) or cfg.get("effort_default", "medium")
        harness = harness if harness in C.HARNESSES else (prefs.get("harness") if prefs.get("harness") in C.HARNESSES
                                                          else cfg.get("harness", "lean"))
        if harness not in C.HARNESSES:
            harness = "lean"
        out = TurnQueue(self, sid, harness, self.current_model(sid))
        self.relay(sid, "turn_start", {"session_id": sid, "source": source, "text": text,
                                       **({"loop": user_meta["loop"]} if user_meta and user_meta.get("loop") else {})})
        self._starting.add(sid)
        task = self.spawn(self._chat_task(sid, row, text, effort, attachments or [], headless, out, harness,
                                          source=source, user_meta=user_meta, model_prompt=model_prompt,
                                          approvals=approvals))
        def _finished(_t):
            self._starting.discard(sid)
            if self.steer_rows.get(sid):  # queued during an engine command (no model turn drained them)
                self._after_turn_steers(sid, None)
        task.add_done_callback(_finished)
        return out

    async def _auto_title(self, sid: str, text: str) -> None:
        """Short 2-5 word title from the model (fallback: the truncated first message stays)."""
        def call() -> Optional[str]:
            import json as _j, urllib.request
            rt = self.bridge.resolve_provider()
            if not rt.base_url:
                return None
            body = {"model": rt.model, "max_tokens": 24, "temperature": 0.3,
                    "chat_template_kwargs": {"enable_thinking": False},
                    "messages": [{"role": "system", "content": "Write a 2-5 word title for this chat. Title case, no quotes, no punctuation at the end. Reply with the title only."},
                                 {"role": "user", "content": text[:1500]}]}
            req = urllib.request.Request(rt.base_url.rstrip("/") + "/chat/completions", data=_j.dumps(body).encode(),
                                         headers={"Content-Type": "application/json", "Authorization": f"Bearer {rt.api_key or 'x'}"})
            with urllib.request.urlopen(req, timeout=20) as r:
                d = _j.loads(r.read())
            t = (d["choices"][0]["message"].get("content") or "").strip().strip('"\'').splitlines()
            t = t[0].strip() if t else ""
            return t[:48] if 1 <= len(t.split()) <= 8 else None
        try:
            title = await asyncio.to_thread(call)
        except Exception as e:  # noqa: BLE001
            log.debug("auto title failed: %s", e)
            return
        if title:
            self.store.update_session(sid, title=title)
            self.hub.publish("session", {"id": sid, "title": title})

    async def _chat_task(self, sid, row, text, effort, attachments, headless, out: asyncio.Queue, harness="lean",
                         source="chat", user_meta=None, model_prompt=None, approvals=None):
        t0 = time.time()
        try:
            if row["title"] in (None, "", "New chat"):
                title = re.sub(r"\s+", " ", text.strip())[:60] or "New chat"
                self.store.update_session(sid, title=title)
                if not text.lstrip().startswith("/"):
                    self.spawn(self._auto_title(sid, text))
            if attachments:
                text = text + self._save_attachments(sid, attachments)
            cmd = S.parse(text) if model_prompt is None else None
            prompt = text if model_prompt is None else model_prompt
            plan = None
            if model_prompt is None and re.match(r"^/plan!(\s|$)", text.strip()):
                task = text.strip()[6:].strip()
                plan = self.plans[sid] = {"title": task or "plan", "phase": "executing"}
                prompt = S.plan_execute_prompt(task)
            elif cmd and cmd.name == "plan":
                plan = self.plans[sid] = {"title": cmd.arg or "plan", "phase": "planning"}
                prompt = S.plan_prompt(cmd.arg)
            elif model_prompt is None and not cmd and self.plans.get(sid, {}).get("phase") == "awaiting" \
                    and GO_WORDS.match(text):
                plan = self.plans[sid]
                plan["phase"] = "executing"
                prompt = S.PLAN_GO_PROMPT
            elif model_prompt is None and not cmd and self.plans.get(sid, {}).get("phase") == "awaiting":
                plan = self.plans[sid]  # revising the plan: keep mapping todo changes to plan events
                plan["phase"] = "planning"
            elif cmd and self.plans.get(sid, {}).get("phase") == "awaiting":
                self.plans.pop(sid, None)  # a different command abandons the pending plan
            if plan is not None:
                out.put_nowait(("plan", {"title": plan["title"], "phase": plan["phase"],
                                         "steps": plan_steps(self.store.get_session_row(sid)["todos"])
                                         if plan["phase"] != "planning" else []}))
            if cmd and cmd.name == "usage":
                return await self._cmd_usage(sid, text, cmd.arg, out)
            if cmd and cmd.name == "cron":
                return await self._cmd_cron(sid, text, cmd.arg, out)
            if cmd and cmd.name == "loop":
                return await self._cmd_loop(sid, text, cmd.arg, out)
            if cmd and cmd.name == "goal":
                return await self._cmd_goal(sid, text, cmd.arg, out)
            if cmd and cmd.name == "compact":
                return await self._cmd_compact(sid, text, out, t0, focus=cmd.arg)
            if cmd and cmd.name == "undo":
                return await self._cmd_undo(sid, text, out)
            if cmd and cmd.name == "yolo":
                return await self._cmd_yolo(sid, text, cmd.arg, out)
            if cmd and cmd.name == "lean":
                return await self._cmd_lean(sid, text, out, t0)
            if cmd is None or cmd.name == "plan":
                pass
            else:
                from . import knowledge as K
                body = K.skill_body_for_prompt(cmd.name)
                if body is not None:
                    p = K._find(cmd.name)
                    prompt = S.skill_prompt(cmd.name, body, cmd.arg, str(p.parent) if p else "")
                # unknown /word → sent as typed
            await self._run_model_turn(sid, row, text, prompt, effort, out, headless, t0, harness,
                                       user_meta=user_meta, approvals=approvals)
        except NotConfigured as e:
            out.put_nowait(("error", {"message": str(e)}))
        except Exception as e:  # noqa: BLE001
            log.exception("turn failed")
            out.put_nowait(("error", {"message": f"{type(e).__name__}: {e}"}))

    async def _run_model_turn(self, sid, row, shown_text, prompt, effort, out, headless, t0, harness="lean",
                              user_meta=None, approvals=None):
        try:
            await self._auto_compact(sid, out)
        except Exception as e:  # noqa: BLE001  never block the turn on a failed compaction
            log.warning("auto compaction (%s) failed: %s", sid, e)
            out.put_nowait(("notice", {"kind": "compact", "text": f"auto-compaction failed: {e}"}))
        history = self.hermes_history(sid)
        user_mid = self.store.add_message(sid, "user", shown_text, {"pending": True, **(user_meta or {})})
        srow = self.store.get_session_row(sid)
        goal = srow["goal"] if (srow.get("goal_status") or "active") == "active" else None
        tracker = X.begin_turn(sid, user_mid, row.get("cwd"), out, self.ckpt)  # labels/diffs/checkpoints
        self.steer_rows.setdefault(sid, [])  # steers queued before the agent existed stay (-> follow-up)
        turn = None
        try:
            turn, fut = await self.bridge.run_turn(
                sid, prompt, history, effort=effort, cwd=row.get("cwd"), system_extra=S.goal_context(goal),
                approvals=approvals or ("deny" if headless else self.approval_mode(sid)), harness=harness,
                model=self.session_prefs(sid).get("model"))
            out.model = turn.model or out.model
        except BaseException:
            X.end_turn(sid)
            raise
        try:
            await self._pump_model_turn(sid, shown_text, prompt, effort, out, headless, t0, history, user_mid,
                                        turn, fut, tracker, user_meta=user_meta)
        finally:
            X.end_turn(sid)
            self._after_turn_steers(sid, turn)

    def _after_turn_steers(self, sid: str, turn) -> None:
        """Steers that never reached the model (sent as it was finishing, or before the agent existed) become
        a follow-up turn right away, so nothing the user typed is lost. A user stop discards them."""
        rows = self.steer_rows.pop(sid, [])
        agent = getattr(turn, "agent", None)
        try:  # anything still buffered in the agent was not delivered; it'd leak into the next turn
            if agent is not None and hasattr(agent, "_drain_pending_steer"):
                agent._drain_pending_steer()
        except Exception:  # noqa: BLE001
            pass
        left = [r for r in rows if not r["applied"]]
        if not left or getattr(turn, "stopped", False):
            return
        with self.store._lock:
            for r in left:
                self.store.conn.execute("DELETE FROM messages WHERE id=?", (r["mid"],))
                self.store.conn.execute("DELETE FROM messages_fts WHERE message_id=?", (r["mid"],))
        text = "\n".join(r["text"] for r in left)
        self.relay(sid, "steer", {"text": text, "applied": False, "followup": True})
        self.spawn(self._steer_followup(sid, text))

    async def _steer_followup(self, sid: str, text: str) -> None:
        for _ in range(100):  # the finished turn's bookkeeping may still be releasing the session
            if not (self.bridge.busy(sid) or sid in self._starting):
                break
            await asyncio.sleep(0.05)
        try:
            q = await self.start_chat(sid, text, source="steer", user_meta={"steer": True, "followup": True})
        except Exception as e:  # noqa: BLE001
            log.warning("steer follow-up failed: %s", e)
            return
        while (await q.get())[0] not in ("done", "error"):
            pass

    async def _pump_model_turn(self, sid, shown_text, prompt, effort, out, headless, t0, history, user_mid,
                               turn, fut, tracker, user_meta=None):
        reasoning: list[str] = []
        tools: dict[str, dict] = {}
        timing = {"tool_s": 0.0, "tool_open": {}, "seg0": None, "seg1": None, "stream_s": 0.0}

        def close_segment():
            if timing["seg0"] is not None and timing["seg1"] is not None:
                timing["stream_s"] += max(0.0, timing["seg1"] - timing["seg0"])
            timing["seg0"] = timing["seg1"] = None

        async def pump():
            while True:
                getter = asyncio.ensure_future(turn.queue.get())
                done, _ = await asyncio.wait({getter, fut}, return_when=asyncio.FIRST_COMPLETED)
                if getter not in done:
                    getter.cancel()
                    while not turn.queue.empty():
                        yield turn.queue.get_nowait()
                    return
                yield getter.result()

        async for event, data in pump():
            now = time.time()
            if event in ("delta", "reasoning"):
                if timing["seg0"] is None:
                    timing["seg0"] = now
                timing["seg1"] = now
            elif event == "tool_start":
                close_segment()
                timing["tool_open"][data.get("id")] = now
            elif event == "tool_end":
                st = timing["tool_open"].pop(data.get("id"), None)
                if st is not None:
                    timing["tool_s"] += now - st
            if event == "reasoning":
                reasoning.append(data["text"])
            if event == "tool_start":
                tools[data["id"]] = {"name": data["name"], "args": data.get("args"), "label": data.get("label")}
            if event == "tool_end":
                args, result = data.pop("_args", None), data.pop("_result", None)
                t = tools.setdefault(data["id"], {"name": data["name"]})
                t.update(result=result, ok=data["ok"])
                for k in ("diff", "seconds"):
                    if data.get(k) is not None:
                        t[k] = data[k]
                if t.get("args") is None:
                    t["args"] = args
                self.store.add_message(sid, "tool", data.get("result_preview", ""),
                                       {"display_only": True, "tool": {**t, "id": data["id"]}})
            if event == "steer":
                self._steer_applied(sid, data.get("text") or "")
            out.put_nowait((event, data))
            if event == "todo":
                self.store.update_session(sid, todos=data["todos"])
                plan = self.plans.get(sid)
                if plan is not None:
                    out.put_nowait(("plan", {"title": plan["title"], "phase": plan["phase"],
                                             "steps": plan_steps(data["todos"])}))

        try:
            result = fut.result()
        except Exception as e:  # noqa: BLE001
            self._fix_user_row(sid, user_mid, prompt)
            out.put_nowait(("error", {"message": f"{type(e).__name__}: {e}"}))
            return
        end = time.time()
        all_msgs = list(result.get("messages") or [])
        if tracker.compacted:
            # Hermes compacted the transcript mid-turn: what it returned replaces the model history. Older rows
            # stay for display but stop feeding the model; this turn's assistant row carries the whole new history.
            self._drop_model_history(sid, before_mid=user_mid)
            user_h, rest = [], all_msgs
        else:
            new_msgs = all_msgs[len(history):]
            if new_msgs and new_msgs[0].get("role") == "user":
                user_h, rest = [new_msgs[0]], new_msgs[1:]
            else:
                user_h, rest = [{"role": "user", "content": prompt}], new_msgs
        self._set_meta(user_mid, {"hermes": user_h, **(user_meta or {})})
        final = result.get("final_response") or ""
        from .agent_bridge import turn_tokens
        toks = turn_tokens(result, getattr(turn, "base", {}) or {})
        usage = {"input": toks["input_tokens"], "output": toks["output_tokens"]}
        if toks["cache_read_tokens"]:
            usage["cached"] = toks["cache_read_tokens"]
        context = X.context_info(turn.agent, result, self._ctx_max_hint())
        context["max_effective"] = CP.effective_max(context["max"], CP.settings(C.load_config()))
        usage["last_input"] = context["used"]
        close_segment()
        tps = turn_tps(usage["output"], end - t0, timing["tool_s"], timing["stream_s"])
        files_changed = [{"path": f["path"], "added": f["added"], "removed": f["removed"]}
                         for f in await asyncio.to_thread(tracker.files_changed)]
        summary = {"tools": tracker.tool_count, "files_changed": files_changed, "seconds": round(end - t0, 2),
                   "tps": tps, "output_tokens": usage["output"]}
        harness = getattr(turn.agent, "_pico_harness", None) or "hermes"
        model = turn.model or out.model
        meta = {"hermes": rest, "usage": usage, "tps": tps, "effort": effort, "context": context, "summary": summary,
                "model": model, "harness": harness}
        if reasoning or result.get("last_reasoning"):
            meta["reasoning"] = "".join(reasoning) or result.get("last_reasoning")
        if result.get("interrupted") or turn.stopped:
            meta["stopped"] = True  # Hermes' returned transcript is already history-valid
        mid = self.store.add_message(sid, "assistant", final, meta)
        if usage["input"] or usage["output"]:
            self.store.add_usage({"session_id": sid, "model": model, "harness": harness, "input": usage["input"],
                                  "output": usage["output"], "cached": usage.get("cached", 0),
                                  "seconds": round(end - t0, 2), "tools": tracker.tool_count, "tps": tps,
                                  "message_id": mid})
        if result.get("failed") and not final:
            out.put_nowait(("error", {"message": result.get("error") or "the model call failed"}))
            return
        extra: dict = {}
        plan = self.plans.get(sid)
        if plan is not None:
            steps = plan_steps(self.store.get_session_row(sid)["todos"]) if tools_touched_todo(tools) else []
            if not steps and plan["phase"] == "planning":
                steps = plan_steps_from_text(final)
            if plan["phase"] == "planning":
                plan["phase"] = "awaiting" if not meta.get("stopped") else "planning"
            elif plan["phase"] == "executing":
                self.plans.pop(sid, None)
                plan = {**plan, "phase": "done"}
            if steps or plan["phase"] in ("awaiting", "done"):
                ev = {"title": plan["title"], "phase": plan["phase"],
                      "steps": steps or plan_steps(self.store.get_session_row(sid)["todos"])}
                out.put_nowait(("plan", ev))
                extra["plan"] = ev
        srow = self.store.get_session_row(sid)
        if srow.get("goal") and (srow.get("goal_status") or "active") == "active":
            if GOAL_DONE_RE.search(final):
                self.store.update_session(sid, goal_status="done")
            gs = self.goal_state(sid)
            out.put_nowait(("goal", gs))
            extra["goal_state"] = gs
        out.put_nowait(("done", {"message_id": mid, "usage": usage, "tps": tps, "seconds": round(end - t0, 2),
                                 "stopped": bool(meta.get("stopped")), "final": final if headless else None,
                                 "context": context, "summary": summary, "yolo": self.approval_mode(sid) == "yolo",
                                 "harness": harness, "model": model,
                                 "profile": self.profile_brief(harness, (self.store.get_session_row(sid) or {}).get("cwd")),
                                 **({"compacted": tracker.compacted[-1]} if tracker.compacted else {}), **extra}))
        if getattr(turn.agent, "_pico_harness", None) == "lean" and final and not meta.get("stopped"):
            # learn memories / skills off the hot path: `done` is already queued
            self.spawn(self._memory_pass(sid, shown_text, final, [t.get("name") for t in tools.values()]))

    async def _memory_pass(self, sid: str, user_text: str, final: str, tools_used: list) -> None:
        from . import lean as L
        self.memory_passes = getattr(self, "memory_passes", 0) + 1
        t0 = time.time()
        try:
            rt = self.bridge.resolve_provider()
            fn = self.memory_pass_model or _memory_pass_call
            actions = await asyncio.to_thread(L.run_memory_pass, rt, user_text, final, tools_used, fn)
        except Exception as e:  # noqa: BLE001
            log.info("memory pass (%s) failed: %s", sid, e)
            return
        log.info("memory pass (%s) finished in %.1fs: %s", sid, time.time() - t0, "; ".join(actions) or "no changes")
        if actions:
            self.bridge.drop_agent(sid)  # next turn re-reads core memory / skills index

    def _ctx_max_hint(self) -> Optional[int]:
        """Model context length from config (local recipe ctx) when Hermes hasn't detected one."""
        cfg = C.load_config()
        prov = cfg.get("provider") or {}
        if prov.get("context_length"):
            return int(prov["context_length"])
        if prov.get("kind") == "local":
            rec = _recipes()
            r = rec.get(prov.get("recipe_id")) if rec and prov.get("recipe_id") else None
            if r and r.get("ctx"):
                return int(r["ctx"])
        return None

    def session_context(self, sid: str) -> dict:
        s = CP.settings(C.load_config())
        for m in reversed(self.store.messages(sid)):
            c = (m["meta"] or {}).get("context")
            if c:
                return {**c, "max_effective": CP.effective_max(c.get("max"), s)}
        mx = self._ctx_max_hint() or X.DEFAULT_CTX
        return {"used": 0, "max": mx, "max_effective": CP.effective_max(mx, s)}

    # profile size / compaction ---------------------------------------------
    def profile_context(self, harness: Optional[str] = None, cwd: Optional[str] = None) -> dict:
        harness = harness if harness in C.HARNESSES else C.load_config().get("harness", "lean")
        def mt(p: Path) -> float:
            try:
                return p.stat().st_mtime
            except OSError:
                return 0.0
        hh = C.hermes_home()
        key = (harness, cwd, X.profile_generation(), mt(hh / "memories" / "USER.md"), mt(hh / "memories" / "MEMORY.md"),
               mt(hh / "skills"), mt(C.pico_home() / "config.json"))
        cache = self.__dict__.setdefault("_profile_cache", {})
        if key not in cache:
            cache.clear()
            cache[key] = CP.profile_context(harness, cwd)
        return dict(cache[key])

    def profile_brief(self, harness: Optional[str] = None, cwd: Optional[str] = None) -> dict:
        try:
            return CP.profile_brief(self.profile_context(harness, cwd))
        except Exception as e:  # noqa: BLE001
            log.debug("profile size failed: %s", e)
            return {"tokens": 0, "budget": 0, "estimate": True}

    def _drop_model_history(self, sid: str, before_mid: Optional[str] = None, upto: Optional[int] = None) -> None:
        """Older rows stay visible but no longer reach the model (meta.hermes = [], compacted_out)."""
        rows = self.store.messages(sid)
        for i, m in enumerate(rows):
            if (before_mid and m["id"] == before_mid) or (upto is not None and i >= upto):
                break
            if CP.row_hermes(m) or "hermes" in m["meta"]:
                self._set_meta(m["id"], {**m["meta"], "hermes": [], "compacted_out": True})

    async def _summarize(self, sid: str, history: list, focus: str = "") -> tuple[str, dict]:
        srow: dict = self.store.get_session_row(sid) or {}
        goal = srow.get("goal") if (srow.get("goal_status") or "active") == "active" else None
        prompt = CP.summary_prompt(S.COMPACT_PROMPT, focus, goal, srow.get("todos"))
        if self.compact_model:  # tests
            return self.compact_model(history, prompt), {}
        turn, fut = await self.bridge.run_turn(sid, prompt, history, effort="off", cwd=None, toolsets=[],
                                               approvals="deny")
        while not fut.done():
            try:
                await asyncio.wait_for(turn.queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                pass
        result = fut.result()
        for _ in range(100):  # the bridge releases the session in a done-callback; the real turn follows
            if not self.bridge.busy(sid):
                break
            await asyncio.sleep(0.02)
        summary = (result.get("final_response") or "").strip()
        if not summary:
            raise RuntimeError("compaction produced no summary")
        return summary, result

    @staticmethod
    def _summary_pair(summary: str) -> list:
        return [{"role": "user", "content": "Here is a summary of our earlier conversation (older messages were "
                                            "compacted):\n\n" + summary},
                {"role": "assistant", "content": "Got it — I'll continue from this summary."}]

    async def _auto_compact(self, sid: str, out) -> Optional[dict]:
        """Before a turn: compact older history once the last turn crossed compaction.at_pct of the effective
        context. Keeps the newest keep_recent messages verbatim (cut on a user message); goal/todos/plan live
        on the session row and in the summary prompt. Emits `compacted {before, after, auto, reason}`."""
        s = CP.settings(C.load_config())
        ctx = self.session_context(sid)
        if not CP.over_threshold(ctx, s):
            return None
        rows = self.store.messages(sid)
        used0, mx = int(ctx["used"]), CP.effective_max(ctx.get("max"), s)
        overhead = used0 - CP.history_tokens([h for m in rows for h in CP.row_hermes(m)])
        if overhead * 100 >= s["at_pct"] * mx:
            # system prompt + tools alone exceed the threshold: compacting history can't get under it and would
            # re-summarize every turn. Tell the client once per session.
            if sid not in self.compact_futile:
                self.compact_futile.add(sid)
                out.put_nowait(("notice", {"kind": "compact", "text": f"auto-compaction skipped: the fixed prompt "
                                           f"(~{max(0, overhead):,} tokens) alone is over {s['at_pct']}% of "
                                           f"{mx:,} — raise compaction.max_ctx_override"}))
            return None
        cut = CP.split_rows(rows, s["keep_recent"])
        older = [h for m in rows[:cut] for h in CP.row_hermes(m)]
        old_tok = CP.history_tokens(older)
        if (used0 - old_tok) * 100 >= s["at_pct"] * mx:
            # the recent messages alone are over the threshold: keeping keep_recent verbatim would re-trigger
            # every turn, so cut down to the last exchange (the minimum, keep_recent=2)
            cut2 = CP.split_rows(rows, 2)
            if cut2 > cut:
                cut = cut2
                older = [h for m in rows[:cut] for h in CP.row_hermes(m)]
                old_tok = CP.history_tokens(older)
        if cut <= 0 or not older or old_tok < 200:  # nothing worth summarizing (avoid thrash)
            return None
        method = None
        if s["mode"] == "trim":
            trimmed, n = CP.trim_tool_outputs(older)
            est = used0 - (old_tok - CP.history_tokens(trimmed))
            if n and est * 100 < s["at_pct"] * mx:
                for m in rows[:cut]:
                    if m["meta"].get("hermes"):
                        new_h, k = CP.trim_tool_outputs(m["meta"]["hermes"])
                        if k:
                            self._set_meta(m["id"], {**m["meta"], "hermes": new_h})
                method, after = "trim", max(0, est)
        if method is None:
            out.put_nowait(("reasoning", {"text": "Compacting older messages…"}))
            src = CP.trim_tool_outputs(older)[0] if s["mode"] == "trim" else older
            summary, _res = await self._summarize(sid, src)
            self._drop_model_history(sid, upto=cut)
            first = self.store.messages(sid)[cut]
            self._set_meta(first["id"], {**first["meta"], "hermes": self._summary_pair(summary) + CP.row_hermes(first),
                                         "compact_summary": summary})
            method = "summary" if s["mode"] == "summary" else "trim+summary"
            after = max(0, used0 - old_tok + CP.history_tokens(self._summary_pair(summary)))
        self.bridge.drop_agent(sid)
        ev = {"before": used0, "after": int(after), "auto": True, "reason": "threshold", "method": method,
              "kept": sum(len(CP.row_hermes(m)) for m in self.store.messages(sid)[cut:]),
              "at_pct": s["at_pct"], "max_effective": mx}
        last = self.store.messages(sid)[-1]
        self._set_meta_merge(last["id"], {"context": {**(last["meta"].get("context") or ctx), "used": int(after)}})
        out.put_nowait(("compacted", ev))
        if s["notify"]:
            out.put_nowait(("notice", {"kind": "compact", "text": f"Compacted older messages ({method}): "
                                       f"~{used0:,} → ~{int(after):,} tokens"}))
        return ev

    def approval_mode(self, sid) -> str:
        if sid in self.yolo or C.load_config().get("approvals") == "yolo":
            return "yolo"
        return "ask"

    async def _cmd_yolo(self, sid, text, arg, out):
        """/yolo [on|off]: this chat runs commands without asking. Global default: config approvals=yolo."""
        a = (arg or "").strip().lower()
        on = (sid not in self.yolo) if a not in ("on", "off") else a == "on"
        (self.yolo.add if on else self.yolo.discard)(sid)
        glob = C.load_config().get("approvals") == "yolo"
        reply = ("yolo on: commands run without asking in this chat. /yolo again to turn it off." if on else
                 "yolo off: Pico asks before risky commands again." + (" (approvals is still yolo in config)" if glob else ""))
        self.store.add_message(sid, "user", text, {"display_only": True, "kind": "command"})
        mid = self.store.add_message(sid, "assistant", reply, {"display_only": True, "kind": "command"})
        out.put_nowait(("delta", {"text": reply}))
        out.put_nowait(("done", {"message_id": mid, "usage": {"input": 0, "output": 0}, "tps": None, "seconds": 0,
                                 "yolo": on or glob}))

    async def _cmd_undo(self, sid, text, out):
        res = await asyncio.to_thread(undo_last_turn, self.store, self.ckpt, sid)
        self.bridge.drop_agent(sid)
        reply = res["note"]
        self.store.add_message(sid, "user", text, {"display_only": True, "kind": "command", "undo": True})
        mid = self.store.add_message(sid, "assistant", reply, {"display_only": True, "kind": "command", "undo": True})
        out.put_nowait(("delta", {"text": reply}))
        out.put_nowait(("done", {"message_id": mid, "usage": {"input": 0, "output": 0}, "tps": None, "seconds": 0,
                                 "undo": res, "context": self.session_context(sid)}))

    def _fix_user_row(self, sid, mid, prompt):
        self._set_meta(mid, {"hermes": [{"role": "user", "content": prompt}], "failed": True})

    def _set_meta_merge(self, mid: str, extra: dict) -> None:
        with self.store._lock:
            row = self.store.conn.execute("SELECT meta FROM messages WHERE id=?", (mid,)).fetchone()
            meta = {**json.loads((row[0] if row else None) or "{}"), **extra}
            self.store.conn.execute("UPDATE messages SET meta=? WHERE id=?", (json.dumps(meta, default=str), mid))

    def _set_meta(self, mid: str, meta: dict) -> None:
        with self.store._lock:
            self.store.conn.execute("UPDATE messages SET meta=? WHERE id=?", (json.dumps(meta, default=str), mid))

    def _save_attachments(self, sid: str, atts: list) -> str:
        notes = []
        d = C.pico_home() / "uploads" / sid
        d.mkdir(parents=True, exist_ok=True)
        for a in atts[:10]:
            name = re.sub(r"[^A-Za-z0-9._-]", "_", str(a.get("name") or "file"))[:80]
            try:
                data = base64.b64decode(a.get("data_b64") or "", validate=False)
            except Exception:  # noqa: BLE001
                continue
            p = d / f"{uuid.uuid4().hex[:6]}-{name}"
            p.write_bytes(data)
            notes.append(f"[Attached file: {p} ({a.get('mime') or 'unknown type'}, {len(data)} bytes)]")
        return ("\n\n" + "\n".join(notes)) if notes else ""

    async def _cmd_goal(self, sid, text, arg, out):
        emit = True
        if arg.lower() in ("clear", "none", "off", "-"):
            self.store.update_session(sid, goal=None, goal_status="cleared", todos=[])
            reply = "Goal cleared."
        elif arg.lower() in ("done", "complete", "finished"):
            self.store.update_session(sid, goal_status="done")
            reply = "Goal marked done."
        elif arg:
            self.store.update_session(sid, goal=arg, goal_status="active", todos=[])
            reply = f"Goal set: {arg}"
        else:
            emit = False
            gs = self.goal_state(sid)
            reply = (f"Current goal ({gs['status']}): {gs['text']}" + (
                f" — {gs['progress']['done']}/{gs['progress']['total']} steps done" if gs["progress"] else "")
                     ) if gs["text"] else "No goal set. Use /goal <what you want done>."
        if emit:
            out.put_nowait(("goal", self.goal_state(sid)))
        self.store.add_message(sid, "user", text, {"display_only": True, "kind": "command"})
        mid = self.store.add_message(sid, "assistant", reply, {"display_only": True, "kind": "command"})
        out.put_nowait(("delta", {"text": reply}))
        out.put_nowait(("done", {"message_id": mid, "usage": {"input": 0, "output": 0}, "tps": None, "seconds": 0,
                                 "goal": self.store.get_session_row(sid)["goal"], "goal_state": self.goal_state(sid)}))

    # /usage /cron /loop -------------------------------------------------------
    def _command_reply(self, sid, text, reply, out, **done_extra):
        self.store.add_message(sid, "user", text, {"display_only": True, "kind": "command"})
        mid = self.store.add_message(sid, "assistant", reply, {"display_only": True, "kind": "command"})
        out.put_nowait(("delta", {"text": reply}))
        out.put_nowait(("done", {"message_id": mid, "usage": {"input": 0, "output": 0}, "tps": None, "seconds": 0,
                                 **done_extra}))

    def usage_report(self, days: int = 30) -> dict:
        days = max(1, min(366, int(days)))
        return U.aggregate(self.store.usage_rows(time.time() - days * 86400 - 86400), days)

    async def _cmd_usage(self, sid, text, arg, out):
        m = re.match(r"^(\d+)\s*d?", (arg or "").strip())
        rep = self.usage_report(int(m.group(1)) if m else 30)
        self._command_reply(sid, text, U.summary_text(rep), out, usage_report=rep)

    def checkins_view(self) -> list[dict]:
        return [checkin_view(c) for c in self.store.list_checkins()]

    def _resolve_checkin(self, ref: str) -> Optional[dict]:
        ref = (ref or "").strip()
        items = self.store.list_checkins()
        if ref.isdigit() and len(ref) <= 3:  # list position from /cron
            return items[int(ref) - 1] if 1 <= int(ref) <= len(items) else None
        exact = next((c for c in items if c["id"] == ref), None)
        if exact or len(ref) < 6:
            return exact
        hits = [c for c in items if c["id"].endswith(ref) or c["id"].startswith(ref)]
        return hits[0] if len(hits) == 1 else None

    async def parse_schedule(self, sched) -> dict:
        """normalize_schedule, falling back to one model call (validated cron) for free text it can't parse."""
        try:
            return normalize_schedule(sched)
        except ValueError:
            text = sched.get("text") if isinstance(sched, dict) else sched if isinstance(sched, str) else None
            if not text:
                raise
            if not SC.cron_expressible(text):
                raise ValueError(f"can't schedule {text!r} exactly — try e.g. 'every monday at 9am' or a cron line "
                                 "like '0 9 1-7 * *' (days 1-7 of each month)") from None
            line = await self._cron_from_model(text)
            if not line:
                raise
            try:
                out = normalize_schedule({"cron": line})
            except ValueError:
                raise ValueError(f"couldn't understand the schedule {text!r}") from None
            out["text"] = text
            return out

    async def _cron_from_model(self, text: str) -> Optional[str]:
        if self.cron_model:
            return self.cron_model(text)
        def call():
            rt = self.bridge.resolve_provider()
            if rt.kind == "openai_login":
                from .lean import aux_completion
                return aux_completion(rt, [{"role": "system", "content": SC.CRON_FALLBACK_PROMPT},
                                           {"role": "user", "content": text}])
            return _memory_pass_call(rt, [{"role": "system", "content": SC.CRON_FALLBACK_PROMPT},
                                          {"role": "user", "content": text}])
        try:
            raw = await asyncio.to_thread(call)
        except Exception as e:  # noqa: BLE001
            log.info("cron fallback failed: %s", e)
            return None
        if (raw or "").strip().upper().startswith("NONE"):
            return None
        m = re.search(r"([\d*/,\-]+(?:\s+[\d*/,\-A-Za-z]+){4})", (raw or "").strip().strip("`"))
        return m.group(1) if m else None

    def add_checkin(self, title: Optional[str], prompt: str, sched: dict, yolo: bool = False) -> dict:
        c = self.store.add_checkin({"title": (title or prompt[:40]).strip(), "prompt": prompt, "schedule": sched,
                                    "yolo": yolo})
        c = self.scheduler.schedule_new(c)
        self.scheduler.poke()
        return checkin_view(self.store.get_checkin(c["id"]))

    async def _cmd_cron(self, sid, text, arg, out):
        a = (arg or "").strip()
        verb, _, rest = a.partition(" ")
        verb = verb.lower()
        try:
            if not a or verb in ("ls", "list"):
                items = self.checkins_view()
                reply = "No scheduled jobs. Add one: /cron every weekday at 8am -- summarize my inbox" if not items else \
                    "\n".join(f"{i}. {'⏸ ' if not c['enabled'] else ''}{c['title']} — {c['schedule_text']}"
                              + (f" · next {_when(c['next_run'])}" if c.get("next_run") and c["enabled"] else "")
                              + (f" · last {c['last_status']}" if c.get("last_status") else "")
                              for i, c in enumerate(items, 1))
            elif verb in ("rm", "del", "delete", "remove"):
                c = self._resolve_checkin(rest)
                if not c:
                    raise ValueError(f"no job {rest!r} (see /cron)")
                self.store.delete_checkin(c["id"])
                reply = f"Removed: {c['title']}"
            elif verb in ("pause", "resume", "enable", "disable"):
                c = self._resolve_checkin(rest)
                if not c:
                    raise ValueError(f"no job {rest!r} (see /cron)")
                on = verb in ("resume", "enable")
                self.store.update_checkin(c["id"], enabled=on)
                if on:
                    self.scheduler.schedule_new(self.store.get_checkin(c["id"]))
                    self.scheduler.poke()
                reply = f"{'Resumed' if on else 'Paused'}: {c['title']}"
            elif verb == "run":
                c = self._resolve_checkin(rest)
                if not c:
                    raise ValueError(f"no job {rest!r} (see /cron)")
                self.scheduler.fire_now(c)
                reply = f"Running now: {c['title']} — the result will land in your inbox."
            else:
                body = rest if verb == "add" else a
                if " -- " in f" {body} ":
                    when, _, prompt = body.partition("--")
                    when, prompt = when.strip(), prompt.strip()
                else:
                    when, prompt = _split_schedule(body)
                if not (when and prompt):
                    raise ValueError("usage: /cron add <when> -- <prompt>   e.g. /cron every weekday at 8am -- check my calendar")
                sched = await self.parse_schedule({"text": when})
                c = self.add_checkin(None, prompt, sched)
                reply = f"Scheduled: {c['title']} — {c['schedule_text']}, next {_when(c['next_run'])}."
        except ValueError as e:
            reply = str(e)
        self._command_reply(sid, text, reply, out, crons=self.checkins_view())

    async def _cmd_loop(self, sid, text, arg, out):
        try:
            a = LP.parse_args(arg)
        except ValueError as e:
            return self._command_reply(sid, text, str(e), out, loop=self.loops.status(sid))
        if a["action"] == "status":
            reply = LP.describe(self.loops.status(sid))
        elif a["action"] == "stop":
            reply = "Loop stopped." if self.loops.stop(sid) else "No loop was running."
        else:
            # the first iteration starts right after this command's turn ends (the session is busy now)
            self.loops.start(sid, a["prompt"], a["every_s"], a["until_done"], a["max_runs"], first_delay=0.3)
            reply = (f"Looping until done (max {a['max_runs']} runs): {a['prompt']}" if a["until_done"] else
                     f"Looping every {SC.fmt_interval(a['every_s'])} (max {a['max_runs']} runs): {a['prompt']}. "
                     "/loop stop to end it.")
        self._command_reply(sid, text, reply, out, loop=self.loops.status(sid))

    async def _cmd_lean(self, sid, text, out, t0):
        """/lean: compact the user profile (Hermes memory) and report the measured speedup."""
        from . import lean_profile as LP
        from . import knowledge as K
        loop = asyncio.get_running_loop()
        buf: list[str] = []

        def emit(chunk: str) -> None:
            buf.append(chunk)
            loop.call_soon_threadsafe(out.put_nowait, ("delta", {"text": chunk}))

        self.store.add_message(sid, "user", text, {"display_only": True, "kind": "command"})
        try:
            rt = self.bridge.resolve_provider()
            store = await asyncio.to_thread(K._store)
            mem_dir = Path(os.environ.get("HERMES_HOME", str(C.pico_home() / "hermes"))) / "memories"
            res = await asyncio.to_thread(LP.run, rt, store, mem_dir, emit)
            self.bridge.drop_all()  # next turns pick up the slimmer profile
            if not res.get("skipped"):
                self.hub.publish("notice", {"session_id": sid, "kind": "memory",
                                            "text": f"profile slimmed {res['notes_before']}→{res['notes_after']} notes · {res['speed_pct']:+.0f}% faster"})
        except Exception as e:  # noqa: BLE001
            emit(f"\n/lean failed: {e}\n")
            res = {"error": str(e)}
        mid = self.store.add_message(sid, "assistant", "".join(buf), {"display_only": True, "kind": "command"})
        out.put_nowait(("done", {"message_id": mid, "usage": {"input": 0, "output": 0}, "tps": None,
                                 "seconds": round(time.time() - t0, 2), "lean": res}))

    async def _cmd_compact(self, sid, text, out, t0, focus: str = ""):
        history = self.hermes_history(sid)
        if not history:
            reply = "Nothing to compact yet."
            mid = self.store.add_message(sid, "assistant", reply, {"display_only": True, "kind": "command"})
            out.put_nowait(("delta", {"text": reply}))
            out.put_nowait(("done", {"message_id": mid, "usage": {"input": 0, "output": 0}, "tps": None, "seconds": 0}))
            return
        out.put_nowait(("reasoning", {"text": "Compacting conversation…"}))
        summary, result = await self._summarize(sid, history, focus)
        before = len(self.store.messages(sid))
        ctx_prev = self.session_context(sid)
        tok_before = ctx_prev.get("used") or _rough_tokens(history)
        self.store.replace_messages(sid, [{
            "role": "assistant", "content": f"Summary of the earlier conversation:\n\n{summary}",
            "meta": {"kind": "compact", "hermes": self._summary_pair(summary)}}])
        self.bridge.drop_agent(sid)
        mid = self.store.messages(sid)[-1]["id"]
        self._set_meta_merge(mid, {"context": {"used": _rough_tokens(self.hermes_history(sid)),
                                               "max": ctx_prev.get("max") or X.DEFAULT_CTX}})
        usage = {"input": int(result.get("input_tokens") or 0), "output": int(result.get("output_tokens") or 0)}
        tok_after = _rough_tokens(self.hermes_history(sid))
        out.put_nowait(("compacted", {"before": int(tok_before), "after": int(tok_after), "auto": False,
                                      "reason": "manual", **({"focus": focus} if focus else {})}))
        out.put_nowait(("delta", {"text": f"Compacted {before} messages into a summary."}))
        out.put_nowait(("done", {"message_id": mid, "usage": usage, "tps": None, "seconds": round(time.time() - t0, 2),
                                 "compacted": before,
                                 "context": self.session_context(sid)}))

    async def run_headless(self, sid: str, text: str, approvals: Optional[str] = None,
                           source: str = "chat") -> tuple[str, Optional[str]]:
        q = await self.start_chat(sid, text, headless=True, approvals=approvals, source=source)
        while True:
            ev, data = await q.get()
            if ev == "done":
                return (data.get("final") or ""), None
            if ev == "error":
                return "", data.get("message")

    async def _run_checkin(self, c: dict) -> None:
        sid = new_id("s_")
        self.store.create_session({"id": sid, "title": c["title"], "source": "checkin"})
        self.store.update_checkin(c["id"], session_id=sid, last_status="running")
        try:
            final, err = await self.run_headless(sid, c["prompt"], approvals="yolo" if c.get("yolo") else "deny",
                                                 source="cron")
        except Exception as e:  # noqa: BLE001
            final, err = "", f"{type(e).__name__}: {e}"
        self.store.update_checkin(c["id"], last_status="error" if err else "ok")
        body = final if not err else f"Couldn't run this check-in: {err}"
        item = self.store.add_inbox(c["title"], body, sid)
        self.hub.publish("inbox", {"item": item, "checkin_id": c["id"]})


# ── HTTP layer ───────────────────────────────────────────────────────────────

def J(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda o: json.dumps(o, default=str))


def err(status: int, message: str) -> web.Response:
    return J({"error": message}, status)


async def body(request: web.Request) -> dict:
    if not request.can_read_body:
        return {}
    try:
        d = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text='{"error":"invalid JSON"}', content_type="application/json")
    return d if isinstance(d, dict) else {}


def make_app(engine: Optional[Engine] = None) -> web.Application:
    eng = engine or Engine()

    @web.middleware
    async def auth_mw(request: web.Request, handler):
        path = request.path
        if not path.startswith("/api/") or (request.method, path) in PUBLIC or request.method == "OPTIONS":
            return await handler(request)
        tok = ""
        h = request.headers.get("Authorization", "")
        if h.lower().startswith("bearer "):
            tok = h[7:].strip()
        tok = tok or request.query.get("token", "")
        if tok and _check_token(eng, tok):
            return await handler(request)
        return err(401, "missing or invalid token")

    app = web.Application(middlewares=[auth_mw], client_max_size=64 * 1024 * 1024)
    app[ENGINE_KEY] = eng
    r = app.router

    # core ---------------------------------------------------------------
    async def health(_):
        eng.set_state(eng.compute_state())
        cfg = C.load_config()
        out = {"ok": True, "version": __version__, "state": eng.state, "model": cfg.get("model") or (cfg.get("provider") or {}).get("model"),
               "provider": (cfg.get("provider") or {}).get("kind")}
        if eng.error:
            out["error"] = eng.error
        return J(out)

    async def system(_):
        return J(await asyncio.to_thread(_hw_scan))

    async def get_config(_):
        return J(C.public_config())

    async def patch_config(request):
        try:
            cfg = C.apply_patch(await body(request))
        except ValueError as e:
            return err(400, str(e))
        sync_hermes_config(C.load_config())
        eng.bridge.drop_all()
        return J(cfg)

    r.add_get("/api/health", health)
    r.add_get("/api/system", system)
    r.add_get("/api/config", get_config)
    r.add_patch("/api/config", patch_config)

    # recipes / setup / models ---------------------------------------------
    async def recipes(request):
        rec = _recipes()
        persona = request.query.get("persona", "general")
        if not rec:
            return J({"recommended": None, "alternatives": [], "catalog_version": "unavailable"})
        sysinfo = await asyncio.to_thread(_hw_scan)
        return J(await asyncio.to_thread(rec.recommend, sysinfo, persona))

    async def updates(_):
        rec = _recipes()
        if not rec:
            return J({"available": []})
        cfg = C.load_config()
        cur = (cfg.get("provider") or {}).get("recipe_id") if (cfg.get("provider") or {}).get("kind") == "local" else None
        sysinfo = await asyncio.to_thread(_hw_scan)
        try:
            avail = await asyncio.to_thread(rec.updates, sysinfo, cur)
        except TypeError:
            avail = await asyncio.to_thread(rec.updates, sysinfo, cur, cfg.get("persona", "general"))
        return J({"available": avail})

    async def setup(request):
        b = await body(request)
        prov = b.get("provider") or {}
        kind = prov.get("kind")
        if kind == "openai_login" and b.get("model") and not prov.get("model"):
            prov["model"] = b["model"]
        if not b.get("persona") and not (C.pico_home() / "config.json").exists():
            b["persona"] = "engineer"
        if kind not in ("local", "custom", "openai_login"):
            return err(400, "provider.kind must be local, custom or openai_login")
        if kind == "custom" and not (prov.get("base_url") and prov.get("model")):
            return err(400, "custom provider needs base_url and model")
        if kind == "local" and not prov.get("recipe_id"):
            return err(400, "local provider needs recipe_id")
        job = Job("setup")
        eng.jobs[job.id] = job
        eng.spawn(_run_setup(eng, job, b))
        return J({"job_id": job.id})

    async def job_events(request):
        job = eng.jobs.get(request.match_info["id"])
        if not job:
            return err(404, "no such job")
        resp = await sse_open(request)
        q: asyncio.Queue = asyncio.Queue()
        for e in job.events:
            q.put_nowait(e)
        if not job.done:
            job.subs.add(q)
        try:
            while True:
                try:
                    ev, data = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    await resp.write(b": ping\n\n")
                    continue
                await resp.write(sse_frame(ev, data))
                if ev in ("done", "error"):
                    break
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            job.subs.discard(q)
        return resp

    async def models(_):
        cfg = C.load_config()
        prov = cfg.get("provider") or {}
        kind = prov.get("kind")
        out: list[dict] = []
        custom_base = prov.get("base_url") or (cfg.get("custom") or {}).get("base_url")
        if kind == "custom" or custom_base:
            out = await asyncio.to_thread(_remote_models, custom_base, C.get_secret("custom_api_key"))
            cur = prov.get("model") if kind == "custom" else (cfg.get("custom") or {}).get("model")
            if not any(m["id"] == cur for m in out) and cur:
                out.insert(0, {"id": cur, "name": cur, "provider": "custom", "local": False, "ctx": None, "tps": None})
        rec = _recipes()
        if rec:
            try:
                cat = rec.load_catalog() if hasattr(rec, "load_catalog") else None
                for x in (cat or {}).get("recipes", []) if isinstance(cat, dict) else []:
                    if eng.runtime and hasattr(eng.runtime, "model_path"):
                        try:
                            if not eng.runtime.model_path(x).exists():
                                continue
                        except Exception:  # noqa: BLE001
                            continue
                    out.append({"id": x["id"], "name": x.get("name", x["id"]), "provider": "local", "local": True,
                                "ctx": x.get("ctx"), "tps": x.get("est_tps")})
            except Exception:  # noqa: BLE001
                pass
        if kind == "openai_login" or await asyncio.to_thread(_codex_logged_in):
            out += [{"id": m, "name": m, "provider": "openai_login", "local": False, "ctx": None, "tps": None}
                    for m in await asyncio.to_thread(_codex_model_ids)]
        active = prov.get("recipe_id") if kind == "local" else (prov.get("model") or cfg.get("model"))
        stats = eng.store.model_stats()
        labels = {"custom": _custom_label(custom_base), "local": "This computer", "openai_login": "ChatGPT"}
        seen = set()
        items = []
        for m in out:
            key = (m["provider"], m["id"])
            if key in seen:
                continue
            seen.add(key)
            st = stats.get(m["id"]) or {}
            items.append({**m, "ctx": m.get("ctx"), "tps_measured": st.get("tps_measured"),
                          "last_used": st.get("last_used"), "provider_label": labels.get(m["provider"], m["provider"]),
                          "active": m["id"] == active and (m["provider"] == kind)})
        return J({"active": active, "provider": kind, "models": items})

    async def set_model(request):
        """Switch the active model. Takes effect on the NEXT turn of every session (cached agents dropped).
        `provider` (custom|openai_login|local) disambiguates; otherwise it's inferred from where the id is
        listed: local recipe -> local, Codex model (logged in) -> openai_login, else the custom endpoint."""
        b = await body(request)
        mid = b.get("id")
        if not mid:
            return err(400, "id required")
        want = b.get("provider")
        cfg = C.load_config()
        prov = dict(cfg.get("provider") or {})
        rec = _recipes()
        if prov.get("kind") == "custom":  # remember the endpoint so we can switch back from ChatGPT/local
            cfg["custom"] = {"base_url": prov.get("base_url"), "model": prov.get("model")}
        target = want
        if not target:
            if rec and rec.get(mid):
                target = "local"
            elif prov.get("kind") == "custom" and mid in [m["id"] for m in await asyncio.to_thread(
                    _remote_models, prov.get("base_url"), C.get_secret("custom_api_key"))]:
                target = "custom"
            elif mid in await asyncio.to_thread(_codex_model_ids) and await asyncio.to_thread(_codex_logged_in):
                target = "openai_login"
            else:
                target = prov.get("kind") or "custom"
        if target == "local":
            if not (rec and rec.get(mid)):
                return err(404, f"unknown local model {mid}")
            if eng.runtime and hasattr(eng.runtime, "model_path"):
                try:
                    if not eng.runtime.model_path(rec.get(mid)).exists():
                        return err(409, f"{mid} isn't downloaded yet — install it from setup first")
                except Exception:  # noqa: BLE001
                    pass
            cfg["provider"] = {"kind": "local", "recipe_id": mid}
            cfg["model"] = mid
            C.save_config(cfg)
            eng.spawn(eng.start_local_model())
        elif target == "openai_login":
            if not await asyncio.to_thread(_codex_logged_in):
                return err(409, "sign in with ChatGPT first (POST /api/auth/openai/start)")
            cfg["provider"] = {"kind": "openai_login", "model": mid}
            cfg["model"] = mid
            C.save_config(cfg)
        elif target == "custom":
            base = prov.get("base_url") if prov.get("kind") == "custom" else (cfg.get("custom") or {}).get("base_url")
            if not base:
                return err(409, "no custom endpoint configured — run setup with a base_url first")
            cfg["provider"] = {"kind": "custom", "base_url": base, "model": mid}
            cfg["model"] = mid
            C.save_config(cfg)
        else:
            return err(400, "provider must be custom, openai_login or local")
        eng.error = None if target != "local" else eng.error
        eng.bridge.drop_all()
        if target != "local":
            eng.set_state(eng.compute_state())
        eng.hub.publish("model", {"state": eng.state, "model": mid, "provider": target})
        return J({"ok": True, "id": mid, "provider": target})

    async def apply_update(request):
        """Apply an offered update (never automatic): model -> install+switch job; config -> restart local model."""
        b = await body(request)
        kind, to = b.get("kind"), b.get("to")
        if kind not in ("model", "config") or not to:
            return err(400, "kind (model|config) and to are required")
        rec = _recipes()
        if not (rec and rec.get(to)):
            return err(404, f"unknown recipe {to}")
        cfg = C.load_config()
        job = Job("update")
        eng.jobs[job.id] = job
        if kind == "model":
            eng.spawn(_run_setup(eng, job, {"persona": cfg.get("persona"), "provider": {"kind": "local", "recipe_id": to}}))
        else:
            async def restart():
                job.emit("progress", {"step": "start", "label": "Restarting with the new settings…", "pct": 50, "bytes": None, "total": None})
                if eng.runtime:
                    await eng.runtime.stop()
                await eng.start_local_model()
                if eng.error:
                    job.emit("error", {"message": eng.error})
                else:
                    job.emit("done", {"ok": True})
            eng.spawn(restart())
        return J({"job_id": job.id})

    r.add_post("/api/updates/apply", apply_update)
    r.add_get("/api/recipes", recipes)
    r.add_get("/api/updates", updates)
    r.add_post("/api/setup", setup)
    r.add_get("/api/jobs/{id}/events", job_events)
    r.add_get("/api/models", models)
    r.add_post("/api/models/active", set_model)

    # OpenAI (ChatGPT) login via Hermes' Codex device-code flow ------------
    async def openai_start(_):
        st = eng.openai_login
        if st.get("state") == "pending" and st.get("expires", 0) > time.time():
            return J({"url": st["url"], "code": st["code"]})
        try:
            ensure_hermes()
            from hermes_cli.auth_codex import _codex_request_device_code
            from hermes_cli.auth_constants import CODEX_OAUTH_CLIENT_ID
        except Exception as e:  # noqa: BLE001
            return err(501, f"ChatGPT login isn't available in this Hermes build: {e}")
        issuer = "https://auth.openai.com"
        try:
            dev = await asyncio.to_thread(_codex_request_device_code, issuer, CODEX_OAUTH_CLIENT_ID)
        except Exception as e:  # noqa: BLE001
            return err(502, f"couldn't start ChatGPT login: {e}")
        eng.openai_login = {"state": "pending", "url": f"{issuer}/codex/device", "code": dev["user_code"],
                            "expires": time.time() + 15 * 60}
        eng.spawn(asyncio.to_thread(_openai_poll, eng, issuer, CODEX_OAUTH_CLIENT_ID, dev))
        return J({"url": eng.openai_login["url"], "code": dev["user_code"]})

    async def openai_status(_):
        """{state: idle|pending|done|error, url, code, error?}. `logged_in:true` whenever creds exist."""
        st = dict(eng.openai_login)
        logged = await asyncio.to_thread(_codex_logged_in)
        state = st.get("state") or "idle"
        if state == "pending" and st.get("expires", 0) < time.time():
            state, st["message"] = "error", "the login code expired — start again"
        if state in ("idle", "logged_in") and logged:
            state = "done"
        out = {"state": state, "url": st.get("url"), "code": st.get("code"), "logged_in": logged}
        if state == "error":
            out["error"] = st.get("message") or "login failed"
            out["message"] = out["error"]
        return J(out)

    async def provider_presets(_):
        from .providers import PRESETS
        return J(PRESETS)

    async def provider_test(request):
        from .providers import test_provider
        b = await body(request)
        kind = b.get("kind") or "custom"
        if kind != "custom":
            return err(400, "only kind 'custom' can be tested here (ChatGPT uses /api/auth/openai/*)")
        if not b.get("base_url"):
            return err(400, "base_url required")
        key = b.get("api_key")
        if key is None and (C.load_config().get("provider") or {}).get("base_url", "").rstrip("/") == \
                str(b["base_url"]).rstrip("/"):
            key = C.get_secret("custom_api_key")  # re-test the saved endpoint without re-typing the key
        res = await asyncio.to_thread(test_provider, b["base_url"], key, b.get("model"))
        return J(res)

    r.add_get("/api/provider/presets", provider_presets)
    r.add_post("/api/provider/test", provider_test)
    r.add_post("/api/auth/openai/start", openai_start)
    r.add_get("/api/auth/openai/status", openai_status)

    # sessions -------------------------------------------------------------
    async def list_sessions(_):
        return J(eng.store.list_sessions())

    async def create_session(request):
        b = await body(request)
        sid = new_id("s_")
        cwd = b.get("cwd")
        if cwd:
            cwd = os.path.abspath(os.path.expanduser(cwd))
            if not os.path.isdir(cwd):
                return err(400, f"cwd does not exist: {cwd}")
        if b.get("effort") is not None and not C.normalize_effort(b.get("effort")):
            return err(400, f"effort must be one of {C.EFFORTS}")
        if b.get("harness") is not None and b.get("harness") not in C.HARNESSES:
            return err(400, f"harness must be one of {C.HARNESSES}")
        sess = {"id": sid, "title": b.get("title") or "New chat", "goal": None, "pinned": False, "todos": [],
                "cwd": cwd, "created": time.time(), "updated": time.time()}
        eng.pending[sid] = sess
        if b.get("yolo"):
            eng.yolo.add(sid)
        if b.get("model") or b.get("effort") or b.get("harness"):
            eng.set_session_prefs(sid, model=b.get("model") or None, effort=C.normalize_effort(b.get("effort")),
                                  harness=b.get("harness"))
        return J(eng.session_view(sid))

    async def get_session(request):
        v = eng.session_view(request.match_info["id"])
        return J(v) if v else err(404, "no such session")

    async def patch_session(request):
        sid = request.match_info["id"]
        b = await body(request)
        fields = {k: b[k] for k in ("title", "pinned", "goal") if k in b}
        if "goal" in fields:
            fields["goal_status"] = "active" if fields["goal"] else "cleared"
        if "yolo" in b:
            (eng.yolo.add if b["yolo"] else eng.yolo.discard)(sid)
        if any(k in b for k in ("model", "effort", "harness")):
            if b.get("effort") is not None and not C.normalize_effort(b.get("effort")):
                return err(400, f"effort must be one of {C.EFFORTS}")
            if b.get("harness") is not None and b.get("harness") not in C.HARNESSES:
                return err(400, f"harness must be one of {C.HARNESSES}")
            p = eng.session_prefs(sid)
            for k in ("model", "effort", "harness"):
                if k in b:
                    p[k] = C.normalize_effort(b[k]) if k == "effort" and b[k] else (b[k] or None)
            eng.store.kv_set(f"sprefs:{sid}", {k: v for k, v in p.items() if v})
            eng.bridge.drop_agent(sid)
        if sid in eng.pending:
            eng.pending[sid].update({k: v for k, v in fields.items() if k != "goal_status"})
        elif eng.store.session_exists(sid):
            eng.store.update_session(sid, **fields)
        else:
            return err(404, "no such session")
        return J(eng.session_view(sid))

    async def delete_session(request):
        sid = request.match_info["id"]
        eng.loops.stop(sid, emit=False)
        eng.bridge.stop(sid)
        eng.bridge.drop_agent(sid)
        if eng.pending.pop(sid, None) is None:
            if not eng.store.session_exists(sid):
                return err(404, "no such session")
            eng.store.delete_session(sid)
            eng.ckpt.drop_session(sid)
        return J({"ok": True})

    async def post_message(request):
        sid = request.match_info["id"]
        if sid not in eng.pending and not eng.store.session_exists(sid):
            return err(404, "no such session")
        b = await body(request)
        text = (b.get("text") or "").strip()
        if not text and not b.get("attachments"):
            return err(400, "text required")
        try:
            eng.bridge.resolve_provider()
        except NotConfigured as e:
            if not (S.parse(text) and S.parse(text).name in ("goal", "undo", "usage", "cron", "loop", "yolo")):
                return err(409, str(e))
        if b.get("harness") is not None and b.get("harness") not in C.HARNESSES:
            return err(400, f"harness must be one of {C.HARNESSES}")
        if b.get("effort") is not None and not C.normalize_effort(b.get("effort")):
            return err(400, f"effort must be one of {C.EFFORTS}")
        q = await eng.start_chat(sid, text, b.get("effort"), b.get("attachments"), harness=b.get("harness"))
        resp = await sse_open(request)
        alive = True
        while True:
            try:
                ev, data = await asyncio.wait_for(q.get(), timeout=15)
            except asyncio.TimeoutError:
                if alive:
                    try:
                        await resp.write(b": ping\n\n")
                    except (ConnectionResetError, RuntimeError):
                        alive = False
                continue
            if alive:
                try:
                    data = {k: v for k, v in data.items() if k != "final" or v is not None}
                    await resp.write(sse_frame(ev, data))
                except (ConnectionResetError, RuntimeError):
                    alive = False  # keep draining; the turn finishes and persists anyway
            if ev in ("done", "error"):
                break
        return resp

    async def stop(request):
        return J({"ok": eng.bridge.stop(request.match_info["id"])})

    async def approve(request):
        b = await body(request)
        ok = eng.bridge.answer_approval(request.match_info["id"], b.get("id", ""), bool(b.get("allow")), bool(b.get("always")))
        return J({"ok": ok}) if ok else err(404, "no pending approval with that id")

    async def search(request):
        return J(eng.store.search(request.query.get("q", "")))

    async def steer(request):
        sid = request.match_info["id"]
        if sid not in eng.pending and not eng.store.session_exists(sid):
            return err(404, "no such session")
        text = ((await body(request)).get("text") or "").strip()
        if not text:
            return err(400, "text required")
        if not (eng.bridge.busy(sid) or sid in eng._starting):
            return err(409, "no turn is running — send it as a normal message")
        mode = eng.steer(sid, text)
        return J({"ok": True, "mode": mode})

    async def get_loop(request):
        sid = request.match_info["id"]
        if sid not in eng.pending and not eng.store.session_exists(sid):
            return err(404, "no such session")
        return J(eng.loops.status(sid))

    async def del_loop(request):
        sid = request.match_info["id"]
        stopped = eng.loops.stop(sid)
        return J({"ok": True, "stopped": stopped, **eng.loops.status(sid)})

    async def session_stream(request):
        """SSE relay of every turn event in this session (incl. loop/cron/steer turns the engine starts)."""
        sid = request.match_info["id"]
        if sid not in eng.pending and not eng.store.session_exists(sid):
            return err(404, "no such session")
        resp = await sse_open(request)
        q: asyncio.Queue = asyncio.Queue()
        eng.session_subs.setdefault(sid, set()).add(q)
        try:
            await resp.write(sse_frame("hello", {"session_id": sid, "busy": eng.bridge.busy(sid),
                                                 "loop": eng.loops.status(sid), "goal_state": eng.goal_state(sid)}))
            while True:
                try:
                    ev, data = await asyncio.wait_for(q.get(), timeout=15)
                    await resp.write(sse_frame(ev, data))
                except asyncio.TimeoutError:
                    await resp.write(b": ping\n\n")
        except (ConnectionResetError, asyncio.CancelledError, RuntimeError):
            pass
        finally:
            subs = eng.session_subs.get(sid)
            if subs is not None:
                subs.discard(q)
                if not subs:
                    eng.session_subs.pop(sid, None)
        return resp

    async def usage(request):
        try:
            days = int(request.query.get("days", "30"))
        except ValueError:
            return err(400, "days must be an integer")
        return J(eng.usage_report(days))

    r.add_post("/api/sessions/{id}/steer", steer)
    r.add_get("/api/sessions/{id}/loop", get_loop)
    r.add_delete("/api/sessions/{id}/loop", del_loop)
    r.add_get("/api/sessions/{id}/stream", session_stream)
    r.add_get("/api/usage", usage)

    r.add_get("/api/sessions", list_sessions)
    r.add_post("/api/sessions", create_session)
    r.add_get("/api/sessions/{id}", get_session)
    r.add_patch("/api/sessions/{id}", patch_session)
    r.add_delete("/api/sessions/{id}", delete_session)
    r.add_post("/api/sessions/{id}/messages", post_message)
    r.add_post("/api/sessions/{id}/stop", stop)
    r.add_post("/api/sessions/{id}/approve", approve)

    async def undo(request):
        sid = request.match_info["id"]
        if not eng.store.session_exists(sid):
            return err(404, "no such session")
        if eng.bridge.busy(sid):
            return err(409, "this chat is still answering — stop it first")
        res = await asyncio.to_thread(undo_last_turn, eng.store, eng.ckpt, sid)
        eng.bridge.drop_agent(sid)
        return J({k: res[k] for k in ("ok", "restored", "deleted", "turn_message_id", "note", "side_effects")
                  if k in res})

    async def checkpoints(request):
        sid = request.match_info["id"]
        if sid not in eng.pending and not eng.store.session_exists(sid):
            return err(404, "no such session")
        return J(await asyncio.to_thread(eng.ckpt.list, sid))

    r.add_post("/api/sessions/{id}/undo", undo)
    r.add_get("/api/sessions/{id}/checkpoints", checkpoints)
    r.add_get("/api/search", search)

    # memory / skills / connectors -------------------------------------------
    from . import knowledge as K
    from . import connectors as CN

    async def mem_list(_):
        return J(await asyncio.to_thread(K.memory_list))

    async def mem_add(request):
        b = await body(request)
        if not (b.get("text") or "").strip():
            return err(400, "text required")
        try:
            def _add():
                with X.quiet_notices():  # the user wrote it; no "remembered" toast
                    return K.memory_add(b["text"], b.get("target", "memory"))
            return J(await asyncio.to_thread(_add))
        except ValueError as e:
            return err(400, str(e))

    async def mem_del(request):
        ok = await asyncio.to_thread(K.memory_delete, request.match_info["id"])
        return J({"ok": True}) if ok else err(404, "no such memory")

    async def skills_list(_):
        return J(await asyncio.to_thread(K.skills_list))

    async def skill_get(request):
        s = await asyncio.to_thread(K.skill_get, request.match_info["name"])
        return J(s) if s else err(404, "no such skill")

    async def skill_put(request):
        b = await body(request)
        try:
            return J(await asyncio.to_thread(K.skill_put, request.match_info["name"], b.get("description", ""), b.get("body", "")))
        except ValueError as e:
            return err(400, str(e))

    async def skill_del(request):
        ok = await asyncio.to_thread(K.skill_delete, request.match_info["name"])
        return J({"ok": True}) if ok else err(404, "no such skill")

    async def skill_toggle(request):
        try:
            return J(await asyncio.to_thread(K.skill_toggle, request.match_info["name"]))
        except KeyError:
            return err(404, "no such skill")

    async def conn_list(_):
        return J(await asyncio.to_thread(CN.catalog))

    async def conn_connect(request):
        b = await body(request)
        try:
            res = await asyncio.to_thread(CN.connect, request.match_info["id"], b.get("fields") or {})
        except KeyError:
            return err(404, "no such connector")
        except ValueError as e:
            return err(400, str(e))
        eng.bridge.drop_all()
        from .agent_bridge import discover_mcp
        eng.spawn(asyncio.to_thread(discover_mcp))
        return J(res)

    async def conn_delete(request):
        try:
            await asyncio.to_thread(CN.disconnect, request.match_info["id"])
        except KeyError:
            return err(404, "no such connector")
        eng.bridge.drop_all()
        return J({"ok": True})

    async def profile_ctx(request):
        sid = request.query.get("session_id")
        row = eng.store.get_session_row(sid) if sid else None
        harness = request.query.get("harness") or ((eng.session_prefs(sid).get("harness")) if sid else None)
        return J(await asyncio.to_thread(eng.profile_context, harness, (row or {}).get("cwd")))

    r.add_get("/api/profile/context", profile_ctx)
    r.add_get("/api/memory", mem_list)
    r.add_post("/api/memory", mem_add)
    r.add_delete("/api/memory/{id}", mem_del)
    r.add_get("/api/skills", skills_list)
    r.add_get("/api/skills/{name}", skill_get)
    r.add_put("/api/skills/{name}", skill_put)
    r.add_delete("/api/skills/{name}", skill_del)
    r.add_post("/api/skills/{name}/toggle", skill_toggle)
    r.add_get("/api/connectors", conn_list)
    r.add_post("/api/connectors/{id}/connect", conn_connect)
    r.add_delete("/api/connectors/{id}", conn_delete)

    # check-ins / inbox / events ---------------------------------------------
    async def ci_list(_):
        return J(eng.checkins_view())

    async def ci_add(request):
        b = await body(request)
        if not (b.get("prompt") or "").strip():
            return err(400, "prompt required")
        try:
            sched = await eng.parse_schedule(b.get("schedule") or {})
        except ValueError as e:
            return err(400, str(e))
        return J(eng.add_checkin(b.get("title"), b["prompt"], sched, bool(b.get("yolo"))))

    async def ci_patch(request):
        cid = request.match_info["id"]
        c = eng.store.get_checkin(cid)
        if not c:
            return err(404, "no such check-in")
        b = await body(request)
        upd: dict = {}
        if "prompt" in b:
            if not (b["prompt"] or "").strip():
                return err(400, "prompt can't be empty")
            upd["prompt"] = b["prompt"]
        if "title" in b and (b["title"] or "").strip():
            upd["title"] = b["title"].strip()
        if "enabled" in b:
            upd["enabled"] = bool(b["enabled"])
        if "yolo" in b:
            upd["yolo"] = bool(b["yolo"])
        if "schedule" in b:
            try:
                upd["schedule"] = await eng.parse_schedule(b["schedule"])
            except ValueError as e:
                return err(400, str(e))
        eng.store.update_checkin(cid, **upd)
        c = eng.store.get_checkin(cid)
        if c["enabled"] and ("schedule" in upd or upd.get("enabled")):
            eng.scheduler.schedule_new(c)
        eng.scheduler.poke()
        return J(checkin_view(eng.store.get_checkin(cid)))

    async def ci_del(request):
        ok = eng.store.delete_checkin(request.match_info["id"])
        return J({"ok": True}) if ok else err(404, "no such check-in")

    async def ci_run(request):
        c = eng.store.get_checkin(request.match_info["id"])
        if not c:
            return err(404, "no such check-in")
        return J({"ok": eng.scheduler.fire_now(c)})

    async def inbox(_):
        return J(eng.store.list_inbox())

    async def inbox_read(request):
        eng.store.mark_inbox_read(request.match_info["id"])
        return J({"ok": True})

    async def events(request):
        resp = await sse_open(request)
        q: asyncio.Queue = asyncio.Queue()
        eng.hub.subs.add(q)
        try:
            await resp.write(sse_frame("model", {"state": eng.compute_state()}))
            while True:
                try:
                    ev, data = await asyncio.wait_for(q.get(), timeout=15)
                    await resp.write(sse_frame(ev, data))
                except asyncio.TimeoutError:
                    await resp.write(b": ping\n\n")
        except (ConnectionResetError, asyncio.CancelledError, RuntimeError):
            pass
        finally:
            eng.hub.subs.discard(q)
        return resp

    r.add_get("/api/checkins", ci_list)
    r.add_post("/api/checkins", ci_add)
    r.add_delete("/api/checkins/{id}", ci_del)
    r.add_patch("/api/checkins/{id}", ci_patch)
    r.add_post("/api/checkins/{id}/run", ci_run)
    r.add_get("/api/inbox", inbox)
    r.add_post("/api/inbox/{id}/read", inbox_read)
    r.add_get("/api/events", events)

    # pairing ----------------------------------------------------------------
    from . import pairing as P

    async def pair(_):
        url = P.advertised_url(eng.host, eng.port, os.environ.get("PICO_PUBLIC_URL"))
        return J(P.create(eng.store, url))

    async def pair_claim(request):
        b = await body(request)
        tok = P.claim(eng.store, b.get("code", ""), b.get("device_name", ""))
        return J({"token": tok}) if tok else err(403, "code is wrong, used or expired")

    async def devices(_):
        return J(eng.store.list_devices())

    async def device_del(request):
        ok = eng.store.delete_device(request.match_info["id"])
        return J({"ok": True}) if ok else err(404, "no such device")

    r.add_post("/api/pair", pair)
    r.add_post("/api/pair/claim", pair_claim)
    r.add_get("/api/devices", devices)
    r.add_delete("/api/devices/{id}", device_del)

    # static web app ---------------------------------------------------------
    async def static(request):
        if request.path.startswith("/api/"):
            return err(404, "not found")
        dist = C.web_dist()
        if dist.is_dir():
            rel = request.match_info.get("tail", "").lstrip("/")
            p = (dist / rel).resolve()
            if rel and p.is_file() and dist.resolve() in p.parents:
                return web.FileResponse(p)
            idx = dist / "index.html"
            if idx.is_file():
                html = idx.read_text(encoding="utf-8")
                # same-origin local page: hand it the token so non-devs never paste keys.
                # Only when the request comes from this machine.
                peer = request.remote or ""
                if peer in ("127.0.0.1", "::1", "localhost"):
                    import json as _json
                    html = html.replace("</head>", f"<script>window.__PICO_TOKEN__={_json.dumps(eng.token)}</script></head>", 1)
                return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "no-store"})
        return web.Response(text=PLACEHOLDER, content_type="text/html")

    r.add_get("/{tail:.*}", static)

    async def on_startup(app):
        eng.scheduler.start()
        X.set_hub(eng.hub.publish)
        X.set_profile_fn(eng.profile_brief)
        cfg = C.load_config()
        if (cfg.get("provider") or {}).get("kind") == "local":
            eng.spawn(eng.start_local_model())
        if os.environ.get("PICO_SKIP_MCP") != "1":
            from .agent_bridge import discover_mcp
            eng.spawn(asyncio.to_thread(discover_mcp))
        eng.set_state(eng.compute_state())

    async def on_cleanup(app):
        eng.loops.stop_all()
        await eng.scheduler.stop()
        if eng.runtime:
            try:
                await eng.runtime.stop()
            except Exception:  # noqa: BLE001
                pass
        for t in list(eng._bg):
            t.cancel()
        eng.store.close()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


PLACEHOLDER = r"""<!doctype html><meta charset=utf-8><title>pico</title>
<body style="background:#0b0d0c;color:#9fb5a8;font:14px ui-monospace,Menlo,monospace;display:grid;place-items:center;height:100vh;margin:0">
<pre style="text-align:center">   ___
  /o o\
  \_^_/
   |=|

pico engine is running.
the web app isn't built yet (web/dist).</pre></body>"""


# ── helpers ──────────────────────────────────────────────────────────────────

def _when(ts: Optional[float]) -> str:
    if not ts:
        return "—"
    import datetime as _dt
    d = _dt.datetime.fromtimestamp(ts)
    now = _dt.datetime.now()
    if d.date() == now.date():
        return d.strftime("today %H:%M")
    if d.date() == (now + _dt.timedelta(days=1)).date():
        return d.strftime("tomorrow %H:%M")
    return d.strftime("%a %b %d %H:%M")


def _split_schedule(body: str) -> tuple[str, str]:
    """`every 30m check X` -> ('every 30m', 'check X'): the longest leading phrase that parses as a schedule."""
    words = body.split()
    for n in range(min(len(words) - 1, 10), 0, -1):
        if SC.parse_text(" ".join(words[:n])):
            return " ".join(words[:n]), " ".join(words[n:])
    return "", body


def _rough_tokens(msgs: list) -> int:
    return sum(len(json.dumps(m.get("content") or "", default=str)) for m in msgs) // 4


def _check_token(eng: Engine, tok: str) -> bool:
    import hmac
    if hmac.compare_digest(tok, eng.token):
        return True
    if tok.startswith("picod_"):
        from .pairing import hash_token
        d = eng.store.device_by_hash(hash_token(tok))
        if d:
            eng.store.seen_device(d["id"])
            return True
    return False


def _memory_pass_call(rt, messages: list[dict]) -> str:
    """One small non-streaming completion for the post-turn memory pass (same model, thinking off)."""
    import urllib.request
    body = {"model": rt.model, "max_tokens": 400, "temperature": 0, "messages": messages,
            "chat_template_kwargs": {"enable_thinking": False}}
    if rt.kind == "openai_login":
        from .lean import aux_completion
        return aux_completion(rt, messages)
    req = urllib.request.Request(rt.base_url.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {rt.api_key or 'x'}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read())
    return d["choices"][0]["message"].get("content") or ""


def _remote_models(base_url: Optional[str], key: Optional[str]) -> list[dict]:
    import urllib.request
    if not base_url:
        return []
    req = urllib.request.Request(base_url.rstrip("/") + "/models", headers={"Authorization": f"Bearer {key or 'none'}"})
    try:
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read())
    except Exception:  # noqa: BLE001
        return []
    out = []
    for m in data.get("data", []) if isinstance(data, dict) else []:
        mid = m.get("id")
        if mid:
            out.append({"id": mid, "name": mid, "provider": "custom", "local": False,
                        "ctx": m.get("max_model_len") or m.get("context_length"), "tps": None})
    return out


def _codex_model_ids() -> list[str]:
    try:
        ensure_hermes()
        from hermes_cli.codex_models import DEFAULT_CODEX_MODELS
        return list(DEFAULT_CODEX_MODELS)
    except Exception:  # noqa: BLE001
        return []


def _custom_label(base_url: Optional[str]) -> str:
    if not base_url:
        return "Custom"
    try:
        from .providers import PRESETS
        for pr in PRESETS:
            if pr["base_url"] and base_url.rstrip("/").startswith(pr["base_url"].rstrip("/")):
                return pr["name"]
        from urllib.parse import urlparse
        host = urlparse(base_url).hostname or base_url
        return host.split(".")[0] if host not in ("localhost", "127.0.0.1") else f"localhost:{urlparse(base_url).port}"
    except Exception:  # noqa: BLE001
        return "Custom"


def _codex_logged_in() -> bool:
    try:
        ensure_hermes()
        from hermes_cli.auth_codex import resolve_codex_runtime_credentials
        return bool(resolve_codex_runtime_credentials(read_only=True).get("api_key"))
    except Exception:  # noqa: BLE001
        return False


def _openai_poll(eng: Engine, issuer: str, client_id: str, dev: dict) -> None:
    try:
        from hermes_cli.auth import _utc_now_z
        from hermes_cli.auth_codex import (_codex_exchange_authorization_code, _codex_poll_authorization_code,
                                           _save_codex_tokens)
        code_resp = _codex_poll_authorization_code(issuer, device_auth_id=dev["device_auth_id"],
                                                   user_code=dev["user_code"], poll_interval=dev["interval"])
        tokens = _codex_exchange_authorization_code(issuer, client_id, code_resp)
        _save_codex_tokens({"access_token": tokens.get("access_token", ""),
                            "refresh_token": tokens.get("refresh_token", "")}, _utc_now_z())
        eng.openai_login = {"state": "done"}
    except BaseException as e:  # noqa: BLE001  (SystemExit on cancel)
        eng.openai_login = {"state": "error", "message": str(e)}


async def _run_setup(eng: Engine, job: Job, b: dict) -> None:
    prov = dict(b.get("provider") or {})
    kind = prov["kind"]
    cfg = C.load_config()
    if b.get("persona"):
        cfg["persona"] = b["persona"]
    if isinstance(b.get("features"), dict):
        cfg["features"] = {**cfg.get("features", {}), **{k: bool(v) for k, v in b["features"].items()}}
    try:
        if kind == "custom":
            key = prov.pop("api_key", None)
            if key is not None:
                C.set_secret("custom_api_key", key)
            job.emit("progress", {"step": "check", "label": "Checking your model server…", "pct": 30, "bytes": None, "total": None})
            ms = await asyncio.to_thread(_remote_models, prov["base_url"], C.get_secret("custom_api_key"))
            if not ms:
                job.emit("progress", {"step": "check", "label": "Couldn't list models (continuing anyway)", "pct": 60, "bytes": None, "total": None})
            cfg["provider"] = {"kind": "custom", "base_url": prov["base_url"].rstrip("/"), "model": prov["model"]}
            cfg["model"] = prov["model"]
        elif kind == "openai_login":
            job.emit("progress", {"step": "auth", "label": "Checking ChatGPT login…", "pct": 30, "bytes": None, "total": None})
            if not await asyncio.to_thread(_codex_logged_in):
                raise RuntimeError("sign in with ChatGPT first (POST /api/auth/openai/start)")
            if (cfg.get("provider") or {}).get("kind") == "custom":
                old = cfg["provider"]
                cfg["custom"] = {"base_url": old.get("base_url"), "model": old.get("model")}
            model = prov.get("model") or (await asyncio.to_thread(_codex_model_ids) or [None])[0]
            cfg["provider"] = {"kind": "openai_login", "model": model}
            cfg["model"] = model
        else:
            rec = _recipes()
            recipe = rec.get(prov["recipe_id"]) if rec else None
            if not recipe:
                raise RuntimeError(f"unknown recipe {prov['recipe_id']}")
            if not eng.runtime:
                raise RuntimeError("local runtime module is not available")

            async def progress(step, label, pct, nbytes=None, total=None):
                job.emit("progress", {"step": step, "label": label, "pct": pct, "bytes": nbytes, "total": total})

            await eng.runtime.install(recipe, progress)
            cfg["provider"] = {"kind": "local", "recipe_id": recipe["id"]}
            cfg["model"] = recipe["id"]
            C.save_config(cfg)
            job.emit("progress", {"step": "start", "label": "Starting the model…", "pct": 95, "bytes": None, "total": None})
            await eng.start_local_model()
            if eng.error:
                raise RuntimeError(eng.error)
        C.save_config(cfg)
        sync_hermes_config(cfg)
        eng.error = None
        eng.bridge.drop_all()
        eng.set_state(eng.compute_state())
        job.emit("progress", {"step": "done", "label": "Ready", "pct": 100, "bytes": None, "total": None})
        job.emit("done", {"ok": True})
        eng.hub.publish("job", {"id": job.id, "kind": job.kind, "ok": True})
    except Exception as e:  # noqa: BLE001
        log.exception("setup failed")
        job.emit("error", {"message": str(e)})
        eng.hub.publish("job", {"id": job.id, "kind": job.kind, "ok": False, "message": str(e)})


def main() -> None:
    logging.basicConfig(level=os.environ.get("PICO_LOG", "INFO"), format="%(asctime)s %(name)s %(levelname)s %(message)s")
    C.ensure_dirs()
    ensure_hermes()  # isolate HERMES_HOME before anything imports Hermes
    from . import knowledge as K
    seeded = K.seed_skills()
    if seeded:
        log.info("seeded skills: %s", ", ".join(seeded))
    sync_hermes_config(C.load_config())
    host = os.environ.get("PICO_HOST", "127.0.0.1")
    port = int(os.environ.get("PICO_PORT", "7878"))
    eng = Engine()
    eng.host, eng.port = host, port
    app = make_app(eng)
    print(f"pico engine {__version__} on http://{host}:{port}  (token: {C.pico_home() / 'token'})", flush=True)
    web.run_app(app, host=host, port=port, print=None, access_log=None)


if __name__ == "__main__":
    main()
