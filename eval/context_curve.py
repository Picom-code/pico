#!/usr/bin/env python3
"""Context-length degradation experiment.

Runs ~8 coding tasks with neutral filler injected at 0/2K/4K/8K/16K/32K extra tokens, each repeated
N times, and reports pass rate + latency vs padding.

Padding method (default "premessage"): the filler (fictional, unrelated ops-handbook text from
eval/lib/filler.py, ~4 chars/token) is prepended to the first user message inside
<docs>...</docs> with a note that it may be irrelevant. That lands in the prompt of *every* model
call of the turn, exactly like extra system-prompt/context-file bulk would. `--mode agents_md`
writes it to AGENTS.md in the sandbox instead (only matters if the harness auto-loads context
files; Pico currently passes skip_context_files=True, so premessage is the meaningful one).

    ~/.hermes/cache/scratch/pico-venv/bin/python eval/context_curve.py --repeat 2
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import statistics
import sys
import threading
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run as R  # noqa: E402
from lib.engine import Engine, MODEL  # noqa: E402

DEFAULT_TASKS = ["code-offbyone", "code-js-slugify", "code-add-feature", "code-refactor", "code-cli-flag",
                 "code-traceback", "code-ts-docstring", "code-multifile"]
DEFAULT_PADS = [0, 2000, 4000, 8000, 16000, 32000]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", default=",".join(DEFAULT_TASKS))
    ap.add_argument("--pads", default=",".join(map(str, DEFAULT_PADS)))
    ap.add_argument("--repeat", type=int, default=2)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--harness", default="hermes", choices=["hermes", "lean"])
    ap.add_argument("--mode", default="premessage", choices=["premessage", "agents_md"])
    ap.add_argument("--effort", default="low")
    ap.add_argument("--timeout-mult", type=float, default=1.5)
    ap.add_argument("--out", default=str(R.DEFAULT_OUT))
    args = ap.parse_args()
    args.keep = False

    wanted = args.tasks.split(",")
    tasks = [t for t in R.load_tasks(None) if t["id"] in wanted]
    pads = [int(p) for p in args.pads.split(",")]
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = Path(args.out) / f"{stamp}-ctxcurve-{args.harness}"
    run_dir.mkdir(parents=True, exist_ok=True)
    eng = Engine(run_dir / "shared-home").start()
    recs = []
    lock = threading.Lock()
    try:
        eng.configure(args.harness)
        harness = args.harness if eng.harness_supported else "hermes"
        jobs = []
        for rep in range(1, args.repeat + 1):
            for pad in pads:
                for t in tasks:
                    tt = dict(t, pad_tokens=pad, pad_mode=args.mode, id=t["id"], dir=t["dir"])
                    jobs.append((tt, rep, pad))
        R.log(f"context curve: {len(tasks)} tasks x {len(pads)} pads x {args.repeat} = {len(jobs)} runs, harness={harness}")

        def one(tt, rep, pad):
            sub = run_dir / f"pad{pad}"
            sub.mkdir(exist_ok=True)
            return R.run_task(tt, rep, harness, eng, sub, args)

        with cf.ThreadPoolExecutor(args.concurrency) as ex:
            for f in cf.as_completed([ex.submit(one, *j) for j in jobs]):
                r = f.result()
                with lock:
                    recs.append(r)
                    with open(run_dir / "results.jsonl", "a") as fh:
                        fh.write(json.dumps(r) + "\n")
    finally:
        eng.stop()

    out_jsonl = R.RESULTS_DIR / f"context-curve-{stamp}.jsonl"
    with open(out_jsonl, "w") as fh:
        for r in sorted(recs, key=lambda r: (r["pad_tokens"], r["id"], r["rep"])):
            fh.write(json.dumps(r) + "\n")
    lines = [f"# Context-length curve — {MODEL} — {harness} harness — {stamp}", "",
             f"- tasks ({len(tasks)}): {', '.join(t['id'] for t in tasks)}",
             f"- padding: neutral filler, mode `{args.mode}` "
             + ("(prepended to the first user message, so it is in every model call's prompt)" if args.mode == "premessage"
                else "(AGENTS.md in the sandbox)"),
             f"- repeat: {args.repeat}, effort: {args.effort}, timeout x{args.timeout_mult}", "",
             "| extra tokens | n | pass rate | median 1st-call prompt | median prompt tok/task | median wall s | mean wall s | median model latency s | median tools |",
             "|---|---|---|---|---|---|---|---|---|"]
    for pad in pads:
        rs = [r for r in recs if r["pad_tokens"] == pad]
        if not rs:
            continue
        p = sum(r["pass"] for r in rs)
        m = lambda k: statistics.median([r[k] for r in rs if r.get(k) is not None] or [0])
        lines.append(f"| {pad} | {len(rs)} | {p}/{len(rs)} = {100*p/len(rs):.0f}% | {m('first_call_prompt'):.0f} | "
                     f"{m('prompt_tokens'):.0f} | {m('wall_s'):.1f} | {statistics.mean([r['wall_s'] for r in rs]):.1f} | "
                     f"{m('model_latency_s'):.1f} | {m('tool_calls'):.0f} |")
    lines += ["", "Failures: " + (", ".join(f"{r['id']}@{r['pad_tokens']} r{r['rep']}" for r in recs if not r["pass"]) or "none"),
              "", f"Raw: `{out_jsonl.relative_to(HERE.parent)}`", ""]
    md = "\n".join(lines)
    (run_dir / "context-curve.md").write_text(md)
    (R.RESULTS_DIR / f"context-curve-{stamp}.md").write_text(md)
    print(md)


if __name__ == "__main__":
    main()
