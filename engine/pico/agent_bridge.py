"""Bridge between the async engine and Hermes' synchronous AIAgent.

* `ensure_hermes()` isolates Hermes (HERMES_HOME=~/.pico/hermes, strips inherited gateway env) and
  puts the checkout on sys.path. Must run before any Hermes module is imported.
* `Bridge.run_turn()` runs `AIAgent.run_conversation` on a worker thread and turns Hermes callbacks
  into Pico SSE events (delta, reasoning, tool_start, tool_end, todo, approval, done, error) pushed
  onto an asyncio.Queue.
* Dangerous-command approvals: Hermes looks up a per-thread approval callback, but tools run on pool
  threads, so we route `_get_approval_callback` through a ContextVar (pool threads copy context).
* Tests inject a fake agent factory via `Bridge(agent_factory=...)`.
"""
from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from . import config as C

log = logging.getLogger("pico.agent")

BASE_TOOLSETS = ["terminal", "file", "todo", "memory", "skills", "web", "session_search"]

_STRIP_ENV_PREFIXES = ("HERMES_SESSION_", "HERMES_GATEWAY", "_HERMES_GATEWAY", "HERMES_UI_", "HERMES_CRON",
                       "HERMES_DELEGATED", "HERMES_TURN_", "HERMES_AGENT_")
_STRIP_ENV_EXACT = ("HERMES_EXEC_ASK", "HERMES_INTERACTIVE", "HERMES_QUIET", "HERMES_MAX_ITERATIONS",
                    "HERMES_PLATFORM", "HERMES_AGENT", "HERMES_REAL_HOME", "AI_AGENT")

_hermes_ready = False
_approval_cv: contextvars.ContextVar[Optional[Callable]] = contextvars.ContextVar("pico_approval", default=None)
# set on a turn's worker context; called with the steer text when Hermes actually injects it
_steer_cv: contextvars.ContextVar[Optional[Callable[[str], None]]] = contextvars.ContextVar("pico_steer", default=None)


def notify_steer_injected(text: str) -> None:
    """Called from inside a turn when a pending steer lands in the model's messages (fakes call it too)."""
    cb = _steer_cv.get()
    if cb:
        try:
            cb(text)
        except Exception:  # noqa: BLE001
            log.debug("steer callback failed", exc_info=True)


def _install_steer_hook() -> None:
    """Wrap Hermes' steer_user_row (built exactly when a steer is delivered) to tell Pico it was applied."""
    import agent.prompt_builder as pb
    import agent.agent_runtime_helpers as arh
    orig = pb.steer_user_row
    if getattr(orig, "_pico", False):
        return

    def steer_user_row(steer_text, *a, **kw):
        row = orig(steer_text, *a, **kw)
        notify_steer_injected(steer_text)
        return row

    steer_user_row._pico = True  # type: ignore[attr-defined]
    pb.steer_user_row = steer_user_row
    arh.steer_user_row = steer_user_row


def _isolate_hermes_auth() -> None:
    """Never fall back to (or write through to) the user's own ~/.hermes auth store: Pico's credentials
    (e.g. the ChatGPT/Codex login) live only under $PICO_HOME/hermes/auth.json."""
    import hermes_cli.auth as ha
    ha._global_auth_file_path = lambda: None
    ha._global_auth_store_cache = None
    try:  # nor silently adopt the Codex CLI's ~/.codex login (in-process only; subprocesses keep CODEX_HOME)
        import hermes_cli.auth_codex as hac
        hac._import_codex_cli_tokens = lambda *a, **kw: None
    except Exception:  # noqa: BLE001
        pass
    try:
        import hermes_constants as hc
        hc.get_default_hermes_root = lambda *a, **kw: C.hermes_home()
    except Exception:  # noqa: BLE001
        pass


def hermes_env_isolate() -> None:
    """Point Hermes at Pico's private home and drop env inherited from a parent Hermes process."""
    for k in list(os.environ):
        if k in _STRIP_ENV_EXACT or k.startswith(_STRIP_ENV_PREFIXES):
            os.environ.pop(k, None)
    os.environ["HERMES_HOME"] = str(C.hermes_home())
    # Never let importing Hermes re-exec this process into its own managed interpreter.
    os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"


