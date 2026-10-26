"""Deterministic, neutral-but-plausible filler text (fictional internal docs) for padding experiments
and long-context fixtures. ~4 chars per token."""
from __future__ import annotations

import random

_TEAMS = ["Billing", "Search", "Identity", "Logistics", "Analytics", "Mobile", "Payments", "Infra", "Support", "Growth"]
_NOUNS = ["ledger", "cache", "queue", "invoice", "shipment", "profile", "report", "session", "bucket", "token",
          "catalog", "webhook", "schedule", "quota", "snapshot", "batch", "tenant", "region", "voucher", "manifest"]
_VERBS = ["reconcile", "rotate", "archive", "replay", "validate", "throttle", "export", "merge", "prune", "index",
          "migrate", "notify", "refresh", "settle", "compact", "audit"]
_ADJ = ["nightly", "regional", "legacy", "primary", "standby", "partial", "incremental", "cold", "warm", "shared"]
_SENT = [
    "The {adj} {noun} job runs under the {team} service account and writes its output to the {noun2} store.",
    "Before you {verb} a {noun}, confirm that the {adj} {noun2} has finished; otherwise retries pile up.",
    "Owners: the {team} on-call rotation. Escalate after two failed attempts to {verb} the {noun}.",
    "Metrics for the {noun} pipeline are exported every {n} seconds and retained for {m} days.",
    "Known issue: a {adj} {noun2} can block the {verb} step; restarting the worker usually clears it.",
    "Configuration lives in `{noun}.{noun2}.toml`; the `{verb}_interval` key defaults to {n} minutes.",
    "The {team} team deprecated the {adj} {noun} endpoint in favor of `/{noun2}/{verb}` last quarter.",
    "Runbook: drain traffic, {verb} the {noun}, verify the {noun2} checksum, then re-enable traffic.",
    "Rate limits: {n} requests per minute per tenant for {noun} reads, {m} for writes.",
    "When the {adj} {noun} lags by more than {n} minutes, the {team} dashboard turns amber.",
]


def paragraph(rng: random.Random, k: int = 5) -> str:
    out = []
    for _ in range(k):
        s = rng.choice(_SENT).format(adj=rng.choice(_ADJ), noun=rng.choice(_NOUNS), noun2=rng.choice(_NOUNS),
                                     verb=rng.choice(_VERBS), team=rng.choice(_TEAMS),
                                     n=rng.choice([5, 10, 15, 30, 60, 90, 120]), m=rng.choice([7, 14, 30, 90, 365]))
        out.append(s)
    return " ".join(out)


def doc(tokens: int, seed: int = 7, title: str = "Operations handbook (excerpt)") -> str:
    rng = random.Random(seed)
    parts = [f"# {title}\n"]
    size = len(parts[0])
    i = 1
    while size < tokens * 4:
        h = f"\n## {i}. {rng.choice(_TEAMS)} — {rng.choice(_ADJ)} {rng.choice(_NOUNS)} {rng.choice(_VERBS)}\n\n"
        p = paragraph(rng, rng.randint(3, 7)) + "\n"
        parts += [h, p]
        size += len(h) + len(p)
        i += 1
    return "".join(parts)[: tokens * 4]
