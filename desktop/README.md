# Pico desktop

A thin Tauri v2 shell around the Pico engine's web app (`web/`, served by the engine).

What it does:

- Opens a `Pico` window: 1200×800, min 760×520. On macOS it uses an overlay title bar with the title hidden. The page gets
  `html.desktop.desktop-mac`, and the web app leaves room for the traffic lights.
- Shows a tiny local splash (`splash/index.html`, a glowing cat and "waking up…") while it checks
  `http://127.0.0.1:$PICO_PORT/api/health` (port 7878 by default).
- If the engine is down, it starts it detached and logs to `$PICO_HOME/engine.log`, the same way the `pico` CLI launcher does:
  `cd ~/Developer/pico/engine && PICO_HOME=~/.pico PICO_PORT=7878 ~/.hermes/cache/scratch/pico-venv/bin/python -m pico.server`
  - `PICO_ENGINE_CMD="…"` replaces that with any shell command. `PICO_ENGINE_DIR`, `PICO_HOME` and `PICO_PORT` are also read.
- Once the engine is healthy, it navigates the window to `http://127.0.0.1:7878/`. The page comes from the engine itself, so loopback token
  injection (`window.__PICO_TOKEN__`) works with no pairing.
- **⌥Space** (Alt+Space) shows and focuses the window from anywhere.
- On macOS, closing the window hides it. Click the dock icon or press ⌥Space to bring it back, and ⌘Q to quit. The engine keeps running.

There's no tray icon yet.

## Dev

```sh
# one-time: Rust (user-level) + JS deps
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
cd desktop && npm install

npx tauri dev                    # debug build + window
npx tauri build --bundles app    # release .app → src-tauri/target/release/bundle/macos/Pico.app
```

The web UI itself is built separately: run `cd web && npm run build`, and the engine serves `web/dist`. The shell bundles nothing but the
splash.

Icon: `python3 scripts/make_icon.py` renders `src-tauri/icons/pico-1024.png` (the cat on charcoal with a pink glow). After that,
`npx tauri icon src-tauri/icons/pico-1024.png -o src-tauri/icons` regenerates every size. `npm run icon` runs both.

## Per-OS notes

- **macOS**: needs the Xcode command-line tools. `--bundles app` gives the `.app` and `--bundles dmg` gives a disk image. The build isn't signed,
  so on another Mac, right-click → Open the first time (or sign and notarize it with your Developer ID).
- **Windows**: needs MSVC build tools and WebView2 (preinstalled on Windows 11). Build with `npx tauri build --bundles nsis` (or `msi`). By default
  the engine is started as `%USERPROFILE%\.hermes\cache\scratch\pico-venv\Scripts\python.exe -m pico.server`, falling back to `python3`.
  Set `PICO_ENGINE_CMD` to point at your install. The overlay title bar is macOS-only; Windows uses the normal frame.
  ⌥Space is Alt+Space there, which Windows also uses for the window menu. If that clashes, change the shortcut in `src/lib.rs`.
- **Linux**: needs `webkit2gtk-4.1`, `libayatana-appindicator3` (optional) and `librsvg2`. See the Tauri prerequisites. Build with
  `npx tauri build --bundles deb` or `--bundles appimage`. Global shortcuts need X11; under Wayland they may not register (this
  is logged, not fatal).

## Layout

```
desktop/
  package.json             @tauri-apps/cli
  splash/index.html        local splash (frontendDist)
  scripts/make_icon.py     icon renderer (Pillow)
  src-tauri/
    tauri.conf.json        bundle config (window is created in code)
    capabilities/          lets the engine origin drag the window
    src/lib.rs             health check, engine spawn, navigate, ⌥Space, hide-on-close
```
