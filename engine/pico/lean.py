"""Pico's LEAN harness: same Hermes engine and tools, ~3x smaller prompt.

What changes versus the stock ("hermes") harness — all done in-process, nothing under ~/.hermes is edited:

* System prompt = STABLE_PROMPT (byte-identical across turns/sessions so endpoint prefix caching works)
  + a dynamic block (host, skills index, deferred-tool index, core memory, project file, cwd, date) that
  only changes when its inputs do (the date at day granularity).
* Tool schemas: short descriptions, same parameter names, so Hermes' handlers run unchanged.
  Always-on: terminal, read_file, write_file, patch, search_files, todo_list + Pico's skill / recall /
  remember. Deferred (one-line index in the prompt, called through Hermes' own tool_call bridge):
  web_search, web_extract, session_search, process_manage, MCP tools.
* Memory: ~300 tokens of core notes injected; the rest via `recall`. `remember` writes explicit requests;
  everything else is learned by a cheap post-turn pass (`memory_pass_*`) that runs after `done`.
* Project context: AGENTS.md / CLAUDE.md / .cursorrules from the session cwd, trimmed.
"""
from __future__ import annotations

import contextvars
import dataclasses
import json
import logging
import os
import platform
import re
import time
from pathlib import Path
from typing import Any, Iterable, Optional

log = logging.getLogger("pico.lean")

LEAN_TOOLSETS = ["terminal", "file", "todo", "web", "session_search", "pico"]
CORE_TOOLS = ("terminal", "read_file", "write_file", "patch", "search_files", "todo_list")
PICO_TOOLS = ("skill", "recall", "remember")
BRIDGE_TOOLS = ("tool_call", "tool_describe", "tool_search")
# Tools Hermes would show directly that lean defers behind tool_call.
LEAN_EXTRA_DEFER = frozenset({"web_search", "web_extract", "session_search", "process_manage", "delegate_task"})
# Hermes tools whose job lean's own tools (skill/recall/remember + the post-turn pass) take over.
HERMES_REPLACED_TOOLS = frozenset({"memory", "skill_manage", "skill_view", "skills_list"})
CORE_MEMORY_CHARS = 1200          # ~300 tokens
CONTEXT_FILE_CHARS = 6000         # ~1,500 tokens
CONTEXT_FILES = ("AGENTS.md", "CLAUDE.md", ".cursorrules")
LEAN_MEMORY_LIMITS = (8000, 4000)  # memory / user chars in lean (core subset is injected, rest recalled)
MAX_LISTED_DEFERRED = 16           # above this the index lists only groups and tool_search is offered

lean_active: contextvars.ContextVar[bool] = contextvars.ContextVar("pico_lean_active", default=False)

# ── stable prefix ────────────────────────────────────────────────────────────
# NEVER interpolate anything into this string: it must stay byte-identical for prefix caching.
STABLE_PROMPT = """You are Pico, a personal AI assistant running on the user's own computer. You can run commands, read and edit files, look things up on the web, remember facts about the user across chats, and follow saved skills.

How to work
- Be concise and direct; match the length of the answer to the question. No filler, no restating the request.
- Act, don't narrate: when a task needs doing, do it with your tools instead of describing what you would do.
- Verify by running things (the script, the tests, a command) before saying something works. Never invent output or results; if something fails, say so and try another way.
- Ask a question only when you are truly blocked or the request is ambiguous in a way that matters.
- For work with 3+ steps keep a checklist with todo_list and mark an item completed only once it is verified.

Tools
- Prefer read_file, search_files, patch and write_file over cat, grep, sed or echo in the terminal. Read a file before changing it; use patch for small edits.
- Relative paths are resolved from the working directory given below.
- You may make several independent tool calls at once.
- Skills are saved how-tos for this user. If one listed below fits the task, load it with skill(name) first and follow it.
- Facts you already know about the user are listed below; use them only when relevant and don't recite them. If an answer may depend on something the user told you before, search with recall(query).
- When the user asks you to remember something, save it with remember(text). Other useful facts are saved automatically after each turn.
- Extra tools are listed under "More tools". Call one with tool_call(name, arguments); use tool_describe(names) if you need its parameters."""


