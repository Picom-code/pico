"""Check-ins / crons: scheduled background prompts.

Schedules (see schedules.py): weekly clock `{time, days}` (legacy), `{every}`, `{cron}` or `{text}`.
At due time the prompt runs headless in a fresh session (approvals denied unless the job has yolo);
the reply lands in the inbox and is broadcast on GET /api/events. The scheduler is a single asyncio
task that sleeps until the next due job (capped at 30s so new jobs and clock changes are picked up).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
from typing import Awaitable, Callable, Optional

from . import schedules as SC
from .schedules import DAYS  # noqa: F401  (re-export for old imports)

log = logging.getLogger("pico.checkins")


def normalize_schedule(schedule) -> dict:
    """Validate any accepted schedule shape -> canonical form (legacy {time, days} stays exactly that)."""
    if not isinstance(schedule, (dict, str)):
        raise ValueError("schedule must be an object: {time,days} | {every} | {cron} | {text}")
    if isinstance(schedule, dict) and schedule and set(schedule) <= {"time", "days"}:
        return SC.normalize_weekly(schedule)
    return SC.normalize(schedule)


def next_run(schedule: dict, after: Optional[dt.datetime] = None, last_run: Optional[float] = None) -> dt.datetime:
    """Next local datetime strictly after `after` matching the schedule."""
    return SC.next_run(normalize_schedule(schedule), after, last_run)


def view(c: dict) -> dict:
    """API item: stored row + schedule_text (old fields untouched)."""
    return {**c, "schedule_text": SC.describe(c.get("schedule") or {})}


RunFn = Callable[[dict], Awaitable[None]]


class Scheduler:
    def __init__(self, store, run: RunFn, now: Callable[[], dt.datetime] = lambda: dt.datetime.now().astimezone()):
        self.store = store
        self.run = run
        self.now = now
        self._task: Optional[asyncio.Task] = None
        self._wake = asyncio.Event()
        self._running: set[str] = set()

    def start(self) -> None:
        if not self._task:
            self._task = asyncio.create_task(self._loop(), name="pico-checkins")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    def poke(self) -> None:
        self._wake.set()

    def schedule_new(self, c: dict) -> dict:
        nr = next_run(c["schedule"], self.now(), c.get("last_run")).timestamp()
        self.store.update_checkin(c["id"], next_run=nr)
        return {**c, "next_run": nr}

    async def tick(self) -> list[str]:
        """Run every due check-in once; returns ids fired. Exposed for tests."""
        fired = []
        now = self.now()
        for c in self.store.list_checkins():
            if not c["enabled"] or c["id"] in self._running:
                continue
            if c["next_run"] is None:
                self.schedule_new(c)
                continue
            if c["next_run"] <= now.timestamp():
                self.store.update_checkin(c["id"], last_run=now.timestamp(), last_status="running",
                                          next_run=next_run(c["schedule"], now, now.timestamp()).timestamp())
                fired.append(c["id"])
                self._running.add(c["id"])
                asyncio.create_task(self._fire(c))
        return fired

    def fire_now(self, c: dict) -> bool:
        """Manual run (POST /run, /cron run): same bookkeeping, schedule untouched. False if already running."""
        if c["id"] in self._running:
            return False
        self.store.update_checkin(c["id"], last_run=self.now().timestamp(), last_status="running")
        self._running.add(c["id"])
        asyncio.create_task(self._fire(c))
        return True

    async def _fire(self, c: dict) -> None:
        try:
            await self.run(c)
        except Exception as e:  # noqa: BLE001
            log.exception("check-in %s failed: %s", c["id"], e)
            try:
                self.store.update_checkin(c["id"], last_status="error")
            except Exception:  # noqa: BLE001
                pass
        finally:
            self._running.discard(c["id"])

    async def _loop(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # noqa: BLE001
                log.exception("check-in tick failed")
            due = [c["next_run"] for c in self.store.list_checkins() if c["enabled"] and c["next_run"]]
            delay = 30.0
            if due:
                delay = max(0.5, min(delay, min(due) - self.now().timestamp()))
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass
