"""Shared fixtures: a scratch PICO_HOME and an engine wired to a fake AIAgent (no network).

No pytest-asyncio/pytest-aiohttp dependency: tests call `run(coro_fn)` which spins an aiohttp
TestClient inside asyncio.run().
"""
from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class FakeAgent:
    """Mimics the AIAgent surface Pico uses: callbacks, run_conversation, interrupt, _todo_store."""

    last = None

    def __init__(self, **kw):
        self.kw = kw
        self.ephemeral_system_prompt = None
        self._interrupted = threading.Event()
        self.prompts: list[str] = []
        self.histories: list[list] = []
        self.system_prompts: list = []

        class _Todo:
            items: list = []

            def read(self):
                return list(self.items)

        self._todo_store = _Todo()

    def interrupt(self, message=None, **kw):
        self._interrupted.set()

    # Hermes' pending-steer surface (interrupt_control): steer() buffers, the loop drains it
    _pending: list

    def steer(self, text, **kw):
        if not (text or "").strip():
            return False
        self.__dict__.setdefault("_pending", []).append(text.strip())
        return True

    def _drain_pending_steer(self):
        p = self.__dict__.get("_pending") or []
        self._pending = []
        return "\n".join(p) or None

    def run_conversation(self, text, conversation_history=None):
        FakeAgent.last = self
        self.prompts.append(text)
        self.histories.append(list(conversation_history or []))
        self.system_prompts.append(self.ephemeral_system_prompt)
        kw = self.kw
        hist = list(conversation_history or [])
        if text.startswith("SLOW"):
            kw["stream_delta_callback"]("thinking...")
            for _ in range(250):
                if self._interrupted.is_set():
                    break
                time.sleep(0.02)
            return {"final_response": "partial", "messages": hist + [{"role": "user", "content": text},
                                                                      {"role": "assistant", "content": "partial"}],
                    "interrupted": self._interrupted.is_set(), "input_tokens": 1, "output_tokens": 1}
        if text.startswith("STEERME"):
            # a "long task": tool calls in a loop; a pending steer is injected after the next tool batch
            from pico.agent_bridge import notify_steer_injected
            seen = None
            for i in range(150):
                if self._interrupted.is_set():
                    break
                kw["tool_start_callback"](f"t{i}", "terminal", {"command": f"echo {i}"})
                time.sleep(0.02)
                kw["tool_complete_callback"](f"t{i}", "terminal", {}, json.dumps({"output": str(i), "exit_code": 0}))
                s = self._drain_pending_steer()
                if s:
                    notify_steer_injected(s)
                    seen = s
                    break
            reply = f"stopped early: {seen}" if seen else "counted to the end"
            kw["stream_delta_callback"](reply)
            return {"final_response": reply, "messages": hist + [{"role": "user", "content": text},
                                                                 {"role": "assistant", "content": reply}],
                    "input_tokens": 10, "output_tokens": 5}
        if text.startswith("Summarize our conversation"):
            return {"final_response": "- user asked about the OS", "messages": hist, "input_tokens": 5, "output_tokens": 5}
        kw["reasoning_callback"]("let me think")
        kw["tool_start_callback"]("call_1", "terminal", {"command": "uname -sm"})
        kw["tool_complete_callback"]("call_1", "terminal", {"command": "uname -sm"},
                                     json.dumps({"output": "Darwin arm64", "exit_code": 0}))
        self._todo_store.items = [{"id": "1", "content": "check os", "status": "completed"}]
        kw["tool_start_callback"]("call_2", "todo_list", {"todos": []})
        kw["tool_complete_callback"]("call_2", "todo_list", {}, json.dumps({"todos": self._todo_store.items}))
        for chunk in ("You are on ", "Darwin arm64", "."):
            kw["stream_delta_callback"](chunk)
        kw["stream_delta_callback"](None)
        reply = "You are on Darwin arm64."
        msgs = hist + [
            {"role": "user", "content": text},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_1", "type": "function",
                                                                 "function": {"name": "terminal", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "call_1", "content": "Darwin arm64"},
            {"role": "assistant", "content": reply},
        ]
        return {"final_response": reply, "messages": msgs, "input_tokens": 100, "output_tokens": 10,
                "completed": True, "failed": False, "interrupted": False}


@pytest.fixture
def pico_home(tmp_path, monkeypatch):
    home = tmp_path / "pico"
    monkeypatch.setenv("PICO_HOME", str(home))
    monkeypatch.setenv("PICO_SKIP_MCP", "1")
    monkeypatch.setenv("PICO_WEB_DIST", str(tmp_path / "nodist"))
    return home


@pytest.fixture
def make_engine(pico_home):
    def _make(configured: bool = True):
        from pico import config as C
        from pico.agent_bridge import Bridge
        from pico.server import Engine
        C.ensure_dirs()
        if configured:
            cfg = C.load_config()
            cfg["provider"] = {"kind": "custom", "base_url": "http://fake/v1", "model": "fake-model"}
            C.save_config(cfg)
        created: list = []

        def factory(**kw):
            a = FakeAgent(**kw)
            created.append(a)
            return a

        eng = Engine(bridge=Bridge(agent_factory=factory), runtime=None)
        eng.created_agents = created  # type: ignore[attr-defined]
        return eng
    return _make


@pytest.fixture
def run(make_engine):
    """run(async_fn, configured=True): async_fn(client, engine, auth_headers)."""
    def _run(fn, configured: bool = True):
        from aiohttp.test_utils import TestClient, TestServer
        from pico.server import make_app
        eng = make_engine(configured)

        async def main():
            client = TestClient(TestServer(make_app(eng)))
            await client.start_server()
            try:
                return await fn(client, eng, {"Authorization": f"Bearer {eng.token}"})
            finally:
                await client.close()
        return asyncio.run(main())
    return _run


def parse_sse(raw: str) -> list[tuple[str, dict]]:
    out = []
    for block in raw.split("\n\n"):
        ev, data = None, None
        for line in block.splitlines():
            if line.startswith("event: "):
                ev = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        if ev:
            out.append((ev, data))
    return out