# ── tool schemas (short descriptions, Hermes parameter names) ────────────────

def _fn(name: str, desc: str, props: dict, required: Iterable[str] = ()) -> dict:
    return {"type": "function", "function": {"name": name, "description": desc, "parameters": {
        "type": "object", "properties": props, "required": list(required)}}}


S = {"type": "string"}
I = {"type": "integer"}
B = {"type": "boolean"}

CORE_SCHEMAS: dict[str, dict] = {
    "terminal": _fn(
        "terminal",
        "Run a shell command on this computer. Working dir and env persist between calls. "
        "background=true only for servers or long jobs (manage them with process_manage).",
        {"command": S,
         "background": B,
         "timeout": {"type": "integer", "description": "Seconds (default 180, max 600)"},
         "workdir": {"type": "string", "description": "Run in this directory instead"}},
        ["command"]),
    "read_file": _fn(
        "read_file",
        "Read a text file with line numbers (also PDF, Office, ipynb). Use offset/limit for big files.",
        {"path": S, "offset": {"type": "integer", "description": "First line (1-based)"},
         "limit": {"type": "integer", "description": "Max lines (default 2000)"}},
        ["path"]),
    "write_file": _fn(
        "write_file",
        "Create or overwrite a whole file; parent dirs are created. Read an existing file first.",
        {"path": S, "content": S}, ["path", "content"]),
    "patch": _fn(
        "patch",
        "Edit a file by replacing old_string (must be unique unless replace_all) with new_string. "
        "Whitespace-tolerant; returns a diff.",
        {"path": S, "old_string": S, "new_string": S, "replace_all": B},
        ["path", "old_string", "new_string"]),
    "search_files": _fn(
        "search_files",
        "Search file contents by regex (target=content) or find files by glob (target=files).",
        {"pattern": S, "target": {"type": "string", "enum": ["content", "files"]},
         "path": {"type": "string", "description": "Directory (default .)"},
         "file_glob": {"type": "string", "description": "Only search files matching this glob"},
         "output_mode": {"type": "string", "enum": ["content", "files_only", "count"]},
         "context": {"type": "integer", "description": "Lines around each match"},
         "limit": I},
        ["pattern"]),
    "todo_list": _fn(
        "todo_list",
        "Checklist for multi-step work. Send the full list (or merge=true to update items by id); "
        "no arguments reads it. One item in_progress at a time.",
        {"todos": {"type": "array", "items": {"type": "object", "properties": {
            "id": S, "content": S,
            "status": {"type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"]}},
            "required": ["id", "content", "status"]}},
         "merge": B}),
}

PICO_SCHEMAS: dict[str, dict] = {
    "skill": _fn("skill", "Load a saved skill's instructions (or one of its files) by name.",
                 {"name": S, "file_path": {"type": "string", "description": "Optional file inside the skill"}},
                 ["name"]),
    "recall": _fn("recall", "Search saved memory notes about the user and past work.",
                  {"query": {"type": "string", "description": "Keywords"}}, ["query"]),
    "remember": _fn("remember", "Save a fact for future chats (when the user asks you to remember it).",
                    {"text": {"type": "string", "description": "One short factual sentence"},
                     "target": {"type": "string", "enum": ["user", "memory"],
                                "description": "user = about the user (default); memory = other notes"}},
                    ["text"]),
}

BRIDGE_SCHEMAS: dict[str, dict] = {
    "tool_call": _fn("tool_call", "Call one of the More tools.",
                     {"name": S, "arguments": {"type": "object"}}, ["name", "arguments"]),
    "tool_describe": _fn("tool_describe", "Get the parameters of More tools.",
                         {"names": {"type": "array", "items": S}}, ["names"]),
    "tool_search": _fn("tool_search", "Find More tools by keywords (e.g. ['github issue']).",
                       {"queries": {"type": "array", "items": S}}, ["queries"]),
}

