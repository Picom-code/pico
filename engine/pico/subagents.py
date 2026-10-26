"""Subagent (Hermes delegate_task) settings: Pico config `subagents` ↔ Hermes `delegation.*`.

Pico config:  subagents: {enabled, max_parallel 1-8, model (null = same as main), effort, max_seconds}
Hermes:       $HERMES_HOME/config.yaml  delegation: {max_concurrent_children, model, reasoning_effort,
              child_timeout_seconds, max_spawn_depth: 1, subagent_auto_approve: false}
Children inherit the parent's provider/base_url/key (delegation.base_url stays unset) so a custom
endpoint works without a second credential; `model` only swaps the model name.
"""
from __future__ import annotations

from typing import Any

from . import config as C

DEFAULTS: dict[str, Any] = {"enabled": True, "max_parallel": 3, "model": None, "effort": "low", "max_seconds": 600}


def normalize(patch: Any, base: dict | None = None) -> dict:
    """Merge + validate a `subagents` patch. Raises ValueError with a user-facing message."""
    out = {**DEFAULTS, **(base or {})}
    if not isinstance(patch, dict):
        raise ValueError("subagents must be an object")
    for k, v in patch.items():
        if k not in DEFAULTS:
            raise ValueError(f"unknown subagents field: {k}")
        out[k] = v
    out["enabled"] = bool(out["enabled"])
    try:
        mp = int(out["max_parallel"])
    except (TypeError, ValueError):
        raise ValueError("subagents.max_parallel must be an integer 1-8") from None
    if not 1 <= mp <= 8:
        raise ValueError("subagents.max_parallel must be between 1 and 8")
    out["max_parallel"] = mp
    if out["model"] in ("", None):
        out["model"] = None
    elif not isinstance(out["model"], str):
        raise ValueError("subagents.model must be a string or null")
    out["effort"] = C.normalize_effort(out["effort"]) or out["effort"]
    if out["effort"] not in C.EFFORTS:
        raise ValueError(f"subagents.effort must be one of {C.EFFORTS}")
    try:
        ms = int(out["max_seconds"])
    except (TypeError, ValueError):
        raise ValueError("subagents.max_seconds must be an integer 30-3600") from None
    if not 30 <= ms <= 3600:
        raise ValueError("subagents.max_seconds must be between 30 and 3600")
    out["max_seconds"] = ms
    return out


def settings(cfg: dict | None = None) -> dict:
    cfg = cfg or C.load_config()
    try:
        return normalize({}, cfg.get("subagents") or {})
    except ValueError:
        return dict(DEFAULTS)


def delegation_block(s: dict) -> dict:
    return {
        "max_concurrent_children": s["max_parallel"],
        "model": s["model"] or "",
        "reasoning_effort": s["effort"],
        "child_timeout_seconds": s["max_seconds"],
        "max_spawn_depth": 1,
        "subagent_auto_approve": False,
    }


def sync_hermes(hermes_cfg: dict, pico_cfg: dict) -> dict:
    """Mutate + return a Hermes config dict with the delegation block for `pico_cfg`."""
    s = settings(pico_cfg)
    deleg = dict(hermes_cfg.get("delegation") or {})
    deleg.update(delegation_block(s))
    for k in ("provider", "base_url", "api_key"):  # inherit the parent's endpoint
        deleg.pop(k, None)
    if not s["model"]:
        deleg.pop("model", None)
    hermes_cfg["delegation"] = deleg
    return hermes_cfg


def toolsets(pico_cfg: dict | None = None) -> list[str]:
    return ["delegation"] if settings(pico_cfg)["enabled"] else []
