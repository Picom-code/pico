"""Rich events: labels, diffs, checkpoints + undo, context/summary, subagents config/events, notices."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest


class EditAgent:
    """Fake AIAgent that edits/creates files through tool callbacks like Hermes' write_file/patch."""

    def __init__(self, **kw):
        self.kw = kw
        self.ephemeral_system_prompt = None
        self.histories: list = []
        self._last_turn_usage = {"prompt_tokens": 1234, "cache_read_tokens": 1000}

        class _CC:
            context_length = 65536
        self.context_compressor = _CC()

    def interrupt(self, *a, **k):
        pass

    def run_conversation(self, text, conversation_history=None):
        kw = self.kw
        hist = list(conversation_history or [])
        self.histories.append(hist)
        cwd = kw.get("cwd")
        if text.startswith("EDIT"):
            p = os.path.join(cwd, "app.txt")
            kw["tool_start_callback"]("c1", "patch", {"path": "app.txt", "old_string": "two", "new_string": "TWO"})
            Path(p).write_text(Path(p).read_text().replace("two", "TWO\nextra"))
            kw["tool_complete_callback"]("c1", "patch", {"path": "app.txt"}, json.dumps({"success": True}))
            kw["tool_start_callback"]("c2", "write_file", {"path": "new.txt", "content": "hi\n"})
            Path(cwd, "new.txt").write_text("hi\n")
            kw["tool_complete_callback"]("c2", "write_file", {}, json.dumps({"bytes_written": 3}))
            kw["tool_start_callback"]("c3", "terminal", {"command": "npm test"})
            kw["tool_complete_callback"]("c3", "terminal", {}, json.dumps({"output": "ok", "exit_code": 0}))
            # subagent relay as Hermes' delegate progress callback would send it
            cb = kw["tool_progress_callback"]
            cb("subagent.start", None, "count files", None, subagent_id="sa-0-x", goal="count files", model="m")
            cb("subagent.tool", "terminal", "ls", {"command": "ls"}, subagent_id="sa-0-x")
            cb("subagent.complete", None, "3 files", None, subagent_id="sa-0-x", status="completed",
               summary="There are 3 files", duration_seconds=1.25, input_tokens=10, output_tokens=5)
        reply = "done editing" if text.startswith("EDIT") else f"history has {len(hist)} msgs"
        kw["stream_delta_callback"](reply)
        msgs = hist + [{"role": "user", "content": text}, {"role": "assistant", "content": reply}]
        return {"final_response": reply, "messages": msgs, "input_tokens": 3000, "output_tokens": 20,
                "last_prompt_tokens": 1234}


@pytest.fixture
def edit_run(pico_home, tmp_path):
    def _run(fn):
        from aiohttp.test_utils import TestClient, TestServer
        from pico import config as C
        from pico.agent_bridge import Bridge
        from pico.server import Engine, make_app
        C.ensure_dirs()
        cfg = C.load_config()
        cfg["provider"] = {"kind": "custom", "base_url": "http://fake/v1", "model": "fake-model"}
        C.save_config(cfg)
        proj = tmp_path / "proj"
        proj.mkdir()
        (proj / "app.txt").write_bytes(b"one\ntwo\nthree\n")

        async def main():
            eng = Engine(bridge=Bridge(agent_factory=lambda **kw: EditAgent(**kw)), runtime=None)
            async with TestClient(TestServer(make_app(eng))) as client:
                await fn(client, eng, {"Authorization": f"Bearer {eng.token}"}, proj)
        asyncio.run(main())
    return _run


async def _send(client, h, sid, text):
    r = await client.post(f"/api/sessions/{sid}/messages", json={"text": text}, headers=h)
    assert r.status == 200, await r.text()
    events, ev = [], None
    async for raw in r.content:
        line = raw.decode().rstrip("\n")
        if line.startswith("event: "):
            ev = line[7:]
        elif line.startswith("data: "):
            events.append((ev, json.loads(line[6:])))
    return events


def test_diff_checkpoint_undo(edit_run):
    async def body(client, eng, h, proj):
        sid = (await (await client.post("/api/sessions", json={"cwd": str(proj)}, headers=h)).json())["id"]
        evs = await _send(client, h, sid, "EDIT please")
        starts = [d for e, d in evs if e == "tool_start"]
        assert [s["label"] for s in starts] == ["edit app.txt", "write new.txt", "terminal `npm test`"]
        ends = {d["id"]: d for e, d in evs if e == "tool_end"}
        d1 = ends["c1"]["diff"]
        assert d1["path"] == "app.txt" and d1["added"] == 2 and d1["removed"] == 1 and d1["created"] is False
        assert "-two" in d1["unified"] and "+TWO" in d1["unified"]
        assert ends["c2"]["diff"]["created"] is True and ends["c2"]["diff"]["added"] == 1
        assert "diff" not in ends["c3"] and isinstance(ends["c3"]["seconds"], float)
        # subagents
        kinds = [e for e, _ in evs]
        assert "subagent_start" in kinds and "subagent_progress" in kinds and "subagent_end" in kinds
        se = next(d for e, d in evs if e == "subagent_end")
        assert se == {"id": "sa-0-x", "ok": True, "summary": "There are 3 files", "seconds": 1.2, "tokens": 15,
                      "status": "completed"} or se["seconds"] in (1.2, 1.3)
        done = evs[-1][1]
        assert evs[-1][0] == "done"
        assert {k: v for k, v in done["context"].items() if k != "max_effective"} == \
            {"used": 1234, "max": 65536, "cached": 1000}
        assert done["context"]["max_effective"] == 65536 and "tokens" in done["profile"]
        assert done["usage"] == {"input": 3000, "output": 20, "last_input": 1234}
        s = done["summary"]
        assert s["tools"] == 3 and s["output_tokens"] == 20
        assert sorted((f["path"].split("/")[-1], f["added"], f["removed"]) for f in s["files_changed"]) == \
            [("app.txt", 2, 1), ("new.txt", 1, 0)]
        # session view carries context
        v = await (await client.get(f"/api/sessions/{sid}", headers=h)).json()
        assert v["context"]["used"] == 1234
        cps = await (await client.get(f"/api/sessions/{sid}/checkpoints", headers=h)).json()
        assert len(cps) == 1 and len(cps[0]["files"]) == 2 and cps[0]["side_effects"] is True
        # undo
        r = await (await client.post(f"/api/sessions/{sid}/undo", headers=h)).json()
        assert r["ok"] and r["turn_message_id"] == cps[0]["turn_message_id"]
        assert (proj / "app.txt").read_bytes() == b"one\ntwo\nthree\n"
        assert not (proj / "new.txt").exists()
        assert any(p.endswith("app.txt") for p in r["restored"]) and any(p.endswith("new.txt") for p in r["deleted"])
        assert "side effects" in r["note"]
        v = await (await client.get(f"/api/sessions/{sid}", headers=h)).json()
        assert v["messages"] == []
        # next turn sees no history
        evs = await _send(client, h, sid, "what did you change?")
        assert "history has 0 msgs" in "".join(d["text"] for e, d in evs if e == "delta")
        assert await (await client.get(f"/api/sessions/{sid}/checkpoints", headers=h)).json() == []
    edit_run(body)


