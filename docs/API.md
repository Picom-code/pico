# Pico engine API (v1)

Base: `http://127.0.0.1:7878` (configurable `PICO_PORT`). Auth: `Authorization: Bearer <token>` where token is in
`~/.pico/token` (created on first engine start, chmod 600). `/api/health` needs no auth. Static web app served at `/`.
Remote (phone) clients use the same token, obtained via pairing.

All JSON. Streaming endpoints are SSE (`text/event-stream`), each event `event: <type>\ndata: <json>\n\n`.

## Core
- `GET /api/health` → `{ok, version, state: "setup"|"ready"|"starting_model"|"error", model, provider}`
- `GET /api/system` → hardware scan:
  `{os, arch, cpu:{name,cores}, ram_gb, gpus:[{vendor,name,vram_gb,driver,compute}], unified_memory:bool,
    disk_free_gb, accelerators:["cuda"|"metal"|"rocm"|"vulkan"|"cpu"], runtimes:{llama_cpp, ollama, lmstudio, vllm}}`
- `GET /api/config` / `PATCH /api/config` → `{persona, provider:{kind,...}, model, effort_default, efforts, accent, features:{voice,image,video}}`
  (secrets are never returned; `has_key: true`). `efforts` = what the active model takes: `["low","medium","high"]`,
  plus `"max"` only when the model supports it (ChatGPT/Codex models that advertise it). `effort_default` must be one
  of `low|medium|high|max`; legacy `"off"` is accepted and stored as `"low"` (also when found in an old config).

## Setup / models
- `GET /api/recipes?persona=engineer|business|creative|marketing|student|general` →
  `{recommended: Recipe, alternatives: [Recipe], catalog_version}`
  `Recipe = {id, model, family, params_b, active_b, quant, file_gb, ctx, runtime, flags, est_tps, tps_source:"measured"|"est",
             strengths:["coding","speed","writing","creative","vision"], fits:true, why:"one line"}`
- `GET /api/updates` → `{available:[{kind:"model"|"config", from, to, delta:{tps:+12, ctx:+32768, quality:"+3 SWE-bench"}, why}]}`
- `POST /api/updates/apply {kind:"model"|"config", to}` → `{job_id}` (progress via /api/jobs/{id}/events). Only on explicit user action.
- `POST /api/setup` body `{persona, provider:{kind:"local", recipe_id} | {kind:"openai_login"} | {kind:"custom", base_url, api_key, model},
   features:{voice,image,video}}` → `{job_id}`
- `GET /api/jobs/{id}/events` (SSE) → `progress {step, label, pct, bytes, total}` … `done {ok}` / `error {message}`
- `GET /api/models` → `{active, models:[{id, name, provider, local:bool, ctx, tps}]}`
- `POST /api/models/active` `{id}` → `{ok}`
- `POST /api/auth/openai/start` → `{url, code}` (device-code style login); `GET /api/auth/openai/status` → `{state}`

## Sessions (chats stored locally in ~/.pico/pico.db)
- `GET /api/sessions` → `[{id, title, updated, pinned, goal, preview}]`
- `POST /api/sessions` `{title?, cwd?}` → session (not persisted until first message)
- `GET /api/sessions/{id}` → `{id, title, goal, todos:[{text,done}], cwd, messages:[Message]}`
  `Message = {id, role:"user"|"assistant"|"tool", content, reasoning?, tool?:{name,args,result,ok}, created, usage?}`
- `PATCH /api/sessions/{id}` `{title?, pinned?, goal?}` ; `DELETE /api/sessions/{id}`
- `POST /api/sessions/{id}/messages` `{text, effort?:"low"|"medium"|"high"|"max", attachments?:[{name,mime,data_b64}]}` → SSE
  (legacy `effort:"off"` → treated as `"low"`; reasoning is always streamed as `reasoning` events whatever the effort —
  clients decide how much to show):
  - `delta {text}` assistant text chunk
  - `reasoning {text}` thinking chunk
  - `tool_start {id, name, args}` / `tool_end {id, name, ok, result_preview}`
  - `todo {todos}` checklist changed
  - `approval {id, command, reason}` — client answers via `POST /api/sessions/{id}/approve {id, allow:bool, always?:bool}`
  - `done {message_id, usage:{input,output}, tps, seconds}`
  - `error {message}`
