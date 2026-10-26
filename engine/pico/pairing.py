"""Phone pairing: one-time codes → per-device tokens. QR payload `pico://pair?u=<url>&c=<code>`."""
from __future__ import annotations

import hashlib
import secrets
import socket
import time
from urllib.parse import quote

from . import qr

CODE_TTL = 300  # seconds
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I


def hash_token(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()


def new_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(8))


def lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def advertised_url(host: str, port: int, override: str | None = None) -> str:
    if override:
        return override.rstrip("/")
    if host in ("0.0.0.0", "::", ""):
        host = lan_ip()
    return f"http://{host}:{port}"


def create(store, url: str) -> dict:
    code = new_code()
    expires = time.time() + CODE_TTL
    store.add_pair_code(code, expires)
    payload = f"pico://pair?u={quote(url, safe='')}&c={code}"
    note = None
    if "127.0.0.1" in url or "localhost" in url:
        note = ("The engine only listens on this computer. To pair a phone, restart it with "
                "PICO_HOST=0.0.0.0 (LAN) or set PICO_PUBLIC_URL to your Tailscale address.")
    return {"code": code, "url": url, "expires": expires, "qr": qr.svg(payload), "payload": payload, "note": note}


def claim(store, code: str, device_name: str) -> str | None:
    code = (code or "").strip().upper().replace("-", "").replace(" ", "")
    if not store.consume_pair_code(code):
        return None
    tok = "picod_" + secrets.token_urlsafe(32)
    store.add_device(device_name or "phone", hash_token(tok))
    return tok
