# Lean harness (default)

Pico runs Hermes' `AIAgent` with one of two harnesses (`config.json` `harness`, or per message for A/B tests):

| | hermes (stock) | lean (default) |
|---|---|---|
| system prompt | Hermes identity + guidance + full skills index + memory dump | `STABLE_PROMPT` (~430 tok, never changes) + dynamic block |
| tools sent | 15 full Hermes schemas (~6.4K tok incl. delegate_task) | 11 short schemas (~1.1K tok) |
| memory | MEMORY.md/USER.md injected whole; `memory` tool writes | ~300 tok core notes injected; `recall` searches the rest; `remember` for explicit requests; post-turn pass learns the rest |
| skills | index + `skill_view`/`skills_list`/`skill_manage` | index (≤10 words each) + `skill`; post-turn pass may draft a skill |
| web, session search, process, subagents, MCP | direct schemas / Hermes tool_search | one-line index under "More tools", called via Hermes' `tool_call`/`tool_describe` bridge (`tool_search` only when >16 extra tools) |
| AGENTS.md / CLAUDE.md / .cursorrules | skipped | first one found in the session cwd, trimmed to ~1.5K tok |

Everything is in-process from `engine/pico/lean.py`; nothing under the Hermes checkout or `~/.hermes` is modified.

## Prompt layout (prefix-cache friendly)
1. `STABLE_PROMPT`: byte-identical across turns, sessions and machines (a test hashes it).
2. Dynamic block, most stable first: computer line, skills index, More-tools index, core memory, project file,
   `Working directory`, `Today` (day granularity). The agent is rebuilt when the date, cwd, skills or memory change.

## Tools
- Always on: `terminal, read_file, write_file, patch, search_files, todo_list` (Hermes handlers, Hermes parameter
  names, shorter descriptions) + Pico's `skill(name, file_path?)`, `recall(query)`, `remember(text, target?)`.
- Deferred: whatever else is enabled (web_search, web_extract, session_search, process_manage, delegate_task, MCP).
  Lean widens Hermes' `tools.tool_search.defer` set only while a lean agent is built or running (ContextVar), so the
  stock harness is untouched.

## Memory pass (off the hot path)
After `done` is queued, `Engine._memory_pass` makes one small call on the same model (thinking off, ≤400 output tok)
with the exchange + the relevant saved notes and gets JSON `{add, update, remove, skill}`. It's applied with Hermes'
`MemoryStore` (file locks, threat scan, `§` format) and `skill_manage(create)`, so Hermes' formats stay compatible.
Lean uses roomier memory limits (8K/4K chars) because only the core subset is injected.

## Results (deepseek-v4.1-flash on a DGX Spark, 2026-10-25)
| | hermes | lean |
|---|---|---|
| "hi" turn, request size (fake-server capture, chars/4) | ~7,890 (sys 1,441 + 15 tools 6,403) | ~1,720 (stable 429 + dynamic 159 + 11 tools 1,104) |
| 3 skills + 40 memory notes | ~9,470 | ~2,100 (dynamic 532) |
| "hi" live, prompt tokens reported by the endpoint | 9,123 | 2,048 |
| eval suite, 30 tasks x2 (`eval/compare.py`) | 60/60, median prompt 57,944 tok/task, 43.5 s | 60/60, median 16,426 tok/task (-72%), 28.6 s (-34%) |

## Measure
`~/.hermes/cache/scratch/bloat/measure_lean.py simple|loaded lean|hermes` captures the exact request body from a
fake OpenAI server and prints the per-part breakdown.
