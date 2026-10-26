"""SQLite store (~/.pico/pico.db): sessions, messages (+FTS5), checkins, inbox, devices, pair codes.

All access goes through one Store object holding a single connection guarded by a lock; the
engine's write rate is tiny (one chat), so this is simpler than a pool and safe across threads.
Message `meta` is a JSON column carrying: reasoning, tool {name,args,result,ok}, usage, and the raw
Hermes message dicts (`hermes`) so history can be replayed to AIAgent exactly.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, title TEXT, cwd TEXT, goal TEXT, pinned INTEGER DEFAULT 0,
  todos TEXT DEFAULT '[]', hermes_session_id TEXT, created REAL, updated REAL, source TEXT DEFAULT 'chat'
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
  content TEXT, meta TEXT DEFAULT '{}', created REAL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, session_id UNINDEXED, message_id UNINDEXED);
CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY, title TEXT, prompt TEXT, schedule TEXT, enabled INTEGER DEFAULT 1,
  last_run REAL, next_run REAL, created REAL
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY, title TEXT, body TEXT, session_id TEXT, created REAL, read INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT, token_hash TEXT UNIQUE, created REAL, last_seen REAL
);
CREATE TABLE IF NOT EXISTS pair_codes (
  code TEXT PRIMARY KEY, expires REAL, used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, model TEXT, harness TEXT, input INTEGER DEFAULT 0,
  output INTEGER DEFAULT 0, cached INTEGER DEFAULT 0, seconds REAL DEFAULT 0, tools INTEGER DEFAULT 0,
  tps REAL, created REAL, message_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS usage_created ON usage(created);
CREATE INDEX IF NOT EXISTS usage_model ON usage(model, created);
"""

# additive column migrations: (table, column, decl)
MIGRATIONS = [
    ("checkins", "last_status", "TEXT"),
    ("checkins", "session_id", "TEXT"),
    ("checkins", "yolo", "INTEGER DEFAULT 0"),
    ("sessions", "goal_status", "TEXT"),
]


def _median(xs: list) -> Optional[float]:
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    return round(xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2, 1)


