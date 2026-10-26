# pico (terminal)

```
 /\_/\   pico — the terminal app
( o.o )  talks only to the Pico engine (HTTP + SSE, docs/API.md)
 > ^ <
```

TypeScript and Bun, compiled to one binary. **No runtime dependencies.** It ships its own ANSI renderer,
key parser, SSE parser and markdown renderer.

## Use

```
pico                          a NEW chat every time (starts the engine if it's down; first-time setup if needed)
pico --yolo                   new chat with /yolo on (red badge right away)
pico --model gpt-5.5          switch model before the first turn        (flags combine)
pico --effort low|med|high    effort for this launch (default: /model → default effort)
pico --verbose quiet|normal|verbose|full   or reasoning=preview tools=full summary=off
pico --cwd ~/code/app         work in another directory
pico --plan "task"            plan first; enter go to run it
pico --goal "text"            start with a goal pinned above the input
pico --loop 10m "prompt"      start a loop (5m · 1h · until-done)
pico --harness lean|hermes    agent harness for this launch
pico -c | -r [id]             resume the last chat / a chat (picker without an id)
pico --setup | --login        choose a model (ChatGPT · any API · local) / sign in with ChatGPT
pico -p "prompt"              print one answer to stdout (exit 0 ok · 1 engine error · 2 unreachable · 3 not set up · 130 ^C)
pico -p - < prompt.txt        prompt from stdin;  cat log | pico -p "explain"  appends piped input
pico --json -p "…"            one JSON event per line (delta/tool_start/tool_end/todo/approval/done/error)
pico sessions [--json]        list sessions
pico doctor [--json]          health + hardware + model + updates
pico -h                       all of the above, with the cat
```

Env: `PICO_URL` (default `http://127.0.0.1:7878`), `PICO_HOME` (default `~/.pico`, token read from `$PICO_HOME/token`),
`PICO_TOKEN` (overrides the token file), `PICO_ENGINE_CMD` (how to start the engine, e.g. `python -m pico.server`;
if unset, uses `pico-engine` on PATH), `NO_COLOR`.

### Keys

