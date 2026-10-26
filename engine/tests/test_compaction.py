"""Profile-context size, compaction config validation, pre-turn auto-compaction (summary + trim)."""
from __future__ import annotations

import pytest

from conftest import parse_sse


async def send(client, h, sid, text, **extra):
    r = await client.post(f"/api/sessions/{sid}/messages", json={"text": text, **extra}, headers=h)
    assert r.status == 200, await r.text()
    return parse_sse(await r.text())


def seed(eng, sid, turns: int, tool_chars: int = 0):
    """turns × (user row, assistant row whose hermes has a tool call/result + reply)."""
    eng.ensure_persisted(sid)
    eng.store.add_message(sid, "user", "My cat is named Tofu.", {"hermes": [{"role": "user", "content": "My cat is named Tofu."}]})
    eng.store.add_message(sid, "assistant", "Nice name.", {"hermes": [{"role": "assistant", "content": "Nice name."}]})
    for i in range(turns):
        u = f"question {i} " + "x" * 2000
        eng.store.add_message(sid, "user", u, {"hermes": [{"role": "user", "content": u}]})
        h = [{"role": "assistant", "content": "", "tool_calls": [{"id": f"c{i}", "type": "function",
                                                                    "function": {"name": "terminal", "arguments": "{}"}}]},
             {"role": "tool", "tool_call_id": f"c{i}", "content": "o" * tool_chars or "ok"},
             {"role": "assistant", "content": f"answer {i}"}]
        eng.store.add_message(sid, "assistant", f"answer {i}", {"hermes": h})


def hist_tok(eng, sid):
    from pico import compaction as CP
    return CP.history_tokens(eng.hermes_history(sid))


def set_ctx(eng, sid, used, mx=1_000_000):
    last = eng.store.messages(sid)[-1]
    eng._set_meta_merge(last["id"], {"context": {"used": used, "max": mx}})


def test_compaction_config_validation(run):
    async def t(client, eng, h):
        cfg = await (await client.get("/api/config", headers=h)).json()
        assert cfg["compaction"] == {"auto": True, "at_pct": 80, "keep_recent": 6, "mode": "summary", "notify": True,
                                     "max_ctx_override": None}
        r = await client.patch("/api/config", json={"compaction": {"at_pct": 60, "mode": "trim", "max_ctx_override": 8000}},
                               headers=h)
        assert r.status == 200
        c = (await r.json())["compaction"]
        assert c["at_pct"] == 60 and c["mode"] == "trim" and c["keep_recent"] == 6 and c["max_ctx_override"] == 8000
        for bad in ({"at_pct": 40}, {"at_pct": 96}, {"keep_recent": 1}, {"keep_recent": 21}, {"mode": "nuke"},
                    {"auto": "yes"}, {"at_pct": 70.5}, {"max_ctx_override": 10}, {"bogus": 1}):
            r = await client.patch("/api/config", json={"compaction": bad}, headers=h)
            assert r.status == 400, bad
        assert (await (await client.get("/api/config", headers=h)).json())["compaction"]["at_pct"] == 60
    run(t)


def test_effective_max_caps():
    from pico import compaction as CP
    s = CP.normalize({})
    assert CP.effective_max(1_000_000, s) == 256_000
    assert CP.effective_max(32_000, s) == 32_000
    assert CP.effective_max(1_000_000, CP.normalize({"max_ctx_override": 8000})) == 8000
    assert CP.over_threshold({"used": 6400, "max": 1_000_000}, CP.normalize({"max_ctx_override": 8000}))
    assert not CP.over_threshold({"used": 6300, "max": 1_000_000}, CP.normalize({"max_ctx_override": 8000}))
    assert not CP.over_threshold({"used": 7900, "max": 8000}, CP.normalize({"auto": False}))


def test_profile_context_shape_and_budget(run, pico_home):
    async def t(client, eng, h):
        p = await (await client.get("/api/profile/context", headers=h)).json()
        for k in ("tokens", "budget", "notes", "user_notes", "memory_notes", "skills_index_tokens", "agents_md_tokens",
                  "total_standing_tokens", "estimate"):
            assert k in p, k
        assert p["budget"] == 300 and p["estimate"] is True and p["tokens"] == 0
        await client.post("/api/memory", json={"text": "User is Pat, lives in Austin", "target": "user"}, headers=h)
        await client.post("/api/memory", json={"text": "Prefers metric units"}, headers=h)
        p2 = await (await client.get("/api/profile/context", headers=h)).json()
        assert p2["user_notes"] == 1 and p2["memory_notes"] == 1 and p2["notes"] == 2
        assert 0 < p2["tokens"] <= p2["budget"] + 20
        assert p2["total_standing_tokens"] == p2["tokens"] + p2["skills_index_tokens"] + p2["agents_md_tokens"]
        # lots of notes: the injected core stays within the budget, the rest is recall-only
        for i in range(30):
            await client.post("/api/memory", json={"text": f"Fact number {i}: " + "detail " * 8}, headers=h)
        p3 = await (await client.get("/api/profile/context", headers=h)).json()
        assert p3["tokens"] <= p3["budget"] + 20 and p3["notes_recall_only"] > 0
        ph = await (await client.get("/api/profile/context?harness=hermes", headers=h)).json()
        assert ph["harness"] == "hermes" and ph["budget"] > 0 and ph["tokens"] > p3["tokens"]
        # done carries profile
        sid = (await (await client.post("/api/sessions", json={}, headers=h)).json())["id"]
        ev = await send(client, h, sid, "hello")
        done = ev[-1][1]
        assert done["profile"]["tokens"] == p3["tokens"] and done["profile"]["budget"] == 300
        assert done["context"]["max_effective"] <= 256_000
    run(t)


