"""Engine API tests with a fake agent: auth, session lifecycle, SSE shape, slash commands, misc."""
from __future__ import annotations

import asyncio
import os
import stat

from conftest import parse_sse


async def send(client, h, sid, text, **extra):
    r = await client.post(f"/api/sessions/{sid}/messages", json={"text": text, **extra}, headers=h)
    assert r.status == 200, await r.text()
    assert r.headers["Content-Type"].startswith("text/event-stream")
    return parse_sse(await r.text())


# ── auth ─────────────────────────────────────────────────────────────────────

def test_token_file_and_auth(run, pico_home):
    async def t(client, eng, h):
        tok_path = pico_home / "token"
        assert tok_path.read_text().strip() == eng.token
        assert stat.S_IMODE(os.stat(tok_path).st_mode) == 0o600
        r = await client.get("/api/health")
        assert r.status == 200
        body = await r.json()
        assert body["ok"] and body["state"] == "ready" and body["provider"] == "custom"
        assert (await client.get("/api/config")).status == 401
        assert (await client.get("/api/config", headers={"Authorization": "Bearer nope"})).status == 401
        assert (await client.get("/api/config", headers=h)).status == 200
        assert (await client.get(f"/api/sessions?token={eng.token}")).status == 200  # EventSource style
        r = await client.get("/")
        assert r.status == 200 and "pico" in await r.text()
    run(t)


def test_secrets_never_returned(run, pico_home):
    async def t(client, eng, h):
        r = await client.patch("/api/config", json={"provider": {"kind": "custom", "base_url": "http://x/v1",
                                                                  "model": "m", "api_key": "sk-SECRET123"}}, headers=h)
        body = await r.text()
        assert r.status == 200 and "sk-SECRET123" not in body
        assert (await r.json())["provider"]["has_key"] is True
        assert "sk-SECRET123" not in (pico_home / "config.json").read_text()
        sec = pico_home / "secrets.json"
        assert "sk-SECRET123" in sec.read_text()
        assert stat.S_IMODE(os.stat(sec).st_mode) == 0o600
        assert "sk-SECRET123" not in await (await client.get("/api/config", headers=h)).text()
    run(t)


def test_setup_state_without_provider(run):
    async def t(client, eng, h):
        assert (await (await client.get("/api/health")).json())["state"] == "setup"
        sid = (await (await client.post("/api/sessions", json={}, headers=h)).json())["id"]
        r = await client.post(f"/api/sessions/{sid}/messages", json={"text": "hi"}, headers=h)
        assert r.status == 409
    run(t, configured=False)


# ── sessions + SSE ───────────────────────────────────────────────────────────