BUILTIN_DEFERRED_DESC = {
    "web_search": "search the web (titles, URLs, snippets)",
    "web_extract": "read web pages or PDF URLs as text",
    "session_search": "search or read past chats with this user",
    "process_manage": "poll, wait for, write to or kill background processes",
    "delegate_task": "hand independent subtasks to parallel helper agents",
}


# ── Hermes integration (in-process only) ─────────────────────────────────────

_installed = False


def install() -> None:
    """Register Pico's tools in Hermes' registry and patch the tool-search config so lean turns defer
    web/session/process tools. Idempotent; requires ensure_hermes() first."""
    global _installed
    if _installed:
        return
    from tools.registry import registry
    registry.register(name="skill", toolset="pico", schema=PICO_SCHEMAS["skill"]["function"], handler=_skill_handler,
                      emoji="📚")
    registry.register(name="recall", toolset="pico", schema=PICO_SCHEMAS["recall"]["function"], handler=_recall_handler,
                      emoji="🧠")
    registry.register(name="remember", toolset="pico", schema=PICO_SCHEMAS["remember"]["function"],
                      handler=_remember_handler, emoji="🧠")

    import tools.tool_search as ts
    orig_ro, orig = ts.load_config_readonly, ts.load_config

    def _lean_cfg(cfg):
        if not lean_active.get():
            return cfg
        return dataclasses.replace(cfg, defer_tools=(cfg.effective_defer_tools | LEAN_EXTRA_DEFER) - {"todo_list"})

    ts.load_config_readonly = lambda: _lean_cfg(orig_ro())
    ts.load_config = lambda: _lean_cfg(orig())

    # Hermes re-derives agent.tools between turns (late MCP servers) and at compaction. A lean agent owns
    # its tool array (deferred tools reach the model through the prompt index), so keep it.
    import tools.mcp_tool_agent as mta
    orig_refresh = mta.refresh_agent_mcp_tools

    def _refresh(agent, *a, **kw):
        if getattr(agent, "_pico_lean", False):
            return set()
        return orig_refresh(agent, *a, **kw)

    mta.refresh_agent_mcp_tools = _refresh
    _installed = True


def attach(agent: Any, prompt_fn) -> None:
    """Turn a freshly built AIAgent into a lean one. `prompt_fn()` returns the current system prompt."""
    agent._pico_lean = True
    agent._build_system_prompt = lambda system_message=None: prompt_fn()  # compaction rebuilds go through here
    agent._skip_mcp_refresh = True


def set_tools(agent: Any, tools: list[dict]) -> None:
    agent.tools = tools
    agent.valid_tool_names = {t["function"]["name"] for t in tools}


# ── deferred tools ───────────────────────────────────────────────────────────

def deferred_defs(enabled_toolsets: list[str]) -> list[dict]:
    """Raw (pre-assembly) defs of every enabled tool lean does not show directly."""
    try:
        import model_tools
        defs = model_tools.get_tool_definitions(enabled_toolsets=enabled_toolsets, quiet_mode=True,
                                                skip_tool_search_assembly=True) or []
    except Exception as e:  # noqa: BLE001
        log.warning("deferred tool listing failed: %s", e)
        return []
    shown = set(CORE_TOOLS) | set(PICO_TOOLS) | set(BRIDGE_TOOLS) | HERMES_REPLACED_TOOLS
    return [d for d in defs if d.get("function", {}).get("name") not in shown]


def _signature(fn: dict, max_params: int = 4) -> str:
    params = (fn.get("parameters") or {})
    props = list((params.get("properties") or {}).keys())
    req = [p for p in (params.get("required") or []) if p in props]
    opt = [p for p in props if p not in req]
    shown = req + [p + "?" for p in opt][: max(0, max_params - len(req))]
    more = len(req) + len(opt) - len(shown)
    return ", ".join(shown) + (", …" if more > 0 else "")