def ensure_hermes() -> None:
    global _hermes_ready
    if _hermes_ready:
        os.environ["HERMES_HOME"] = str(C.hermes_home())  # PICO_HOME may change (tests)
        return
    hermes_env_isolate()
    C.hermes_home().mkdir(parents=True, exist_ok=True)
    src = str(C.hermes_src())
    if src not in sys.path:
        sys.path.insert(0, src)
    import tools.terminal_tool as tt  # noqa: E402  (Hermes)

    original = tt._get_approval_callback

    def _routed():
        return _approval_cv.get() or original()

    tt._get_approval_callback = _routed
    try:
        _isolate_hermes_auth()
    except Exception as e:  # noqa: BLE001
        log.warning("couldn't isolate Hermes auth store: %s", e)
    try:
        _install_steer_hook()
    except Exception as e:  # noqa: BLE001
        log.warning("steer hook unavailable: %s", e)
    _hermes_ready = True


# ── Hermes config.yaml under HERMES_HOME (approvals, skills.disabled, mcp_servers) ────────────────

def hermes_config_path() -> Path:
    return C.hermes_home() / "config.yaml"


def read_hermes_config() -> dict:
    import yaml
    try:
        return yaml.safe_load(hermes_config_path().read_text()) or {}
    except (OSError, ValueError):
        return {}


def write_hermes_config(cfg: dict) -> None:
    import yaml
    p = hermes_config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".yaml.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        yaml.safe_dump(cfg, f, sort_keys=False)
    os.replace(tmp, p)


def sync_hermes_config(pico_cfg: dict) -> None:
    """Mirror the bits of Pico config Hermes reads itself (approval mode)."""
    cfg = read_hermes_config()
    appr = cfg.setdefault("approvals", {})
    appr["mode"] = "smart" if pico_cfg.get("approvals") == "auto" else "manual"
    appr.setdefault("timeout", 300)
    from .subagents import sync_hermes
    sync_hermes(cfg, pico_cfg)
    write_hermes_config(cfg)


# ── effort ───────────────────────────────────────────────────────────────────

