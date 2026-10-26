# Pico architecture

```
pico engine  (Python, 127.0.0.1:7878, token auth)   ~/.pico/
  ├─ agent: Hermes AIAgent used as a library (pinned hermes-agent git rev), HERMES_HOME=~/.pico/hermes
  │    memory, skills, MCP, tools, compaction come from Hermes unchanged
  ├─ sessions: ~/.pico/pico.db (sqlite) — chats live on this machine
  ├─ runtime: local model server it installs & supervises (llama.cpp llama-server; MLX on Apple optional)
  ├─ hwscan + recipes: picks model/quant/flags for this box + persona
  ├─ checkins: scheduler for background replies -> inbox + phone push
  └─ HTTP+SSE API (docs/API.md)  — every client below speaks only this
        ├─ cli/      TypeScript (Bun-compiled single binary). Pi-style dev TUI.
        ├─ web/      Preact+Vite static app served by the engine at /
        ├─ desktop/  Tauri shell around web/ (small, native)
        └─ ios/      SwiftUI remote (separate app from Pico Kitty), pairs by QR over Tailscale/LAN
recipes/  catalog.json in git: hardware tier -> model, quant, runtime flags, measured tok/s, ctx.
          Engine fetches it; never auto-applies. Shows "update available: +12 tok/s, +32k ctx".
installer/ install.sh + install.ps1: uv -> Python 3.11 -> pico engine; CLI binary; llama.cpp build for the GPU.
           Never touches GPU drivers/OS; tells the user what is missing.
```

Design rules
- Dark, sleek, lowkey. ASCII skeleton mascot `(o.o)` / `|=|`. Mono type. One accent color.
- Effort levels off/low/medium/high each have a color; the CLI prompt bar takes that color (Shift+Tab cycles).
- Beginners never edit config files. Developers can (everything is plain files under ~/.pico).
- Updates are offered, never applied without a click.