def _short_desc(name: str, desc: str, words: int = 12) -> str:
    if name in BUILTIN_DEFERRED_DESC:
        return BUILTIN_DEFERRED_DESC[name]
    first = re.split(r"(?<=[.!?])\s|\n", (desc or "").strip(), maxsplit=1)[0]
    w = first.split()
    return " ".join(w[:words]).rstrip(".,;:") + ("…" if len(w) > words else "")


def deferred_index(defs: list[dict]) -> tuple[str, bool]:
    """(prompt section, needs_tool_search). Builtins first, then MCP tools grouped by server."""
    if not defs:
        return "", False
    fns = [d["function"] for d in defs]
    builtin = [f for f in fns if f["name"] in BUILTIN_DEFERRED_DESC]
    other = [f for f in fns if f["name"] not in BUILTIN_DEFERRED_DESC]
    lines = [f"- {f['name']}({_signature(f)}): {_short_desc(f['name'], f.get('description', ''))}" for f in builtin]
    many = len(other) > MAX_LISTED_DEFERRED
    if other and not many:
        lines += [f"- {f['name']}({_signature(f)}): {_short_desc(f['name'], f.get('description', ''))}" for f in other]
    elif other:
        groups: dict[str, int] = {}
        for f in other:
            g = f["name"].split("_")[1] if f["name"].startswith("mcp_") and f["name"].count("_") >= 2 else "other"
            groups[g] = groups.get(g, 0) + 1
        lines.append("- connected apps: " + ", ".join(f"{g} ({n} tools)" for g, n in sorted(groups.items()))
                     + " — find them with tool_search")
    return "## More tools (call with tool_call)\n" + "\n".join(lines), many


def lean_tools(needs_search: bool, has_deferred: bool = True) -> list[dict]:
    tools = [CORE_SCHEMAS[n] for n in CORE_TOOLS] + [PICO_SCHEMAS[n] for n in PICO_TOOLS]
    if has_deferred:
        tools += [BRIDGE_SCHEMAS["tool_call"], BRIDGE_SCHEMAS["tool_describe"]]
        if needs_search:
            tools.append(BRIDGE_SCHEMAS["tool_search"])
    return tools


# ── memory ───────────────────────────────────────────────────────────────────

def memory_store():
    """Hermes MemoryStore over the same MEMORY.md / USER.md, with roomier limits: lean injects only a core
    subset and retrieves the rest with recall, so the char cap no longer protects the prompt."""
    from .agent_bridge import ensure_hermes
    ensure_hermes()
    from tools.memory_tool import load_on_disk_store
    from tools.memory_tool_store import MemoryStore
    base = load_on_disk_store()
    s = MemoryStore(max(base.memory_char_limit, LEAN_MEMORY_LIMITS[0]), max(base.user_char_limit, LEAN_MEMORY_LIMITS[1]),
                    memory_enabled=base.memory_enabled, user_profile_enabled=base.user_profile_enabled)
    s.load_from_disk()
    return s


def safe_notes() -> list[tuple[str, str]]:
    try:
        return all_notes(memory_store())
    except Exception as e:  # noqa: BLE001
        log.warning("lean: memory unavailable: %s", e)
        return []


def safe_skills() -> list[dict]:
    try:
        from . import knowledge as K
        return K.skills_list()
    except Exception as e:  # noqa: BLE001
        log.warning("lean: skills unavailable: %s", e)
        return []


def all_notes(store) -> list[tuple[str, str]]:
    return [("user", e) for e in store.user_entries if e] + [("memory", e) for e in store.memory_entries if e]


def core_memory(notes: list[tuple[str, str]], budget: int = CORE_MEMORY_CHARS) -> tuple[list[str], int]:
    """Most important notes that fit `budget` chars: user-profile notes first (who the user is, standing
    preferences), then agent notes, each in saved order. Returns (lines, how many were left out)."""
    picked, used = [], 0
    for _t, text in notes:
        line = " ".join(text.split())
        if text.startswith("[BLOCKED:"):
            continue
        if used + len(line) + 3 > budget:
            continue  # a later, shorter note may still fit
        picked.append(line)
        used += len(line) + 3
    return picked, len(notes) - len(picked)