def test_session_lifecycle_and_sse_shape(run):
    async def t(client, eng, h):
        s = await (await client.post("/api/sessions", json={"title": None}, headers=h)).json()
        sid = s["id"]
        # lazy: not persisted / listed until the first message
        assert await (await client.get("/api/sessions", headers=h)).json() == []
        assert (await client.get(f"/api/sessions/{sid}", headers=h)).status == 200

        events = await send(client, h, sid, "what OS am I on?", effort="off")
        kinds = [e for e, _ in events]
        assert kinds[0] == "reasoning"
        assert "tool_start" in kinds and "tool_end" in kinds and "todo" in kinds and "delta" in kinds
        assert kinds[-1] == "done"
        ts = next(d for e, d in events if e == "tool_start")
        assert ts == {"id": "call_1", "name": "terminal", "args": {"command": "uname -sm"},
                      "label": "terminal `uname -sm`"}
        te = next(d for e, d in events if e == "tool_end")
        assert {"id", "name", "ok", "result_preview"} <= set(te) <= {"id", "name", "ok", "result_preview", "seconds", "diff", "diffs"}
        assert te["ok"] is True
        todo = next(d for e, d in events if e == "todo")
        assert todo["todos"][0]["text"] == "check os" and todo["todos"][0]["done"] is True
        done = events[-1][1]
        assert {k: done["usage"][k] for k in ("input", "output")} == {"input": 100, "output": 10} and done["message_id"]
        assert "last_input" in done["usage"] and done["context"]["max"] > 0 and done["summary"]["tools"] == 2
        assert "seconds" in done and "tps" in done
        assert "".join(d["text"] for e, d in events if e == "delta") == "You are on Darwin arm64."
        # legacy effort=off is no longer user-facing: it maps to low (thinking stays on, reasoning still streams)
        kw = eng.created_agents[0].kw
        assert kw["reasoning_config"] == {"enabled": True, "effort": "low"}
        assert kw["request_overrides"]["extra_body"]["chat_template_kwargs"]["enable_thinking"] is True
        assert kw["platform"] == "pico" and kw["session_id"] == sid

        listed = await (await client.get("/api/sessions", headers=h)).json()
        assert listed[0]["id"] == sid and listed[0]["title"] == "what OS am I on?"
        full = await (await client.get(f"/api/sessions/{sid}", headers=h)).json()
        roles = [m["role"] for m in full["messages"]]
        assert roles == ["user", "tool", "tool", "assistant"]
        assert full["messages"][1]["tool"]["name"] == "terminal"
        assert full["messages"][-1]["reasoning"] == "let me think"
        assert full["todos"][0]["text"] == "check os"

        # second turn sees the first turn's Hermes transcript as history
        await send(client, h, sid, "and again?", effort="high")
        agent = eng.created_agents[-1]
        hist = agent.histories[-1]
        assert [m["role"] for m in hist] == ["user", "assistant", "tool", "assistant"]
        assert hist[0]["content"] == "what OS am I on?"
        assert agent.kw["reasoning_config"] == {"enabled": True, "effort": "high"}

        # search
        hits = await (await client.get("/api/search?q=Darwin", headers=h)).json()
        assert hits and hits[0]["session_id"] == sid and "[Darwin]" in hits[0]["snippet"]

        # patch / delete
        r = await client.patch(f"/api/sessions/{sid}", json={"pinned": True, "title": "OS"}, headers=h)
        assert (await r.json())["pinned"] is True
        assert (await client.delete(f"/api/sessions/{sid}", headers=h)).status == 200
        assert (await client.get(f"/api/sessions/{sid}", headers=h)).status == 404
        assert await (await client.get("/api/search?q=Darwin", headers=h)).json() == []
    run(t)


def test_stop_interrupts(run):
    async def t(client, eng, h):
        sid = (await (await client.post("/api/sessions", json={}, headers=h)).json())["id"]

        async def stopper():
            await asyncio.sleep(0.3)
            r = await client.post(f"/api/sessions/{sid}/stop", headers=h)
            assert (await r.json())["ok"] is True

        task = asyncio.create_task(stopper())
        events = await send(client, h, sid, "SLOW please")
        await task
        assert events[-1][0] == "done" and events[-1][1]["stopped"] is True
        assert events[-1][1]["seconds"] < 4
    run(t)


def test_approval_roundtrip(run):
    """Bridge-level: an approval callback emits `approval` and blocks until POST /approve."""
    async def t(client, eng, h):
        from pico.agent_bridge import _approval_cv
        sid = (await (await client.post("/api/sessions", json={}, headers=h)).json())["id"]
        eng.ensure_persisted(sid)
        seen = {}

        class ApprovingAgent:
            def __init__(self, **kw):
                self.kw = kw

            def run_conversation(self, text, conversation_history=None):
                cb = _approval_cv.get()
                seen["choice"] = cb("rm -rf /tmp/x", "delete in root path", allow_permanent=True)
                return {"final_response": "ok", "messages": [], "input_tokens": 0, "output_tokens": 0}

        eng.bridge._factory = ApprovingAgent
        turn, fut = await eng.bridge.run_turn(sid, "go", [], effort="low", cwd=None)
        ev, data = await asyncio.wait_for(turn.queue.get(), 5)
        assert ev == "approval" and data["command"] == "rm -rf /tmp/x" and data["reason"]
        r = await client.post(f"/api/sessions/{sid}/approve", json={"id": data["id"], "allow": True}, headers=h)
        assert (await r.json())["ok"] is True
        await asyncio.wait_for(fut, 5)
        assert seen["choice"] == "once"
    run(t)


# ── slash commands ───────────────────────────────────────────────────────────

def test_slash_parse():
    from pico.slash import parse
    assert parse("/goal ship v1").name == "goal" and parse("/goal ship v1").arg == "ship v1"
    assert parse("/compact").arg == ""
    assert parse("/humanizer fix this\nplease").arg == "fix this\nplease"
    assert parse("/usr/bin/env python") is None
    assert parse("hello /goal") is None
    assert parse("//x") is None
    assert parse("/plan build a shed").builtin


