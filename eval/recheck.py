#!/usr/bin/env python3
"""Re-run checks on a finished run's kept sandboxes (failing ones are kept) after a check bug fix.
Rewrites <run_dir>/results.jsonl and the eval/results/<run>.jsonl/.md, marking changed records with
"rechecked": true so the correction is visible.

    python eval/recheck.py ~/.hermes/cache/scratch/eval-runs/<run_dir> [--tasks id,...]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run as R  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("--tasks")
    a = ap.parse_args()
    rd = Path(a.run_dir).expanduser()
    recs = [json.loads(l) for l in (rd / "results.jsonl").read_text().splitlines() if l.strip()]
    tasks = {t["id"]: t for t in R.load_tasks(None)}
    want = set(a.tasks.split(",")) if a.tasks else None
    changed = 0
    for r in recs:
        if r["pass"] or (want and r["id"] not in want):
            continue
        tdir = rd / f"{r['id']}__r{r['rep']}"
        sb = tdir / "sandbox"
        if not sb.is_dir() or r.get("error") or r.get("timed_out"):
            continue
        t = tasks[r["id"]]
        answers = sorted(tdir.glob("answer_*.txt"))
        env = {**os.environ, "SANDBOX": str(sb), "TASK_DIR": str(t["dir"]), "HIDDEN": str(t["dir"] / "hidden"),
               "RUN_DIR": str(tdir), "TOOLS_JSON": str(tdir / "tools.json"), "EVAL_LIB": str(HERE / "lib"),
               "ANSWER": str(answers[-1]) if answers else ""}
        for x in answers:
            env["ANSWER_" + x.stem.split("_")[1]] = str(x)
        cp = subprocess.run(["bash", "-c", t["check"]], cwd=sb, env=env, capture_output=True, text=True, timeout=120)
        if cp.returncode == 0:
            r.update(passed_before_recheck=False, rechecked=True, check_out=(cp.stdout + cp.stderr)[-600:])
            r["pass"] = True
            changed += 1
            print(f"now PASS: {r['id']} r{r['rep']}")
    (rd / "results.jsonl").write_text("".join(json.dumps(r) + "\n" for r in recs))
    name = rd.name
    meta_md = (R.RESULTS_DIR / f"{name}.md")
    if meta_md.exists() or (R.RESULTS_DIR / f"{name}.jsonl").exists():
        with open(R.RESULTS_DIR / f"{name}.jsonl", "w") as fh:
            for r in sorted(recs, key=lambda r: (r["id"], r["rep"])):
                fh.write(json.dumps(r) + "\n")
        harness = recs[0]["harness"] if recs else "?"
        md = R.summarize(recs, f"Pico eval — {harness} — {name}",
                         {"harness": harness, "model": recs[0].get("model") if recs else "", "runs": len(recs),
                          "rechecked": f"{changed} record(s) re-scored after a check fix (see `rechecked` in JSONL)",
                          "run_dir": str(rd)})
        meta_md.write_text(md)
    print(f"{changed} record(s) changed")


if __name__ == "__main__":
    main()
