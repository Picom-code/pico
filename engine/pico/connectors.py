"""Connectors catalog → Hermes `mcp_servers` (+ toolset env keys) under HERMES_HOME.

Each entry says in one plain sentence what it does. `connect()` writes Hermes config; Hermes itself
spawns/talks to the MCP servers. Honesty rules:
  * `requires` lists what must exist on this machine (e.g. `npx`); we report `available: false`
    when it is missing rather than pretending.
  * OAuth-style servers (Notion/Linear hosted MCP) use Hermes' MCP OAuth (`auth: oauth`), which
    completes in a browser the first time Hermes connects — marked `kind: "oauth"`.
Secrets typed by the user go into HERMES_HOME/.env (chmod 600) and are referenced as ${VAR} so they
never appear in config.yaml or API responses.
"""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import Any

from . import config as C
from .agent_bridge import read_hermes_config, write_hermes_config

CATALOG: list[dict[str, Any]] = [
    {
        "id": "web_search", "name": "Web search",
        "what": "Lets Pico search the web and read pages when your question needs fresh information.",
        "kind": "key", "requires": [],
        "setup": {"fields": [{"name": "TAVILY_API_KEY", "label": "Tavily API key (free tier at tavily.com)", "secret": True}]},
        "env_only": True,
    },
    {
        "id": "filesystem", "name": "Files on this computer",
        "what": "Lets Pico read and organize files inside one folder you choose (and nowhere else).",
        "kind": "mcp", "requires": ["npx"],
        "setup": {"fields": [{"name": "path", "label": "Folder Pico may use", "secret": False, "default": str(Path.home() / "Documents")}]},
        "mcp": lambda f: {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", os.path.expanduser(f["path"])]},
    },
    {
        "id": "github", "name": "GitHub",
        "what": "Lets Pico read your repositories, issues and pull requests, and open new ones when you ask.",
        "kind": "key", "requires": [],
        "setup": {"fields": [{"name": "GITHUB_PERSONAL_ACCESS_TOKEN", "label": "GitHub personal access token", "secret": True}]},
        "mcp": lambda f: {"url": "https://api.githubcopilot.com/mcp/",
                          "headers": {"Authorization": "Bearer ${PICO_GITHUB_TOKEN}"}},
        "env_map": {"GITHUB_PERSONAL_ACCESS_TOKEN": "PICO_GITHUB_TOKEN"},
    },
    {
        "id": "notion", "name": "Notion",
        "what": "Lets Pico find, read and update pages in your Notion workspace.",
        "kind": "oauth", "requires": [],
        "setup": {"oauth_url": "https://mcp.notion.com/mcp", "fields": [],
                  "note": "Your browser opens to approve access the first time Pico uses Notion."},
        "mcp": lambda f: {"url": "https://mcp.notion.com/mcp", "auth": "oauth"},
    },
    {
        "id": "linear", "name": "Linear",
        "what": "Lets Pico look up and create Linear issues for you.",
        "kind": "oauth", "requires": [],
        "setup": {"oauth_url": "https://mcp.linear.app/mcp", "fields": [],
                  "note": "Your browser opens to approve access the first time Pico uses Linear."},
        "mcp": lambda f: {"url": "https://mcp.linear.app/mcp", "auth": "oauth"},
    },
    {
        "id": "slack", "name": "Slack",
        "what": "Lets Pico read channels and post messages in your Slack workspace.",
        "kind": "key", "requires": ["npx"],
        "setup": {"fields": [{"name": "SLACK_BOT_TOKEN", "label": "Slack bot token (xoxb-…)", "secret": True},
                             {"name": "SLACK_TEAM_ID", "label": "Slack team ID (T…)", "secret": False}]},
        "mcp": lambda f: {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-slack"],
                          "env": {"SLACK_BOT_TOKEN": "${PICO_SLACK_BOT_TOKEN}", "SLACK_TEAM_ID": f.get("SLACK_TEAM_ID", "")}},
        "env_map": {"SLACK_BOT_TOKEN": "PICO_SLACK_BOT_TOKEN"},
    },
    {
        "id": "google", "name": "Google (Gmail, Calendar, Drive)",
        "what": "Lets Pico read your email, calendar and documents. Needs a Google Cloud OAuth client today.",
        "kind": "oauth", "requires": ["uvx"],
        "setup": {"fields": [{"name": "GOOGLE_OAUTH_CLIENT_ID", "label": "Google OAuth client ID", "secret": False},
                             {"name": "GOOGLE_OAUTH_CLIENT_SECRET", "label": "Google OAuth client secret", "secret": True}],
                  "note": "Experimental: uses the community workspace-mcp server; a browser sign-in follows."},
        "mcp": lambda f: {"command": "uvx", "args": ["workspace-mcp", "--tool-tier", "core"],
                          "env": {"GOOGLE_OAUTH_CLIENT_ID": f.get("GOOGLE_OAUTH_CLIENT_ID", ""),
                                  "GOOGLE_OAUTH_CLIENT_SECRET": "${PICO_GOOGLE_OAUTH_CLIENT_SECRET}"}},
        "env_map": {"GOOGLE_OAUTH_CLIENT_SECRET": "PICO_GOOGLE_OAUTH_CLIENT_SECRET"},
    },
]

_BY_ID = {c["id"]: c for c in CATALOG}
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")


def _env_path() -> Path:
    return C.hermes_home() / ".env"


def read_env() -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for line in _env_path().read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"')
    except OSError:
        pass
    return out


def write_env(values: dict[str, str | None]) -> None:
    env = read_env()
    for k, v in values.items():
        if not _ENV_NAME.match(k):
            raise ValueError(f"bad env name {k}")
        if v:
            env[k] = v.replace("\n", "")
        else:
            env.pop(k, None)
    p = _env_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("".join(f'{k}="{v}"\n' for k, v in env.items()))
    os.chmod(p, 0o600)
    for k, v in values.items():  # make it visible to Hermes in this process too
        if v:
            os.environ[k] = v
        else:
            os.environ.pop(k, None)


def _missing(c: dict) -> list[str]:
    return [r for r in c.get("requires", []) if not shutil.which(r)]


def _connected(c: dict, servers: dict, env: dict) -> bool:
    if c.get("env_only"):
        return all(env.get(f["name"]) for f in c["setup"]["fields"] if f.get("secret"))
    return f"pico-{c['id']}" in servers


def catalog() -> list[dict]:
    servers = read_hermes_config().get("mcp_servers") or {}
    env = read_env()
    out = []
    for c in CATALOG:
        miss = _missing(c)
        setup = {k: v for k, v in c["setup"].items()}
        out.append({"id": c["id"], "name": c["name"], "what": c["what"], "kind": c["kind"],
                    "connected": _connected(c, servers, env), "available": not miss,
                    "missing": miss, "setup": setup})
    return out


def connect(cid: str, fields: dict[str, str]) -> dict:
    c = _BY_ID.get(cid)
    if not c:
        raise KeyError(cid)
    miss = _missing(c)
    if miss:
        raise ValueError(f"{c['name']} needs {', '.join(miss)} installed on this computer first")
    fields = {k: (v or "").strip() for k, v in (fields or {}).items()}
    for f in c["setup"].get("fields", []):
        if not fields.get(f["name"]):
            if f.get("default"):
                fields[f["name"]] = f["default"]
            else:
                raise ValueError(f"missing field {f['name']}")
    secret_names = {f["name"] for f in c["setup"].get("fields", []) if f.get("secret")}
    env_map = c.get("env_map", {})
    write_env({env_map.get(k, k): v for k, v in fields.items() if k in secret_names})
    if not c.get("env_only"):
        cfg = read_hermes_config()
        servers = cfg.setdefault("mcp_servers", {})
        servers[f"pico-{cid}"] = c["mcp"](fields)
        write_hermes_config(cfg)
    return next(x for x in catalog() if x["id"] == cid)


def disconnect(cid: str) -> bool:
    c = _BY_ID.get(cid)
    if not c:
        raise KeyError(cid)
    cfg = read_hermes_config()
    servers = cfg.get("mcp_servers") or {}
    removed = servers.pop(f"pico-{cid}", None) is not None
    write_hermes_config(cfg)
    names = [f["name"] for f in c["setup"].get("fields", []) if f.get("secret")]
    env_map = c.get("env_map", {})
    write_env({env_map.get(n, n): None for n in names})
    return removed or bool(c.get("env_only"))
