"""Tiny stdlib client + process manager for a Pico engine used by the eval runner.

Never prints or logs the provider API key. Only kills processes it started itself.
"""
from __future__ import annotations

import json
import os
import socket
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ENGINE_DIR = REPO / "engine"
PICO_PY = Path(os.environ.get("PICO_EVAL_PYTHON") or Path.home() / ".hermes/cache/scratch/pico-venv/bin/python")
SPARK_URL = os.environ.get("PICO_EVAL_BASE_URL", "https://gpu.example.ts.net/v1")
MODEL = os.environ.get("PICO_EVAL_MODEL", "deepseek-v4.1-flash")
FORBIDDEN_PORTS = {7878}


def spark_key() -> str:
    """custom_providers[name=spark].api_key from ~/.hermes/config.yaml (read-only, never printed)."""
    env = os.environ.get("PICO_EVAL_API_KEY")
    if env:
        return env
    import yaml  # available in the pico venv
    cfg = yaml.safe_load((Path.home() / ".hermes/config.yaml").read_text()) or {}
    for p in cfg.get("custom_providers") or []:
        if isinstance(p, dict) and p.get("name") == "spark":
            return p.get("api_key") or ""
    raise RuntimeError("no custom_providers entry named 'spark' in ~/.hermes/config.yaml")


def free_port(start: int = 7950) -> int:
    p = start
    while True:
        if p not in FORBIDDEN_PORTS:
            with socket.socket() as s:
                try:
                    s.bind(("127.0.0.1", p))
                    return p
                except OSError:
                    pass
        p += 1


class Engine:
    def __init__(self, home: Path, port: int | None = None, external: bool = False):
        self.home = Path(home)
        self.port = port
        self.proc: subprocess.Popen | None = None
        self.external = external
        self.token = ""
        self.harness_supported: bool | None = None

    # process ---------------------------------------------------------------
    def start(self, timeout: float = 120) -> "Engine":
        if self.port in FORBIDDEN_PORTS:
            raise RuntimeError("refusing to use the user's live engine port")
        if not self.external:
            self.home.mkdir(parents=True, exist_ok=True)
            self.port = self.port or free_port()
            env = {**os.environ, "PICO_HOME": str(self.home), "PICO_PORT": str(self.port), "PICO_SKIP_MCP": "1"}
            env.pop("PICO_EVAL_API_KEY", None)
            log = open(self.home / "engine.log", "ab")
            # engine_main.py = unmodified pico.server.main with thread names in the log format
            self.proc = subprocess.Popen([str(PICO_PY), str(Path(__file__).with_name("engine_main.py"))],
                                         cwd=str(ENGINE_DIR), env=env,
                                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc and self.proc.poll() is not None:
                raise RuntimeError(f"engine exited early (see {self.home}/engine.log)")
            try:
                self.get("/api/health", auth=False)
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.5)
        else:
            raise RuntimeError("engine did not become healthy")
        self.token = (self.home / "token").read_text().strip()
        return self

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    # http ------------------------------------------------------------------
    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _req(self, method: str, path: str, body=None, auth=True, timeout=60):
        data = json.dumps(body).encode() if body is not None else None
        h = {"Content-Type": "application/json"}
        if auth:
            h["Authorization"] = f"Bearer {self.token}"
        return urllib.request.Request(self.base + path, data=data, headers=h, method=method), timeout

    def call(self, method: str, path: str, body=None, auth=True, timeout=60):
        req, t = self._req(method, path, body, auth, timeout)
        with urllib.request.urlopen(req, timeout=t) as r:
            raw = r.read()
        return json.loads(raw) if raw else None

    def get(self, path, auth=True):
        return self.call("GET", path, auth=auth)

    def sse(self, path: str, body=None, method="POST", read_timeout=60):
        """Yield (event, data) from an SSE endpoint."""
        req, _ = self._req(method, path, body)
        resp = urllib.request.urlopen(req, timeout=read_timeout)
        ev, buf = None, []
        try:
            for raw in resp:
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if line.startswith(":"):
                    yield ("_ping", {})
                    continue
                if line.startswith("event:"):
                    ev = line[6:].strip()
                elif line.startswith("data:"):
                    buf.append(line[5:].lstrip())
                elif line == "" and ev:
                    try:
                        data = json.loads("\n".join(buf)) if buf else {}
                    except ValueError:
                        data = {"raw": "\n".join(buf)}
                    yield (ev, data)
                    ev, buf = None, []
        finally:
            resp.close()

    # setup -----------------------------------------------------------------
    def configure(self, harness: str = "hermes") -> None:
        h = self.get("/api/health", auth=False)
        if h.get("state") != "ready" or h.get("model") != MODEL:
            job = self.call("POST", "/api/setup", {"persona": "engineer", "provider": {
                "kind": "custom", "base_url": SPARK_URL, "api_key": spark_key(), "model": MODEL}})
            for ev, data in self.sse(f"/api/jobs/{job['job_id']}/events", method="GET", read_timeout=180):
                if ev == "error":
                    raise RuntimeError(f"setup failed: {data.get('message')}")
                if ev == "done":
                    break
        # approvals stay "ask": the runner answers every approval itself (deterministic, no LLM judge)
        self.call("PATCH", "/api/config", {"approvals": "ask"})
        self.harness_supported = self.set_harness(harness)

    def set_harness(self, harness: str) -> bool:
        try:
            cfg = self.call("PATCH", "/api/config", {"harness": harness})
        except urllib.error.HTTPError:
            return False
        return (cfg or {}).get("harness") == harness

    def add_memory(self, text: str, target: str = "memory"):
        return self.call("POST", "/api/memory", {"text": text, "target": target})

    def call_usage(self) -> dict:
        """Per-session list of model API calls parsed from the engine log:
        {session_id: [{"prompt": int, "out": int, "cached": int, "latency": float}]}.
        Hermes logs one "API call #N: ... in=P out=O ... cache=C/P" line per call on the turn's worker
        thread and closes the turn with "Turn ended: ... session=<sid>" on the same thread."""
        import re
        pend: dict[str, list] = {}
        out: dict[str, list] = {}
        rx_call = re.compile(r"\[([^\]]+)\] agent\.conversation_loop INFO API call #\d+: .*? in=(\d+) out=(\d+) .*?latency=([\d.]+)s(?: cache=(\d+)/)?")
        rx_end = re.compile(r"\[([^\]]+)\] .*Turn ended: .*session=(\S+)")
        try:
            text = (self.home / "engine.log").read_text(errors="replace")
        except OSError:
            return {}
        for line in text.splitlines():
            m = rx_call.search(line)
            if m:
                pend.setdefault(m.group(1), []).append({"prompt": int(m.group(2)), "out": int(m.group(3)),
                                                        "latency": float(m.group(4)), "cached": int(m.group(5) or 0)})
                continue
            m = rx_end.search(line)
            if m:
                out.setdefault(m.group(2), []).extend(pend.pop(m.group(1), []))
        return out

    def api_turns(self, sid: str) -> int | None:
        """Model API calls in a session = assistant entries in the stored Hermes transcripts."""
        try:
            con = sqlite3.connect(f"file:{self.home / 'pico.db'}?mode=ro", uri=True, timeout=5)
            n = 0
            for (meta,) in con.execute("SELECT meta FROM messages WHERE session_id=? AND role='assistant'", (sid,)):
                for m in (json.loads(meta or "{}").get("hermes") or []):
                    if m.get("role") == "assistant":
                        n += 1
            con.close()
            return n
        except Exception:  # noqa: BLE001
            return None
