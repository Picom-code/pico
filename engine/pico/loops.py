"""/loop: re-run a prompt in the same session on an interval (or until the model says LOOP_DONE).

One asyncio task per looping session. Time and sleep are injectable so tests drive a fake clock.
Each iteration calls `run(sid, n, prompt, state)` -> final reply text ('' when skipped/failed) or None
when the session was busy (iteration skipped, does not count).
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from .schedules import fmt_interval, parse_interval

log = logging.getLogger("pico.loops")

DEFAULT_EVERY_S = 600
MIN_EVERY_S = 30
DEFAULT_MAX_RUNS = 20
UNTIL_DONE_MAX = 10
DONE_RE = re.compile(r"^\s*\**LOOP_DONE\**\s*$", re.M)

UNTIL_DONE_SUFFIX = ("\n\n[Loop mode: you'll be re-run on this task automatically after each reply. Make real progress "
                     "each time. When the task is completely finished, put a line containing only LOOP_DONE at the "
                     "end of your reply; otherwise don't write that word.]")


@dataclass
class LoopState:
    session_id: str
    prompt: str
    every_s: int
    until_done: bool = False
    max_runs: int = DEFAULT_MAX_RUNS
    runs: int = 0
    next_at: Optional[float] = None
    state: str = "waiting"  # running | waiting | stopped | done
    started: float = field(default_factory=time.time)
    task: Optional[asyncio.Task] = None
    last_error: Optional[str] = None

    def view(self) -> dict:
        return {"active": self.state in ("running", "waiting"), "prompt": self.prompt,
                "every_s": 0 if self.until_done else self.every_s, "until_done": self.until_done, "runs": self.runs,
                "max_runs": self.max_runs, "next_at": self.next_at if self.state == "waiting" else None,
                "state": self.state}


def parse_args(arg: str) -> dict:
    """`/loop` argument -> {action, ...}. Raises ValueError with a short message."""
    a = (arg or "").strip()
    low = a.lower()
    if not a or low in ("status", "show"):
        return {"action": "status"}
    if low in ("stop", "off", "cancel", "end"):
        return {"action": "stop"}
    if low.startswith(("until-done", "until done", "untildone")):
        prompt = re.sub(r"^until[- ]?done\s*", "", a, flags=re.I).strip()
        if not prompt:
            raise ValueError("usage: /loop until-done <prompt>")
        return {"action": "start", "until_done": True, "prompt": prompt, "every_s": 0, "max_runs": UNTIL_DONE_MAX}
    first, _, rest = a.partition(" ")
    secs = parse_interval(first)
    if secs is None and first.lower() == "every":  # "/loop every 5m prompt"
        nxt, _, rest2 = rest.partition(" ")
        secs = parse_interval(nxt)
        if secs is not None:
            rest = rest2
    if secs is None:
        secs, prompt = DEFAULT_EVERY_S, a
    else:
        prompt = rest.strip()
    if not prompt:
        raise ValueError("usage: /loop <interval> <prompt>  (e.g. /loop 5m check the build)")
    if secs < MIN_EVERY_S:
        raise ValueError(f"the shortest loop interval is {MIN_EVERY_S}s")
    max_runs = DEFAULT_MAX_RUNS
    m = re.search(r"\s--(?:times|max)[= ](\d+)\s*$", " " + prompt)
    if m:
        max_runs = max(1, min(200, int(m.group(1))))
        prompt = prompt[: m.start() - 1 + 1].rstrip() if m.start() > 0 else ""
        prompt = re.sub(r"\s*--(?:times|max)[= ]\d+\s*$", "", prompt).strip()
    return {"action": "start", "until_done": False, "prompt": prompt, "every_s": secs, "max_runs": max_runs}


RunFn = Callable[[str, int, str, LoopState], Awaitable[Optional[str]]]
EventFn = Callable[[LoopState, int], None]


class LoopManager:
    def __init__(self, run: RunFn, on_event: EventFn = lambda s, n: None,
                 now: Callable[[], float] = time.time, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 busy_retry_s: float = 5.0):
        self.run = run
        self.on_event = on_event
        self.now = now
        self.sleep = sleep
        self.busy_retry_s = busy_retry_s
        self.loops: dict[str, LoopState] = {}

    def get(self, sid: str) -> Optional[LoopState]:
        return self.loops.get(sid)

    def status(self, sid: str) -> dict:
        s = self.loops.get(sid)
        return s.view() if s else {"active": False, "prompt": None, "every_s": None, "runs": 0, "max_runs": None,
                                   "next_at": None, "state": "stopped", "until_done": False}

    def start(self, sid: str, prompt: str, every_s: int, until_done: bool = False, max_runs: Optional[int] = None,
              first_delay: float = 0.0) -> LoopState:
        self.stop(sid, emit=False)
        st = LoopState(sid, prompt, int(every_s), until_done,
                       max_runs or (UNTIL_DONE_MAX if until_done else DEFAULT_MAX_RUNS))
        st.next_at = self.now() + first_delay
        self.loops[sid] = st
        st.task = asyncio.ensure_future(self._run(st, first_delay))
        return st

    def stop(self, sid: str, emit: bool = True) -> bool:
        st = self.loops.get(sid)
        if not st or st.state not in ("running", "waiting"):
            return False
        st.state = "stopped"
        st.next_at = None
        if st.task and not st.task.done() and st.task is not asyncio.current_task():
            st.task.cancel()
        if emit:
            self.on_event(st, st.runs)
        return True

    def stop_all(self) -> None:
        for sid in list(self.loops):
            self.stop(sid, emit=False)

    async def _run(self, st: LoopState, delay: float) -> None:
        try:
            if delay > 0:
                st.state = "waiting"
                self.on_event(st, st.runs)
                await self.sleep(delay)
            while st.state in ("running", "waiting"):
                n = st.runs + 1
                st.state, st.next_at = "running", None
                self.on_event(st, n)
                try:
                    final = await self.run(st.session_id, n, st.prompt, st)
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    log.warning("loop %s iteration %d failed: %s", st.session_id, n, e)
                    st.last_error = str(e)
                    final = ""
                if st.state == "stopped":
                    return
                if final is None:  # busy: skip, retry soon, don't count
                    st.state = "waiting"
                    wait = self.busy_retry_s if st.until_done else st.every_s
                    st.next_at = self.now() + wait
                    self.on_event(st, st.runs)
                    await self.sleep(wait)
                    continue
                st.runs = n
                if st.until_done and DONE_RE.search(final or ""):
                    st.state = "done"
                    self.on_event(st, n)
                    return
                if st.runs >= st.max_runs:
                    st.state = "done"
                    self.on_event(st, n)
                    return
                wait = 0.0 if st.until_done else float(st.every_s)
                st.state = "waiting"
                st.next_at = self.now() + wait
                self.on_event(st, n)
                await self.sleep(wait)
        except asyncio.CancelledError:
            pass


def describe(st: dict) -> str:
    if not st.get("active"):
        return "No loop running in this chat. Start one with /loop 10m <prompt> or /loop until-done <prompt>."
    if st.get("until_done"):
        return f"Looping until done: “{st['prompt']}” — run {st['runs']}/{st['max_runs']}. /loop stop to end it."
    nxt = ""
    if st.get("next_at"):
        secs = max(0, int(st["next_at"] - time.time()))
        nxt = f", next in {fmt_interval(secs) if secs >= 60 else str(secs) + 's'}"
    return (f"Looping every {fmt_interval(st['every_s'])}: “{st['prompt']}” — run {st['runs']}/{st['max_runs']}{nxt}. "
            "/loop stop to end it.")