_WORD = re.compile(r"[a-z0-9][a-z0-9'_-]*")
_STOP = set("a an and are as at be by did do does for from has have how i in is it its me my of on or our "
            "that the their there this to was what when where which who why with you your".split())


def _terms(s: str) -> set[str]:
    out = set()
    for w in _WORD.findall(s.lower()):
        if w in _STOP:
            continue
        out.add(w)
        if len(w) > 4 and w.endswith("s"):
            out.add(w[:-1])
    return out


def recall(notes: list[tuple[str, str]], query: str, limit: int = 8) -> list[dict]:
    q = _terms(query)
    if not q:
        return [{"target": t, "text": e} for t, e in notes[:limit]]
    scored = []
    for i, (t, e) in enumerate(notes):
        et = _terms(e)
        hit = len(q & et) + 0.5 * sum(1 for w in q for x in et if len(w) > 3 and (x.startswith(w) or w.startswith(x)) and x != w)
        if hit:
            scored.append((-hit, i, t, e))
    scored.sort()
    return [{"target": t, "text": e} for _s, _i, t, e in scored[:limit]]


# ── tool handlers (run on Hermes' tool threads) ──────────────────────────────

def _skill_handler(args: dict, **kw) -> str:
    from tools.skills_tool import skill_view
    return skill_view(str(args.get("name") or ""), file_path=args.get("file_path"), task_id=kw.get("task_id"))


def _recall_handler(args: dict, **kw) -> str:
    try:
        notes = all_notes(memory_store())
    except Exception as e:  # noqa: BLE001
        return json.dumps({"error": f"memory unavailable: {e}"})
    hits = recall(notes, str(args.get("query") or ""))
    return json.dumps({"results": hits, "total_notes": len(notes)} if hits else
                      {"results": [], "total_notes": len(notes), "note": "no matching notes"}, ensure_ascii=False)


def _remember_handler(args: dict, **kw) -> str:
    text = " ".join(str(args.get("text") or "").split())
    target = "memory" if args.get("target") == "memory" else "user"
    if not text:
        return json.dumps({"error": "text is required"})
    res = memory_store().add(target, text)
    ok = res.get("success", True) and not res.get("error")
    return json.dumps({"success": True, "saved": text} if ok else
                      {"success": False, "error": res.get("error") or res.get("message")}, ensure_ascii=False)


# ── dynamic block ────────────────────────────────────────────────────────────

def host_line() -> str:
    if os.name == "nt":
        osn = f"Windows {platform.release()}"
    elif os.uname().sysname == "Darwin":
        osn = f"macOS {platform.mac_ver()[0] or platform.release()}"
    else:
        osn = f"{platform.system()} {platform.release()}"
    shell = os.path.basename(os.environ.get("SHELL") or ("cmd" if os.name == "nt" else "sh"))
    return f"Computer: {osn} ({platform.machine()}), shell {shell}, home {os.path.expanduser('~')}"


def skills_index(skills: list[dict], words: int = 10) -> str:
    rows = []
    for s in sorted((s for s in skills if s.get("enabled", True)), key=lambda s: s["name"]):
        d = " ".join(str(s.get("description") or "").split()[:words]).rstrip(".")
        rows.append(f"- {s['name']}: {d}" if d else f"- {s['name']}")
    return ("## Skills (load with skill(name))\n" + "\n".join(rows)) if rows else ""


def context_file(cwd: Optional[str], budget: int = CONTEXT_FILE_CHARS) -> str:
    if not cwd:
        return ""
    for name in CONTEXT_FILES:
        p = Path(cwd) / name
        try:
            if not p.is_file():
                continue
            text = p.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            continue
        if not text:
            continue
        try:
            from agent.prompt_builder import _scan_context_content
            text = _scan_context_content(text, name)
        except Exception:  # noqa: BLE001
            pass
        if len(text) > budget:
            text = text[:budget].rsplit("\n", 1)[0] + f"\n[… {name} truncated]"
        return f"## Project instructions ({name})\n{text}"
    return ""


