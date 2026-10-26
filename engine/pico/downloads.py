"""Download + extraction helpers for Pico's local runtime (stdlib only).

Everything here is synchronous and meant to be run in a worker thread
(``asyncio.to_thread``); progress is reported through a plain callback
``on_bytes(done_bytes, total_bytes_or_None)``.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import stat
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Callable, Optional

USER_AGENT = "pico-runtime/0.1 (+https://github.com/; llama.cpp manager)"
CHUNK = 1 << 20  # 1 MiB


class DownloadError(RuntimeError):
    pass


class DiskSpaceError(DownloadError):
    pass


class UnsafeArchiveError(RuntimeError):
    pass


# ---------------------------------------------------------------- HTTP

class _StripAuthOnCrossHostRedirect(urllib.request.HTTPRedirectHandler):
    """Follow redirects, keep Range, but never forward Authorization to another host
    (HF redirects to a CDN; GitHub redirects to objects.githubusercontent.com)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None:
            old_host = urllib.parse.urlsplit(req.full_url).hostname
            new_host = urllib.parse.urlsplit(newurl).hostname
            if old_host != new_host:
                for k in list(new.headers):
                    if k.lower() == "authorization":
                        del new.headers[k]
                new.unredirected_hdrs.pop("Authorization", None)
        return new


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):  # noqa: D401
        return None


_opener = urllib.request.build_opener(_StripAuthOnCrossHostRedirect)
_noredir_opener = urllib.request.build_opener(_NoRedirect)


def _request(url: str, headers: Optional[dict] = None, method: str = "GET") -> urllib.request.Request:
    h = {"User-Agent": USER_AGENT}
    h.update(headers or {})
    return urllib.request.Request(url, headers=h, method=method)


def http_get_bytes(url: str, headers: Optional[dict] = None, timeout: float = 30) -> bytes:
    with _opener.open(_request(url, headers), timeout=timeout) as r:
        return r.read()


def head_info(url: str, headers: Optional[dict] = None, timeout: float = 30) -> dict:
    """Return {'size': int|None, 'sha256': str|None} for a URL.

    For Hugging Face LFS files the first (non-followed) response carries
    ``X-Linked-Size`` and ``X-Linked-Etag`` (= sha256 of the file)."""
    info: dict = {"size": None, "sha256": None}
    try:
        resp = _noredir_opener.open(_request(url, headers, "HEAD"), timeout=timeout)
        hdrs = resp.headers
        resp.close()
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            hdrs = e.headers
        else:
            raise DownloadError(f"HEAD {url} failed: HTTP {e.code}") from e
    linked_size = hdrs.get("X-Linked-Size")
    etag = (hdrs.get("X-Linked-Etag") or hdrs.get("ETag") or "").strip('"').removeprefix("W/").strip('"')
    if linked_size and linked_size.isdigit():
        info["size"] = int(linked_size)
    elif hdrs.get("Content-Length", "").isdigit() and not hdrs.get("Location"):
        info["size"] = int(hdrs["Content-Length"])
    if len(etag) == 64 and all(c in "0123456789abcdef" for c in etag.lower()):
        info["sha256"] = etag.lower()
    if info["size"] is None and hdrs.get("Location"):
        # follow once to the real object for its length
        try:
            with _opener.open(_request(url, headers, "HEAD"), timeout=timeout) as r:
                cl = r.headers.get("Content-Length")
                if cl and cl.isdigit():
                    info["size"] = int(cl)
        except Exception:
            pass
    return info


def check_disk_space(path: Path, need_bytes: int, reserve_bytes: int = 512 * 1024 * 1024) -> None:
    path.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(path).free
    if need_bytes + reserve_bytes > free:
        raise DiskSpaceError(
            f"Not enough disk space in {path}: need {need_bytes / 1e9:.2f} GB "
            f"(+{reserve_bytes / 1e9:.1f} GB headroom), only {free / 1e9:.2f} GB free. "
            f"Free up space or pick a smaller model."
        )