def effort_params(effort: str, provider_kind: str) -> tuple[dict, dict]:
    """(reasoning_config, request_overrides) for an effort level.

    off  -> INTERNAL only (compaction, titles): reasoning disabled; for local/custom OpenAI-compatible
            servers also send chat_template_kwargs.enable_thinking=false (Qwen/DeepSeek templates honour it).
            Users can't pick it any more: a stored/sent "off" is normalized to "low" before reaching here.
    else -> reasoning_effort=<level> (Hermes' custom provider profile emits it top-level). "max" is
            clamped to "high" unless the provider advertises it (C.supported_efforts).
    """
    if effort != "off":
        effort = C.normalize_effort(effort) or "medium"
        if effort == "max" and provider_kind != "openai_login":
            effort = "high"
    templ = provider_kind in ("custom", "local")
    if effort == "off":
        ro = {"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}} if templ else {}
        return {"enabled": False}, ro
    ro = {"extra_body": {"chat_template_kwargs": {"enable_thinking": True}}} if templ else {}
    return {"enabled": True, "effort": effort}, ro


# ── provider resolution ──────────────────────────────────────────────────────

class NotConfigured(RuntimeError):
    pass


@dataclass
class ProviderRuntime:
    kind: str
    provider: str
    base_url: str
    api_key: str
    model: str

    def signature(self) -> tuple:
        return (self.kind, self.provider, self.base_url, self.model, hash(self.api_key))


# ── events ───────────────────────────────────────────────────────────────────

def preview(text: Any, n: int = 400) -> str:
    s = text if isinstance(text, str) else json.dumps(text, default=str)
    return s if len(s) <= n else s[:n] + "…"


def result_ok(result: Any) -> bool:
    try:
        d = json.loads(result) if isinstance(result, str) else result
    except (TypeError, ValueError):
        return True
    if isinstance(d, dict):
        if d.get("success") is False or d.get("error"):
            return False
        ec = d.get("exit_code")
        if isinstance(ec, int) and ec != 0:
            return False
    return True


def todos_from_store(items: list[dict]) -> list[dict]:
    return [{"id": t.get("id"), "text": t.get("content", ""), "status": t.get("status", "pending"),
             "done": t.get("status") == "completed"} for t in (items or [])]


@dataclass
class Turn:
    session_id: str
    queue: asyncio.Queue
    loop: asyncio.AbstractEventLoop
    agent: Any = None
    approvals: dict = field(default_factory=dict)  # id -> {"event": Event, "choice": str}
    stopped: bool = False
    model: Optional[str] = None
    base: dict = field(default_factory=dict)  # agent session_* token counters before this turn
    steers: list = field(default_factory=list)  # texts accepted by Bridge.steer during this turn

    def emit(self, event: str, data: dict) -> None:
        self.loop.call_soon_threadsafe(self.queue.put_nowait, (event, data))


class Bridge:
    """Owns per-session AIAgent instances and runs turns."""

    def __init__(self, agent_factory: Optional[Callable[..., Any]] = None):
        self._factory = agent_factory
        self._agents: dict[str, tuple[tuple, Any]] = {}
        self._turns: dict[str, Turn] = {}
        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="pico-turn")
        self.runtime_base_url: Optional[str] = None  # set by server when the local runtime is up

    # provider ---------------------------------------------------------------
    def resolve_provider(self, cfg: Optional[dict] = None, model: Optional[str] = None) -> ProviderRuntime:
        """Active provider; `model` overrides the model id for one session/turn (same endpoint)."""
        rt = self._resolve_provider(cfg)
        if model:
            rt.model = model
        return rt

    def _resolve_provider(self, cfg: Optional[dict] = None) -> ProviderRuntime:
        cfg = cfg or C.load_config()
        prov = cfg.get("provider") or {}
        kind = prov.get("kind")
        if kind == "custom":
            if not prov.get("base_url"):
                raise NotConfigured("custom provider needs base_url")
            return ProviderRuntime("custom", "custom", prov["base_url"].rstrip("/"),
                                   C.get_secret("custom_api_key") or "no-key", prov.get("model") or cfg.get("model") or "")
        if kind == "local":
            if not self.runtime_base_url:
                raise NotConfigured("local model is not running yet")
            return ProviderRuntime("local", "custom", self.runtime_base_url.rstrip("/"), "local",
                                   cfg.get("model") or prov.get("model") or "local")
        if kind == "openai_login":
            ensure_hermes()
            from hermes_cli.auth_codex import resolve_codex_runtime_credentials
            try:
                creds = resolve_codex_runtime_credentials()
            except Exception as e:  # noqa: BLE001
                raise NotConfigured(f"ChatGPT login missing or expired: {e}") from e
            model = prov.get("model") or cfg.get("model")
            if not model:
                from hermes_cli.codex_models import DEFAULT_CODEX_MODELS
                model = DEFAULT_CODEX_MODELS[0]
            return ProviderRuntime("openai_login", "openai-codex", creds["base_url"], creds["api_key"], model)
        raise NotConfigured("no provider configured — run setup")

    # agents -----------------------------------------------------------------
    def _make_agent(self, session_id: str, rt: ProviderRuntime, effort: str, cwd: Optional[str], turn: Turn,
                    toolsets: Optional[list[str]] = None, harness: str = "hermes") -> Any:
        reasoning_config, overrides = effort_params(effort, rt.kind)
        lean = harness == "lean"
        ts = toolsets if toolsets is not None else (lean_toolsets() if lean else enabled_toolsets())
        kwargs = dict(
            base_url=rt.base_url, api_key=rt.api_key, provider=rt.provider, model=rt.model, quiet_mode=True,
            platform="pico", session_id=session_id, skip_context_files=True,
            enabled_toolsets=ts,
            reasoning_config=reasoning_config, request_overrides=overrides,
        )
        if lean:
            # memory writes / skill authoring happen in Pico's post-turn pass, not Hermes' review fork
            kwargs.update(skip_memory=True, skip_background_review=True)
        if cwd:
            kwargs["cwd"] = cwd
        cbs = self._callbacks(turn)
        if self._factory:
            agent = self._factory(**kwargs, **cbs)
        else:
            ensure_hermes()
            from run_agent import AIAgent
            if lean:
                from . import lean as L
                L.install()
                tok = L.lean_active.set(True)
                try:
                    agent = AIAgent(**kwargs, **cbs)
                finally:
                    L.lean_active.reset(tok)
            else:
                agent = AIAgent(**kwargs, **cbs)
        if lean:
            self._leanify(agent, ts, cwd, no_tools=toolsets == [])
        agent._pico_harness = harness
        agent._pico_model = rt.model
        return agent

    def _leanify(self, agent: Any, ts: list[str], cwd: Optional[str], no_tools: bool = False) -> None:
        """Swap the system prompt and tool array of a freshly built agent for the lean ones."""
        from . import lean as L
        deferred = [] if (no_tools or self._factory) else L.deferred_defs(ts)
        if self._factory and not no_tools:  # tests: the builtin deferred tools, no Hermes registry needed
            deferred = [{"type": "function", "function": {"name": n, "description": d, "parameters": {}}}
                        for n, d in L.BUILTIN_DEFERRED_DESC.items()]
        section, needs_search = L.deferred_index(deferred)
        tools = [] if no_tools else L.lean_tools(needs_search, bool(deferred))
        known = set(L.CORE_TOOLS) | set(L.PICO_TOOLS) | set(L.BRIDGE_TOOLS) | L.HERMES_REPLACED_TOOLS | {
            d["function"]["name"] for d in deferred}
        extra = [t for t in (getattr(agent, "tools", None) or []) if isinstance(t, dict)
                 and t.get("function", {}).get("name") not in known]  # post-build tools (memory provider, …)
        L.set_tools(agent, tools + ([] if no_tools else extra))
        notes = L.safe_notes()
        dynamic = L.build_dynamic(skills=L.safe_skills(), deferred_section=section, notes=notes, cwd=cwd)
        prompt = L.build_prompt(dynamic)
        agent._pico_lean_parts = {"stable": L.STABLE_PROMPT, "dynamic": dynamic}

        def prompt_fn():
            agent._cached_system_prompt_static = L.STABLE_PROMPT
            return prompt
        L.attach(agent, prompt_fn)

    def _callbacks(self, turn_ref: Turn) -> dict:
        # Callbacks look up the *current* turn for the session, so a cached agent reused by a later
        # turn emits into that turn's queue.
        sid = turn_ref.session_id

        def cur() -> Optional[Turn]:
            return self._turns.get(sid)

        def on_delta(text):
            t = cur()
            if t and text:
                t.emit("delta", {"text": text})

        def on_reasoning(text):
            t = cur()
            if t and text:
                t.emit("reasoning", {"text": text})

        from . import events_extra as X

        def on_tool_start(call_id, name, args):
            t = cur()
            if t:
                extra = X.tool_start_extra(sid, call_id, name, args)  # label + checkpoint pre-images
                t.emit("tool_start", {"id": call_id, "name": name, "args": args if isinstance(args, dict) else {"raw": str(args)}, **extra})

        def on_tool_complete(call_id, name, args, result):
            t = cur()
            if not t:
                return
            extra = X.tool_end_extra(sid, call_id, name, args, result)  # seconds + diff
            t.emit("tool_end", {"id": call_id, "name": name, "ok": result_ok(result),
                                "result_preview": preview(result), **extra, "_args": args, "_result": preview(result, 4000)})
            if name in ("todo_list", "todo"):
                store = getattr(t.agent, "_todo_store", None)
                items = store.read() if store is not None else _todos_from_result(result)
                t.emit("todo", {"todos": todos_from_store(items)})

        def emit_cur(event, data):
            t = cur()
            if t:
                t.emit(event, data)

        return dict(stream_delta_callback=on_delta, reasoning_callback=on_reasoning,
                    tool_start_callback=on_tool_start, tool_complete_callback=on_tool_complete,
                    tool_progress_callback=X.progress_callback(sid, emit_cur))

    def get_agent(self, session_id: str, effort: str, cwd: Optional[str], turn: Turn, harness: str = "hermes",
                  model: Optional[str] = None) -> Any:
        rt = self.resolve_provider(model=model)
        sig = (rt.signature(), effort, cwd, tuple(lean_toolsets() if harness == "lean" else enabled_toolsets()), harness,
               time.strftime("%Y-%m-%d") if harness == "lean" else None)  # lean prompt carries the date
        cached = self._agents.get(session_id)
        if cached and cached[0] == sig:
            return cached[1]
        agent = self._make_agent(session_id, rt, effort, cwd, turn, harness=harness)
        self._agents[session_id] = (sig, agent)
        return agent

    def drop_agent(self, session_id: str) -> None:
        self._agents.pop(session_id, None)

    def drop_all(self) -> None:
        self._agents.clear()

    def busy(self, session_id: str) -> bool:
        return session_id in self._turns

    # turn -------------------------------------------------------------------
    async def run_turn(self, session_id: str, user_text: str, history: list[dict], *, effort: str,
                       cwd: Optional[str], system_extra: str = "", toolsets: Optional[list[str]] = None,
                       fresh_agent: bool = False, approvals: str = "ask",
                       harness: str = "hermes", model: Optional[str] = None) -> tuple[Turn, asyncio.Future]:
        """Start a turn; returns (turn, future). Events stream on turn.queue; the future resolves to
        the Hermes result dict (or raises)."""
        loop = asyncio.get_running_loop()
        turn = Turn(session_id=session_id, queue=asyncio.Queue(), loop=loop)
        if session_id in self._turns:
            raise RuntimeError("busy")
        self._turns[session_id] = turn
        try:
            if fresh_agent or toolsets is not None:
                agent = self._make_agent(session_id, self.resolve_provider(model=model), effort, cwd, turn,
                                         toolsets=toolsets, harness=harness)
            else:
                agent = self.get_agent(session_id, effort, cwd, turn, harness=harness, model=model)
        except Exception:
            self._turns.pop(session_id, None)
            raise
        turn.agent = agent
        turn.model = getattr(agent, "_pico_model", None) or getattr(agent, "model", None)
        turn.base = {k: _int(getattr(agent, f"session_{k}", 0)) for k in TOKEN_KEYS}
        try:
            agent.ephemeral_system_prompt = system_extra or None
        except Exception:  # noqa: BLE001
            pass

        def approval_cb(command, description, **kw):
            if approvals == "yolo" and not turn.stopped:
                turn.emit("notice", {"kind": "yolo", "text": f"auto-approved: {str(command)[:120]}"})
                return "once"
            if approvals != "ask" or turn.stopped:
                return "deny"  # headless (check-ins) or stopping: nobody can answer
            aid = "a_" + uuid.uuid4().hex[:10]
            ev = threading.Event()
            turn.approvals[aid] = {"event": ev, "choice": "deny"}
            turn.emit("approval", {"id": aid, "command": command, "reason": description,
                                   "allow_always": bool(kw.get("allow_permanent", True))})
            ok = ev.wait(timeout=300)
            choice = turn.approvals.pop(aid, {}).get("choice", "deny") if ok else "deny"
            return choice

        def on_steer(text: str) -> None:
            turn.emit("steer", {"text": text, "applied": True})

        def work():
            _approval_cv.set(approval_cb)
            _steer_cv.set(on_steer)
            if harness == "lean":
                from .lean import lean_active
                lean_active.set(True)  # lean tool-search scope for this turn's threads (context is copied)
            # Hermes' terminal/file tools read the working dir from a per-context var, not the
            # AIAgent(cwd=) kwarg alone. Pin it on this worker context so tools run in the user's folder.
            if cwd:
                try:
                    from agent.runtime_cwd import set_session_cwd
                    set_session_cwd(cwd)
                except Exception:  # noqa: BLE001
                    pass
                try:
                    # the shell itself reads TERMINAL_CWD through the terminal scope
                    from tools.terminal_scope import get_terminal_scope, set_terminal_scope
                    base = dict(get_terminal_scope() or {k: v for k, v in os.environ.items() if k.startswith("TERMINAL_")})
                    base["TERMINAL_CWD"] = cwd
                    set_terminal_scope(base)
                except Exception:  # noqa: BLE001
                    pass
            if not self._factory:
                from tools.approval_context import set_hermes_interactive_context
                set_hermes_interactive_context(True)
                from . import events_extra
                events_extra.install()  # compaction / memory / skill / terminal-stream hooks (idempotent)
            return agent.run_conversation(user_text, conversation_history=history)

        ctx = contextvars.copy_context()
        fut = loop.run_in_executor(self._pool, ctx.run, work)

        def _done(_f):
            self._turns.pop(session_id, None)

        fut.add_done_callback(_done)
        return turn, fut

    def steer(self, session_id: str, text: str) -> bool:
        """Queue `text` for the running turn via Hermes' pending-steer slot: the model sees it as a user
        message right after the current tool batch / before its next model call, without stopping.
        A foreground terminal command is asked to yield (backgrounded) so the steer isn't parked behind it."""
        turn = self._turns.get(session_id)
        agent = turn.agent if turn else None
        if not turn or turn.stopped or agent is None or not hasattr(agent, "steer"):
            return False
        if not agent.steer(text):
            return False
        turn.steers.append(text)
        if getattr(agent, "_executing_tools", False):
            try:
                from agent.interrupt_control import _request_yield
                lock = getattr(agent, "_tool_worker_threads_lock", None)
                tids = list(getattr(agent, "_tool_worker_threads", None) or [])
                if lock is not None:
                    with lock:
                        tids = list(agent._tool_worker_threads)
                for tid in tids:
                    _request_yield(tid)
            except Exception:  # noqa: BLE001
                pass
        return True

    def answer_approval(self, session_id: str, approval_id: str, allow: bool, always: bool = False) -> bool:
        turn = self._turns.get(session_id)
        if not turn or approval_id not in turn.approvals:
            return False
        slot = turn.approvals[approval_id]
        slot["choice"] = ("always" if always else "once") if allow else "deny"
        slot["event"].set()
        return True

    def stop(self, session_id: str) -> bool:
        turn = self._turns.get(session_id)
        if not turn:
            return False
        turn.stopped = True
        for slot in list(turn.approvals.values()):
            slot["choice"] = "deny"
            slot["event"].set()
        agent = turn.agent
        if agent is not None and hasattr(agent, "interrupt"):
            try:
                agent.interrupt("Stopped by user", hard_cancel=True)
            except TypeError:
                agent.interrupt("Stopped by user")
        return True


