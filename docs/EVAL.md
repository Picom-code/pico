# Pico harness eval

`eval/` measures how well a harness mode (`hermes` vs `lean`) does real work through the engine API,
and what it costs. It drives a throwaway engine (own `PICO_HOME`, port 7950+, never the live 7878
engine) against DeepSeek v4.1 Flash on a DGX Spark.

```sh
PY=~/.hermes/cache/scratch/pico-venv/bin/python        # this interpreter matters
$PY eval/verify_checks.py                               # checks discriminate? (no model)
$PY eval/run.py --harness hermes --repeat 2             # full suite, ~30 tasks
$PY eval/run.py --harness lean --repeat 2 --tasks memory,coding
$PY eval/compare.py eval/results/<hermes>.jsonl eval/results/<lean>.jsonl   # PASS/FAIL vs the bar
$PY eval/context_curve.py --repeat 2                    # pass rate/latency vs extra context
```

## Acceptance bar (lean as Pico's default)
`compare.py A B` exits 0 and prints `VERDICT: PASS` only if B (lean):
1. overall pass rate ≥ A (hermes),
2. pass rate ≥ A in **every** category (memory & skills especially),
3. median prompt tokens per task < A.
Run both modes with `--repeat 2` (or more) so one flaky task doesn't decide the verdict.

## Runner
`eval/run.py`: one engine; per task a fresh sandbox (copy of `fixture/` and then `setup.sh`), a new session with
`cwd=sandbox`, the prompt(s) sent via `POST /api/sessions/{id}/messages`, SSE consumed, every `approval`
auto-allowed through `/approve`, a wall-clock timeout (`/stop`), then the task's `check`. Tasks marked
`isolated: true` (memory) get their own engine so memories never leak between tasks. If
`PATCH /api/config {harness}` is accepted the runner also sends `harness` per message; otherwise the run
is labelled `hermes`.

Recorded per task (JSONL): `pass`, `prompt_tokens` (sum of the full prompt of every model call, incl.
cached prefix, parsed from the engine log's per-call usage lines), `input_tokens` (sum of
`done.usage.input` = uncached input), `output_tokens`, `first_call_prompt` (system + tools + first user
message = harness overhead), `cached_tokens`, `api_calls`, `tool_calls`, `tools`, `wall_s`,
`model_latency_s`, `error`, `timed_out`. Outputs: `eval/results/<stamp>-<harness>.{jsonl,md}`
(small, committed); sandboxes/transcripts in `~/.hermes/cache/scratch/eval-runs/` (passing sandboxes
are deleted).

The engine is launched through `eval/lib/engine_main.py`, which is the unmodified `pico.server.main`
plus thread names in the log format, so per-call usage can be attributed to sessions.

## Tasks (`eval/tasks/<id>/task.yaml`)
```yaml
id: code-offbyone
category: coding            # coding | terminal | memory | everyday | long-context
timeout_s: 240
prompt: "..."               # or  sessions: ["teach…", "use…"]  (each a new chat in the same engine)
isolated: true              # own engine (memory tasks)
memory: [text | {text, target}]   # seeded via POST /api/memory before the first session
check: python3 "$HIDDEN/test.py"  # bash, cwd=sandbox, exit 0 = pass
```
Check env: `SANDBOX`, `TASK_DIR`, `HIDDEN` (tests the agent never sees), `ANSWER` / `ANSWER_n` (final
reply text), `TOOLS_JSON` (tool calls with args), `EVAL_LIB`. Optional `setup.sh` / `gen.py` builds
fixtures (long-context ones are generated so the repo stays small); `solution/` and `solution.sh` are
reference answers used only by `verify_checks.py`.

| category | n | what |
|---|---|---|
| coding | 12 | off-by-one, JS bug, add method, refactor-keep-green, CLI flag, .env parser, type hints, TS from doc comment, debug from traceback, multi-file feature, rename across files, write tests that kill 5 mutants |
| terminal | 5 | biggest file (hidden dirs), fix a broken bash script, JSON-log report, git revert + branch + commit, Makefile targets |
| memory | 5 | codename recall, tabs preference, metric-units preference (all 2 sessions), humanizer skill must be loaded, no irrelevant memory dump |
| everyday | 5 | exactly-5-bullet summary, action items → JSON, CSV → sorted markdown table, <120-word email reply with required facts, constrained week schedule |
| long-context | 3 | needle in ~30K tokens of docs (with a decoy), trace a bug through ~25 generated modules, find 4 calls across 30 transcript files (with decoy codes) |

All checks are deterministic code, with no LLM judge. Writing tasks check required facts, length, format and banned
AI-isms. `verify_checks.py` confirms each check fails on the untouched fixture and passes on the reference
solution (`eval/results/check-discrimination.json`).

## Context-length experiment
`eval/context_curve.py` runs 8 coding tasks with 0/2K/4K/8K/16K/32K tokens of neutral filler prepended to
the first user message (so it's in every call's prompt, like extra system-prompt bulk). `--mode agents_md`
writes an AGENTS.md instead, but Pico passes `skip_context_files=True` so that mode is inert today.
Results: `eval/results/context-curve.md`.