def today_line(now: Optional[float] = None) -> str:
    t = time.localtime(now if now is not None else time.time())
    return "Today: " + time.strftime("%A, %d %B %Y", t)


def build_dynamic(*, skills: list[dict], deferred_section: str, notes: list[tuple[str, str]], cwd: Optional[str],
                  now: Optional[float] = None, host: Optional[str] = None) -> str:
    """Most stable first so a changed part only re-prefills what follows it."""
    parts = [host or host_line(), skills_index(skills), deferred_section]
    core, left = core_memory(notes)
    if core:
        mem = "## What you know about the user\n" + "\n".join(f"- {c}" for c in core)
        if left:
            mem += f"\n({left} more saved notes: use recall)"
        parts.append(mem)
    elif left:
        parts.append(f"## What you know about the user\n({left} saved notes: use recall)")
    parts.append(context_file(cwd))
    parts.append(f"Working directory: {cwd or os.getcwd()}")
    parts.append(today_line(now))
    return "\n\n".join(p for p in parts if p)


def build_prompt(dynamic: str) -> str:
    return STABLE_PROMPT + "\n\n" + dynamic


# ── post-turn memory pass ────────────────────────────────────────────────────

MEMORY_PASS_SYSTEM = """You maintain the long-term memory of a personal assistant. Read the latest exchange and the saved notes, then decide what to change. Reply with JSON only, no prose:
{"add": [{"target": "user"|"memory", "text": "..."}], "update": [{"old": "<exact saved note>", "new": "..."}], "remove": ["<exact saved note>"], "skill": null}

Save durable facts that will matter in future chats: who the user is, people/pets/places in their life, preferences and standing instructions (formats, units, style, tools), their projects, and anything they asked to be remembered. target "user" = about the user; "memory" = facts about their machine, projects or environment.
Do not save: one-off task details (files, folders, commands, outputs or code from this task), the assistant's own actions, temporary or scratch locations, things already saved (update instead if changed), secrets or passwords, or anything only relevant to this chat. When unsure, save nothing.
Write each note as one short declarative sentence ("User's dog is named Biscuit."). Most exchanges need no change: then reply {"add": [], "update": [], "remove": [], "skill": null}.
Set "skill" to {"name": "lowercase-hyphenated", "description": "under 60 chars", "body": "markdown steps"} only when the assistant just worked out a reusable multi-step procedure the user will likely want again and no listed skill covers it."""


def memory_pass_messages(user_text: str, final: str, notes: list[tuple[str, str]], tools_used: list[str],
                         skill_names: Iterable[str]) -> list[dict]:
    rel = notes if sum(len(e) for _t, e in notes) <= 4000 else (
        [(n["target"], n["text"]) for n in recall(notes, user_text + " " + final, limit=20)])
    saved = "\n".join(f"- [{t}] {e}" for t, e in rel) or "(none)"
    body = (f"Saved notes (relevant subset):\n{saved}\n\nExisting skills: {', '.join(sorted(skill_names)) or '(none)'}\n\n"
            f"Latest exchange\nUser: {user_text[:3000]}\n"
            + (f"(assistant used tools: {', '.join(tools_used[:12])})\n" if tools_used else "")
            + f"Assistant: {final[:3000]}")
    return [{"role": "system", "content": MEMORY_PASS_SYSTEM}, {"role": "user", "content": body}]


def parse_ops(text: str) -> dict:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    i, j = text.find("{"), text.rfind("}")
    if i < 0 or j <= i:
        return {}
    try:
        d = json.loads(text[i:j + 1])
    except ValueError:
        return {}
    return d if isinstance(d, dict) else {}


_SKILL_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{1,47}$")