def new_id(prefix: str = "") -> str:
    return prefix + uuid.uuid4().hex[:16]


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        for table, col, decl in MIGRATIONS:
            have = {row[1] for row in self.conn.execute(f"PRAGMA table_info({table})")}
            if col not in have:
                self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    def _q(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return list(self.conn.execute(sql, args))

    def _x(self, sql: str, args: tuple = ()) -> None:
        with self._lock:
            self.conn.execute(sql, args)

    # ── sessions ─────────────────────────────────────────────────────────────
    def session_exists(self, sid: str) -> bool:
        return bool(self._q("SELECT 1 FROM sessions WHERE id=?", (sid,)))

    def create_session(self, sess: dict) -> None:
        now = time.time()
        self._x(
            "INSERT OR IGNORE INTO sessions(id,title,cwd,goal,pinned,todos,created,updated,source) VALUES(?,?,?,?,?,?,?,?,?)",
            (sess["id"], sess.get("title") or "New chat", sess.get("cwd"), sess.get("goal"),
             int(bool(sess.get("pinned"))), json.dumps(sess.get("todos") or []), sess.get("created") or now, now,
             sess.get("source") or "chat"),
        )

    def get_session_row(self, sid: str) -> Optional[dict]:
        rows = self._q("SELECT * FROM sessions WHERE id=?", (sid,))
        if not rows:
            return None
        d = dict(rows[0])
        d["todos"] = json.loads(d.get("todos") or "[]")
        d["pinned"] = bool(d["pinned"])
        return d

    def update_session(self, sid: str, **fields: Any) -> None:
        if not fields:
            return
        cols, vals = [], []
        for k, v in fields.items():
            if k not in ("title", "cwd", "goal", "pinned", "todos", "hermes_session_id", "goal_status"):
                continue
            if k == "todos":
                v = json.dumps(v or [])
            if k == "pinned":
                v = int(bool(v))
            cols.append(f"{k}=?")
            vals.append(v)
        cols.append("updated=?")
        vals.append(time.time())
        self._x(f"UPDATE sessions SET {','.join(cols)} WHERE id=?", (*vals, sid))

    def touch(self, sid: str) -> None:
        self._x("UPDATE sessions SET updated=? WHERE id=?", (time.time(), sid))

    def delete_session(self, sid: str) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM messages_fts WHERE session_id=?", (sid,))
            self.conn.execute("DELETE FROM messages WHERE session_id=?", (sid,))
            self.conn.execute("DELETE FROM sessions WHERE id=?", (sid,))

    def list_sessions(self) -> list[dict]:
        rows = self._q(
            """SELECT s.*, (SELECT content FROM messages m WHERE m.session_id=s.id AND m.role IN ('user','assistant')
                 ORDER BY seq DESC LIMIT 1) AS preview
               FROM sessions s ORDER BY s.pinned DESC, s.updated DESC"""
        )
        out = []
        for r in rows:
            prev = (r["preview"] or "").strip().replace("\n", " ")
            out.append({"id": r["id"], "title": r["title"], "updated": r["updated"], "pinned": bool(r["pinned"]),
                        "goal": r["goal"], "preview": prev[:140], "source": r["source"]})
        return out

    # ── messages ─────────────────────────────────────────────────────────────
    def add_message(self, sid: str, role: str, content: str, meta: Optional[dict] = None,
                    mid: Optional[str] = None) -> str:
        mid = mid or new_id("m_")
        with self._lock:
            seq = self.conn.execute("SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE session_id=?", (sid,)).fetchone()[0]
            self.conn.execute(
                "INSERT INTO messages(id,session_id,seq,role,content,meta,created) VALUES(?,?,?,?,?,?,?)",
                (mid, sid, seq, role, content or "", json.dumps(meta or {}, default=str), time.time()),
            )
            if role in ("user", "assistant") and content:
                self.conn.execute("INSERT INTO messages_fts(content,session_id,message_id) VALUES(?,?,?)",
                                  (content, sid, mid))
            self.conn.execute("UPDATE sessions SET updated=? WHERE id=?", (time.time(), sid))
        return mid

    def messages(self, sid: str) -> list[dict]:
        out = []
        for r in self._q("SELECT * FROM messages WHERE session_id=? ORDER BY seq", (sid,)):
            meta = json.loads(r["meta"] or "{}")
            out.append({"id": r["id"], "role": r["role"], "content": r["content"], "created": r["created"],
                        "meta": meta})
        return out

    def replace_messages(self, sid: str, msgs: list[dict]) -> None:
        """Used by /compact: wipe and re-insert (role, content, meta) rows."""
        with self._lock:
            self.conn.execute("DELETE FROM messages_fts WHERE session_id=?", (sid,))
            self.conn.execute("DELETE FROM messages WHERE session_id=?", (sid,))
        for m in msgs:
            self.add_message(sid, m["role"], m.get("content") or "", m.get("meta") or {})

    def search(self, q: str, limit: int = 30) -> list[dict]:
        q = (q or "").strip()
        if not q:
            return []
        # Quote each token so user input can't inject FTS syntax; prefix-match the last one.
        toks = [t.replace('"', '') for t in q.split() if t.replace('"', '')]
        if not toks:
            return []
        match = " ".join(f'"{t}"' for t in toks[:-1]) + (" " if len(toks) > 1 else "") + f'"{toks[-1]}"*'
        try:
            rows = self._q(
                """SELECT f.session_id, f.message_id, snippet(messages_fts, 0, '[', ']', '…', 12) AS snip, s.title
                   FROM messages_fts f JOIN sessions s ON s.id=f.session_id
                   WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?""", (match, limit))
        except sqlite3.OperationalError:
            return []
        return [{"session_id": r["session_id"], "message_id": r["message_id"], "title": r["title"],
                 "snippet": r["snip"]} for r in rows]

    # ── checkins ─────────────────────────────────────────────────────────────
    def add_checkin(self, c: dict) -> dict:
        c = {**c, "id": c.get("id") or new_id("c_"), "created": time.time()}
        self._x("INSERT INTO checkins(id,title,prompt,schedule,enabled,last_run,next_run,created,yolo) VALUES(?,?,?,?,?,?,?,?,?)",
                (c["id"], c["title"], c["prompt"], json.dumps(c["schedule"]), int(c.get("enabled", True)),
                 c.get("last_run"), c.get("next_run"), c["created"], int(bool(c.get("yolo")))))
        return self.get_checkin(c["id"])

    def _checkin(self, r: sqlite3.Row) -> dict:
        return {"id": r["id"], "title": r["title"], "prompt": r["prompt"], "schedule": json.loads(r["schedule"]),
                "enabled": bool(r["enabled"]), "last_run": r["last_run"], "next_run": r["next_run"],
                "created": r["created"], "last_status": r["last_status"], "session_id": r["session_id"],
                "yolo": bool(r["yolo"])}

    def get_checkin(self, cid: str) -> Optional[dict]:
        rows = self._q("SELECT * FROM checkins WHERE id=?", (cid,))
        return self._checkin(rows[0]) if rows else None

    def list_checkins(self) -> list[dict]:
        return [self._checkin(r) for r in self._q("SELECT * FROM checkins ORDER BY created")]

    def update_checkin(self, cid: str, **f: Any) -> None:
        for k, v in f.items():
            if k == "schedule":
                v = json.dumps(v)
            elif k in ("enabled", "yolo"):
                v = int(bool(v))
            if k in ("last_run", "next_run", "enabled", "title", "prompt", "schedule", "last_status", "session_id", "yolo"):
                self._x(f"UPDATE checkins SET {k}=? WHERE id=?", (v, cid))

    def delete_checkin(self, cid: str) -> bool:
        with self._lock:
            return self.conn.execute("DELETE FROM checkins WHERE id=?", (cid,)).rowcount > 0

    # ── inbox ────────────────────────────────────────────────────────────────
    def add_inbox(self, title: str, body: str, session_id: Optional[str]) -> dict:
        item = {"id": new_id("i_"), "title": title, "body": body, "session_id": session_id,
                "created": time.time(), "read": False}
        self._x("INSERT INTO inbox(id,title,body,session_id,created,read) VALUES(?,?,?,?,?,0)",
                (item["id"], title, body, session_id, item["created"]))
        return item

    def list_inbox(self) -> list[dict]:
        return [{**dict(r), "read": bool(r["read"])} for r in self._q("SELECT * FROM inbox ORDER BY created DESC")]

    def mark_inbox_read(self, iid: str) -> None:
        self._x("UPDATE inbox SET read=1 WHERE id=?", (iid,))

    # ── devices / pairing ────────────────────────────────────────────────────
    def add_pair_code(self, code: str, expires: float) -> None:
        self._x("INSERT OR REPLACE INTO pair_codes(code,expires,used) VALUES(?,?,0)", (code, expires))

    def consume_pair_code(self, code: str) -> bool:
        with self._lock:
            row = self.conn.execute("SELECT expires,used FROM pair_codes WHERE code=?", (code,)).fetchone()
            if not row or row["used"] or row["expires"] < time.time():
                return False
            self.conn.execute("UPDATE pair_codes SET used=1 WHERE code=?", (code,))
            return True

    def add_device(self, name: str, token_hash: str) -> dict:
        d = {"id": new_id("d_"), "name": name, "created": time.time()}
        self._x("INSERT INTO devices(id,name,token_hash,created,last_seen) VALUES(?,?,?,?,?)",
                (d["id"], name, token_hash, d["created"], d["created"]))
        return d

    def device_by_hash(self, token_hash: str) -> Optional[dict]:
        rows = self._q("SELECT id,name,created,last_seen FROM devices WHERE token_hash=?", (token_hash,))
        return dict(rows[0]) if rows else None

    def list_devices(self) -> list[dict]:
        return [dict(r) for r in self._q("SELECT id,name,created,last_seen FROM devices ORDER BY created")]

    def delete_device(self, did: str) -> bool:
        with self._lock:
            return self.conn.execute("DELETE FROM devices WHERE id=?", (did,)).rowcount > 0

    def seen_device(self, did: str) -> None:
        self._x("UPDATE devices SET last_seen=? WHERE id=?", (time.time(), did))

    # ── usage ────────────────────────────────────────────────────────────────
    def add_usage(self, u: dict) -> None:
        self._x("INSERT OR IGNORE INTO usage(session_id,model,harness,input,output,cached,seconds,tools,tps,created,message_id) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (u.get("session_id"), u.get("model") or "unknown", u.get("harness") or "hermes", int(u.get("input") or 0),
                 int(u.get("output") or 0), int(u.get("cached") or 0), float(u.get("seconds") or 0),
                 int(u.get("tools") or 0), u.get("tps"), u.get("created") or time.time(), u.get("message_id")))

    def usage_rows(self, since: float = 0.0) -> list[dict]:
        return [dict(r) for r in self._q("SELECT * FROM usage WHERE created>=? ORDER BY created", (since,))]

    def model_stats(self) -> dict:
        """model -> {tps_measured (median of last 20 turns with tps), last_used}."""
        out: dict[str, dict] = {}
        for r in self._q("SELECT model, MAX(created) AS last FROM usage GROUP BY model"):
            tps = [x[0] for x in self._q("SELECT tps FROM usage WHERE model=? AND tps IS NOT NULL AND tps>0 "
                                         "ORDER BY created DESC LIMIT 20", (r["model"],))]
            out[r["model"]] = {"tps_measured": _median(tps), "last_used": r["last"]}
        return out

    # ── kv ───────────────────────────────────────────────────────────────────
    def kv_get(self, k: str, default: Any = None) -> Any:
        rows = self._q("SELECT v FROM kv WHERE k=?", (k,))
        return json.loads(rows[0]["v"]) if rows else default

    def kv_set(self, k: str, v: Any) -> None:
        self._x("INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)", (k, json.dumps(v)))