def test_slash_undo_repeatable(edit_run):
    async def body(client, eng, h, proj):
        sid = (await (await client.post("/api/sessions", json={"cwd": str(proj)}, headers=h)).json())["id"]
        await _send(client, h, sid, "EDIT one")
        after1 = (proj / "app.txt").read_bytes()
        await _send(client, h, sid, "EDIT two")  # app.txt has no "two" now except "TWO"... still writes new.txt
        evs = await _send(client, h, sid, "/undo")
        assert evs[-1][0] == "done" and evs[-1][1]["undo"]["ok"]
        assert "Undid the last turn" in "".join(d["text"] for e, d in evs if e == "delta")
        assert (proj / "app.txt").read_bytes() == after1
        evs = await _send(client, h, sid, "/undo")
        assert (proj / "app.txt").read_bytes() == b"one\ntwo\nthree\n"
        evs = await _send(client, h, sid, "/undo")
        assert "Nothing to undo" in "".join(d["text"] for e, d in evs if e == "delta")
    edit_run(body)


def test_checkpoint_prune(pico_home):
    from pico import config as C
    from pico.checkpoints import CheckpointStore
    C.ensure_dirs()
    cs = CheckpointStore()
    for i in range(25):
        cs.snapshot("s1", f"t{i:02d}", f"/tmp/x{i}", b"x")
    assert len(list((C.pico_home() / "checkpoints" / "s1").iterdir())) == 20


def test_labels_and_diff_cap():
    from pico.events_extra import diff_stats, tool_label
    assert tool_label("read_file", {"path": "/p/README.md"}, "/p") == "read README.md"
    assert tool_label("search_files", {"pattern": "TODO"}) == 'search "TODO"'
    assert tool_label("patch", {"mode": "patch", "patch": "*** Begin Patch\n*** Update File: src/app.ts\n"}) == "edit src/app.ts"
    big = diff_stats(b"", ("x\n" * 500).encode(), "f")
    assert big["added"] == 500 and big["unified"].count("\n") <= 201


def test_subagent_config(run):
    async def body(client, eng, h):
        c = await (await client.get("/api/config", headers=h)).json()
        assert c["subagents"] == {"enabled": True, "max_parallel": 3, "model": None, "effort": "low", "max_seconds": 600}
        r = await client.patch("/api/config", json={"subagents": {"max_parallel": 9}}, headers=h)
        assert r.status == 400
        r = await client.patch("/api/config", json={"subagents": {"max_parallel": 5, "effort": "off"}}, headers=h)
        assert r.status == 200 and (await r.json())["subagents"]["max_parallel"] == 5
        from pico.agent_bridge import enabled_toolsets, read_hermes_config
        d = read_hermes_config()["delegation"]
        assert d["max_concurrent_children"] == 5 and d["reasoning_effort"] == "low" and d["child_timeout_seconds"] == 600
        assert "delegation" in enabled_toolsets()
        await client.patch("/api/config", json={"subagents": {"enabled": False}}, headers=h)
        assert "delegation" not in enabled_toolsets()
    run(body)


def test_notice_routing(pico_home):
    """In-turn notices go to the turn stream; others to the /api/events hub with session_id."""
    from pico import events_extra as X
    got = []
    X.set_hub(lambda e, d: got.append((e, d)))

    async def main():
        q: asyncio.Queue = asyncio.Queue()
        X.begin_turn("s_n", "t1", None, q)
        X.notice("memory", "Remembered: x")
        await asyncio.sleep(0)
        ev, d = q.get_nowait()
        d.pop("profile", None)  # attached when the engine registered a profile fn (other tests)
        assert (ev, d) == ("notice", {"kind": "memory", "text": "Remembered: x"})
        X.end_turn("s_n")
        X.notice("skill", "Skill created: y")
        await asyncio.sleep(0)
        assert got[-1] == ("notice", {"session_id": "s_n", "kind": "skill", "text": "Skill created: y"})
        with X.quiet_notices():
            X.notice("memory", "nope")
        await asyncio.sleep(0)
        assert len(got) == 1
    asyncio.run(main())
    X._hub_publish = None
