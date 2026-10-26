"""Steering, models, usage, crons, /loop, goal/plan events, easy provider setup, efforts."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import time

import pytest

from conftest import parse_sse

TZ = dt.timezone(dt.timedelta(hours=-5))


def at(y, m, d, hh, mm):
    return dt.datetime(y, m, d, hh, mm, tzinfo=TZ)


async def send(client, h, sid, text, **extra):
    r = await client.post(f"/api/sessions/{sid}/messages", json={"text": text, **extra}, headers=h)
    assert r.status == 200, await r.text()
    return parse_sse(await r.text())


async def new_session(client, h, **body):
    r = await client.post("/api/sessions", json=body, headers=h)
    assert r.status == 200, await r.text()
    return (await r.json())["id"]


# ── schedules ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text,expect", [
    ("every weekday at 8am", {"time": "08:00", "days": ["mon", "tue", "wed", "thu", "fri"]}),
    ("weekdays 8:30", {"time": "08:30", "days": ["mon", "tue", "wed", "thu", "fri"]}),
    ("daily at 7:30", {"time": "07:30", "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]}),
    ("every monday and friday at 9:15", {"time": "09:15", "days": ["mon", "fri"]}),
    ("weekends at noon", {"time": "12:00", "days": ["sat", "sun"]}),
    ("8am weekdays", {"time": "08:00", "days": ["mon", "tue", "wed", "thu", "fri"]}),
    ("every day at 5pm", {"time": "17:00", "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]}),
    ("every 30m", {"every": "30m", "every_s": 1800}),
    ("every 2 hours", {"every": "2h", "every_s": 7200}),
    ("hourly", {"every": "1h", "every_s": 3600}),
    ("every half hour", {"every": "30m", "every_s": 1800}),
    ("every other hour", {"every": "2h", "every_s": 7200}),
    ("0 8 * * 1-5", {"cron": "0 8 * * 1-5"}),
])
def test_parse_text(text, expect):
    from pico.schedules import parse_text
    assert parse_text(text) == expect


def test_parse_text_rejects_nonsense():
    from pico.schedules import parse_text
    for t in ("tomorrow at dawn", "whenever", "", "check the build"):
        assert parse_text(t) is None


def test_normalize_shapes_and_describe():
    from pico.checkins import normalize_schedule
    from pico.schedules import describe
    assert normalize_schedule({"time": "7:30", "days": ["weekdays"]}) == {"time": "07:30", "days": ["mon", "tue", "wed", "thu", "fri"]}
    assert normalize_schedule({"every": "90m"}) == {"every": "90m", "every_s": 5400}
    assert normalize_schedule({"cron": "0  8 * * 1-5"}) == {"cron": "0 8 * * 1-5"}
    t = normalize_schedule({"text": "every weekday at 8am"})
    assert t["time"] == "08:00" and t["text"] == "every weekday at 8am"
    assert describe(t) == "every weekday at 08:00"
    assert describe({"cron": "0 8 * * 1-5"}) == "every weekday at 08:00"
    assert describe({"every": "30m", "every_s": 1800}) == "every 30m"
    for bad in ({"every": "10s"}, {"every": "soon"}, {"cron": "61 * * * *"}, {"cron": "0 0 30 2 *"},
                {"cron": "* * *"}, {"text": "when pigs fly"}, {}, "x" * 0, 5):
        with pytest.raises(ValueError):
            normalize_schedule(bad)  # type: ignore[arg-type]


def test_next_run_every_and_cron():
    from pico.checkins import next_run
    # interval anchored on last run
    last = at(2026, 10, 25, 12, 0).timestamp()
    assert next_run({"every": "30m"}, at(2026, 10, 25, 12, 10), last) == at(2026, 10, 25, 12, 30)
    # long-missed interval: never fires in the past
    assert next_run({"every": "30m"}, at(2026, 10, 25, 15, 0), last) == at(2026, 10, 25, 15, 30)
    # cron weekdays 08:00 from Sunday noon -> Monday 08:00
    assert next_run({"cron": "0 8 * * 1-5"}, at(2026, 10, 25, 12, 0)) == at(2026, 10, 26, 8, 0)
    assert next_run({"cron": "*/15 * * * *"}, at(2026, 10, 25, 12, 7)) == at(2026, 10, 25, 12, 15)
    # strictly after
    assert next_run({"cron": "0 8 * * *"}, at(2026, 10, 26, 8, 0)) == at(2026, 10, 27, 8, 0)
    # dom OR dow when both restricted (classic cron)
    assert next_run({"cron": "0 9 1 * mon"}, at(2026, 10, 25, 12, 0)) == at(2026, 10, 26, 9, 0)


# ── usage aggregation ────────────────────────────────────────────────────────

def test_usage_aggregate():
    from pico.usage import aggregate, summary_text
    now = at(2026, 10, 25, 12, 0).timestamp()
    rows = [
        {"model": "a", "harness": "lean", "input": 100, "output": 10, "cached": 300, "seconds": 2, "tools": 1, "tps": 20, "created": now - 60},
        {"model": "a", "harness": "lean", "input": 100, "output": 30, "cached": 100, "seconds": 3, "tools": 0, "tps": 40, "created": now - 86400},
        {"model": "b", "harness": "hermes", "input": 200, "output": 20, "cached": 0, "seconds": 5, "tools": 2, "tps": None, "created": now - 2 * 86400},
        {"model": "old", "harness": "lean", "input": 9999, "output": 9999, "cached": 0, "seconds": 1, "tools": 0, "tps": 1, "created": now - 40 * 86400},
    ]
    rep = aggregate(rows, days=30, now=now)
    assert rep["totals"] == {"turns": 3, "input": 400, "output": 60, "cached": 400, "seconds": 10.0, "tools": 3}
    assert rep["cache_hit_pct"] == 50.0  # 400 cached of 800 prompt tokens
    assert len(rep["days"]) == 30 and rep["days"][-1]["date"] == "2026-10-25" and rep["days"][-1]["turns"] == 1
    assert rep["days"][-2] == {"date": "2026-10-24", "turns": 1, "input": 100, "output": 30, "cached": 100}
    a = next(m for m in rep["by_model"] if m["model"] == "a")
    assert a["turns"] == 2 and a["tps"] == 30.0 and a["output"] == 40
    assert {h["harness"] for h in rep["by_harness"]} == {"lean", "hermes"}
    assert rep["today"]["turns"] == 1 and rep["today"]["date"] == "2026-10-25"
    assert "3 turns" in summary_text(rep)


def test_turn_tokens_delta():
    from pico.agent_bridge import turn_tokens
    assert turn_tokens({"input_tokens": 300, "output_tokens": 40, "cache_read_tokens": 50},
                       {"input_tokens": 100, "output_tokens": 10, "cache_read_tokens": 50}) == \
        {"input_tokens": 200, "output_tokens": 30, "cache_read_tokens": 0}
    # counters reset (fresh agent): take as is
    assert turn_tokens({"input_tokens": 5, "output_tokens": 1}, {"input_tokens": 100})["input_tokens"] == 5


def test_usage_api_and_slash(run):
    async def t(client, eng, h):
        sid = await new_session(client, h)
        await send(client, h, sid, "what OS am I on?")
        await send(client, h, sid, "again?")
        rep = await (await client.get("/api/usage?days=7", headers=h)).json()
        assert rep["totals"]["turns"] == 2 and rep["totals"]["input"] == 200 and rep["totals"]["output"] == 20
        assert rep["totals"]["tools"] == 4 and rep["by_model"][0]["model"] == "fake-model"
        assert rep["by_harness"][0]["harness"] == "lean" and len(rep["days"]) == 7 and rep["today"]["turns"] == 2
        ev = await send(client, h, sid, "/usage")
        done = ev[-1][1]
        assert "2 turns" in "".join(d["text"] for e, d in ev if e == "delta")
        assert done["usage_report"]["totals"]["turns"] == 2
        assert (await client.get("/api/usage?days=x", headers=h)).status == 400
    run(t)


def test_usage_backfill(make_engine):
    eng = make_engine()
    eng.store.create_session({"id": "s_old", "title": "x"})
    eng.store.add_message("s_old", "assistant", "hi", {"usage": {"input": 50, "output": 5}, "tps": 12.0,
                                                       "summary": {"seconds": 1.5, "tools": 2}, "context": {"cached": 20}})
    eng.store.kv_set("usage_backfilled", False)
    from pico.usage import backfill
    assert backfill(eng.store) == 1 and backfill(eng.store) == 0
    rows = eng.store.usage_rows()
    assert rows[0]["input"] == 50 and rows[0]["cached"] == 20 and rows[0]["tools"] == 2


# ── models ───────────────────────────────────────────────────────────────────

def test_models_items_and_switch(run, monkeypatch):
    import pico.server as srv
    monkeypatch.setattr(srv, "_remote_models", lambda base, key: [
        {"id": "fake-model", "name": "fake-model", "provider": "custom", "local": False, "ctx": 32768, "tps": None},
        {"id": "other", "name": "other", "provider": "custom", "local": False, "ctx": 8192, "tps": None}])
    monkeypatch.setattr(srv, "_codex_logged_in", lambda: False)

    async def t(client, eng, h):
        sid = await new_session(client, h)
        done = (await send(client, h, sid, "what OS am I on?"))[-1][1]
        assert done["model"] == "fake-model" and done["harness"] == "lean" and done["yolo"] is False
        res = await (await client.get("/api/models", headers=h)).json()
        fm = next(m for m in res["models"] if m["id"] == "fake-model")
        assert fm["ctx"] == 32768 and fm["last_used"] and fm["provider_label"] and fm["active"] is True
        assert "tps_measured" in fm
        assert next(m for m in res["models"] if m["id"] == "other")["tps_measured"] is None
        n_agents = len(eng.created_agents)
        r = await client.post("/api/models/active", json={"id": "other"}, headers=h)
        assert r.status == 200 and (await r.json())["provider"] == "custom"
        done = (await send(client, h, sid, "and now?"))[-1][1]
        assert done["model"] == "other" and len(eng.created_agents) == n_agents + 1  # cached agent dropped
        assert eng.created_agents[-1].kw["model"] == "other"
        # ChatGPT models need a login
        r = await client.post("/api/models/active", json={"id": "gpt-5", "provider": "openai_login"}, headers=h)
        assert r.status == 409
    run(t)


def test_models_list_codex_when_logged_in(run, monkeypatch):
    import pico.server as srv
    monkeypatch.setattr(srv, "_remote_models", lambda base, key: [])
    monkeypatch.setattr(srv, "_codex_logged_in", lambda: True)
    monkeypatch.setattr(srv, "_codex_model_ids", lambda: ["gpt-5.5", "gpt-5.4-mini"])

    async def t(client, eng, h):
        res = await (await client.get("/api/models", headers=h)).json()
        codex = [m for m in res["models"] if m["provider"] == "openai_login"]
        assert [m["id"] for m in codex] == ["gpt-5.5", "gpt-5.4-mini"] and codex[0]["provider_label"] == "ChatGPT"
        r = await client.post("/api/models/active", json={"id": "gpt-5.5"}, headers=h)
        assert (await r.json())["provider"] == "openai_login"
        from pico import config as C
        cfg = C.load_config()
        assert cfg["provider"] == {"kind": "openai_login", "model": "gpt-5.5"}
        assert cfg["custom"]["base_url"] == "http://fake/v1"  # remembered for switching back
        r = await client.post("/api/models/active", json={"id": "fake-model", "provider": "custom"}, headers=h)
        assert r.status == 200 and C.load_config()["provider"]["base_url"] == "http://fake/v1"
    run(t)


# ── steering ─────────────────────────────────────────────────────────────────

def test_steer_409_when_idle(run):
    async def t(client, eng, h):
        sid = await new_session(client, h)
        r = await client.post(f"/api/sessions/{sid}/steer", json={"text": "stop"}, headers=h)
        assert r.status == 409
        assert (await client.post(f"/api/sessions/{sid}/steer", json={"text": ""}, headers=h)).status == 400
        assert (await client.post("/api/sessions/s_nope/steer", json={"text": "x"}, headers=h)).status == 404
    run(t)


def test_steer_injects_into_running_turn(run):
    async def t(client, eng, h):
        sid = await new_session(client, h)

        async def go():
            return await send(client, h, sid, "STEERME count slowly")
        task = asyncio.create_task(go())
        for _ in range(100):
            await asyncio.sleep(0.02)
            if eng.bridge.busy(sid) and eng.bridge._turns[sid].agent is not None:
                break
        await asyncio.sleep(0.1)
        r = await client.post(f"/api/sessions/{sid}/steer", json={"text": "stop at 5 and say pineapple"}, headers=h)
        assert r.status == 200 and await r.json() == {"ok": True, "mode": "steer"}
        ev = await task
        steers = [d for e, d in ev if e == "steer"]
        assert steers == [{"text": "stop at 5 and say pineapple", "applied": True}]
        done = ev[-1][1]
        assert ev[-1][0] == "done" and done["model"] == "fake-model" and "yolo" in done and done["harness"]
        full = await (await client.get(f"/api/sessions/{sid}", headers=h)).json()
        steer_msgs = [m for m in full["messages"] if m.get("steer")]
        assert len(steer_msgs) == 1 and steer_msgs[0]["role"] == "user"
        assert "pineapple" in full["messages"][-1]["content"]
    run(t)


def test_steer_after_last_tool_becomes_followup(run):
    """A steer the model never saw (turn finishing) becomes the next turn instead of being lost."""
    async def t(client, eng, h):
        sid = await new_session(client, h)
        watch = asyncio.Queue()
        eng.session_subs.setdefault(sid, set()).add(watch)

        async def go():
            return await send(client, h, sid, "SLOW one")
        task = asyncio.create_task(go())
        for _ in range(100):
            await asyncio.sleep(0.02)
            if eng.bridge.busy(sid) and eng.bridge._turns[sid].agent is not None:
                break
        r = await client.post(f"/api/sessions/{sid}/steer", json={"text": "what OS am I on?"}, headers=h)
        assert (await r.json())["mode"] == "steer"
        eng.bridge._turns[sid].agent.interrupt()  # SLOW returns without draining the steer
        eng.bridge._turns[sid].stopped = False
        await task
        seen = []
        while True:
            ev, data = await asyncio.wait_for(watch.get(), 5)
            seen.append(ev)
            if ev == "done" and seen.count("done") == 2:
                break
        assert "turn_start" in seen
        msgs = eng.store.messages(sid)
        follow = [m for m in msgs if m["role"] == "user" and m["meta"].get("followup")]
        assert follow and follow[0]["content"] == "what OS am I on?"
        assert "Darwin" in msgs[-1]["content"]
    run(t)


def test_steer_queued_during_command_runs_next(run):
    async def t(client, eng, h):
        sid = await new_session(client, h)
        await send(client, h, sid, "hello")
        eng._starting.add(sid)  # an engine command is mid-flight: busy, but no agent to steer
        r = await client.post(f"/api/sessions/{sid}/steer", json={"text": "what OS am I on?"}, headers=h)
        assert await r.json() == {"ok": True, "mode": "queued"}
        eng._starting.discard(sid)
        q = await eng.start_chat(sid, "/usage")
        while (await q.get())[0] != "done":
            pass
        for _ in range(100):
            await asyncio.sleep(0.05)
            msgs = eng.store.messages(sid)
            if msgs[-1]["role"] == "assistant" and "Darwin" in msgs[-1]["content"]:
                break
        assert any(m["meta"].get("followup") and m["content"] == "what OS am I on?" for m in msgs)
        assert "Darwin" in msgs[-1]["content"]
    run(t)


# ── crons ────────────────────────────────────────────────────────────────────

def test_checkins_new_shapes_patch_and_fields(run):
    async def t(client, eng, h):
        r = await client.post("/api/checkins", json={"prompt": "what OS?", "schedule": {"every": "30m"}}, headers=h)
        c = await r.json()
        assert r.status == 200 and c["schedule"] == {"every": "30m", "every_s": 1800}
        assert c["schedule_text"] == "every 30m" and c["next_run"] and c["last_run"] is None
        assert "last_status" in c and "session_id" in c
        r = await client.post("/api/checkins", json={"prompt": "x", "schedule": {"cron": "0 8 * * 1-5"}}, headers=h)
        assert (await r.json())["schedule_text"] == "every weekday at 08:00"
        r = await client.post("/api/checkins", json={"prompt": "x", "schedule": {"text": "every weekday at 8am"}}, headers=h)
        assert (await r.json())["schedule"]["time"] == "08:00"
        # model fallback for phrases the parser doesn't know, validated
        eng.cron_model = lambda text: "30 6 * * 0"
        r = await client.post("/api/checkins", json={"prompt": "x", "schedule": {"text": "sunday crack of dawn"}}, headers=h)
        d = await r.json()
        assert r.status == 200 and d["schedule"]["cron"] == "30 6 * * 0" and d["schedule"]["text"] == "sunday crack of dawn"
        r = await client.post("/api/checkins", json={"prompt": "x", "schedule": {"text": "first monday of the month at 9"}}, headers=h)
        assert r.status == 400 and "exactly" in (await r.json())["error"]  # never approximated to every Monday
        eng.cron_model = lambda text: "not a cron"
        r = await client.post("/api/checkins", json={"prompt": "x", "schedule": {"text": "gibberish words"}}, headers=h)
        assert r.status == 400
        # legacy shape unchanged
        r = await client.post("/api/checkins", json={"prompt": "x", "schedule": {"time": "7:30", "days": ["weekdays"]}}, headers=h)
        assert (await r.json())["schedule"] == {"time": "07:30", "days": ["mon", "tue", "wed", "thu", "fri"]}
        # PATCH
        r = await client.patch(f"/api/checkins/{c['id']}", json={"enabled": False, "prompt": "new prompt",
                                                                 "schedule": {"every": "2h"}}, headers=h)
        p = await r.json()
        assert p["enabled"] is False and p["prompt"] == "new prompt" and p["schedule_text"] == "every 2h"
        assert (await client.patch(f"/api/checkins/{c['id']}", json={"schedule": {"every": "1s"}}, headers=h)).status == 400
        assert (await client.patch("/api/checkins/c_nope", json={}, headers=h)).status == 404
        # fire: status + session recorded, headless approvals deny
        q = asyncio.Queue()
        eng.hub.subs.add(q)
        await client.patch(f"/api/checkins/{c['id']}", json={"enabled": True}, headers=h)
        eng.store.update_checkin(c["id"], next_run=1.0)
        assert c["id"] in await eng.scheduler.tick()
        while True:
            ev, data = await asyncio.wait_for(q.get(), 5)
            if ev == "inbox":
                break
        assert "Darwin" in data["item"]["body"]
        await asyncio.sleep(0.05)
        got = eng.store.get_checkin(c["id"])
        assert got["last_status"] == "ok" and got["session_id"] == data["item"]["session_id"] and got["last_run"]
    run(t)


def test_cron_slash(run):
    async def t(client, eng, h):
        sid = await new_session(client, h)

        async def cron(arg):
            ev = await send(client, h, sid, "/cron" + (" " + arg if arg else ""))
            return "".join(d["text"] for e, d in ev if e == "delta"), ev[-1][1]
        text, done = await cron("")
        assert "No scheduled jobs" in text and done["crons"] == []
        text, done = await cron("add every weekday at 8am -- summarize my inbox")
        assert "every weekday at 08:00" in text and done["crons"][0]["prompt"] == "summarize my inbox"
        text, done = await cron("every 30m check the build")
        assert done["crons"][1]["schedule_text"] == "every 30m" and done["crons"][1]["prompt"] == "check the build"
        text, done = await cron("")
        assert text.startswith("1. ") and "2. " in text
        text, done = await cron("pause 2")
        assert "Paused" in text and done["crons"][1]["enabled"] is False
        text, done = await cron("resume 2")
        assert done["crons"][1]["enabled"] is True
        text, done = await cron("run 1")
        assert "Running now" in text
        text, done = await cron(f"rm {done['crons'][0]['id']}")
        assert "Removed" in text and len(done["crons"]) == 1
        text, done = await cron("rm 9")
        assert "no job" in text
        assert not any(m["role"] == "user" and not m["meta"].get("display_only")
                       for m in eng.store.messages(sid))  # never sent to the model
    run(t)


# ── /loop ────────────────────────────────────────────────────────────────────

def test_loop_args():
    from pico.loops import parse_args
    assert parse_args("") == {"action": "status"}
    assert parse_args("stop") == {"action": "stop"}
    a = parse_args("5m check the build")
    assert a["every_s"] == 300 and a["prompt"] == "check the build" and a["max_runs"] == 20
    assert parse_args("check the build")["every_s"] == 600  # default 10m
    assert parse_args("every 1h ping")["every_s"] == 3600
    assert parse_args("2m ping --times 3")["max_runs"] == 3 and parse_args("2m ping --times 3")["prompt"] == "ping"
    u = parse_args("until-done fix the tests")
    assert u["until_done"] and u["max_runs"] == 10 and u["prompt"] == "fix the tests"
    with pytest.raises(ValueError):
        parse_args("10s too fast")
    with pytest.raises(ValueError):
        parse_args("until-done")


def test_loop_manager_fake_clock():
    from pico.loops import LoopManager

    async def main():
        clock = {"t": 1000.0}
        sleeps: list = []

        async def fake_sleep(s):
            sleeps.append(s)
            clock["t"] += s
            await asyncio.sleep(0)

        calls, events, busy = [], [], {"n": 0}

        async def run(sid, n, prompt, st):
            if busy["n"]:
                busy["n"] -= 1
                return None
            calls.append((n, clock["t"]))
            return "reply"

        mgr = LoopManager(run, lambda st, n: events.append((st.state, n)), now=lambda: clock["t"], sleep=fake_sleep)
        busy["n"] = 1  # first attempt finds the chat busy -> skipped, not counted
        st = mgr.start("s1", "ping", 300, max_runs=3)
        await asyncio.wait_for(st.task, 2)
        assert [n for n, _ in calls] == [1, 2, 3] and st.runs == 3 and st.state == "done"
        assert calls[1][1] - calls[0][1] == 300 and calls[2][1] - calls[1][1] == 300
        assert sleeps[0] == 300  # the busy skip waited one interval
        assert events[-1] == ("done", 3) and ("running", 1) in events
        assert mgr.status("s1")["active"] is False

        # until-done: stops when the reply has a LOOP_DONE line
        replies = iter(["working", "still going", "all fixed\nLOOP_DONE"])

        async def run2(sid, n, prompt, st):
            return next(replies)
        mgr2 = LoopManager(run2, now=lambda: clock["t"], sleep=fake_sleep)
        st2 = mgr2.start("s2", "fix", 0, until_done=True)
        await asyncio.wait_for(st2.task, 2)
        assert st2.runs == 3 and st2.state == "done"

        # stop while waiting
        async def real_sleep(s):
            await asyncio.sleep(0.01 if s else 0)
        mgr3 = LoopManager(run2 if False else (lambda *a: asyncio.sleep(0, "x")), now=time.time, sleep=real_sleep)
        st3 = mgr3.start("s3", "x", 60)
        await asyncio.sleep(0.05)
        assert mgr3.stop("s3") and mgr3.status("s3")["state"] == "stopped"
    asyncio.run(main())


def test_loop_slash_and_api(run):
    async def t(client, eng, h):
        sid = await new_session(client, h)
        st = await (await client.get(f"/api/sessions/{sid}/loop", headers=h)).json()
        assert st["active"] is False
        hub = asyncio.Queue()
        eng.hub.subs.add(hub)
        ev = await send(client, h, sid, "/loop 30s what OS am I on?")
        done = ev[-1][1]
        assert done["loop"]["active"] and done["loop"]["every_s"] == 30 and done["loop"]["max_runs"] == 20
        # first iteration runs right away as a normal turn with meta.loop
        while True:
            e, d = await asyncio.wait_for(hub.get(), 5)
            if e == "loop" and d["state"] == "waiting" and d["n"] == 1:
                break
        assert d["session_id"] == sid and d["next_at"] > time.time() + 20
        msgs = (await (await client.get(f"/api/sessions/{sid}", headers=h)).json())["messages"]
        loop_msgs = [m for m in msgs if m.get("loop")]
        assert loop_msgs and loop_msgs[0]["loop"] == {"n": 1} and "Darwin" in msgs[-1]["content"]
        st = await (await client.get(f"/api/sessions/{sid}/loop", headers=h)).json()
        assert st["active"] and st["runs"] == 1 and st["prompt"] == "what OS am I on?"
        text = "".join(d["text"] for e, d in await send(client, h, sid, "/loop") if e == "delta")
        assert "Looping every 30s" in text
        r = await client.delete(f"/api/sessions/{sid}/loop", headers=h)
        assert (await r.json())["stopped"] is True
        assert (await (await client.get(f"/api/sessions/{sid}/loop", headers=h)).json())["active"] is False
        e, d = await asyncio.wait_for(hub.get(), 5)
        while not (e == "loop" and d["state"] == "stopped"):
            e, d = await asyncio.wait_for(hub.get(), 5)
        text = "".join(d["text"] for e, d in await send(client, h, sid, "/loop 5s x") if e == "delta")
        assert "30s" in text
    run(t)


def test_session_stream_relays_engine_turns(run):
    async def t(client, eng, h):
        sid = await new_session(client, h)
        await send(client, h, sid, "hello")  # persist
        resp = await client.get(f"/api/sessions/{sid}/stream", headers=h)
        assert resp.status == 200
        buf = b""

        async def read_until(pred):
            nonlocal buf
            while True:
                chunk = await asyncio.wait_for(resp.content.readany(), 5)
                buf += chunk
                evs = parse_sse(buf.decode())
                if pred(evs):
                    return evs
        await read_until(lambda evs: any(e == "hello" for e, _ in evs))
        # an engine-started turn (as a loop/cron would) shows up on the stream
        q = await eng.start_chat(sid, "what OS am I on?", source="loop", user_meta={"loop": {"n": 1}})
        while (await q.get())[0] != "done":
            pass
        evs = await read_until(lambda evs: any(e == "done" for e, _ in evs))
        names = [e for e, _ in evs]
        assert names[0] == "hello" and "turn_start" in names and "delta" in names and "tool_start" in names
        ts = next(d for e, d in evs if e == "turn_start")
        assert ts["source"] == "loop" and ts["loop"] == {"n": 1}
        done = next(d for e, d in evs if e == "done")
        assert done["model"] == "fake-model" and "final" not in done
        resp.close()
    run(t)


# ── goal / plan ──────────────────────────────────────────────────────────────

def test_goal_state_shape_and_events(run):
    async def t(client, eng, h):
        sid = await new_session(client, h)
        full = await (await client.get(f"/api/sessions/{sid}", headers=h)).json()
        assert full["goal_state"] == {"text": None, "status": "cleared", "progress": None, "todos": []}
        ev = await send(client, h, sid, "/goal know the OS")
        g = next(d for e, d in ev if e == "goal")
        assert g == {"text": "know the OS", "status": "active", "progress": None, "todos": []}
        ev = await send(client, h, sid, "what OS am I on?")
        g = next(d for e, d in ev if e == "goal")
        assert g["status"] == "active" and g["progress"] == {"done": 1, "total": 1}
        assert g["todos"] == [{"text": "check os", "done": True}] and ev[-1][1]["goal_state"] == g
        assert "GOAL_DONE" in eng.created_agents[-1].system_prompts[-1] and "todo_list" in eng.created_agents[-1].system_prompts[-1]
        full = await (await client.get(f"/api/sessions/{sid}", headers=h)).json()
        assert set(full["goal_state"]) == {"text", "status", "progress", "todos"}
        # the model saying GOAL_DONE marks it done
        from conftest import FakeAgent
        orig = FakeAgent.run_conversation

        def done_reply(self, text, conversation_history=None):
            r = orig(self, text, conversation_history)
            r["final_response"] += "\nGOAL_DONE"
            return r
        FakeAgent.run_conversation = done_reply
        try:
            ev = await send(client, h, sid, "anything else?")
        finally:
            FakeAgent.run_conversation = orig
        assert next(d for e, d in ev if e == "goal")["status"] == "done"
        ev = await send(client, h, sid, "/goal clear")
        assert next(d for e, d in ev if e == "goal") == {"text": None, "status": "cleared", "progress": None, "todos": []}
    run(t)


def test_plan_events_then_go(run):
    async def t(client, eng, h):
        sid = await new_session(client, h)
        ev = await send(client, h, sid, "/plan find the OS")
        plans = [d for e, d in ev if e == "plan"]
        assert plans[0]["phase"] == "planning" and plans[0]["steps"] == []
        assert plans[-1]["phase"] == "awaiting" and plans[-1]["steps"] == [{"text": "check os", "status": "done"}]
        assert ev[-1][1]["plan"]["phase"] == "awaiting"
        assert eng.created_agents[-1].prompts[-1].startswith("[Plan mode]")
        ev = await send(client, h, sid, "go")
        assert eng.created_agents[-1].prompts[-1].startswith("Go ahead")
        plans = [d for e, d in ev if e == "plan"]
        assert plans[0]["phase"] == "executing" and plans[-1]["phase"] == "done"
        # after done, "go" is just text
        await send(client, h, sid, "go")
        assert eng.created_agents[-1].prompts[-1] == "go"
        ev = await send(client, h, sid, "/plan! find it again")
        assert eng.created_agents[-1].prompts[-1].startswith("[Plan then do]")
        plans = [d for e, d in ev if e == "plan"]
        assert plans[0]["phase"] == "executing" and plans[-1]["phase"] == "done"
    run(t)


# ── easy setup / providers ─────────────────────────────────────────────────────

def test_provider_presets(run):
    async def t(client, eng, h):
        ps = await (await client.get("/api/provider/presets", headers=h)).json()
        ids = [p["id"] for p in ps]
        assert ids == ["openai", "openrouter", "groq", "together", "deepseek", "anthropic", "ollama", "lmstudio", "custom"]
        o = next(p for p in ps if p["id"] == "ollama")
        assert o == {**o, "base_url": "http://localhost:11434/v1", "needs_key": False}
        assert set(ps[0]) == {"id", "name", "base_url", "needs_key", "note"}
    run(t)


class _FakeHTTP:
    """Minimal OpenAI-compatible server for provider tests."""

    def __init__(self, key=None, models=("m1", "m2"), has_models=True):
        from aiohttp import web
        self.key, self.models, self.has_models = key, models, has_models
        app = web.Application()
        app.router.add_get("/v1/models", self.list)
        app.router.add_post("/v1/chat/completions", self.chat)
        self.app = app

    def _auth(self, request):
        return self.key is None or request.headers.get("Authorization") == f"Bearer {self.key}"

    async def list(self, request):
        from aiohttp import web
        if not self.has_models:
            return web.Response(status=404)
        if not self._auth(request):
            return web.json_response({"error": "bad key " + request.headers.get("Authorization", "")}, status=401)
        return web.json_response({"data": [{"id": m, "max_model_len": 4096} for m in self.models]})

    async def chat(self, request):
        from aiohttp import web
        if not self._auth(request):
            return web.json_response({"error": "bad key"}, status=401)
        b = await request.json()
        if b["model"] not in self.models:
            return web.json_response({"error": "no such model"}, status=404)
        await asyncio.sleep(0.1)
        return web.json_response({"choices": [{"message": {"content": "ok"}}], "usage": {"completion_tokens": 2}})


def test_provider_test_endpoint(run):
    async def t(client, eng, h):
        from aiohttp.test_utils import TestServer
        srv = TestServer(_FakeHTTP(key="sk-secret-123").app)
        await srv.start_server()
        base = str(srv.make_url("/v1"))
        try:
            async def test(**b):
                r = await client.post("/api/provider/test", json={"kind": "custom", "base_url": base, **b}, headers=h)
                assert r.status == 200
                raw = await r.text()
                assert "sk-secret-123" not in raw  # never echoed
                return json.loads(raw)
            ok = await test(api_key="sk-secret-123")
            assert ok["ok"] and ok["models"] == ["m1", "m2"] and ok["model_used"] == "m1"
            assert ok["latency_s"] >= 0.1 and ok["tps"] and "error" not in ok
            assert (await test(api_key="sk-secret-123", model="m2"))["model_used"] == "m2"
            bad = await test(api_key="wrong")
            assert not bad["ok"] and bad["error"]["kind"] == "auth"
            nf = await test(api_key="sk-secret-123", model="nope")
            assert nf["error"]["kind"] == "not_found" and "m1" in nf["error"]["message"]
            dead = await (await client.post("/api/provider/test", json={"kind": "custom", "base_url": "http://127.0.0.1:9/v1"},
                                            headers=h)).json()
            assert dead["error"]["kind"] == "network" and dead["ok"] is False
            from pico import config as C
            assert C.get_secret("custom_api_key") is None  # never stored
        finally:
            await srv.close()
        # endpoint without /models: tolerated when a model is given
        srv2 = TestServer(_FakeHTTP(has_models=False, models=("x",)).app)
        await srv2.start_server()
        try:
            r = await (await client.post("/api/provider/test", json={"base_url": str(srv2.make_url("/v1")), "model": "x"},
                                         headers=h)).json()
            assert r["ok"] and r["models"] == [] and r["model_used"] == "x"
        finally:
            await srv2.close()
        assert (await client.post("/api/provider/test", json={"kind": "openai_login"}, headers=h)).status == 400
    run(t)


def test_setup_custom_fast_and_openai_login(run, monkeypatch):
    import pico.server as srv
    monkeypatch.setattr(srv, "_remote_models", lambda base, key: [{"id": "m1", "name": "m1", "provider": "custom",
                                                                    "local": False, "ctx": None, "tps": None}])

    async def wait_job(client, h, jid):
        return parse_sse(await (await client.get(f"/api/jobs/{jid}/events", headers=h)).text())

    async def t(client, eng, h):
        from pico import config as C
        t0 = time.time()
        r = await client.post("/api/setup", json={"provider": {"kind": "custom", "base_url": "http://x/v1/",
                                                               "api_key": "sk-1", "model": "m1"}}, headers=h)
        ev = await wait_job(client, h, (await r.json())["job_id"])
        assert ev[-1][0] == "done" and time.time() - t0 < 5
        cfg = C.load_config()
        assert cfg["provider"] == {"kind": "custom", "base_url": "http://x/v1", "model": "m1"}
        assert C.get_secret("custom_api_key") == "sk-1" and "sk-1" not in (C.pico_home() / "config.json").read_text()
        # openai_login without creds -> error; with creds -> done, model from top-level or default
        monkeypatch.setattr(srv, "_codex_logged_in", lambda: False)
        r = await client.post("/api/setup", json={"provider": {"kind": "openai_login"}}, headers=h)
        ev = await wait_job(client, h, (await r.json())["job_id"])
        assert ev[-1][0] == "error" and "ChatGPT" in ev[-1][1]["message"]
        monkeypatch.setattr(srv, "_codex_logged_in", lambda: True)
        monkeypatch.setattr(srv, "_codex_model_ids", lambda: ["gpt-5.5", "gpt-5.4-mini"])
        r = await client.post("/api/setup", json={"provider": {"kind": "openai_login"}, "model": "gpt-5.4-mini"}, headers=h)
        ev = await wait_job(client, h, (await r.json())["job_id"])
        assert ev[-1][0] == "done"
        assert C.load_config()["provider"] == {"kind": "openai_login", "model": "gpt-5.4-mini"}
        r = await client.post("/api/setup", json={"provider": {"kind": "openai_login"}}, headers=h)
        await wait_job(client, h, (await r.json())["job_id"])
        assert C.load_config()["provider"]["model"] == "gpt-5.5"
    run(t, configured=False)


def test_setup_persona_defaults_to_engineer(run, monkeypatch):
    import pico.server as srv
    monkeypatch.setattr(srv, "_remote_models", lambda base, key: [])

    async def t(client, eng, h):
        from pico import config as C
        (C.pico_home() / "config.json").unlink(missing_ok=True)
        r = await client.post("/api/setup", json={"provider": {"kind": "custom", "base_url": "http://x/v1", "model": "m"}},
                              headers=h)
        await (await client.get(f"/api/jobs/{(await r.json())['job_id']}/events", headers=h)).text()
        assert C.load_config()["persona"] == "engineer"
    run(t, configured=False)


def test_openai_status_shapes(run, monkeypatch):
    import pico.server as srv
    monkeypatch.setattr(srv, "_codex_logged_in", lambda: False)

    async def t(client, eng, h):
        st = await (await client.get("/api/auth/openai/status", headers=h)).json()
        assert st["state"] == "idle" and st["logged_in"] is False
        eng.openai_login = {"state": "pending", "url": "https://auth.openai.com/codex/device", "code": "AB-12",
                            "expires": time.time() + 600}
        st = await (await client.get("/api/auth/openai/status", headers=h)).json()
        assert st == {"state": "pending", "url": "https://auth.openai.com/codex/device", "code": "AB-12", "logged_in": False}
        eng.openai_login = {"state": "error", "message": "denied"}
        st = await (await client.get("/api/auth/openai/status", headers=h)).json()
        assert st["state"] == "error" and st["error"] == "denied"
        monkeypatch.setattr(srv, "_codex_logged_in", lambda: True)
        eng.openai_login = {"state": "done"}
        assert (await (await client.get("/api/auth/openai/status", headers=h)).json())["state"] == "done"
        eng.openai_login = {"state": "idle"}
        assert (await (await client.get("/api/auth/openai/status", headers=h)).json())["state"] == "done"
    run(t)


def test_openai_login_turn_resolves_codex_creds(run, monkeypatch):
    """provider openai_login: the turn's agent gets Hermes' Codex creds (mocked) in lean mode."""
    import hermes_cli.auth_codex as hac  # noqa: F401  (ensure importable)

    async def t(client, eng, h):
        from pico import config as C
        from pico.agent_bridge import ensure_hermes
        ensure_hermes()
        import hermes_cli.auth_codex as hac2
        monkeypatch.setattr(hac2, "resolve_codex_runtime_credentials",
                            lambda **kw: {"api_key": "tok-xyz", "base_url": "https://chatgpt.com/backend-api/codex"})
        cfg = C.load_config()
        cfg["provider"] = {"kind": "openai_login", "model": "gpt-5.5"}
        C.save_config(cfg)
        sid = await new_session(client, h)
        done = (await send(client, h, sid, "what OS am I on?"))[-1][1]
        kw = eng.created_agents[-1].kw
        assert kw["provider"] == "openai-codex" and kw["api_key"] == "tok-xyz" and kw["model"] == "gpt-5.5"
        assert done["harness"] == "lean" and done["model"] == "gpt-5.5"
    try:
        from pico.agent_bridge import ensure_hermes
        ensure_hermes()
    except Exception:  # noqa: BLE001
        pytest.skip("Hermes not importable")
    run(t)


def test_hermes_auth_isolated(pico_home):
    from pico import config as C
    from pico.agent_bridge import ensure_hermes
    try:
        ensure_hermes()
    except Exception:  # noqa: BLE001
        pytest.skip("Hermes not importable")
    import hermes_cli.auth as ha
    import hermes_cli.auth_codex as hac
    assert ha._auth_file_path() == C.hermes_home() / "auth.json"
    assert ha._global_auth_file_path() is None  # never falls back to ~/.hermes/auth.json
    assert hac._import_codex_cli_tokens() is None  # never adopts ~/.codex


# ── sessions POST prefs / efforts ──────────────────────────────────────────────

def test_session_create_with_prefs(run):
    async def t(client, eng, h):
        r = await client.post("/api/sessions", json={"yolo": True, "model": "other-model", "effort": "high",
                                                     "harness": "hermes"}, headers=h)
        s = await r.json()
        assert s["yolo"] is True and s["model"] == "other-model" and s["effort"] == "high" and s["harness"] == "hermes"
        done = (await send(client, h, s["id"], "what OS am I on?"))[-1][1]
        assert done["yolo"] is True and done["model"] == "other-model" and done["harness"] == "hermes"
        kw = eng.created_agents[-1].kw
        assert kw["model"] == "other-model" and kw["reasoning_config"] == {"enabled": True, "effort": "high"}
        full = await (await client.get(f"/api/sessions/{s['id']}", headers=h)).json()
        assert full["yolo"] is True and full["model"] == "other-model"
        assert (await client.post("/api/sessions", json={"effort": "ludicrous"}, headers=h)).status == 400
        assert (await client.post("/api/sessions", json={"harness": "x"}, headers=h)).status == 400
        r = await client.patch(f"/api/sessions/{s['id']}", json={"model": None, "effort": "low"}, headers=h)
        assert (await r.json())["model"] == "fake-model"
    run(t)


def test_efforts_off_maps_to_low(run):
    async def t(client, eng, h):
        from pico import config as C
        cfg = await (await client.get("/api/config", headers=h)).json()
        assert cfg["efforts"] == ["low", "medium", "high"]
        r = await client.patch("/api/config", json={"effort_default": "off"}, headers=h)
        assert r.status == 200 and (await r.json())["effort_default"] == "low"
        assert (await client.patch("/api/config", json={"effort_default": "turbo"}, headers=h)).status == 400
        raw = C.load_config()
        raw["effort_default"] = "off"
        C.save_config(raw)
        assert C.load_config()["effort_default"] == "low"
        sid = await new_session(client, h)
        ev = await send(client, h, sid, "what OS am I on?", effort="off")
        assert eng.created_agents[-1].kw["reasoning_config"] == {"enabled": True, "effort": "low"}
        assert any(e == "reasoning" for e, _ in ev)  # reasoning always streamed
        assert C.normalize_effort("max") == "max" and C.normalize_effort("xhigh") == "max"
        from pico.agent_bridge import effort_params
        assert effort_params("max", "custom")[0]["effort"] == "high"  # clamped where unsupported
        assert effort_params("max", "openai_login")[0]["effort"] == "max"
    run(t)
