# Contributing to pico

Thanks for helping. Small, focused PRs land fastest. Open an issue first if the change is large.

## Layout

| dir | stack | tests |
|---|---|---|
| `engine/` | Python ≥ 3.11, aiohttp, Hermes Agent as a library | `pytest` |
| `cli/` | TypeScript on Bun | `bun test`, `tsc --noEmit` |
| `web/` | Preact + Vite | `npm run build` (typecheck + build) |
| `desktop/` | Tauri v2 (Rust) | `npx tauri build --bundles app` |
| `installer/` | POSIX sh + PowerShell | `installer/test-docker.sh` |
| `eval/` | Python | needs a real model endpoint |

## Engine

```sh
git clone https://github.com/NousResearch/hermes-agent ~/src/hermes-agent   # the installer pins a commit; see installer/install.sh
python3 -m venv .venv && . .venv/bin/activate
pip install -e "engine[test]"
pip install -e ~/src/hermes-agent        # or set PICO_HERMES_PATH=~/src/hermes-agent
cd engine && python -m pytest -q tests
PICO_HOME=/tmp/pico-dev PICO_PORT=7878 python -m pico.server   # run it
```

Most tests use a fake `AIAgent` (no network). Tests that need a real Hermes checkout skip when it isn't importable.

## Terminal app

```sh
cd cli
bun install
bun test               # unit tests + pty frame snapshots against a mock engine
bunx tsc --noEmit
bun run mock &         # mock engine
bun src/main.ts        # run against it (PICO_URL=http://127.0.0.1:7979)
bun run build          # single binary in dist/pico
```

UI changes should come with a frame: `python3 test/drive.py <scenario>` records pty frames to `test/frames/`.

## Web and desktop

```sh
cd web && npm install && npm run dev:mock:ready     # mock engine + vite on :5173
cd desktop && npm install && npx tauri dev
```

## Eval

The eval drives a throwaway engine against a real OpenAI-compatible endpoint:

```sh
export PICO_EVAL_BASE_URL=https://your-endpoint/v1 PICO_EVAL_API_KEY=... PICO_EVAL_MODEL=deepseek-v4.1-flash
python eval/run.py --harness lean --repeat 2
python eval/compare.py eval/results/<hermes>.jsonl eval/results/<lean>.jsonl
```

Changes to the lean harness need a `compare.py` verdict of `PASS` against `hermes`. See [docs/EVAL.md](docs/EVAL.md).

## Style

- Keep it lean. Every token in the prompt and every dependency has to justify itself.
- No secrets, hostnames or personal paths in commits, frames or eval results.
- Commit subjects use a scope prefix: `engine: …`, `cli: …`, `web: …`, `installer: …`.