| key | action |
|---|---|
| enter | send. **While a reply streams: steer it** — your text shows as a dim `↳ steer: …` in the turn and turns accent with ✓ when the engine applies it (if no turn is running any more it's queued `↳ queued` and sent next) |
| alt/option+enter · leading `!` | while busy: stop the turn and send this as a new message |
| tab · → | complete: slash commands (+ aliases, skills) with dim ghost text, then arguments (`/model <id>`, `/theme`, `/cron rm <id>`, `/loop 5m`, `/resume <id>`, `/effort`, `/verbose`), and `@path` relative to the session cwd. Tab again cycles; a dim candidate row shows when there are several |
| shift+enter · ctrl+j · `\`+enter | newline |
| shift+tab | cycle effort low → med → high (→ max if the engine advertises it). The input rule under the cat changes color. Only this chat; `/model` sets the default for new chats |
| esc | stop the turn (a loop turn: just that turn) · close the palette · dismiss a waiting plan |
| ctrl+p | next model |
| enter / e (plan waiting) | go / edit the plan |
| ctrl+c | stop the running turn, or clear the input; press again within 1.5 s to quit (the cat waves bye) |
| ctrl+d (empty input) | quit |
| ctrl+o | expand / collapse diffs, thinking and subagent summaries of the last turn · with a goal pinned: the goal checklist |
| ctrl+l | redraw everything from state (same as `/redraw`; also automatic, debounced, on resize) |
| ↑ / ↓ | history (or move between lines when the input is multiline) |
| `/` | command palette, fuzzy (`/thm` → `/theme`, matched letters lit). tab completes, enter runs |
| `@path` | tab-complete files and dirs. The file is attached on send (≤256 KB) |
| `?` (empty input) | keys cheat-sheet |
| y / n / a | approval prompt: allow / deny / always allow |
| ctrl+a/e/u/k/w, alt+b/f, ctrl+←/→ | line editing |

### Commands

| command | |
|---|---|
| `/model [id]` | rounded picker grouped by provider (`● name   ctx 128k   51 tok/s`, `~` = estimate, `—` = unknown), status line previews the highlighted model; a `default effort ‹ ● med ›` row (←→) sets what new chats start at. `/model <id>` switches directly (tab completes ids) |
| `/setup` (`/login`) | one small box: ChatGPT subscription (device-code login, opens the browser) · Any API (base URL with presets — openai, openrouter, anthropic, groq, together, deepseek, ollama, lmstudio — masked key, model picker, test call `✓ connected · 51 tok/s`) · Local model (hardware scan). The key is never shown after typing |
| `/new` `/sessions` `/resume [id]` | fresh chat, list / reopen chats |
| `/goal <goal>` · `/goal` · `/goal clear` | pins `◎ goal  ship the installer  ▰▰▰▱▱ 3/5` above the cat; bare `/goal` (or ctrl+o) opens the checklist box; when reached the cat celebrates once and the banner turns green, then fades |
| `/plan <task>` · `/plan! <task>` | a live checklist card in the turn (`○ pending` · spinner `active` · `✓ done`); `/plan` waits with `enter go · e edit · esc cancel`, `/plan!` plans then runs |
| `/loop 5m <prompt>` · `/loop until-done <prompt>` · `/loop stop` | engine repeats a prompt in this chat; status line shows `↻ loop 3/20 · next 4:12`; loop turns appear with a dim `↻ loop #3` header |
| `/cron` · `/cron add …` | bare: a box of scheduled jobs (`● title  every weekday 8:00  next in 3h  last ✓`; n new · enter run now · space pause · d delete). Text forms go to the engine |
| `/inbox` | results from scheduled jobs (they also arrive as `✉ title: first line` with a `✉ N` badge until viewed); enter opens the job's chat |
| usage line | one dim line under the status bar: `session 12k in · 1.1k out · cached 82%   today 212k · 31 turns   30d 1.4M ▁▃▅▇` (session = summed `done.usage` this chat; today/30d from `/api/usage`, refreshed after each turn). Under 70 cols: `session 12k · today 212k`. ChatGPT-subscription models show `ChatGPT plan`; if the engine sends `usage.limits` it shows `session ▰▰▱▱▱▱ 34% · resets 5pm`. No `$` unless the engine sends a cost. Toggle in /settings → Config |
| status line | `model · ● med · ▰▰▱▱▱▱▱┊▱▱ 38k/128k cached 92% · you ▰▰▰▱ 210 · 51 tok/s` — context uses `max_effective` when sent, `┊` marks the auto-compaction threshold; `you ▰▰▰▱` is the standing profile vs its budget (amber > 90%, hidden < 70 cols). Auto-compaction flashes `↺ compacted 92k→18k` and leaves `↺ auto-compacted (kept last 6)` in the turn |
| reply style | default **band**: your message sits on a subtle full-width band (`#24242b` / 256-color 236) with an accent `›`; replies open with `(^.^) pico` (face = final mood). `label`, `bar` (▌) and `plain` in /theme. ASCII / NO_COLOR fall back to `> ` and `pico:` |
| `/usage` | card: today and 30 days (turns, tokens in/out, cache hit %, time), a 30-day sparkline, per-model tok/s |
| `/compact` | summarize context |
| `/lean` | slim your profile and show the A/B speedup |
| `/yolo [on\|off]` | this chat runs gated commands without asking. A red `yolo` badge sits in the status line (it flips immediately and survives `/resume`), the resting cat goes `( ¬.¬ )`, and each auto-approved command gets a dim `→ auto-approved` line under it in the tool tree. Global default: config `approvals: "yolo"` |
| `/undo` | roll back the last turn (restores changed files) and remove it from the screen |
| `/agents` (`/subagents`) | subagent settings: on/off, parallel, model, effort, time budget |
| `/settings` (`/status`, `/config`) | **one tabbed panel**: `Status  Config  Usage  Look & feel`. ←→ / tab switch tabs (or 1–4), ↑↓ move, enter / space / + − change, esc closes. Every change saves immediately with a brief ✓. **Status**: version, engine URL + health, model + provider, harness, approvals/yolo, ChatGPT login, cwd, session, context, and the standing prompt breakdown (profile, skills index, AGENTS.md, total; `/lean` to slim it). **Config** (PATCH `/api/config`): default effort, approvals ask/yolo, harness lean/hermes, subagents on + max helpers, **compaction** (auto, compact at 50–95%, keep recent 2–20, summary/trim, notify), plus usage line / reasoning / tool detail / summary (tui.json). **Usage**: today / 7 days / 30 days bars (tokens in/out, cache %, turns, time), 30-day sparkline, per-model tok/s, per-harness split, plan-limit bars when the engine sends them |
| `/theme` | opens **Look & feel**: accent (hotpink, mint, cyan, lavender, amber, white), spinner, **reply style** (band · label · bar · plain) and verbosity, with a live preview; saved to `$PICO_HOME/tui.json`. `PICO_ACCENT` / `PICO_SPINNER` / `PICO_VERBOSE` override per run |
| `/verbose [level]` | reasoning `hidden` · `timer` (default) · `preview` (last thought line) · `full` (streams, folds when the answer starts); tools `quiet` (one line: `read 2 · edit 1 · ran 3`) · `normal` · `full` (20-line tails + diffs); summary `on`/`off`. Presets: quiet · normal · verbose · full, or `reasoning=preview tools=full`. ctrl+o still expands anything |
| `/copy` | copy the last reply (OSC 52 + pbcopy / clip / wl-copy); a `✓ copied` toast shows in the status line |
| `/memory` `/skills` `/search <q>` `/connect` `/update` | memory, skills, search, connectors, model/config updates (`/update` shows deltas and asks before applying) |
| `/effort` `/clear` `/redraw` `/help` `/quit` | |

Skills from the engine appear in the palette and `/help` after the built-ins.

## What you see

```
› fix the off-by-one in calc.py                        your message (accent ›)

  ✻ thought 2.1s  ctrl+o                               live: shimmering "thinking" + timer
  ┬ 3 steps                                            tools as a tree, ✓/✗ + seconds
  ├─ ✓ read calc.py  0.1s
  ├─ ✓ edit calc.py  0.0s
  │  ✎ calc.py  +1 −1  (ctrl+o to see)                 edits collapse to a summary
  └─ ✓ python3 -m pytest -q  0.4s                      running: spinner + ≤4-line live tail (╰ …)
     → auto-approved                                   /yolo (or ✓ allowed / ✗ denied after a prompt)

  The reply, as markdown: headings, lists, aligned tables, code boxes, links.

  (^.^)✧ done in 4.1s · 3 tools · 1 file +1 −1 · 51 tok/s       cat sign-off
                                                   /\_/\
                                                  ( o.o )      the cat perches on the input rule
──────────────────────────────────────────────── > ^ < ─── ● med ─   rule color = effort
› ask anything · / for commands · @ to attach
deepseek-v4.1-flash · ● med · yolo · ▰▱▱▱▱▱▱▱▱▱ 9k/1024k cached 92% · 51 tok/s
```

Cat moods: idle `o.o` (blinks now and then), watching you type `•.•`, thinking `o.O ?`, working `>.< ~`,
done `^.^ ✧` (1.5 s), error `x.x !`, asleep `-.- zZ` (60 s idle), yolo `¬.¬`. On exit:
`(^.^)ﾉ bye for now · resume with pico -r <id>`.

Approval prompt: a small box `╭─ run this? ─╮` with the command, the reason, and `y allow · n deny · a always`.

Context pills `▰▱`: accent < 80 % · amber 80–95 % · red > 95 %. "run /compact" shows past 85 %, and a
`↺ compacted 92k→18k` pulse plays on compaction. The fill eases toward new values. `tok/s` is output tokens
over model time (tool time excluded).

Env: `PICO_ASCII=1` forces ASCII glyphs (auto on non-UTF-8 locales / legacy Windows console);
`COLORTERM=truecolor` enables 24-bit color (otherwise 256).

## Design notes

- **Inline renderer, not alt-screen.** Finished output is written once into the terminal's normal
  scrollback, so native scroll, select and copy keep working. Only the live region is redrawn in place,
  wrapped in synchronized-update escapes (`?2026`): the streaming reply, todo panel, approval box, input
  and status bar. Only changed rows are rewritten (a spinner tick is ~200 bytes). Long streaming replies
  flow into scrollback as they grow. All finished items are kept as state, so `/redraw`, resize, `/undo`
  and ctrl+o re-flow the whole conversation at the current width.
- **Input:** bracketed paste (including pastes split across chunks), kitty `CSI u` and xterm
  `modifyOtherKeys` for real Shift+Enter, legacy fallbacks, and Windows conhost `\b` backspace. Unbracketed
  multi-line pastes are detected heuristically.
- **Windows:** no Unix-only APIs. VT output works in Windows Terminal and Windows 10+ conhost. Resize is
  polled because conhost doesn't reliably emit resize events. The engine is spawned with `shell: true` and
  `windowsHide`.
- **Non-interactive approvals are always denied** (`pico -p` never auto-runs a gated command), and a
  note is printed to stderr.

## Develop

```
bun install                  # dev deps only (typescript, @types/bun)
bun test                     # unit tests + integration tests against the mock engine
bun run typecheck
bun run mock                 # mock engine on :7979 (add --setup for the wizard flow, --fast)
PICO_URL=http://127.0.0.1:7979 PICO_TOKEN=test-token bun src/main.ts
uv run --with pyte test/drive.py chat|polish|blocks|picks|feel|theme|agents-settings|wizard|effort|stop [--split]
                             # drive the real binary in a pty against the mock; frames (.txt + raw .ansi) in test/frames/
sh test/frames/settings/run.sh   # settings tabs, usage line @120/60, compaction, reply-* styles (fresh mock each)
uv run --with pyte test/drive.py steer|tab|model|cron|loop|usage|goal|plan|setup-api|setup-errors|setup-login|verbosity-quiet|… --out test/frames/features
uv run --with pyte test/drive.py launch-flags --name launch-yolo "--args=--yolo|--model|gpt-5.5"   # extra CLI args, | separated
uv run --with pyte test/drive.py live-code --cwd /tmp/pico-polish --url http://127.0.0.1:7878
                             # same, against the real engine (live-code: fix a bug + run tests; live-yolo)
```

Mock prompt keywords: `tool`, `todo`, `approve`, `think`, `error`, `long`, `say hi`, `agents`, `remember`, `compact`,
`half` / `fill` (context to ~62 % / ~90 %), `new file`, `slow`, `/yolo` (then `approve` auto-approves). The mock also serves undo, checkpoints and `/api/events`.

## Build

```
bun run build                                  # dist/pico for this machine
bun run build:all                              # every target below
bun scripts/build-all.ts linux-x64 windows-x64 # a subset
```

Targets: `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64` (`.exe`).
Each one is a single file. Size is dominated by the embedded Bun runtime (~60 MB on macOS arm64,
~97 MB linux-x64, ~112 MB windows-x64). The app code itself is about 66 KB minified.