- `POST /api/sessions/{id}/stop`
- Slash commands are plain text: `/goal X`, `/plan X`, `/compact`, `/skill-name args` are handled by the engine.
- `GET /api/search?q=` → past-chat search hits `[{session_id, title, snippet}]`

## Memory / skills / connections
- `GET /api/memory` → `[{id, text}]`; `POST /api/memory {text}`; `DELETE /api/memory/{id}`
- `GET /api/skills` → `[{name, description, category, enabled, builtin}]`; `GET /api/skills/{name}` → `{…, body}`;
  `PUT /api/skills/{name} {description, body}`; `DELETE /api/skills/{name}`; `POST /api/skills/{name}/toggle`
- `GET /api/connectors` → catalog `[{id, name, what:"one plain sentence", kind:"mcp"|"oauth"|"key", connected, setup:{fields|oauth_url}}]`
- `POST /api/connectors/{id}/connect {fields}` ; `DELETE /api/connectors/{id}`

## Background replies
- `GET /api/checkins` / `POST /api/checkins {title, prompt, schedule:{time:"07:30", days:["mon",…]}}` / `DELETE /api/checkins/{id}`
- `GET /api/inbox` → `[{id, title, body, session_id, created, read}]`
- `GET /api/events` (SSE, long-lived) → `inbox {item}`, `job {…}`, `model {state}` — clients use this for notifications.

## Pairing (phone)
- `POST /api/pair` → `{code, url, expires, qr}` where `qr` is an SVG string encoding `pico://pair?u=<url>&c=<code>`
- `POST /api/pair/claim {code, device_name}` (no auth) → `{token}`

