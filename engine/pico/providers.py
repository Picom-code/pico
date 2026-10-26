"""Provider presets and the connection test used by easy model setup (POST /api/provider/test)."""
from __future__ import annotations

import json
import socket
import time
import urllib.error
import urllib.request
from typing import Optional

PRESETS = [
    {"id": "openai", "name": "OpenAI", "base_url": "https://api.openai.com/v1", "needs_key": True,
     "note": "API key from platform.openai.com (billed per token, separate from a ChatGPT subscription)."},
    {"id": "openrouter", "name": "OpenRouter", "base_url": "https://openrouter.ai/api/v1", "needs_key": True,
     "note": "One key for hundreds of models (openrouter.ai/keys)."},
    {"id": "groq", "name": "Groq", "base_url": "https://api.groq.com/openai/v1", "needs_key": True,
     "note": "Very fast open models (console.groq.com/keys)."},
    {"id": "together", "name": "Together AI", "base_url": "https://api.together.xyz/v1", "needs_key": True,
     "note": "Open models in the cloud (api.together.ai)."},
    {"id": "deepseek", "name": "DeepSeek", "base_url": "https://api.deepseek.com/v1", "needs_key": True,
     "note": "DeepSeek's own API (platform.deepseek.com)."},
    {"id": "anthropic", "name": "Anthropic (OpenAI-compatible)", "base_url": "https://api.anthropic.com/v1",
     "needs_key": True, "note": "Claude via Anthropic's OpenAI-compatible endpoint (console.anthropic.com)."},
    {"id": "ollama", "name": "Ollama", "base_url": "http://localhost:11434/v1", "needs_key": False,
     "note": "Models running in Ollama on this computer. Start Ollama and pull a model first."},
    {"id": "lmstudio", "name": "LM Studio", "base_url": "http://localhost:1234/v1", "needs_key": False,
     "note": "LM Studio's local server (Developer tab → Start server)."},
    {"id": "custom", "name": "Custom (OpenAI-compatible)", "base_url": "", "needs_key": False,
     "note": "Any OpenAI-compatible server: vLLM, SGLang, llama.cpp, a box on your network…"},
]


def _headers(key: Optional[str]) -> dict:
    h = {"Content-Type": "application/json", "User-Agent": "pico-engine"}
    if key:
        h["Authorization"] = f"Bearer {key}"
        if "anthropic" in (key[:10] if key else ""):
            pass
    return h


def _classify(e: BaseException, key: Optional[str]) -> dict:
    """Exception -> {kind, message} in plain English. Never includes the key."""
    if isinstance(e, urllib.error.HTTPError):
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            pass
        if key:
            body = body.replace(key, "***")
        if e.code in (401, 403):
            return {"kind": "auth", "message": "The server rejected the API key" + (" (none was given)." if not key else ".")
                    + " Check the key and that it has access to this model."}
        if e.code == 404:
            return {"kind": "not_found", "message": "The server answered but that URL or model wasn't found. "
                                                    "Check the base URL (it usually ends in /v1) and the model name."}
        if e.code == 429:
            return {"kind": "other", "message": "The server says you're rate-limited or out of credit (HTTP 429)."}
        return {"kind": "other", "message": f"The server returned HTTP {e.code}. {body.strip()[:200]}".strip()}
    reason = getattr(e, "reason", e)
    if isinstance(reason, (socket.timeout, TimeoutError)) or isinstance(e, (socket.timeout, TimeoutError)) \
            or "timed out" in str(reason).lower():
        return {"kind": "timeout", "message": "The server didn't answer in time. Is it running and reachable from this computer?"}
    if isinstance(e, urllib.error.URLError) or isinstance(e, (ConnectionError, OSError)):
        msg = str(reason)
        if "nodename nor servname" in msg or "Name or service not known" in msg or "getaddrinfo" in msg:
            return {"kind": "network", "message": "Couldn't find that server name. Check the address for typos."}
        if "refused" in msg.lower():
            return {"kind": "network", "message": "Nothing is listening at that address. Is the server running?"}
        if "CERTIFICATE" in msg.upper() or "SSL" in msg.upper():
            return {"kind": "network", "message": "The secure connection failed (certificate problem)."}
        return {"kind": "network", "message": f"Couldn't connect to the server ({msg[:120]})."}
    return {"kind": "other", "message": f"{type(e).__name__}: {str(e)[:200]}"}


def list_models(base_url: str, key: Optional[str], timeout: float = 6.0) -> tuple[list[dict], Optional[BaseException]]:
    req = urllib.request.Request(base_url.rstrip("/") + "/models", headers=_headers(key))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read() or b"{}")
    except Exception as e:  # noqa: BLE001
        return [], e
    items = data.get("data") if isinstance(data, dict) else data if isinstance(data, list) else []
    out = []
    for m in items or []:
        if isinstance(m, dict) and m.get("id"):
            out.append({"id": m["id"], "ctx": m.get("max_model_len") or m.get("context_length") or m.get("context_window")})
    return out, None


def _pick_model(ids: list[str]) -> Optional[str]:
    """A sensible default for the test call when the user didn't name a model."""
    skip = ("embed", "whisper", "tts", "dall-e", "image", "moderation", "audio", "rerank", "transcribe", "realtime")
    chat = [i for i in ids if not any(s in i.lower() for s in skip)]
    return (chat or ids or [None])[0]


def test_provider(base_url: str, api_key: Optional[str] = None, model: Optional[str] = None,
                  timeout: float = 30.0) -> dict:
    """List /models (tolerated if missing) and run an 8-token completion. Result never contains the key."""
    base_url = (base_url or "").strip().rstrip("/")
    out = {"ok": False, "models": [], "model_used": None, "tps": None, "latency_s": None}
    if not base_url.startswith(("http://", "https://")):
        out["error"] = {"kind": "other", "message": "The base URL must start with http:// or https://"}
        return out
    models, list_err = list_models(base_url, api_key, timeout=min(timeout, 8.0))
    out["models"] = [m["id"] for m in models]
    if list_err is not None:
        cls = _classify(list_err, api_key)
        if cls["kind"] in ("network", "timeout", "auth"):
            out["error"] = cls  # no point trying a completion against a dead / locked server
            return out
    use = model or _pick_model(out["models"])
    if not use:
        out["error"] = {"kind": "not_found", "message": "The server didn't list any models; type the model name to use."}
        return out
    out["model_used"] = use
    body = {"model": use, "max_tokens": 8, "temperature": 0, "stream": False,
            "messages": [{"role": "user", "content": "Reply with the single word: ok"}]}
    req = urllib.request.Request(base_url + "/chat/completions", data=json.dumps(body).encode(), headers=_headers(api_key))
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read() or b"{}")
    except Exception as e:  # noqa: BLE001
        out["latency_s"] = round(time.time() - t0, 2)
        out["error"] = _classify(e, api_key)
        if out["error"]["kind"] == "not_found" and out["models"] and use not in out["models"]:
            out["error"]["message"] = f"The server doesn't have a model called {use!r}. It lists: " + ", ".join(out["models"][:8])
        return out
    dt_s = time.time() - t0
    out["latency_s"] = round(dt_s, 2)
    try:
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        _ = msg.get("content") or msg.get("reasoning_content") or ""
    except Exception:  # noqa: BLE001
        out["error"] = {"kind": "other", "message": "The server answered, but not in the OpenAI chat format."}
        return out
    toks = int(((data.get("usage") or {}).get("completion_tokens")) or 0)
    out["tps"] = round(toks / dt_s, 1) if toks and dt_s > 0.05 else None
    out["ok"] = True
    return out