def test_goal_plan_skill_compact(run, pico_home):
    async def t(client, eng, h):
        sid = (await (await client.post("/api/sessions", json={}, headers=h)).json())["id"]
        ev = await send(client, h, sid, "/goal finish the report")
        assert ev[-1][0] == "done" and ev[-1][1]["goal"] == "finish the report"
        assert (await (await client.get(f"/api/sessions/{sid}", headers=h)).json())["goal"] == "finish the report"
        assert not eng.created_agents  # /goal never calls the model

        await send(client, h, sid, "hello")
        assert "finish the report" in eng.created_agents[-1].system_prompts[-1]
        # /goal messages are display-only, not replayed to the model
        await send(client, h, sid, "/plan write it")
        agent = eng.created_agents[-1]
        assert agent.prompts[-1].startswith("[Plan mode]") and "write it" in agent.prompts[-1]
        assert all("/goal" not in (m.get("content") or "") for m in agent.histories[-1])

        # skill slash: write a skill then invoke it
        r = await client.put("/api/skills/shout", json={"description": "Shout", "body": "Reply in CAPS."}, headers=h)
        assert r.status == 200
        await send(client, h, sid, "/shout hi there")
        p = eng.created_agents[-1].prompts[-1]
        assert "Reply in CAPS." in p and "hi there" in p
        # disabled skill → sent as typed
        await client.post("/api/skills/shout/toggle", headers=h)
        await send(client, h, sid, "/shout again")
        assert eng.created_agents[-1].prompts[-1] == "/shout again"

        ev = await send(client, h, sid, "/compact")
        assert ev[-1][0] == "done" and ev[-1][1]["compacted"] > 0
        full = await (await client.get(f"/api/sessions/{sid}", headers=h)).json()
        assert len(full["messages"]) == 1 and "user asked about the OS" in full["messages"][0]["content"]
        assert eng.hermes_history(sid)[0]["role"] == "user"
    run(t)


# ── memory / skills / connectors / pairing / checkins API ───────────────────

def test_memory_and_skills_use_hermes_storage(run, pico_home):
    async def t(client, eng, h):
        r = await client.post("/api/memory", json={"text": "User prefers metric units"}, headers=h)
        assert r.status == 200, await r.text()
        mem = await (await client.get("/api/memory", headers=h)).json()
        assert any(m["text"] == "User prefers metric units" for m in mem)
        assert "User prefers metric units" in (pico_home / "hermes" / "memories" / "MEMORY.md").read_text()
        mid = mem[0]["id"]
        assert (await client.delete(f"/api/memory/{mid}", headers=h)).status == 200
        assert await (await client.get("/api/memory", headers=h)).json() == []

        await client.put("/api/skills/my-skill", json={"description": "d", "body": "B"}, headers=h)
        sk = await (await client.get("/api/skills/my-skill", headers=h)).json()
        assert sk["body"].strip() == "B" and sk["enabled"] is True
        assert (pico_home / "hermes" / "skills" / "pico" / "my-skill" / "SKILL.md").exists()
        sk = await (await client.post("/api/skills/my-skill/toggle", headers=h)).json()
        assert sk["enabled"] is False
        import yaml
        cfg = yaml.safe_load((pico_home / "hermes" / "config.yaml").read_text())
        assert "my-skill" in cfg["skills"]["disabled"]
        assert (await client.delete("/api/skills/my-skill", headers=h)).status == 200
    run(t)