def apply_ops(ops: dict, store=None) -> list[str]:
    """Apply a memory-pass result with Hermes' own storage (threat scan, file locks, formats)."""
    store = store or memory_store()
    done: list[str] = []
    for a in (ops.get("add") or [])[:5]:
        if isinstance(a, str):
            a = {"text": a}
        if not isinstance(a, dict):
            continue
        text = " ".join(str(a.get("text") or "").split())
        if not text or len(text) > 400:
            continue
        r = store.add("memory" if a.get("target") == "memory" else "user", text)
        if r.get("success", True) and not r.get("error") and "already exists" not in str(r.get("message", "")):
            done.append(f"add: {text}")
    for u in (ops.get("update") or [])[:5]:
        if not isinstance(u, dict) or not u.get("old") or not u.get("new"):
            continue
        for target in ("user", "memory"):
            entries = store.user_entries if target == "user" else store.memory_entries
            if any(str(u["old"]).strip() in e for e in entries):
                r = store.replace(target, str(u["old"]).strip(), " ".join(str(u["new"]).split()))
                if r.get("success", True) and not r.get("error"):
                    done.append(f"update: {u['new']}")
                break
    for old in (ops.get("remove") or [])[:5]:
        old = str(old or "").strip()
        if not old:
            continue
        for target in ("user", "memory"):
            entries = store.user_entries if target == "user" else store.memory_entries
            if old in entries:
                r = store.remove(target, old, matched_entry=old)
                if r.get("success", True) and not r.get("error"):
                    done.append(f"remove: {old}")
                break
    sk = ops.get("skill")
    if isinstance(sk, dict) and _SKILL_NAME.match(str(sk.get("name") or "")) and str(sk.get("body") or "").strip():
        done += create_skill(str(sk["name"]), str(sk.get("description") or "")[:60], str(sk["body"]))
    return done


def run_memory_pass(rt, user_text: str, final: str, tools_used: list, call) -> list[str]:
    """One cheap model call -> memory/skill ops -> applied. `call(rt, messages) -> str`. Never raises for
    model/parse errors (returns [])."""
    store = memory_store()
    try:
        from . import knowledge as K
        skill_names = K.skill_names()
    except Exception:  # noqa: BLE001
        skill_names = set()
    msgs = memory_pass_messages(user_text, final, all_notes(store), [t for t in tools_used if t], skill_names)
    try:
        raw = call(rt, msgs)
    except Exception as e:  # noqa: BLE001
        log.info("memory pass call failed: %s", e)
        return []
    ops = parse_ops(raw)
    if not ops:
        return []
    if isinstance(ops.get("skill"), dict) and str(ops["skill"].get("name") or "") in skill_names:
        ops["skill"] = None
    return apply_ops(ops, store)


def aux_completion(rt, messages: list[dict]) -> str:
    """Memory-pass completion through Hermes' auxiliary client (providers without a plain chat endpoint)."""
    from agent.auxiliary_client import call_llm
    resp = call_llm(task="memory_pass", provider=rt.provider, model=rt.model, base_url=rt.base_url,
                    api_key=rt.api_key, messages=messages, max_tokens=400, temperature=0)
    try:
        return resp.choices[0].message.content or ""
    except Exception:  # noqa: BLE001
        return str(resp or "")


def create_skill(name: str, description: str, body: str) -> list[str]:
    try:
        import yaml
        from tools.skill_manager_tool import skill_manage
        fm = yaml.safe_dump({"name": name, "description": description or name, "version": "0.1.0",
                             "author": "Pico (learned)"}, sort_keys=False, allow_unicode=True)
        r = json.loads(skill_manage(action="create", name=name, content=f"---\n{fm}---\n\n{body.strip()}\n",
                                    category="pico-learned"))
        if r.get("success"):
            try:
                from tools.skills_tool import clear_skills_cache
                clear_skills_cache()
            except Exception:  # noqa: BLE001
                pass
            return [f"skill: {name}"]
        log.info("memory pass skill not created: %s", r.get("error"))
    except Exception as e:  # noqa: BLE001
        log.info("memory pass skill failed: %s", e)
    return []
