"""Per-turn file checkpoints for /undo.

Layout: $PICO_HOME/checkpoints/<session>/<turn_message_id>/
    manifest.json   {turn_message_id, created, side_effects, files:[{path, existed, blob, added, removed}]}
    <n>.bin         pre-image bytes of each file (first snapshot in the turn wins)

Only pre-images are stored (files the agent mutated in that turn, ≤2 MB each); the newest 20 turns per
session are kept. Turns that ran terminal/code tools are flagged `side_effects` — undo can't reverse
those (installs, deletions done by shell commands, network calls…).
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Optional

from . import config as C
from .events_extra import diff_stats, read_bytes

KEEP_TURNS = 20
_lock = threading.RLock()


def _safe(s: str) -> str:
    return "".join(ch for ch in str(s) if ch.isalnum() or ch in "-_")[:64] or "x"


class CheckpointStore:
    def __init__(self, root: Optional[Path] = None):
        self._root = root

    @property
    def root(self) -> Path:
        return self._root or (C.pico_home() / "checkpoints")

    def turn_dir(self, sid: str, turn: str) -> Path:
        return self.root / _safe(sid) / _safe(turn)

    def _manifest(self, sid: str, turn: str) -> dict:
        try:
            return json.loads((self.turn_dir(sid, turn) / "manifest.json").read_text())
        except (OSError, ValueError):
            return {"turn_message_id": turn, "created": time.time(), "side_effects": False, "files": []}

    def _save(self, sid: str, turn: str, m: dict) -> None:
        d = self.turn_dir(sid, turn)
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "manifest.json.tmp"
        tmp.write_text(json.dumps(m, indent=1))
        os.replace(tmp, d / "manifest.json")

    # recording ------------------------------------------------------------
    def snapshot(self, sid: str, turn: str, path: str, data: Optional[bytes]) -> None:
        """Record the pre-image of `path` (None = did not exist) unless already recorded this turn."""
        with _lock:
            m = self._manifest(sid, turn)
            if any(f["path"] == path for f in m["files"]):
                return
            entry = {"path": path, "existed": data is not None, "blob": None}
            if data is not None:
                d = self.turn_dir(sid, turn)
                d.mkdir(parents=True, exist_ok=True)
                name = f"{len(m['files'])}.bin"
                (d / name).write_bytes(data)
                entry["blob"] = name
            m["files"].append(entry)
            self._save(sid, turn, m)
            self.prune(sid)

    def mark_side_effects(self, sid: str, turn: str) -> None:
        with _lock:
            m = self._manifest(sid, turn)
            if not m.get("side_effects"):
                m["side_effects"] = True
                self._save(sid, turn, m)
                self.prune(sid)

    def _pre(self, sid: str, turn: str, f: dict) -> Optional[bytes]:
        if not f.get("existed"):
            return None
        try:
            return (self.turn_dir(sid, turn) / f["blob"]).read_bytes()
        except OSError:
            return None

    def finalize(self, sid: str, turn: str) -> list[dict]:
        """Compute per-file +/- for the turn (pre-image vs now), store it, return [{path, added, removed}].
        Files the turn touched but left byte-identical are dropped."""
        with _lock:
            d = self.turn_dir(sid, turn)
            if not (d / "manifest.json").exists():
                return []
            m = self._manifest(sid, turn)
            keep, out = [], []
            for f in m["files"]:
                pre = self._pre(sid, turn, f)
                try:
                    now = read_bytes(f["path"])
                except ValueError:
                    now = b"\0"  # too large now; treat as changed
                if now == pre:
                    if f.get("blob"):
                        (d / f["blob"]).unlink(missing_ok=True)
                    continue
                st = diff_stats(pre, now, os.path.basename(f["path"]))
                f["added"], f["removed"] = st["added"], st["removed"]
                f["created"], f["deleted"] = pre is None, now is None
                keep.append(f)
                out.append({"path": f["path"], "added": st["added"], "removed": st["removed"],
                            "created": pre is None})
            m["files"] = keep
            if not keep and not m.get("side_effects"):
                shutil.rmtree(d, ignore_errors=True)
                return []
            self._save(sid, turn, m)
            return out

    # listing / restore ----------------------------------------------------
    def list(self, sid: str) -> list[dict]:
        base = self.root / _safe(sid)
        if not base.is_dir():
            return []
        out = []
        for d in base.iterdir():
            if not (d / "manifest.json").is_file():
                continue
            m = self._manifest(sid, d.name)
            out.append({"turn_message_id": m.get("turn_message_id") or d.name, "created": m.get("created"),
                        "side_effects": bool(m.get("side_effects")),
                        "files": [{"path": f["path"], "added": f.get("added", 0), "removed": f.get("removed", 0),
                                   "created": not f.get("existed")} for f in m["files"]]})
        out.sort(key=lambda x: x["created"] or 0, reverse=True)
        return out

    def get(self, sid: str, turn: str) -> Optional[dict]:
        d = self.turn_dir(sid, turn)
        return self._manifest(sid, turn) if (d / "manifest.json").is_file() else None

    def restore(self, sid: str, turn: str) -> dict:
        """Write pre-images back (delete files that didn't exist). Removes the checkpoint afterwards."""
        with _lock:
            m = self.get(sid, turn)
            if not m:
                return {"restored": [], "deleted": [], "side_effects": False, "found": False}
            restored, deleted, failed = [], [], []
            for f in reversed(m["files"]):
                p = f["path"]
                try:
                    if f.get("existed"):
                        data = self._pre(sid, turn, f)
                        if data is None:
                            failed.append(p)
                            continue
                        Path(p).parent.mkdir(parents=True, exist_ok=True)
                        tmp = p + ".pico-undo.tmp"
                        with open(tmp, "wb") as fh:
                            fh.write(data)
                        try:
                            shutil.copymode(p, tmp)
                        except OSError:
                            pass
                        os.replace(tmp, p)
                        restored.append(p)
                    elif os.path.lexists(p):
                        os.remove(p)
                        deleted.append(p)
                except OSError:
                    failed.append(p)
            shutil.rmtree(self.turn_dir(sid, turn), ignore_errors=True)
            return {"restored": restored, "deleted": deleted, "failed": failed,
                    "side_effects": bool(m.get("side_effects")), "found": True}

    def drop(self, sid: str, turn: str) -> None:
        shutil.rmtree(self.turn_dir(sid, turn), ignore_errors=True)

    def drop_session(self, sid: str) -> None:
        shutil.rmtree(self.root / _safe(sid), ignore_errors=True)

    def prune(self, sid: str, keep: int = KEEP_TURNS) -> None:
        base = self.root / _safe(sid)
        if not base.is_dir():
            return
        dirs = [d for d in base.iterdir() if d.is_dir()]
        if len(dirs) <= keep:
            return

        def created(d: Path) -> float:
            try:
                return float(json.loads((d / "manifest.json").read_text()).get("created") or 0)
            except (OSError, ValueError):
                return d.stat().st_mtime
        for d in sorted(dirs, key=created)[:-keep]:
            shutil.rmtree(d, ignore_errors=True)


# ── undo (history + files) ───────────────────────────────────────────────────

def _is_turn_start(m: dict) -> bool:
    meta = m.get("meta") or {}
    return m["role"] == "user" and meta.get("kind") != "command" and not meta.get("undo")


def undo_last_turn(store, ckpt: "CheckpointStore", sid: str) -> dict:
    """Restore the most recent model turn's files and delete that turn's messages (user msg onward).
    Returns {ok, restored, deleted, turn_message_id, note}."""
    msgs = store.messages(sid)
    idx = next((i for i in range(len(msgs) - 1, -1, -1) if _is_turn_start(msgs[i])), None)
    if idx is None:
        return {"ok": False, "restored": [], "deleted": [], "turn_message_id": None,
                "note": "Nothing to undo."}
    turn_id = msgs[idx]["id"]
    res = ckpt.restore(sid, turn_id)
    doomed = [m["id"] for m in msgs[idx:] if not ((m.get("meta") or {}).get("kind") == "command"
                                                  and (m.get("meta") or {}).get("undo"))]
    with store._lock:
        for mid in doomed:
            store.conn.execute("DELETE FROM messages WHERE id=?", (mid,))
            store.conn.execute("DELETE FROM messages_fts WHERE message_id=?", (mid,))
    parts = []
    n = len(res["restored"]) + len(res["deleted"])
    parts.append(f"Undid the last turn" + (f" and restored {n} file{'s' if n != 1 else ''}." if n else
                                           " (it didn't change any files)."))
    if res.get("failed"):
        parts.append(f"Couldn't restore: {', '.join(res['failed'])}.")
    if res.get("side_effects"):
        parts.append("That turn also ran terminal commands; their side effects (installs, deleted or moved "
                     "files, network calls) are not covered by undo.")
    return {"ok": True, "restored": res["restored"], "deleted": res["deleted"], "turn_message_id": turn_id,
            "side_effects": bool(res.get("side_effects")), "removed_messages": len(doomed),
            "note": " ".join(parts)}