def download_file(
    url: str,
    dest: Path,
    headers: Optional[dict] = None,
    on_bytes: Optional[Callable[[int, Optional[int]], None]] = None,
    expected_size: Optional[int] = None,
    timeout: float = 60,
    retries: int = 4,
) -> Path:
    """Stream ``url`` to ``dest`` via ``dest.part`` with HTTP Range resume.

    If ``dest`` already exists with the expected size it is left alone.
    Retries transient network failures, resuming from the bytes already on disk."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and (expected_size is None or dest.stat().st_size == expected_size):
        if on_bytes:
            on_bytes(dest.stat().st_size, dest.stat().st_size)
        return dest
    part = dest.with_name(dest.name + ".part")
    attempt = 0
    while True:
        try:
            _download_once(url, part, headers, on_bytes, expected_size, timeout)
            break
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            if isinstance(e, urllib.error.HTTPError) and e.code not in (408, 429, 500, 502, 503, 504):
                raise DownloadError(f"Download failed ({url}): HTTP {e.code} {e.reason}") from e
            attempt += 1
            if attempt > retries:
                raise DownloadError(f"Download failed after {retries} retries ({url}): {e}") from e
            time.sleep(min(2 ** attempt, 20))
    size = part.stat().st_size
    if expected_size is not None and size != expected_size:
        raise DownloadError(f"Size mismatch for {dest.name}: got {size}, expected {expected_size}")
    os.replace(part, dest)
    return dest


def _download_once(url, part: Path, headers, on_bytes, expected_size, timeout) -> None:
    have = part.stat().st_size if part.exists() else 0
    if expected_size is not None and have == expected_size:
        return
    if expected_size is not None and have > expected_size:
        part.unlink()
        have = 0
    h = dict(headers or {})
    if have:
        h["Range"] = f"bytes={have}-"
    try:
        resp = _opener.open(_request(url, h), timeout=timeout)
    except urllib.error.HTTPError as e:
        if e.code == 416 and have:
            # Range not satisfiable: we probably already have the whole file.
            if expected_size is None or have == expected_size:
                return
            part.unlink()
            return _download_once(url, part, headers, on_bytes, expected_size, timeout)
        raise
    with resp:
        status = getattr(resp, "status", resp.getcode())
        if status == 206:
            mode = "ab"
            cr = resp.headers.get("Content-Range", "")  # bytes start-end/total
            total = int(cr.rsplit("/", 1)[1]) if "/" in cr and cr.rsplit("/", 1)[1].isdigit() else expected_size
            start = int(cr.split()[1].split("-")[0]) if cr.startswith("bytes ") else have
            if start != have:  # server ignored our offset semantics; restart cleanly
                mode, have = "wb", 0
        else:  # 200: server ignored Range -> start over
            mode, have = "wb", 0
            cl = resp.headers.get("Content-Length")
            total = int(cl) if cl and cl.isdigit() else expected_size
        done = have
        if on_bytes:
            on_bytes(done, total)
        with open(part, mode) as f:
            while True:
                buf = resp.read(CHUNK)
                if not buf:
                    break
                f.write(buf)
                done += len(buf)
                if on_bytes:
                    on_bytes(done, total)
        if total is not None and done < total:
            raise ConnectionError(f"connection closed early ({done}/{total} bytes)")


def sha256_file(path: Path, on_bytes: Optional[Callable[[int, Optional[int]], None]] = None) -> str:
    h = hashlib.sha256()
    total = Path(path).stat().st_size
    done = 0
    with open(path, "rb") as f:
        while True:
            buf = f.read(8 * CHUNK)
            if not buf:
                break
            h.update(buf)
            done += len(buf)
            if on_bytes:
                on_bytes(done, total)
    return h.hexdigest()


# ---------------------------------------------------------------- archives

def _check_member_name(name: str) -> PurePosixPath:
    n = name.replace("\\", "/")
    p = PurePosixPath(n)
    if n.startswith("/") or (len(n) > 1 and n[1] == ":") or ".." in p.parts:
        raise UnsafeArchiveError(f"unsafe path in archive: {name!r}")
    return p


def _inside(base: Path, target: Path) -> bool:
    base = base.resolve()
    try:
        target.resolve().relative_to(base)
        return True
    except ValueError:
        return False


def safe_extract(archive: Path, dest: Path) -> Path:
    """Extract a .zip / .tar.gz into ``dest`` refusing path traversal, absolute
    paths and links that point outside ``dest``."""
    archive, dest = Path(archive), Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    name = archive.name.lower()
    if name.endswith(".zip"):
        _safe_extract_zip(archive, dest)
    elif name.endswith((".tar.gz", ".tgz", ".tar.xz", ".tar")):
        _safe_extract_tar(archive, dest)
    else:
        raise UnsafeArchiveError(f"unknown archive type: {archive.name}")
    return dest


def _safe_extract_zip(archive: Path, dest: Path) -> None:
    with zipfile.ZipFile(archive) as zf:
        infos = zf.infolist()
        for info in infos:  # validate everything first
            p = _check_member_name(info.filename)
            if not _inside(dest, dest / p):
                raise UnsafeArchiveError(f"zip member escapes destination: {info.filename!r}")
        for info in infos:
            p = _check_member_name(info.filename)
            target = dest / p
            mode = (info.external_attr >> 16) & 0xFFFF
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if stat.S_ISLNK(mode):
                link = zf.read(info).decode()
                if link.startswith("/") or not _inside(dest, target.parent / link):
                    raise UnsafeArchiveError(f"zip symlink escapes destination: {info.filename} -> {link}")
                if target.exists() or target.is_symlink():
                    target.unlink()
                os.symlink(link, target)
                continue
            with zf.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out, CHUNK)
            if mode & 0o111:
                target.chmod((mode & 0o777) & ~0o022 | 0o400)


def _safe_extract_tar(archive: Path, dest: Path) -> None:
    with tarfile.open(archive) as tf:
        members = tf.getmembers()
        for m in members:
            p = _check_member_name(m.name)
            if not _inside(dest, dest / p):
                raise UnsafeArchiveError(f"tar member escapes destination: {m.name!r}")
            if m.issym() or m.islnk():
                link = m.linkname
                base = (dest / p).parent if m.issym() else dest
                if link.startswith("/") or not _inside(dest, base / link):
                    raise UnsafeArchiveError(f"tar link escapes destination: {m.name} -> {link}")
            if m.isdev() or m.isfifo():
                raise UnsafeArchiveError(f"device/fifo in archive: {m.name}")
        if hasattr(tarfile, "data_filter"):
            tf.extractall(dest, members=members, filter="data")
        else:  # pragma: no cover - python < 3.11.4
            tf.extractall(dest, members=members)
