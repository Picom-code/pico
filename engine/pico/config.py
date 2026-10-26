"""Paths, user config (~/.pico/config.json), secrets (~/.pico/secrets.json) and the API token.

Everything is a plain file under PICO_HOME (default ~/.pico) so developers can inspect it.
Secrets never leave this module through the API: `public_config()` strips them.
"""
from __future__ import annotations

import copy
import json
import os
import secrets as _secrets
import threading
from pathlib import Path
from typing import Any

EFFORTS = ("low", "medium", "high", "max")  # user-facing; "max" only where the model supports it
_EFFORT_ALIASES = {"off": "low", "none": "low", "minimal": "low", "xhigh": "max"}


def normalize_effort(e) -> "str | None":
    """User/stored effort -> one of EFFORTS. Legacy "off" maps to "low" (back-compat); unknown -> None."""
    if not isinstance(e, str):
        return None
    e = e.strip().lower()
    e = _EFFORT_ALIASES.get(e, e)
    return e if e in EFFORTS else None


def supported_efforts(cfg: "dict | None" = None) -> list:
    """Efforts to advertise for the active model: low|medium|high, plus max when the model takes it."""
    cfg = cfg or load_config()
    prov = cfg.get("provider") or {}
    out = ["low", "medium", "high"]
    if prov.get("kind") == "openai_login":
        try:
            from agent.reasoning_effort import codex_supported_efforts  # Hermes (on sys.path once ensured)
            if "max" in codex_supported_efforts(prov.get("model") or cfg.get("model")):
                out.append("max")
        except Exception:  # noqa: BLE001
            pass
    return out
PERSONAS = ("engineer", "business", "creative", "marketing", "student", "general")

DEFAULT_CONFIG: dict[str, Any] = {
    "persona": "general",
    "provider": {"kind": None},  # local {recipe_id} | custom {base_url, model} | openai_login {model}
    "model": None,
    "effort_default": "medium",
    "accent": "#7CFFB2",
    "features": {"voice": False, "image": False, "video": False},
    "approvals": "ask",  # ask | auto (Hermes smart approval) | yolo (never ask)
    # Hermes delegate_task children (see subagents.py); model None = same as the main model
    "subagents": {"enabled": True, "max_parallel": 3, "model": None, "effort": "low", "max_seconds": 600},
    # agent harness: "lean" (Pico's compact prompt + tools, docs/LEAN.md) | "hermes" (stock Hermes, for A/B)
    "harness": "lean",
    # pre-turn auto-compaction of long chats (see compaction.py; validated there)
    "compaction": {"auto": True, "at_pct": 80, "keep_recent": 6, "mode": "summary", "notify": True,
                   "max_ctx_override": None},
}
HARNESSES = ("lean", "hermes")

_lock = threading.RLock()


def pico_home() -> Path:
    return Path(os.environ.get("PICO_HOME") or Path.home() / ".pico").expanduser()


def hermes_home() -> Path:
    return pico_home() / "hermes"


def hermes_src() -> Path:
    return Path(os.environ.get("PICO_HERMES_PATH") or Path.home() / ".hermes" / "hermes-agent").expanduser()


def db_path() -> Path:
    return pico_home() / "pico.db"


def web_dist() -> Path:
    env = os.environ.get("PICO_WEB_DIST")
    if env:
        return Path(env).expanduser()
    return Path(__file__).resolve().parents[2] / "web" / "dist"


def ensure_dirs() -> None:
    home = pico_home()
    home.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(home, 0o700)
    except OSError:
        pass
    hermes_home().mkdir(parents=True, exist_ok=True)


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return copy.deepcopy(default)


# ── token ────────────────────────────────────────────────────────────────────

def load_or_create_token() -> str:
    path = pico_home() / "token"
    with _lock:
        if path.exists():
            tok = path.read_text().strip()
            if tok:
                os.chmod(path, 0o600)
                return tok
        tok = "pico_" + _secrets.token_urlsafe(32)
        _write_private(path, tok + "\n")
        return tok


# ── config ───────────────────────────────────────────────────────────────────

def _merge(base: dict, extra: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (extra or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict) and k != "provider":
            out[k] = _merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def load_config() -> dict:
    with _lock:
        cfg = _merge(DEFAULT_CONFIG, _read_json(pico_home() / "config.json", {}))
    cfg["effort_default"] = normalize_effort(cfg.get("effort_default")) or "medium"
    sub = cfg.get("subagents")
    if isinstance(sub, dict) and sub.get("effort") is not None:
        sub["effort"] = normalize_effort(sub.get("effort")) or "low"
    return cfg


def save_config(cfg: dict) -> None:
    with _lock:
        clean = copy.deepcopy(cfg)
        prov = clean.get("provider") or {}
        prov.pop("api_key", None)  # never on disk outside secrets.json
        _write_private(pico_home() / "config.json", json.dumps(clean, indent=2) + "\n")


def load_secrets() -> dict:
    with _lock:
        return _read_json(pico_home() / "secrets.json", {})


def save_secrets(data: dict) -> None:
    with _lock:
        _write_private(pico_home() / "secrets.json", json.dumps(data, indent=2) + "\n")


def set_secret(key: str, value: str | None) -> None:
    with _lock:
        data = load_secrets()
        if value:
            data[key] = value
        else:
            data.pop(key, None)
        save_secrets(data)


def get_secret(key: str) -> str | None:
    return load_secrets().get(key) or None


def public_config(cfg: dict | None = None) -> dict:
    cfg = copy.deepcopy(cfg or load_config())
    prov = cfg.get("provider") or {}
    prov.pop("api_key", None)
    if prov.get("kind") == "custom":
        prov["has_key"] = bool(get_secret("custom_api_key"))
    cfg["provider"] = prov
    cfg["efforts"] = supported_efforts(cfg)
    return cfg


def apply_patch(patch: dict) -> dict:
    """PATCH /api/config. Validates the user-editable fields; returns the new public config."""
    cfg = load_config()
    for key in ("persona", "model", "effort_default", "accent", "approvals"):
        if key in patch:
            cfg[key] = patch[key]
    if cfg.get("approvals", "ask") not in ("ask", "auto", "yolo"):
        raise ValueError("approvals must be ask, auto or yolo")
    if "effort_default" in patch:
        eff = normalize_effort(patch["effort_default"])
        if not eff:
            raise ValueError(f"effort_default must be one of {EFFORTS}")
        cfg["effort_default"] = eff
    if "harness" in patch:
        if patch["harness"] not in HARNESSES:
            raise ValueError(f"harness must be one of {HARNESSES}")
        cfg["harness"] = patch["harness"]
    if "features" in patch and isinstance(patch["features"], dict):
        cfg["features"] = {**cfg.get("features", {}), **{k: bool(v) for k, v in patch["features"].items()}}
    if "subagents" in patch:
        from .subagents import normalize
        cfg["subagents"] = normalize(patch["subagents"], cfg.get("subagents"))
    if "compaction" in patch:
        from .compaction import normalize as _cnorm
        cfg["compaction"] = _cnorm(patch["compaction"], cfg.get("compaction"))
    if "provider" in patch and isinstance(patch["provider"], dict):
        prov = dict(patch["provider"])
        key = prov.pop("api_key", None)
        if key is not None:
            set_secret("custom_api_key", key)
        merged = {**(cfg.get("provider") or {}), **prov}
        cfg["provider"] = merged
    save_config(cfg)
    return public_config(cfg)
