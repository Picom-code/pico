"""Memory + skills, read/written in Hermes' own on-disk formats under HERMES_HOME so Hermes' memory
tool and skill self-improvement keep working on the same files.

Memory: HERMES_HOME/memories/MEMORY.md (agent notes) and USER.md (user profile), entries separated by
"\\n§\\n". We use Hermes' MemoryStore when importable (file locks + threat scan); ids are stable
hashes of `<target>:<text>` so DELETE works without positional races.
Skills: HERMES_HOME/skills/<category>/<name>/SKILL.md with YAML frontmatter; disabled list in
config.yaml `skills.disabled`. Builtin = seeded from the Hermes checkout (tracked in .pico-seeded).
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any, Optional

import yaml

from . import config as C
from .agent_bridge import ensure_hermes, read_hermes_config, write_hermes_config

DELIM = "\n§\n"
SEED_SKILLS = [
    "creative/humanizer",
    "productivity/weekly-review-planning",
    "productivity/document-to-action-items",
    "productivity/meeting-action-items",
    "research/grounded-citations",
    "productivity/pdf",
    "productivity/docx",
    "productivity/xlsx",
]
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


# ── memory ───────────────────────────────────────────────────────────────────

def _mem_id(target: str, text: str) -> str:
    return hashlib.sha1(f"{target}:{text}".encode()).hexdigest()[:12]


def _store():
    ensure_hermes()
    if C.load_config().get("harness", "lean") == "lean":
        from .lean import memory_store  # same files, lean's roomier limits (only a core subset is injected)
        return memory_store()
    from tools.memory_tool import load_on_disk_store
    return load_on_disk_store()


def memory_list() -> list[dict]:
    s = _store()
    out = []
    for target, entries in (("user", s.user_entries), ("memory", s.memory_entries)):
        for e in entries:
            out.append({"id": _mem_id(target, e), "text": e, "target": target})
    return out


def memory_add(text: str, target: str = "memory") -> dict:
    target = "user" if target == "user" else "memory"
    res = _store().add(target, text)
    if not res.get("success", True) or res.get("error"):
        raise ValueError(res.get("error") or res.get("message") or "memory add failed")
    return {"id": _mem_id(target, text.strip()), "text": text.strip(), "target": target}


def memory_delete(mid: str) -> bool:
    s = _store()
    for target, entries in (("user", s.user_entries), ("memory", s.memory_entries)):
        for e in entries:
            if _mem_id(target, e) == mid:
                res = s.remove(target, e, matched_entry=e)
                return bool(res.get("success", True)) and not res.get("error")
    return False


# ── skills ───────────────────────────────────────────────────────────────────

def skills_dir() -> Path:
    return C.hermes_home() / "skills"


def _seed_marker() -> Path:
    return skills_dir() / ".pico-seeded"


def seeded_names() -> set[str]:
    try:
        return set(json.loads(_seed_marker().read_text()))
    except (OSError, ValueError):
        return set()


def seed_skills() -> list[str]:
    """Copy a small curated set of non-dev Hermes skills on first run (never the user's ~/.hermes/skills)."""
    if _seed_marker().exists():
        return []
    src_root = C.hermes_src() / "skills"
    copied = []
    for rel in SEED_SKILLS:
        src = src_root / rel
        if not (src / "SKILL.md").is_file():
            continue
        dst = skills_dir() / rel
        if not dst.exists():
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        copied.append(rel.split("/")[-1])
    skills_dir().mkdir(parents=True, exist_ok=True)
    _seed_marker().write_text(json.dumps(copied))
    return copied


def _parse(md: str) -> tuple[dict, str]:
    if md.startswith("---"):
        parts = md.split("---", 2)
        if len(parts) == 3:
            try:
                meta = yaml.safe_load(parts[1]) or {}
            except yaml.YAMLError:
                meta = {}
            return (meta if isinstance(meta, dict) else {}), parts[2].lstrip("\n")
    return {}, md


def _all_skill_files() -> list[Path]:
    root = skills_dir()
    if not root.exists():
        return []
    return sorted(p for p in root.rglob("SKILL.md") if ".hub" not in p.parts and ".archive" not in p.parts)


def _disabled() -> set[str]:
    sk = read_hermes_config().get("skills") or {}
    return set(sk.get("disabled") or [])


def _find(name: str) -> Optional[Path]:
    for p in _all_skill_files():
        meta, _ = _parse(p.read_text(errors="replace"))
        if (meta.get("name") or p.parent.name) == name:
            return p
    return None


def _info(p: Path, disabled: set[str], seeded: set[str]) -> dict:
    meta, body = _parse(p.read_text(errors="replace"))
    name = meta.get("name") or p.parent.name
    rel = p.parent.relative_to(skills_dir()).parts
    category = (meta.get("metadata") or {}).get("hermes", {}).get("category") if isinstance(meta.get("metadata"), dict) else None
    category = category or (rel[0] if len(rel) > 1 else "general")
    return {"name": name, "description": str(meta.get("description") or ""), "category": category,
            "enabled": name not in disabled, "builtin": name in seeded, "_body": body, "_meta": meta}


def skills_list() -> list[dict]:
    d, s = _disabled(), seeded_names()
    out = []
    for p in _all_skill_files():
        i = _info(p, d, s)
        out.append({k: v for k, v in i.items() if not k.startswith("_")})
    return out


def skill_get(name: str) -> Optional[dict]:
    p = _find(name)
    if not p:
        return None
    i = _info(p, _disabled(), seeded_names())
    return {**{k: v for k, v in i.items() if not k.startswith("_")}, "body": i["_body"]}


def skill_body_for_prompt(name: str) -> Optional[str]:
    """Body used when the user types /<skill-name>; None if unknown or disabled."""
    p = _find(name)
    if not p or name in _disabled():
        return None
    return _parse(p.read_text(errors="replace"))[1]


def skill_put(name: str, description: str, body: str) -> dict:
    if not _NAME_RE.match(name or ""):
        raise ValueError("skill name must be lowercase letters, digits, - or _")
    p = _find(name)
    if p:
        meta, _ = _parse(p.read_text(errors="replace"))
    else:
        p = skills_dir() / "pico" / name / "SKILL.md"
        p.parent.mkdir(parents=True, exist_ok=True)
        meta = {"name": name, "version": "0.1.0", "author": "Pico user"}
    meta["name"] = name
    meta["description"] = description or meta.get("description") or ""
    p.write_text("---\n" + yaml.safe_dump(meta, sort_keys=False, allow_unicode=True) + "---\n\n" + (body or "").lstrip("\n"))
    _clear_skill_caches()
    return skill_get(name)  # type: ignore[return-value]


def skill_delete(name: str) -> bool:
    p = _find(name)
    if not p:
        return False
    shutil.rmtree(p.parent)
    _clear_skill_caches()
    return True


def skill_toggle(name: str) -> dict:
    if not _find(name):
        raise KeyError(name)
    cfg = read_hermes_config()
    sk = cfg.setdefault("skills", {})
    dis = list(sk.get("disabled") or [])
    if name in dis:
        dis.remove(name)
    else:
        dis.append(name)
    sk["disabled"] = dis
    write_hermes_config(cfg)
    _clear_skill_caches()
    return skill_get(name)  # type: ignore[return-value]


def _clear_skill_caches() -> None:
    try:
        from tools.skills_tool import clear_skills_cache
        clear_skills_cache()
    except Exception:  # noqa: BLE001
        pass


def skill_names() -> set[str]:
    return {s["name"] for s in skills_list()}


def unused(_: Any = None) -> None:  # keep linters calm about Any import on some versions
    return None
