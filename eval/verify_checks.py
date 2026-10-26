#!/usr/bin/env python3
"""Discrimination test for task checks, no model involved:
  * no-op  : fixture + setup.sh untouched, empty answer  -> check must FAIL
  * oracle : apply solution/ overlay and/or solution.sh   -> check must PASS (where a solution exists)
Tasks whose pass depends on the agent's chat reply or tool log (memory/skill) only get the no-op test,
unless they ship an oracle.

    python3 eval/verify_checks.py [--tasks ids]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def load(filt):
    import yaml
    out = []
    for d in sorted((HERE / "tasks").iterdir()):
        if (d / "task.yaml").is_file():
            t = yaml.safe_load((d / "task.yaml").read_text())
            t["dir"] = d
            if not filt or any(k in t["id"] for k in filt.split(",")):
                out.append(t)
    return out


def run_check(t, oracle: bool) -> tuple[bool, str]:
    tdir = t["dir"]
    root = Path(tempfile.mkdtemp(prefix="pico-verify-", dir=os.environ.get("TMPDIR")))
    sb = root / "sandbox"
    try:
        if (tdir / "fixture").is_dir():
            shutil.copytree(tdir / "fixture", sb)
        else:
            sb.mkdir()
        env = {**os.environ, "SANDBOX": str(sb), "TASK_DIR": str(tdir), "HIDDEN": str(tdir / "hidden"),
               "EVAL_LIB": str(HERE / "lib"), "RUN_DIR": str(root)}
        if (tdir / "setup.sh").is_file():
            subprocess.run(["bash", str(tdir / "setup.sh")], cwd=sb, env=env, check=True, capture_output=True)
        ans = root / "answer_1.txt"
        tools = root / "tools.json"
        ans.write_text("")
        tools.write_text("[]")
        if oracle:
            if (tdir / "solution").is_dir():
                shutil.copytree(tdir / "solution", sb, dirs_exist_ok=True)
            if (tdir / "solution.sh").is_file():
                subprocess.run(["bash", str(tdir / "solution.sh")], cwd=sb, env=env, check=True, capture_output=True)
            if (tdir / "solution_answer.txt").is_file():
                ans.write_text((tdir / "solution_answer.txt").read_text())
            if (tdir / "solution_tools.json").is_file():
                tools.write_text((tdir / "solution_tools.json").read_text())
        env.update(ANSWER=str(ans), ANSWER_1=str(ans), TOOLS_JSON=str(tools))
        cp = subprocess.run(["bash", "-c", t["check"]], cwd=sb, env=env, capture_output=True, text=True, timeout=120)
        return cp.returncode == 0, (cp.stdout + cp.stderr).strip()[-300:]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks")
    a = ap.parse_args()
    bad = 0
    rows = []
    for t in load(a.tasks):
        has_oracle = any((t["dir"] / n).exists() for n in ("solution", "solution.sh"))
        noop_pass, noop_out = run_check(t, False)
        ora = run_check(t, True) if has_oracle else (None, "")
        ok = (not noop_pass) and (ora[0] in (True, None))
        bad += not ok
        rows.append({"id": t["id"], "noop_fails": not noop_pass, "oracle_passes": ora[0], "ok": ok})
        print(f"{'OK ' if ok else 'BAD'} {t['id']:26} noop={'fail' if not noop_pass else 'PASS(!)'} "
              f"oracle={ {True: 'pass', False: 'FAIL(!)', None: '-'}[ora[0]] }"
              + ("" if ok else f"\n     noop: {noop_out[-150:]}\n     oracle: {ora[1][-200:]}"))
    (HERE / "results" / "check-discrimination.json").write_text(json.dumps(rows, indent=1) + "\n")
    print(f"{len(rows) - bad}/{len(rows)} checks discriminate")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
