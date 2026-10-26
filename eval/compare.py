#!/usr/bin/env python3
"""Compare two eval runs (A = baseline, usually hermes; B = candidate, usually lean).

    python3 eval/compare.py eval/results/<A>.jsonl eval/results/<B>.jsonl

Acceptance bar for B (lean becoming Pico's default):
  1. overall pass rate  B >= A
  2. per-category pass rate  B >= A for every category (memory & skills called out)
  3. fewer tokens: median prompt tokens per task  B < A  (falls back to uncached input if prompt
     tokens are missing)
Prints PASS/FAIL per criterion and an overall verdict; exit code 0 = PASS, 1 = FAIL.
Pass rates are compared over the tasks present in both runs. Use --repeat >= 2 so one flaky task
doesn't decide the verdict; --slack lets you allow a tolerance in percentage points (default 0).
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import defaultdict


def load(path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def pct(a, b):
    if not a or b is None:
        return "n/a"
    return f"{100 * (b - a) / a:+.0f}%"


def rate(rs):
    return 100 * sum(r["pass"] for r in rs) / len(rs) if rs else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--slack", type=float, default=0.0, help="allowed pass-rate drop in points (default 0)")
    args = ap.parse_args()
    A, B = load(args.a), load(args.b)
    ids = {r["id"] for r in A} & {r["id"] for r in B}
    A = [r for r in A if r["id"] in ids]
    B = [r for r in B if r["id"] in ids]
    la, lb = (A[0]["harness"] if A else "A"), (B[0]["harness"] if B else "B")
    if la == lb:
        la, lb = la + "(A)", lb + "(B)"
    tok_key = "prompt_tokens" if all(r.get("prompt_tokens") is not None for r in A + B) else "input_tokens"

    cats = defaultdict(lambda: ([], []))
    for r in A:
        cats[r["category"]][0].append(r)
    for r in B:
        cats[r["category"]][1].append(r)

    print(f"A = {la}  ({args.a}, {len(A)} runs)\nB = {lb}  ({args.b}, {len(B)} runs)\n")
    hdr = (f"| group | n A/B | pass {la} | pass {lb} | Δ pts | med prompt tok A→B | Δ tok | med out tok A→B | "
           f"med 1st-call A→B | med wall s A→B | Δ time | med tools A→B |")
    print(hdr)
    print("|" + "---|" * 12)
    verdict = []

    def row(name, ra, rb):
        pa, pb = rate(ra), rate(rb)
        ta, tb = med([r.get(tok_key) for r in ra]), med([r.get(tok_key) for r in rb])
        oa, ob = med([r["output_tokens"] for r in ra]), med([r["output_tokens"] for r in rb])
        fa, fb = med([r.get("first_call_prompt") for r in ra]), med([r.get("first_call_prompt") for r in rb])
        wa, wb = med([r["wall_s"] for r in ra]), med([r["wall_s"] for r in rb])
        ca, cb = med([r["tool_calls"] for r in ra]), med([r["tool_calls"] for r in rb])
        print(f"| {name} | {len(ra)}/{len(rb)} | {pa:.0f}% | {pb:.0f}% | {pb - pa:+.0f} | {ta:.0f}→{tb:.0f} | {pct(ta, tb)} | "
              f"{oa:.0f}→{ob:.0f} | {(fa or 0):.0f}→{(fb or 0):.0f} | {wa:.1f}→{wb:.1f} | {pct(wa, wb)} | {ca:.0f}→{cb:.0f} |")
        return pa, pb, ta, tb

    pa, pb, ta, tb = row("**ALL**", A, B)
    for c in sorted(cats):
        cpa, cpb, _, _ = row(c, *cats[c])
        verdict.append((f"category '{c}' pass rate {cpb:.0f}% >= {cpa:.0f}%" + (" (memory & skills)" if c == "memory" else ""),
                        cpb + args.slack >= cpa))
    verdict.insert(0, (f"overall pass rate {pb:.0f}% >= {pa:.0f}%", pb + args.slack >= pa))
    verdict.append((f"fewer tokens: median {tok_key} {tb:.0f} < {ta:.0f} ({pct(ta, tb)})", tb is not None and ta is not None and tb < ta))

    # per-task flips
    def by_task(rs):
        d = defaultdict(list)
        for r in rs:
            d[r["id"]].append(r["pass"])
        return {k: sum(v) / len(v) for k, v in d.items()}
    ta_, tb_ = by_task(A), by_task(B)
    worse = sorted(k for k in ids if tb_[k] < ta_[k])
    better = sorted(k for k in ids if tb_[k] > ta_[k])
    print()
    if worse:
        print("Regressed tasks (B lower pass fraction): " + ", ".join(f"{k} {ta_[k]:.0%}→{tb_[k]:.0%}" for k in worse))
    if better:
        print("Improved tasks: " + ", ".join(f"{k} {ta_[k]:.0%}→{tb_[k]:.0%}" for k in better))
    reps = max(r.get("rep", 1) for r in A + B)
    if reps < 2:
        print("NOTE: runs have repeat=1; use --repeat 2+ for both modes before trusting the verdict.")

    print(f"\nAcceptance bar: {lb} must match or beat {la} on pass rate (overall and every category) with fewer tokens"
          + (f" (slack {args.slack} pts)" if args.slack else ""))
    for text, ok in verdict:
        print(f"  [{'PASS' if ok else 'FAIL'}] {text}")
    ok = all(v for _, v in verdict)
    print(f"\nVERDICT: {'PASS' if ok else 'FAIL'} — {lb} {'meets' if ok else 'does NOT meet'} the bar vs {la}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