TOKEN_KEYS = ("input_tokens", "output_tokens", "cache_read_tokens")


def _int(v: Any) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def turn_tokens(result: dict, base: dict) -> dict:
    """Per-turn token counts. Hermes reports the agent's *session* counters (cumulative while Pico reuses a
    cached agent), so subtract the pre-turn snapshot; a counter that went down was reset -> take it as is."""
    out = {}
    for k in TOKEN_KEYS:
        v, b = _int(result.get(k)), _int(base.get(k))
        out[k] = v - b if v >= b else v
    return out


def _todos_from_result(result: Any) -> list[dict]:
    try:
        d = json.loads(result) if isinstance(result, str) else result
        return d.get("todos") or []
    except Exception:  # noqa: BLE001
        return []


def enabled_toolsets() -> list[str]:
    servers = (read_hermes_config().get("mcp_servers") or {}) if _hermes_ready else {}
    from .subagents import toolsets as _sub_ts
    return BASE_TOOLSETS + _sub_ts() + [f"mcp-{n}" for n, v in servers.items() if not (isinstance(v, dict) and v.get("enabled") is False)]


def lean_toolsets() -> list[str]:
    """Lean: the same capabilities minus Hermes' memory/skills toolsets (replaced by Pico's skill/recall/remember)."""
    from .lean import LEAN_TOOLSETS
    extra = [t for t in enabled_toolsets() if t not in BASE_TOOLSETS]  # delegation + mcp-*
    return LEAN_TOOLSETS + extra


def discover_mcp() -> list[str]:
    """Connect configured MCP servers (blocking, up to ~120s) — call from a thread."""
    ensure_hermes()
    if not read_hermes_config().get("mcp_servers"):
        return []
    try:
        from tools.mcp_tool_discovery import discover_mcp_tools
        return discover_mcp_tools() or []
    except Exception as e:  # noqa: BLE001
        log.warning("MCP discovery failed: %s", e)
        return []
