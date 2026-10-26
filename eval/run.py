#!/usr/bin/env python3
"""Pico harness eval runner.

Drives a throwaway Pico engine (own PICO_HOME, port 7950+) over its HTTP+SSE API against the
configured model, one fresh sandbox per task, then runs each task's deterministic check.

    ~/.hermes/cache/scratch/pico-venv/bin/python eval/run.py --harness hermes --repeat 1

Outputs: <out>/<stamp>-<harness>/ (sandboxes, transcripts; pruned unless --keep) and
eval/results/<stamp>-<harness>.jsonl + .md (small, committed).

Task format: eval/tasks/<id>/task.yaml (see docs/EVAL.md). Key fields:
  id, category, prompt | sessions: [prompt, ...], timeout_s, check (shell, cwd=sandbox, exit 0 = pass),
  isolated: true (own engine; memory tasks), memory: [text, ...] (seeded before the first session),
  effort (default "low"), pad_tokens (context experiment only).
Check env: SANDBOX, TASK_DIR, HIDDEN (=TASK_DIR/hidden), ANSWER (last final reply file),
ANSWER_1..N (per-session reply files), RUN_DIR.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import shutil
import statistics
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from lib.engine import Engine, MODEL  # noqa: E402

import yaml  # noqa: E402  (pico venv)

TASKS_DIR = HERE / "tasks"
RESULTS_DIR = HERE / "results"
DEFAULT_OUT = Path.home() / ".hermes/cache/scratch/eval-runs"
_print_lock = threading.Lock()


def log(*a):
    with _print_lock:
        print(*a, flush=True)


def load_tasks(filt: str | None) -> list[dict]:
    tasks = []
    for d in sorted(TASKS_DIR.iterdir()):
        f = d / "task.yaml"
        if not f.is_file():
            continue
        t = yaml.safe_load(f.read_text())
        t["dir"] = d
        t.setdefault("id", d.name)
        if filt:
            keys = [k.strip() for k in filt.split(",") if k.strip()]
            if not any(k == t["id"] or k == t.get("category") or k in t["id"] for k in keys):
                continue
        tasks.append(t)
    return tasks


# ── one turn ─────────────────────────────────────────────────────────────────

def run_turn(eng: Engine, sid: str, text: str, effort: str, harness: str, deadline: float, stats: dict) -> str:
    body = {"text": text, "effort": effort}
    if eng.harness_supported:
        body["harness"] = harness
    final: list[str] = []
    stopper = None

    def watchdog():
        while not stats.get("_turn_over"):
            if time.time() > deadline:
                stats["timed_out"] = True
                try:
                    eng.call("POST", f"/api/sessions/{sid}/stop", {})
                except Exception:  # noqa: BLE001
                    pass
                return
            time.sleep(1)

    stats["_turn_over"] = False
    stopper = threading.Thread(target=watchdog, daemon=True)
    stopper.start()
    try:
        for ev, data in eng.sse(f"/api/sessions/{sid}/messages", body, read_timeout=max(60, deadline - time.time() + 60)):
            if ev == "delta":
                final.append(data.get("text", ""))
            elif ev == "tool_start":
                stats["tool_calls"] += 1
                stats["tools"].append(data.get("name"))
                stats["tool_events"].append({"name": data.get("name"), "args": json.dumps(data.get("args"))[:2000]})
                final.clear()  # keep only the text after the last tool call as the "answer"
            elif ev == "approval":
                stats["approvals"] += 1
                try:
                    eng.call("POST", f"/api/sessions/{sid}/approve", {"id": data["id"], "allow": True})
                except Exception:  # noqa: BLE001
                    pass
            elif ev == "done":
                u = data.get("usage") or {}
                stats["turn_inputs"].append(int(u.get("input") or 0))
                stats["output_tokens"] += int(u.get("output") or 0)
                stats["turns"] += 1
                if data.get("stopped"):
                    stats["stopped"] = True
                break
            elif ev == "error":
                stats["error"] = (data.get("message") or "error")[:300]
                break
    finally:
        stats["_turn_over"] = True
    # the stored assistant message is the authoritative final text
    try:
        s = eng.get(f"/api/sessions/{sid}")
        msgs = [m for m in s.get("messages", []) if m.get("role") == "assistant"]
        if msgs and msgs[-1].get("content"):
            return msgs[-1]["content"]
    except Exception:  # noqa: BLE001
        pass
    return "".join(final)


# ── one task ─────────────────────────────────────────────────────────────────

def pad_text(tokens: int) -> str:
    """Neutral filler docs (~4 chars/token), deterministic."""
    from lib.filler import doc
    return doc(tokens, seed=11, title="Internal operations handbook (unrelated to the task)")


def run_task(task: dict, rep: int, harness: str, eng_shared: Engine | None, run_dir: Path, args) -> dict:
    tid = task["id"]
    tdir: Path = task["dir"]
    rdir = run_dir / f"{tid}__r{rep}"
    sandbox = rdir / "sandbox"
    if rdir.exists():
        shutil.rmtree(rdir)
    rdir.mkdir(parents=True)
    fx = tdir / "fixture"
    if fx.is_dir():
        shutil.copytree(fx, sandbox, symlinks=True)
    else:
        sandbox.mkdir()
    if (tdir / "setup.sh").is_file():
        subprocess.run(["bash", str(tdir / "setup.sh")], cwd=sandbox, capture_output=True, timeout=120,
                       env={**os.environ, "TASK_DIR": str(tdir), "EVAL_LIB": str(HERE / "lib"), "SANDBOX": str(sandbox)})
    pad = int(task.get("pad_tokens") or 0)
    pad_mode = task.get("pad_mode", "premessage")
    if pad and pad_mode == "agents_md":
        (sandbox / "AGENTS.md").write_text("# Project notes\n\n" + pad_text(pad))

    stats = {"tool_calls": 0, "tools": [], "tool_events": [], "approvals": 0, "turn_inputs": [], "output_tokens": 0, "turns": 0,
             "error": None, "timed_out": False, "stopped": False}
    rec = {"id": tid, "category": task.get("category"), "rep": rep, "harness": harness, "model": MODEL,
           "pad_tokens": pad, "pass": False}
    t0 = time.time()
    own = None
    eng = eng_shared
    try:
        if task.get("isolated") or eng is None:
            own = Engine(rdir / "home").start()
            own.configure(harness)
            eng = own
        for m in task.get("memory") or []:
            eng.add_memory(m if isinstance(m, str) else m["text"], "memory" if isinstance(m, str) else m.get("target", "memory"))
        prompts = task.get("sessions") or [task["prompt"]]
        timeout = float(task.get("timeout_s") or 300) * args.timeout_mult
        deadline = t0 + timeout
        effort = task.get("effort") or args.effort
        sids = []
        for i, p in enumerate(prompts, 1):
            if isinstance(p, str):
                p = {"text": p}
            if i == 1 or p.get("new_session", True):
                s = eng.call("POST", "/api/sessions", {"cwd": str(sandbox), "title": f"eval {tid} s{i}"})
                sids.append(s["id"])
            text = p["text"]
            if pad and pad_mode == "premessage" and i == 1:
                text = ("Background reference material (may or may not be relevant):\n\n<docs>\n" + pad_text(pad)
                        + "\n</docs>\n\nTask:\n" + text)
            ans = run_turn(eng, sids[-1], text, effort, harness, deadline, stats)
            (rdir / f"answer_{i}.txt").write_text(ans or "")
            if stats["error"] or stats["timed_out"]:
                break
        rec["api_turns"] = sum((eng.api_turns(s) or 0) for s in sids) or None
        time.sleep(0.3)  # let the log flush the "Turn ended" line
        cu = eng.call_usage()
        calls = [c for s in sids for c in cu.get(s, [])]
        if calls:
            rec["api_calls"] = len(calls)
            rec["prompt_tokens"] = sum(c["prompt"] for c in calls)      # full prompt incl. cached prefix
            rec["cached_tokens"] = sum(c["cached"] for c in calls)
            rec["first_call_prompt"] = calls[0]["prompt"]                 # system+tools+first user msg
            rec["max_prompt"] = max(c["prompt"] for c in calls)
            rec["model_latency_s"] = round(sum(c["latency"] for c in calls), 1)
    except Exception as e:  # noqa: BLE001
        stats["error"] = f"runner: {type(e).__name__}: {e}"[:300]
        (rdir / "runner_error.txt").write_text(traceback.format_exc())
    finally:
        if own:
            own.stop()
    rec["wall_s"] = round(time.time() - t0, 1)
    for k in ("api_calls", "prompt_tokens", "cached_tokens", "first_call_prompt", "max_prompt", "model_latency_s"):
        rec.setdefault(k, None)

    (rdir / "tools.json").write_text(json.dumps(stats["tool_events"], indent=1))
    # check ------------------------------------------------------------------
    answers = sorted(rdir.glob("answer_*.txt"))
    env = {**os.environ, "SANDBOX": str(sandbox), "TASK_DIR": str(tdir), "HIDDEN": str(tdir / "hidden"),
           "TOOLS_JSON": str(rdir / "tools.json"), "EVAL_LIB": str(HERE / "lib"),
           "RUN_DIR": str(rdir), "ANSWER": str(answers[-1]) if answers else str(rdir / "answer_none.txt")}
    for a in answers:
        env["ANSWER_" + a.stem.split("_")[1]] = str(a)
    if not answers:
        (rdir / "answer_none.txt").write_text("")
    try:
        cp = subprocess.run(["bash", "-c", task["check"]], cwd=sandbox, env=env, capture_output=True, text=True,
                            timeout=int(task.get("check_timeout_s", 120)))
        rec["pass"] = cp.returncode == 0
        rec["check_out"] = (cp.stdout + cp.stderr)[-600:]
    except subprocess.TimeoutExpired:
        rec["check_out"] = "check timed out"
    rec.update(
        # done.usage.input = Hermes input_tokens = prompt minus cache reads (uncached input), summed over turns
        input_tokens=sum(stats["turn_inputs"]), output_tokens=stats["output_tokens"],
        first_turn_input=stats["turn_inputs"][0] if stats["turn_inputs"] else None,
        tool_calls=stats["tool_calls"], tools=stats["tools"], approvals=stats["approvals"], turns=stats["turns"],
        error=stats["error"], timed_out=stats["timed_out"],
    )
    if not args.keep and rec["pass"]:
        shutil.rmtree(sandbox, ignore_errors=True)
        shutil.rmtree(rdir / "home", ignore_errors=True)
    elif not args.keep:
        shutil.rmtree(rdir / "home", ignore_errors=True)  # keep failing sandboxes for diagnosis (small)
    status = "PASS" if rec["pass"] else ("TIMEOUT" if rec["timed_out"] else "FAIL")
    log(f"  {status:7} {tid:28} r{rep}  {rec['wall_s']:6.1f}s  prompt={rec['prompt_tokens'] or 0:>7} in={rec['input_tokens']:>6} out={rec['output_tokens']:>6} "
        f"tools={rec['tool_calls']:>2}" + (f"  err={rec['error'][:80]}" if rec["error"] else ""))
    return rec


# ── summary ──────────────────────────────────────────────────────────────────

def _med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else 0


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else 0


def summarize(recs: list[dict], title: str, meta: dict) -> str:
    lines = [f"# {title}", ""]
    for k, v in meta.items():
        lines.append(f"- **{k}**: {v}")
    lines.append("")
    groups = {"ALL": recs}
    for r in recs:
        groups.setdefault(r["category"], []).append(r)
    lines.append("| category | n | pass rate | median prompt tok | mean prompt tok | median uncached in | median out tok | median 1st-call prompt | median wall s | median tools | median API calls |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for g, rs in groups.items():
        n = len(rs)
        p = sum(r["pass"] for r in rs)
        lines.append(f"| {g} | {n} | {p}/{n} = {100*p/n:.0f}% | {_med([r.get('prompt_tokens') for r in rs]):.0f} | "
                     f"{_mean([r.get('prompt_tokens') for r in rs]):.0f} | {_med([r['input_tokens'] for r in rs]):.0f} | "
                     f"{_med([r['output_tokens'] for r in rs]):.0f} | {_med([r.get('first_call_prompt') for r in rs]):.0f} | "
                     f"{_med([r['wall_s'] for r in rs]):.1f} | {_med([r['tool_calls'] for r in rs]):.0f} | "
                     f"{_med([r.get('api_calls') for r in rs]):.0f} |")
    lines += ["", "Token columns: *prompt* = sum of full prompt tokens over every model call (incl. cached prefix; "
              "from the engine log); *uncached in* = sum of `done.usage.input` (prompt minus cache reads); "
              "*1st-call prompt* = system + tools + first user message (harness overhead).",
              "", "## Per task", "", "| task | cat | pass | wall s | prompt tok | uncached in | out tok | tools | calls | error / check tail |",
              "|---|---|---|---|---|---|---|---|---|---|"]
    for r in sorted(recs, key=lambda r: (r["category"], r["id"], r["rep"])):
        note = (r.get("error") or ("" if r["pass"] else (r.get("check_out") or "").strip().splitlines()[-1:] and
                (r.get("check_out") or "").strip().splitlines()[-1]) or "")
        note = str(note).replace("|", "\\|")[:110]
        lines.append(f"| {r['id']} r{r['rep']} | {r['category']} | {'✅' if r['pass'] else '❌'} | {r['wall_s']} | "
                     f"{r.get('prompt_tokens')} | {r['input_tokens']} | {r['output_tokens']} | {r['tool_calls']} | "
                     f"{r.get('api_calls')} | {note} |")
    slow = sorted(recs, key=lambda r: -r["wall_s"])[:5]
    lines += ["", "Slowest: " + ", ".join(f"{r['id']} ({r['wall_s']}s)" for r in slow)]
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--harness", default="hermes", choices=["hermes", "lean"])
    ap.add_argument("--tasks", help="comma list of ids / categories / substrings")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--port", type=int, help="port for the shared engine (default: first free >= 7950)")
    ap.add_argument("--effort", default="low")
    ap.add_argument("--timeout-mult", type=float, default=1.0)
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--tag", default="", help="suffix for result file names")
    ap.add_argument("--keep", action="store_true", help="keep all sandboxes")
    ap.add_argument("--no-results", action="store_true", help="don't write eval/results files")
    args = ap.parse_args()

    tasks = load_tasks(args.tasks)
    if not tasks:
        sys.exit("no tasks matched")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    name = f"{stamp}-{args.harness}" + (f"-{args.tag}" if args.tag else "")
    run_dir = Path(args.out) / name
    run_dir.mkdir(parents=True, exist_ok=True)
    eng = Engine(run_dir / "shared-home", port=args.port).start()
    recs: list[dict] = []
    try:
        eng.configure(args.harness)
        harness_label = args.harness if eng.harness_supported else "hermes"
        if args.harness == "lean" and not eng.harness_supported:
            log("WARNING: engine does not support harness=lean; running (and labeling) as 'hermes'")
        log(f"engine :{eng.port}  model={MODEL}  harness={harness_label}  tasks={len(tasks)} x{args.repeat}  run_dir={run_dir}")
        jobs = [(t, r) for r in range(1, args.repeat + 1) for t in tasks]
        out_jsonl = RESULTS_DIR / f"{name}.jsonl"
        lock = threading.Lock()
        with cf.ThreadPoolExecutor(args.concurrency) as ex:
            futs = [ex.submit(run_task, t, r, harness_label, None if t.get("isolated") else eng, run_dir, args)
                    for t, r in jobs]
            for f in cf.as_completed(futs):
                rec = f.result()
                with lock:
                    recs.append(rec)
                    with open(run_dir / "results.jsonl", "a") as fh:
                        fh.write(json.dumps(rec) + "\n")
        meta = {"harness": harness_label, "model": MODEL, "effort": args.effort, "repeat": args.repeat,
                "tasks": len(tasks), "harness_param_supported": eng.harness_supported, "run_dir": str(run_dir),
                "date": datetime.now().isoformat(timespec="seconds")}
        md = summarize(recs, f"Pico eval — {harness_label} — {stamp}", meta)
        (run_dir / "summary.md").write_text(md)
        if not args.no_results:
            RESULTS_DIR.mkdir(exist_ok=True)
            with open(out_jsonl, "w") as fh:
                for r in sorted(recs, key=lambda r: (r["id"], r["rep"])):
                    fh.write(json.dumps(r) + "\n")
            (RESULTS_DIR / f"{name}.md").write_text(md)
            log(f"wrote {out_jsonl} and {out_jsonl.with_suffix('.md')}")
        p = sum(r["pass"] for r in recs)
        log(f"PASS {p}/{len(recs)} = {100*p/max(1,len(recs)):.0f}%")
    finally:
        eng.stop()


if __name__ == "__main__":
    main()