## Engine additions (v1, additive — existing clients unaffected)
- Auth also accepts `?token=` (EventSource can't set headers). Paired-device tokens work everywhere.
- `done` may carry `stopped:bool`, `goal` (after `/goal`), `compacted:int` (after `/compact`). `approval` adds `allow_always`.
- `POST /api/sessions/{id}/messages` → `409 {error}` when no provider is configured or the chat is already answering.
- Harness: config `harness: "lean"|"hermes"` (default `"lean"`; `PATCH /api/config {harness}`, 400 on other values).
  `POST /api/sessions/{id}/messages` accepts `harness` to override it for one turn (A/B evals). `done` carries
  `harness`. See docs/LEAN.md.
- Messages may carry `kind: "command"|"compact"`. `/goal clear` clears the goal.
- `POST /api/memory {text, target?:"memory"|"user"}`; items include `target`.
- Connectors include `available:bool, missing:[binary]` (e.g. needs `npx`).
- `POST /api/pair` also returns `payload` (the QR text) and `note` (set when the engine only listens on 127.0.0.1).
- `POST /api/checkins/{id}/run` (run now), `POST /api/inbox/{id}/read`, `GET /api/devices`, `DELETE /api/devices/{id}`.

## Rich turn events, checkpoints, subagents (v1, additive)
All new fields are optional extras on existing events; old clients can ignore them.

**Turn stream** (`POST /api/sessions/{id}/messages`):
- `tool_start {id, name, args, label}` — `label` is short human text: ``terminal `npm test` ``, `edit src/app.ts`,
  `write notes.md`, `read README.md`, `search "TODO"`, `delegate 2 subagents`, `memory add`, …
- `tool_progress {id, tail:[≤6 lines]}` — live output of a running terminal command, only after it has run 1.5 s,
  at most 4/s. (Comes from Hermes' terminal output stream; other tools don't emit it.)
- `tool_end {id, name, ok, result_preview, seconds, diff?, diffs?}` — for file-mutating tools (`write_file`, `patch`):
  `diff = {path (relative to the chat folder when inside it), abs_path, added, removed, unified (≤200 lines),
  created:bool, deleted:bool}`. A V4A multi-file patch also has `diffs:[…]` (all files; `diff` = first).
- `subagent_start {id, goal, model}` / `subagent_progress {id, label, tail?}` (≤2/s per subagent) /
  `subagent_end {id, ok, summary (≤400 chars), seconds, tokens, status}` — children spawned by `delegate_task`.
  The parent's `delegate_task` call stays open (`tool_start` … `tool_end`) until all children finish; the
  subagent events arrive in between.
- `notice {kind:"memory"|"skill", text}` — the agent saved/forgot a memory (`Remembered about you: …`) or created/
  updated a skill (`Skill created: tab-style`). Hooked at Hermes' storage layer, so it also fires for any
  memory/skill write made by tools or post-turn passes. User writes via `POST /api/memory` don't notify.
- `compacted {before, after}` (tokens) — on `/compact` and on Hermes' automatic mid-turn compaction (`auto:true`).
- `done` adds:
  - `usage.last_input` — prompt tokens of the turn's *last* model call (`usage.input` stays the sum over calls).
  - `context {used, max, cached?}` — used = `usage.last_input`; max = the model's context length as Hermes
    detected it (provider `/models` metadata), else provider `context_length` / local recipe `ctx` from config,
    else 128000; `cached` = prompt-cache hit tokens of that call when the endpoint reports them
    (`prompt_tokens_details.cached_tokens` etc.).
  - `summary {tools, files_changed:[{path, added, removed}], seconds, tps, output_tokens}` — `files_changed` is
    net per file for the whole turn (pre-turn image vs now).
  - after `/undo`: `undo {…same as POST /undo…}`; after `/compact`: `context` too.
- `GET /api/sessions/{id}` adds `context {used, max, cached?}` (from the last turn); assistant messages keep their
  `context` and `summary`; tool messages' `tool` gains `label`, `seconds`, `diff`.

**Checkpoints / undo** — before the first change to each file in a turn the engine stores its pre-image (or "did
not exist") under `$PICO_HOME/checkpoints/<session>/<turn_message_id>/` (files ≤2 MB; newest 20 turns per chat kept).
- `GET /api/sessions/{id}/checkpoints` → `[{turn_message_id, created, side_effects:bool, files:[{path, added, removed, created}]}]`
  newest first. `turn_message_id` = the id of that turn's user message. `side_effects` = the turn ran terminal/code
  tools whose effects undo can't reverse.
- `POST /api/sessions/{id}/undo` → `{ok, restored:[abs paths], deleted:[abs paths], turn_message_id, note, side_effects}`.
  Restores the most recent model turn's files byte-for-byte (files it created are deleted) and removes that turn's
  messages (user message + assistant/tool messages) from history, so the model no longer sees them. Repeat to
  step further back. `ok:false, note:"Nothing to undo."` when there is no turn. `409` while the chat is answering.
- Slash `/undo` does the same inside the chat: streams `delta {text: note}` then `done {…, undo}`.

**Subagents** — `GET/PATCH /api/config` gain
`subagents: {enabled:true, max_parallel:3 (1-8), model:null (=main model), effort:"low" (off|low|medium|high),
max_seconds:600 (30-3600)}`. Out-of-range values → `400`. When enabled, Pico sessions get Hermes' `delegate_task`
tool; settings map to `$PICO_HOME/hermes/config.yaml` `delegation.{max_concurrent_children, model, reasoning_effort,
child_timeout_seconds}` (depth 1, no auto-approve; children reuse the main endpoint/key). Children run
synchronously inside the parent turn (Pico has no detached-result delivery).

**Global events** (`GET /api/events`) — also `session {id, title}` (auto titles) and
`notice {session_id, kind, text}` for memory/skill writes that happen outside a live turn (e.g. background passes).


## Steering, models, usage, crons, /loop, goal & plan, easy setup (v1, additive)

### Every `done`
`done` always carries `yolo:bool`, `model` (model id that answered), `harness:"lean"|"hermes"` (slash-command `done`s
too; `harness` may be null for engine-handled commands). New optional extras: `goal_state`, `plan`, `usage_report`
(`/usage`), `crons` (`/cron`), `loop` (`/loop`). `usage` gains `cached` (prompt-cache hit tokens of the turn) when the
endpoint reports them; `usage.input` is per turn and excludes cache reads.

### Steering (talk to a turn while it runs)
- `POST /api/sessions/{id}/steer {text}` →
  - `{ok:true, mode:"steer"}` — a turn is running; the text goes into Hermes' pending-steer slot and the model sees it
    as a user message right after the current tool call(s) / before its next model call. The turn is NOT stopped.
    A foreground terminal command is asked to yield (backgrounded) so the steer isn't parked behind a long command.
  - `{ok:true, mode:"queued"}` — the chat is busy but has no live agent to steer yet (turn just starting / engine
    command); the text runs as the next turn as soon as this one finishes.
  - `409 {error}` — nothing is running: send it as a normal message instead. `400` empty text, `404` unknown session.
- The running turn's stream (and the session stream) emits `steer {text, applied:true}` once the text is actually
  injected into the model's messages.
- If the turn finishes before the model saw it (it was writing its final answer), the engine starts a follow-up turn
  with that text right away: session stream gets `steer {text, applied:false, followup:true}` then a normal turn
  (`turn_start {source:"steer"}` …). Stopping the turn (`/stop`) discards undelivered steers.
- History: the steer is stored as a user message with `steer:true` (`GET /api/sessions/{id}` messages), positioned
  where it was sent. Follow-up turns' user message has `steer:true, followup:true`.

### Session stream (see turns you didn't start)
- `GET /api/sessions/{id}/stream` (SSE, long-lived; `?token=` works) — relays every event of every turn in this
  session, including turns the engine starts itself (`/loop` iterations, steer follow-ups) and turns started by other
  clients. First event `hello {session_id, busy, loop, goal_state}`; each turn begins with
  `turn_start {session_id, source:"chat"|"loop"|"steer"|"cron", text, loop?:{n}}` followed by the usual turn events
  (`delta`, `reasoning`, `tool_*`, `todo`, `plan`, `goal`, `steer`, `approval`, `done`/`error`); also `loop {…}`.
  `done.final` is omitted. Approvals seen here can be answered with `POST /approve` as usual.
  (Cron jobs run in their own fresh session; watch `/api/events` `inbox` for them.)

### Models
- `GET /api/models` → `{active, provider, models:[{id, name, provider:"custom"|"openai_login"|"local", local, ctx,
  tps, tps_measured, last_used, provider_label, active:bool}]}`
  - `ctx` = context length from the endpoint's `/v1/models` (`max_model_len`/`context_length`) or the local recipe.
  - `tps_measured` = median output tok/s of the last 20 turns on that model (null if none); `last_used` = epoch secs.
  - `provider_label` = e.g. `"OpenRouter"`, `"my-gpu-box"` (host), `"localhost:11434"`, `"ChatGPT"`, `"This computer"`.
  - Lists: the custom endpoint's models (also after switching away from it), ChatGPT/Codex models whenever the ChatGPT
    login exists, and installed local recipes.
- `POST /api/models/active {id, provider?:"custom"|"openai_login"|"local"}` → `{ok, id, provider}`. Takes effect on the
  NEXT turn of every session (cached agents are dropped; running turns finish on the old model). `provider` is
  inferred when omitted (local recipe → local; listed by the custom endpoint → custom; Codex model + logged in →
  openai_login). `409` for ChatGPT models without a login, a local recipe that isn't downloaded, or custom without an
  endpoint; `404` unknown recipe. The custom endpoint is remembered (config `custom`) so you can switch back.
- Per-chat model: `POST /api/sessions {model}` / `PATCH /api/sessions/{id} {model}` (same endpoint, other model id;
  `null` = follow the global model).

### Usage
- Every finished model turn is recorded `(session_id, model, harness, input, output, cached, seconds, tools, tps)`.
  Turns from before this version are backfilled once from stored message metadata.
- `GET /api/usage?days=30` (1-366) →
  `{days_requested, totals:{turns,input,output,cached,seconds,tools}, cache_hit_pct (cached/(input+cached)·100, null if
  none), days:[{date:"YYYY-MM-DD", turns, input, output, cached}] (every day in range, oldest first, zero-filled),
  by_model:[{model, turns, input, output, cached, seconds, tools, tps}], by_harness:[{harness, …same}],
  today:{date, turns, input, output, cached, seconds, tools}}` (`tps` = median of the last 20 measured turns).
- Slash `/usage [N]` → short text summary as `delta`, and `done.usage_report` = the same JSON (N days, default 30).

### Crons (check-ins, extended — old fields and `{time, days}` keep working)
- `POST /api/checkins {title?, prompt, schedule, yolo?:bool}` where `schedule` is one of
  - `{time:"07:30", days:["mon",…|"weekdays"|"weekends"|"daily"]}` (stored exactly as before)
  - `{every:"30m"|"2h"|"1d"}` (min 1m; stored `{every, every_s}`; anchored on the last run)
  - `{cron:"0 8 * * 1-5"}` (5 fields, local time, names like `mon`/`jan` ok)
  - `{text:"every weekday at 8am"}` — parsed deterministically (`every 30m`, `hourly`, `every other hour`,
    `daily at 7:30`, `weekdays 8:30`, `mon and fri at 9:15`, `weekends at noon`, `every morning`, a raw cron line, …);
    otherwise the model is asked once for a cron line, which is validated. Phrases cron can't express exactly
    (`first monday of the month`, `every other tuesday`) → `400` with a suggestion, never an approximation.
    The parsed form is stored with the original `text`.
  `400 {error}` with a plain message when it can't be understood.
- Items: `{id, title, prompt, schedule, enabled, created, last_run, next_run, yolo, schedule_text (human, e.g.
  "every weekday at 08:00", "every 30m"), last_status:null|"running"|"ok"|"error", session_id (session of the last run)}`.
- `PATCH /api/checkins/{id} {enabled?, prompt?, title?, schedule?, yolo?}` → item (`400` bad schedule, `404`).
- `POST /api/checkins/{id}/run` → `{ok}` (false if it's already running). Runs are headless in a fresh session:
  approvals are denied unless the job has `yolo:true`. Result → inbox + `/api/events` `inbox {item, checkin_id}`.
- Slash `/cron` (reply is short text; `done.crons` = full item list):
  `/cron` (list, numbered) · `/cron add <when> -- <prompt>` · `/cron every 30m check X` (schedule = longest leading
  phrase that parses) · `/cron rm <id|n>` · `/cron pause|resume <id|n>` · `/cron run <id|n>`.

### /loop (re-run a prompt in this chat)
- `/loop <interval> <prompt>` — interval `30s`(min)…`5m`/`1h`/`every 2h`; omitted → 10m. Optional `--times N`
  (default max_runs 20). `/loop until-done <prompt>` — re-runs immediately after each turn until the reply has a line
  `LOOP_DONE` (the engine tells the model so) or 10 runs. `/loop` → status text; `/loop stop`.
  The first iteration starts right after the command. `done.loop` = status.
- Each iteration is a normal turn in the session: user message carries `loop:{n}` (shown in `GET /api/sessions/{id}`),
  visible live on `GET /api/sessions/{id}/stream`. An iteration is skipped (not counted) while another turn is running.
  Loops live in engine memory (stop when the engine restarts or the chat is deleted).
- `GET /api/sessions/{id}/loop` → `{active, prompt, every_s (0 for until-done), until_done, runs, max_runs, next_at
  (epoch secs while waiting, else null), state:"running"|"waiting"|"stopped"|"done"}`; `DELETE` → `{ok, stopped, …status}`.
- `/api/events` (and the session stream) → `loop {session_id, n, next_at, state, runs, max_runs}` on every transition.

### Goal (structured)
- `goal {text, status:"active"|"done"|"cleared", progress:{done,total}|null, todos:[{text,done}]}` is emitted on
  `/goal X` (set; the todo list is reset), `/goal clear`, `/goal done`, and after every turn of a chat with an active
  goal. Progress comes from the chat's todo list (the model is told to keep one for the goal). When the model says
  the goal is met it ends with a `GOAL_DONE` line → status `done` (and the goal stops being injected).
- `GET /api/sessions/{id}` → `goal_state` (same shape; `{text:null, status:"cleared", progress:null, todos:[]}` when
  unset). `PATCH /api/sessions/{id} {goal}` sets/clears it too. `done` after `/goal` has `goal_state`.

### Plan (structured)
- `/plan <task>` — the model records the plan with the todo tool first and doesn't act; the turn ends with the plan
  and a question. Events: `plan {title, phase, steps:[{text, status:"pending"|"active"|"done"}]}` — at the start
  (`phase:"planning"`, steps `[]`), on every todo change, and at the end (`phase:"awaiting"`; also `done.plan`).
  If the model wrote a numbered list instead of using the tool, steps are parsed from the text.
- Next user message `go`/`yes`/`ok`/`proceed`/`do it`/… (alone) executes it: `plan {phase:"executing"}` … step status
  updates … `plan {phase:"done"}`. Any other message revises the plan (`phase` back to `planning`); another slash
  command abandons it.
- `/plan! <task>` — plan then execute in one turn (`phase:"executing"` → `"done"`).

### Easy model setup
- `GET /api/provider/presets` → `[{id, name, base_url, needs_key, note}]` for `openai`, `openrouter`, `groq`,
  `together`, `deepseek`, `anthropic` (OpenAI-compatible endpoint), `ollama` (`http://localhost:11434/v1`, no key),
  `lmstudio` (`http://localhost:1234/v1`, no key), `custom` (empty base_url).
- `POST /api/provider/test {kind:"custom", base_url, api_key?, model?}` → `{ok, models:[ids], model_used, tps,
  latency_s, error?:{kind:"auth"|"not_found"|"timeout"|"network"|"other", message}}`. Lists `/v1/models` (endpoints
  without it are tolerated when `model` is given), then runs an 8-token completion with `model` (or the first chat
  model listed). The key is never stored or echoed; omitted `api_key` for the already-saved endpoint reuses the saved
  key. Always HTTP 200 for a completed test (`ok:false` + `error`); `400` for a missing base_url / other kinds.
- `POST /api/setup` — fast paths, no downloads: `{provider:{kind:"custom", base_url, api_key?, model}}` and
  `{provider:{kind:"openai_login", model?}, model?}` (model defaults to the first Codex model). `persona` is optional
  (first setup defaults to `"engineer"`). Job emits `done {ok}` within a second or two; `error {message}` if the
  ChatGPT login is missing.
- New chats with settings in one call: `POST /api/sessions {title?, cwd?, yolo?:bool, model?, effort?, harness?}` →
  the session (`yolo`, `model`, `effort`, `harness` echoed; also in `GET /api/sessions/{id}`). `PATCH` accepts the same
  keys (`yolo`, `model`, `effort`, `harness`). `400` for a bad effort/harness.

### ChatGPT (subscription) login
- `POST /api/auth/openai/start` → `{url, code}` (Hermes' Codex device-code flow; open `url`, enter `code`).
- `GET /api/auth/openai/status` → `{state:"idle"|"pending"|"done"|"error", url, code, logged_in:bool, error?}`
  (`error` = plain message, also as `message`; an expired code → `error`). `done` also when creds already exist.
- Credentials are stored only in `$PICO_HOME/hermes/auth.json` — Pico never reads or writes `~/.hermes/auth.json`
  and never adopts the Codex CLI's `~/.codex` login. After `done`: `GET /api/models` lists the Codex models, and
  `POST /api/setup {provider:{kind:"openai_login"}}` or `POST /api/models/active {id, provider:"openai_login"}`
  switches to it.

## Profile context size & auto-compaction (v1, additive)

### Profile context
`GET /api/profile/context[?harness=lean|hermes][&session_id=…]` → what the user's standing context costs per turn:
```
{harness, tokens, budget, notes, notes_recall_only, user_notes, memory_notes,
 skills_index_tokens, agents_md_tokens, total_standing_tokens, estimate:true, tokenizer:"chars/4"}
```
- `lean`: `tokens` = the "What you know about the user" block exactly as lean injects it (core subset of USER.md +
  MEMORY.md, user notes first); `budget` = the core-memory budget (1200 chars ≈ 300 tokens); `notes` = injected notes,
  `notes_recall_only` = saved notes left to `recall`. `agents_md_tokens` = the project file (AGENTS.md/CLAUDE.md/
  .cursorrules) for the session's `cwd` (0 without `session_id`/cwd).
- `hermes`: `tokens` = Hermes' full MEMORY + USER PROFILE blocks; `budget` = Hermes' `memory_char_limit +
  user_char_limit` ÷ 4; `agents_md_tokens` is 0 (Pico runs Hermes with `skip_context_files`).
- Harness defaults to the session's harness (with `session_id`), else config `harness`.
- `estimate:true` always for now: no tokenizer ships with the engine, counts are chars/4.
- Every model-turn `done` carries `profile {tokens, budget, estimate}` (for the turn's harness), and memory
  `notice {kind:"memory"}` events carry the refreshed `profile` too.

### Auto-compaction
`GET/PATCH /api/config` gain
`compaction: {auto:true, at_pct:80 (50-95), keep_recent:6 (2-20), mode:"summary"|"trim", notify:true,
max_ctx_override:null | int (1000-2000000)}`. Partial patches merge; bad values / unknown fields → `400`.
- Before each model turn: if the chat's last `context.used ≥ at_pct% of context.max_effective`, the engine compacts the
  older history, then emits `compacted {before, after, auto:true, reason:"threshold", method, kept, at_pct,
  max_effective}` (and `notice {kind:"compact", text}` when `notify`) on the turn stream *before* the turn's own events.
  - `keep_recent` = newest model-visible messages kept verbatim (tool calls/results count; the cut snaps back to a
    user message so tool pairs never split).
  - `mode:"summary"`: older messages → one model summary (same prompt as `/compact`, plus the active goal verbatim and
    open todo steps). `mode:"trim"`: older tool outputs (>240 chars) are replaced by a placeholder first; if that's
    still over the threshold, the trimmed history is summarized too (`method:"trim+summary"`).
  - Goal, todos and plan live on the session, unaffected. Older messages stay in `GET /api/sessions/{id}` for display;
    they just no longer reach the model. `before`/`after` are tokens (`after` estimated, chars/4).
  - If the newest `keep_recent` messages alone are over the threshold, the cut moves to the last exchange (as if
    `keep_recent:2`) so it doesn't re-fire every turn; under ~200 tokens of older history it does nothing.
  - If the fixed prompt (system + tools: `used` minus history) alone is over the threshold, compaction can't help: it
    is skipped and one `notice {kind:"compact", text:"auto-compaction skipped: …"}` is sent per chat (per engine run).
  - A failed compaction never blocks the turn: `notice {kind:"compact", text:"auto-compaction failed: …"}`.
- `context.max_effective` (on `done.context`, session `context`) = the size the percentage uses:
  `min(max, max_ctx_override)` when set, else `min(max, 256000)` (providers that report 1M windows). Clients should
  show `used / max_effective`.
- Hermes' own mid-turn compression still emits `compacted {before, after, auto:true}` in both harnesses; the turn's
  `done` then carries `compacted {…}` and Pico stores Hermes' compacted transcript as the model history.
- `/compact [focus words]` (manual, whole chat → summary) accepts optional focus text for the summarizer; its
  `compacted` event is `{before, after, auto:false, reason:"manual", focus?}`.
