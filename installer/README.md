# pico installer

One line installs pico, and running it again updates in place. It installs at user level only: no sudo, no system packages.

```sh
# macOS · Linux
curl -fsSL https://raw.githubusercontent.com/Picom-code/pico/main/installer/install.sh | sh
# non-interactive / preview
curl -fsSL https://raw.githubusercontent.com/Picom-code/pico/main/installer/install.sh | sh -s -- --yes --dry-run
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/Picom-code/pico/main/installer/install.ps1 | iex
```

## What it does

1. Fetches pico (`PICO_REF`, default `main`) and Hermes Agent at a pinned commit.
2. Installs a private Python through [uv](https://github.com/astral-sh/uv), then installs Hermes' exact lockfile and the pico engine into a venv.
3. Installs the `pico` CLI. It downloads a release asset when one exists for your platform; otherwise it builds the CLI with a private copy of Bun.
4. Builds the web app when Node is present (skip with `--no-web`).
5. Links `pico` into `PICO_BIN_DIR`. It adds that directory to PATH only if it isn't there already: one line in your shell rc on Unix, or your user PATH on Windows.

Your data in `PICO_HOME` (default `~/.pico`) is never touched. The app lives in `PICO_PREFIX` and the two stay separate.
`pico update` shows what changed and asks before re-running the installer. `pico uninstall` removes the app and keeps your data unless you pass `--purge`.

## Flags

| sh | PowerShell | does |
|---|---|---|
| `--yes` | `-Yes` | don't ask |
| `--dry-run` | `-DryRun` | print the plan, change nothing |
| `--no-web` | `-NoWeb` | skip the web app |
| `--no-modify-path` | `-NoModifyPath` | don't touch PATH or shell rc |

## Environment

| var | default | |
|---|---|---|
| `PICO_PREFIX` | `~/.pico-app` · `%LOCALAPPDATA%\Pico` | app install dir |
| `PICO_HOME` | `~/.pico` | your data (never modified by the installer) |
| `PICO_BIN_DIR` | `~/.local/bin` | where the `pico` link goes |
| `PICO_REPO` / `PICO_REF` | `Picom-code/pico` / `main` | source to install |
| `PICO_SRC` | | install from a local checkout instead |
| `PICO_HERMES_REF` | pinned commit | Hermes Agent version |
| `PICO_NO_WEB`, `PICO_NO_MODIFY_PATH` | | `1` = same as the flags |

## Testing

`installer/test-docker.sh ubuntu:24.04` runs a clean install inside a container.