def test_auto_compaction_summary_keeps_recent_and_goal(run):
    async def t(client, eng, h):
        await client.patch("/api/config", json={"compaction": {"at_pct": 50, "keep_recent": 4, "max_ctx_override": 4000}},
                           headers=h)
        sid = (await (await client.post("/api/sessions", json={}, headers=h)).json())["id"]
        await send(client, h, sid, "/goal write the cat report")
        seed(eng, sid, 4)
        used = hist_tok(eng, sid) + 300  # ~2,000 history + a 300-token prompt: over 50% of 4,000
        set_ctx(eng, sid, used)
        seen = {}

        def fake(history, prompt):
            seen["history"], seen["prompt"] = history, prompt
            return "- the user's cat is named Tofu"
        eng.compact_model = fake
        ev = await send(client, h, sid, "what's my cat called?")
        names = [e for e, _ in ev]
        assert "compacted" in names and names.index("compacted") < names.index("done")
        c = dict(ev)["compacted"]
        assert c["auto"] is True and c["reason"] == "threshold" and c["before"] == used and c["after"] < 2000
        assert c["method"] == "summary"
        assert "write the cat report" in seen["prompt"]  # goal preserved in the summary
        assert any("Tofu" in (m.get("content") or "") for m in seen["history"])
        hist = eng.created_agents[-1].histories[-1]
        assert "Tofu" in hist[0]["content"] and "summary" in hist[0]["content"]
        # newest keep_recent model messages (last user row + its assistant: 1 + 3) are verbatim
        assert [m.get("content") for m in hist[-4:]][0].startswith("question 3")
        assert hist[-1]["content"] == "answer 3"
        assert not any((m.get("content") or "").startswith("question 0") for m in hist)
        # the goal is still on the session and still sent as system context
        assert "write the cat report" in eng.created_agents[-1].system_prompts[-1]
        # display rows stay; notice emitted
        assert any(e == "notice" and d["kind"] == "compact" for e, d in ev)
        full = await (await client.get(f"/api/sessions/{sid}", headers=h)).json()
        assert any("question 0" in m["content"] for m in full["messages"])
        # below the threshold now: the next turn does not compact again
        ev2 = await send(client, h, sid, "thanks")
        assert "compacted" not in [e for e, _ in ev2]
    run(t)


def test_auto_compaction_trim_mode(run):
    async def t(client, eng, h):
        await client.patch("/api/config", json={"compaction": {"at_pct": 50, "keep_recent": 4, "mode": "trim",
                                                               "max_ctx_override": 8000}}, headers=h)
        sid = (await (await client.post("/api/sessions", json={}, headers=h)).json())["id"]
        seed(eng, sid, 3, tool_chars=8000)  # 3 × ~2000-token tool outputs + 3 × 500-token questions
        set_ctx(eng, sid, hist_tok(eng, sid) + 300)
        eng.compact_model = lambda *_: pytest.fail("trim should be enough")
        ev = await send(client, h, sid, "next")
        c = dict(ev)["compacted"]
        assert c["method"] == "trim" and c["after"] < 4000 < c["before"]
        hist = eng.created_agents[-1].histories[-1]
        tools = [m for m in hist if m.get("role") == "tool"]
        from pico.compaction import TRIMMED
        assert tools[0]["content"] == TRIMMED and tools[1]["content"] == TRIMMED
        assert tools[-1]["content"] == "o" * 8000  # inside keep_recent: verbatim
        assert hist[0]["content"] == "My cat is named Tofu."  # nothing summarized
        # still over after trimming -> trim + summary
        sid2 = (await (await client.post("/api/sessions", json={}, headers=h)).json())["id"]
        await client.patch("/api/config", json={"compaction": {"max_ctx_override": 5000}}, headers=h)
        seed(eng, sid2, 3, tool_chars=8000)
        set_ctx(eng, sid2, hist_tok(eng, sid2) + 300)  # trimming 2 outputs (~4k) leaves ~4.3k > 2.5k
        eng.compact_model = lambda hist, prompt: "- cat Tofu"
        ev = await send(client, h, sid2, "next")
        assert dict(ev)["compacted"]["method"] == "trim+summary"
    run(t)


def test_auto_compaction_skips_when_prompt_alone_is_over(run):
    async def t(client, eng, h):
        await client.patch("/api/config", json={"compaction": {"at_pct": 50, "keep_recent": 2, "max_ctx_override": 8000}},
                           headers=h)
        sid = (await (await client.post("/api/sessions", json={}, headers=h)).json())["id"]
        seed(eng, sid, 3)
        set_ctx(eng, sid, hist_tok(eng, sid) + 4500)  # 4,500-token prompt alone: the rest is system prompt + tools
        eng.compact_model = lambda *_: pytest.fail("futile compaction must not run")
        ev = await send(client, h, sid, "next")
        assert "compacted" not in [e for e, _ in ev]
        assert any(e == "notice" and "skipped" in d["text"] for e, d in ev)
    run(t)


def test_manual_compact_focus(run):
    async def t(client, eng, h):
        sid = (await (await client.post("/api/sessions", json={}, headers=h)).json())["id"]
        seed(eng, sid, 2)
        got = {}
        eng.compact_model = lambda hist, prompt: got.setdefault("p", prompt) and "- summary"
        ev = await send(client, h, sid, "/compact the cat names")
        c = dict(ev)["compacted"]
        assert c["auto"] is False and c["reason"] == "manual" and c["focus"] == "the cat names"
        assert "Focus especially on: the cat names" in got["p"]
        assert "max_effective" in ev[-1][1]["context"]
    run(t)
