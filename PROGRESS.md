# Pico — progress (resumable)

Goal: hyper-simple installable "Hermes for everyone": desktop + terminal + web + phone, ASCII skeleton theme,
hardware-aware model setup, Hermes memory/skills/MCP, background replies. Separate from Pico Kitty (iOS).

Decisions (from Pico, 2026-10-25)
- macOS + Linux + Windows; setup flow installs everything.
- Built ON TOP of Hermes (library use of AIAgent, pinned rev), not a fork. Spike passed: AIAgent called directly with
  HERMES_HOME=~/.pico/hermes ran a terminal tool on a DGX Spark endpoint (TTFT 6.1s).
- CLI in TypeScript (Bun single binary). Pi-like: Shift+Tab cycles effort, prompt bar color follows effort.
- Model/config updates are OFFERED with deltas (+tps, +ctx), never auto-applied.
- Background replies (check-ins) run in the engine.
- Local/experimental only; no TestFlight until Pico says. iOS remote = new bundle id, not Pico Kitty.

Phases
- [ ] 1 engine (API.md) + hwscan + recipes
- [ ] 2 CLI (TS) + installer (sh/ps1)
- [ ] 3 web app + desktop (Tauri)
- [ ] 4 iOS remote pairing
- [ ] 5 local voice/image/video, catalog agent, check-ins polish
- [ ] 6 packaging, GitHub releases

Log
- 2026-10-25: Phase 1-3 core landed (commit bc8c497). Engine on Hermes AIAgent (111 tests), hwscan + catalog 2026.10.25 (26 chat recipes + voice/image/video), llama.cpp runtime (real run: b11669 + Qwen3.5-0.8B, 113 tok/s on M3 Pro), TS CLI (37 tests, 60MB bun binary), Preact web (37KB gz).
  Integration verified live vs Spark: setup job, CLI -p runs tools in launch dir (fixed: pin session cwd + terminal scope), web app chat via engine (token auto-injected for localhost), approvals render.
  Run: cd engine && PICO_HOME=~/.pico ~/.hermes/cache/scratch/pico-venv/bin/python -m pico.server ; cli/dist/pico ; http://127.0.0.1:7878
  Next: installer (install.sh/ps1 + uv), Tauri desktop shell, iOS remote (new bundle id), local voice/image, catalog-update agent, web: user message rendered twice in chat (bug), CLI binary size (60MB).
  Blocker: Mac disk 6.6GB free -> can't test real recommended local models here; test local path on Spark/Windows box.