def test_connectors(run, pico_home):
    async def t(client, eng, h):
        cat = await (await client.get("/api/connectors", headers=h)).json()
        ids = {c["id"] for c in cat}
        assert {"web_search", "github", "notion", "filesystem"} <= ids
        assert all(c["what"] and c["kind"] in ("mcp", "oauth", "key") for c in cat)
        r = await client.post("/api/connectors/github/connect", json={"fields": {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_X"}}, headers=h)
        assert r.status == 200 and "ghp_X" not in await r.text()
        import yaml
        cfg = yaml.safe_load((pico_home / "hermes" / "config.yaml").read_text())
        assert cfg["mcp_servers"]["pico-github"]["url"].startswith("https://")
        assert "ghp_X" not in (pico_home / "hermes" / "config.yaml").read_text()
        assert "ghp_X" in (pico_home / "hermes" / ".env").read_text()
        assert (await client.delete("/api/connectors/github", headers=h)).status == 200
        cfg = yaml.safe_load((pico_home / "hermes" / "config.yaml").read_text())
        assert "pico-github" not in cfg["mcp_servers"]
    run(t)


def test_pairing(run):
    async def t(client, eng, h):
        p = await (await client.post("/api/pair", headers=h)).json()
        assert p["qr"].startswith("<svg") and p["code"] and "pico://pair?u=" in p["payload"]
        r = await client.post("/api/pair/claim", json={"code": p["code"], "device_name": "iPhone"})
        tok = (await r.json())["token"]
        assert (await client.get("/api/sessions", headers={"Authorization": f"Bearer {tok}"})).status == 200
        r = await client.post("/api/pair/claim", json={"code": p["code"], "device_name": "again"})
        assert r.status == 403  # one-time
    run(t)


def test_qr_encoder_matches_known_vector():
    from pico.qr import QrCode
    q = QrCode(b"HELLO", "M")
    assert q.version == 1 and q.size == 21
    # finder pattern corners
    assert q.modules[0][0] and q.modules[0][6] and not q.modules[1][1]
    big = QrCode(b"pico://pair?u=" + b"x" * 300, "M")
    assert big.version > 5


def test_checkins_api_and_fire(run):
    async def t(client, eng, h):
        r = await client.post("/api/checkins", json={"title": "Morning", "prompt": "what OS?",
                                                      "schedule": {"time": "7:30", "days": ["weekdays"]}}, headers=h)
        c = await r.json()
        assert r.status == 200 and c["schedule"] == {"time": "07:30", "days": ["mon", "tue", "wed", "thu", "fri"]}
        assert c["next_run"]
        bad = await client.post("/api/checkins", json={"prompt": "x", "schedule": {"time": "25:00"}}, headers=h)
        assert bad.status == 400
        # fire it now via the scheduler
        q = asyncio.Queue()
        eng.hub.subs.add(q)
        eng.store.update_checkin(c["id"], next_run=1.0)
        fired = await eng.scheduler.tick()
        assert fired == [c["id"]]
        ev, data = await asyncio.wait_for(q.get(), 5)
        assert ev == "inbox" and data["item"]["title"] == "Morning" and "Darwin" in data["item"]["body"]
        inbox = await (await client.get("/api/inbox", headers=h)).json()
        assert inbox[0]["session_id"]
        assert eng.store.get_checkin(c["id"])["next_run"] > 1.0
    run(t)


# ── tps ──────────────────────────────────────────────────────────────────────

def test_turn_tps_is_sane():
    from pico.server import turn_tps
    # regression: 121 tokens, 3.65s turn, answer burst-emitted at the very end -> was 30464.7 tok/s
    assert turn_tps(121, 3.65, tool_s=0.0, stream_s=0.004) == round(121 / 3.65, 1)
    # tool time is excluded from model time
    assert turn_tps(100, 12.0, tool_s=10.0, stream_s=0.0) == 50.0
    # a real streamed answer uses the streaming span
    assert turn_tps(200, 10.0, tool_s=0.0, stream_s=8.0) == 25.0
    assert turn_tps(0, 3.0) is None and turn_tps(50, 0.01) is None


def test_done_tps_bounded(run):
    async def t(client, eng, h):
        sid = (await (await client.post("/api/sessions", json={}, headers=h)).json())["id"]
        done = (await send(client, h, sid, "what OS am I on?", effort="off"))[-1][1]
        assert done["tps"] is None or 0 < done["tps"] <= 10 / max(done["seconds"] - 0.0, 0.05) + 1
    run(t)


def test_yolo_state_in_session_and_done(run):
    async def t(client, eng, h):
        sid = (await (await client.post("/api/sessions", json={}, headers=h)).json())["id"]
        done = (await send(client, h, sid, "/yolo on"))[-1][1]
        assert done["yolo"] is True
        full = await (await client.get(f"/api/sessions/{sid}", headers=h)).json()
        assert full["yolo"] is True
        done = (await send(client, h, sid, "what OS am I on?", effort="off"))[-1][1]
        assert done["yolo"] is True
        assert (await send(client, h, sid, "/yolo off"))[-1][1]["yolo"] is False
        assert (await (await client.get(f"/api/sessions/{sid}", headers=h)).json())["yolo"] is False
    run(t)
