#!/bin/sh
# Pico installer for macOS + Linux. User-level only: no sudo, no system packages.
# Writes to $PICO_PREFIX (app), $PICO_BIN_DIR (one symlink) and, only if that dir is not on PATH yet,
# one line in your shell rc. Your data ($PICO_HOME, default ~/.pico) is never touched.
#
#   curl -fsSL https://raw.githubusercontent.com/Picom-code/pico/main/installer/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --yes --no-web --dry-run
#
# Re-running it updates in place. See installer/README.md for every knob.
set -eu

PICO_REPO="${PICO_REPO:-https://github.com/Picom-code/pico}"
PICO_REF="${PICO_REF:-main}"
PICO_SRC="${PICO_SRC:-}"
PREFIX="${PICO_PREFIX:-$HOME/.pico-app}"
DATA="${PICO_HOME:-$HOME/.pico}"
BIN_DIR="${PICO_BIN_DIR:-$HOME/.local/bin}"
HERMES_REPO="${PICO_HERMES_REPO:-NousResearch/hermes-agent}"
# Known-good Hermes Agent commit (what Pico is developed and tested against).
HERMES_REF="${PICO_HERMES_REF:-b222bced94bc1588423022ba59d7336d0e486c89}"
UV_VERSION="${PICO_UV_VERSION:-0.13.5}"
UV_MIN="0.13.0"
BUN_VERSION="${PICO_BUN_VERSION:-1.3.13}"
PY_VERSION="3.14"

YES=0 NO_WEB=0 DRY=0 MODIFY_PATH=1
[ "${PICO_NO_MODIFY_PATH:-}" = 1 ] && MODIFY_PATH=0
[ "${PICO_NO_WEB:-}" = 1 ] && NO_WEB=1
for a in "$@"; do
  case "$a" in
    -y|--yes) YES=1 ;;
    --no-web) NO_WEB=1 ;;
    --dry-run) DRY=1 ;;
    --no-modify-path) MODIFY_PATH=0 ;;
    -h|--help)
      sed -n '2,11p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
      echo "flags: --yes --no-web --dry-run --no-modify-path"
      exit 0 ;;
    *) echo "pico installer: unknown flag $a" >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------------ output
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  PINK=$(printf '\033[38;2;255;46;153m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m'); B=$(printf '\033[1m'); R=$(printf '\033[0m')
else
  PINK='' DIM='' RED='' B='' R=''
fi
LOG=/dev/null
ok()   { printf '  %s✓%s %s\n' "$PINK" "$R" "$*"; }
note() { printf '  %s%s%s\n' "$DIM" "$*" "$R"; }
step() { printf '  %s·%s %s%s%s\n' "$PINK" "$R" "$DIM" "$*" "$R"; }
die() {
  printf '  %s✗%s %s\n' "$RED" "$R" "$*" >&2
  if [ "$LOG" != /dev/null ] && [ -s "$LOG" ]; then
    tail -n 12 "$LOG" | sed 's/^/    /' >&2
    printf '  %sfull log: %s%s\n' "$DIM" "$LOG" "$R" >&2
  fi
  exit 1
}
run() { "$@" >>"$LOG" 2>&1 || die "failed: $*"; }
have() { command -v "$1" >/dev/null 2>&1; }
fetch() { # url out
  if have curl; then curl -fsSL --retry 3 --connect-timeout 15 -o "$2" "$1"
  else wget -q -O "$2" "$1"; fi
}
fetch_quiet() { fetch "$@" >>"$LOG" 2>&1; }
ver_ge() { # a >= b, dotted numbers
  awk -v a="$1" -v b="$2" 'BEGIN{n=split(a,x,".");m=split(b,y,".");for(i=1;i<=(n>m?n:m);i++){if((x[i]+0)>(y[i]+0))exit 0;if((x[i]+0)<(y[i]+0))exit 1}exit 0}'
}
abspath() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$PWD" "$1" ;; esac; }

printf '%s /\\_/\\%s\n%s( o.o )%s  %spico installer%s\n%s > ^ <%s\n\n' "$PINK" "$R" "$PINK" "$R" "$B" "$R" "$PINK" "$R"

# ------------------------------------------------------------------ detect
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) die "unsupported OS $(uname -s) — on Windows use: irm https://raw.githubusercontent.com/Picom-code/pico/main/installer/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) die "unsupported CPU $(uname -m) (need arm64 or x86_64)" ;;
esac
if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then ARCH=arm64; fi
LIBC=gnu
if [ "$OS" = linux ] && { [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); }; then LIBC=musl; fi
have curl || have wget || die "need curl or wget"
have tar || die "need tar"
case "$PREFIX" in *"'"*|*'"'*) die "PICO_PREFIX must not contain quotes" ;; esac
PREFIX=$(abspath "$PREFIX"); DATA=$(abspath "$DATA"); BIN_DIR=$(abspath "$BIN_DIR")
[ -n "$PICO_SRC" ] && PICO_SRC=$(abspath "$PICO_SRC")
[ "$PREFIX" = "$DATA" ] && die "PICO_PREFIX and PICO_HOME must differ (app and data stay separate)"

if [ -n "$PICO_SRC" ]; then SRC_DESC="local $PICO_SRC"
else SRC_DESC="$PICO_REPO@$PICO_REF"; fi
ACTION=install; [ -f "$PREFIX/install.json" ] && ACTION=update
ok "$OS $ARCH${LIBC:+ ($LIBC)}"
[ "$LIBC" = musl ] && note "musl/Alpine is untested — glibc distros are the supported path"

if [ "$DRY" = 1 ]; then
  echo
  note "plan ($ACTION, nothing will be changed):"
  note "  app      $PREFIX"
  note "  data     $DATA (kept as is)"
  note "  source   $SRC_DESC"
  note "  hermes   $HERMES_REPO@$(printf '%s' "$HERMES_REF" | cut -c1-12)"
  note "  python   $PY_VERSION via uv $UV_VERSION (private copy unless uv >= $UV_MIN is on PATH)"
  note "  cli      release asset pico-$OS-$ARCH if PICO_REF is a release tag, else built with bun $BUN_VERSION"
  if [ "$NO_WEB" = 1 ]; then note "  web      skipped (--no-web)"; else note "  web      release asset or npm build if node is present, else skipped"; fi
  note "  link     $BIN_DIR/pico -> $PREFIX/bin/pico"
  exit 0
fi

if [ "$YES" = 0 ] && [ -r /dev/tty ] && (exec </dev/tty) 2>/dev/null; then
  printf '  %s %s%s%s? [Y/n] ' "$ACTION" "$B" "$PREFIX" "$R"
  read -r ans </dev/tty || ans=y
  case "$ans" in n|N|no|NO) note "cancelled"; exit 1 ;; esac
fi

T0=$(date +%s)
mkdir -p "$PREFIX/bin" "$PREFIX/tmp" "$PREFIX/tools"
LOG="$PREFIX/install.log"
: >"$LOG"
TMP="$PREFIX/tmp"

stop_engine() { # only the engine that runs from this prefix
  pat="$PREFIX/venv/bin/python"
  if have pkill; then pkill -f "$pat" 2>/dev/null || true
  elif [ -d /proc ]; then
    for p in /proc/[0-9]*; do
      if tr '\0' ' ' <"$p/cmdline" 2>/dev/null | grep -qF "$pat"; then kill "${p#/proc/}" 2>/dev/null || true; fi
    done
  fi
}
[ -d "$PREFIX/venv" ] && stop_engine

# ------------------------------------------------------------------ uv
UV=""
if have uv && ver_ge "$(uv --version 2>/dev/null | awk '{print $2}')" "$UV_MIN"; then UV=$(command -v uv)
elif [ -x "$PREFIX/tools/uv" ] && ver_ge "$("$PREFIX/tools/uv" --version | awk '{print $2}')" "$UV_MIN"; then UV="$PREFIX/tools/uv"
else
  step "getting uv $UV_VERSION"
  fetch_quiet "https://astral.sh/uv/$UV_VERSION/install.sh" "$TMP/uv-install.sh" || die "could not download uv"
  run env UV_INSTALL_DIR="$PREFIX/tools" UV_NO_MODIFY_PATH=1 INSTALLER_NO_MODIFY_PATH=1 sh "$TMP/uv-install.sh"
  UV="$PREFIX/tools/uv"
fi
ok "uv $("$UV" --version | awk '{print $2}')"

# ------------------------------------------------------------------ pico source
gh_slug() { printf '%s' "$1" | sed -n 's#^https://github.com/\([^/]*/[^/.]*\)\(\.git\)\{0,1\}/\{0,1\}$#\1#p'; }
SRC="$PREFIX/src"
if [ -n "$PICO_SRC" ]; then
  [ -d "$PICO_SRC/engine" ] && [ -d "$PICO_SRC/cli" ] || die "PICO_SRC=$PICO_SRC is not a pico checkout"
  SOURCE=local
  COMMIT=$(git -C "$PICO_SRC" rev-parse HEAD 2>/dev/null || echo local)
  rm -rf "$SRC.new"; mkdir -p "$SRC.new"
  (cd "$PICO_SRC" && tar --exclude=./.git --exclude=node_modules --exclude=dist --exclude=__pycache__ \
      --exclude=.venv --exclude=./ios --exclude=./desktop --exclude=./eval -cf - .) | (cd "$SRC.new" && tar -xf -) \
    || die "could not copy $PICO_SRC"
  rm -rf "$SRC"; mv "$SRC.new" "$SRC"
elif have git; then
  SOURCE=git
  step "fetching pico ($PICO_REF)"
  if [ ! -d "$SRC/.git" ]; then rm -rf "$SRC"; run git init -q "$SRC"; run git -C "$SRC" remote add origin "$PICO_REPO"; fi
  run git -C "$SRC" remote set-url origin "$PICO_REPO"
  run git -C "$SRC" fetch -q --depth 1 origin "$PICO_REF"
  run git -C "$SRC" reset -q --hard FETCH_HEAD
  run git -C "$SRC" clean -q -fdx
  COMMIT=$(git -C "$SRC" rev-parse HEAD)
else
  SOURCE=tarball
  slug=$(gh_slug "$PICO_REPO"); [ -n "$slug" ] || die "no git and PICO_REPO is not a github.com URL"
  step "downloading pico ($PICO_REF)"
  fetch_quiet "https://codeload.github.com/$slug/tar.gz/$PICO_REF" "$TMP/pico.tgz" || die "could not download $PICO_REPO@$PICO_REF"
  rm -rf "$SRC.new"; mkdir -p "$SRC.new"
  run tar -xzf "$TMP/pico.tgz" -C "$SRC.new" --strip-components=1
  rm -rf "$SRC"; mv "$SRC.new" "$SRC"; rm -f "$TMP/pico.tgz"
  COMMIT=$(curl -fsSL -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$slug/commits/$PICO_REF" 2>/dev/null || echo "$PICO_REF")
fi
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SRC/cli/package.json" | head -n 1)
ok "pico $VERSION · $(printf '%s' "$COMMIT" | cut -c1-7) · $SOURCE"

# ------------------------------------------------------------------ hermes agent (pinned)
HA="$PREFIX/hermes-agent"
if [ "$(cat "$HA/.pico-hermes-ref" 2>/dev/null)" != "$HERMES_REF" ]; then
  step "downloading hermes agent"
  fetch_quiet "https://codeload.github.com/$HERMES_REPO/tar.gz/$HERMES_REF" "$TMP/hermes.tgz" || die "could not download hermes agent $HERMES_REF"
  rm -rf "$HA.new"; mkdir -p "$HA.new"
  run tar -xzf "$TMP/hermes.tgz" -C "$HA.new" --strip-components=1
  # not needed at runtime: test suite, docs site, desktop/mobile apps, contributor assets
  rm -rf "$HA.new/tests" "$HA.new/tests-js" "$HA.new/website" "$HA.new/apps" "$HA.new/contributors" "$HA.new/evals"
  printf '%s\n' "$HERMES_REF" >"$HA.new/.pico-hermes-ref"
  rm -rf "$HA"; mv "$HA.new" "$HA"; rm -f "$TMP/hermes.tgz"
fi
ok "hermes agent $(printf '%s' "$HERMES_REF" | cut -c1-7)"

# ------------------------------------------------------------------ python + venv
export UV_PYTHON_INSTALL_DIR="$PREFIX/python" UV_PYTHON_PREFERENCE=only-managed UV_NO_PROGRESS=1
step "python $PY_VERSION + packages"
run "$UV" python install "$PY_VERSION"
rm -rf "$PREFIX/venv"
run "$UV" venv -q "$PREFIX/venv" --python "$PY_VERSION"
PY="$PREFIX/venv/bin/python"
# Hermes' own lockfile pins every package; install exactly that set, then the engine on top.
run "$UV" export -q --project "$HA" --frozen --no-dev --no-emit-project --no-hashes --no-header -o "$TMP/hermes-req.txt"
run "$UV" pip install -q --python "$PY" --no-deps -r "$TMP/hermes-req.txt"
run "$UV" pip install -q --python "$PY" -e "$SRC/engine"  # editable: engine finds recipes/ and web/ in src
(cd "$TMP" && PYTHONPATH="$HA" HERMES_HOME="$TMP/hermes-check" HERMES_DISABLE_LAZY_INSTALLS=1 \
  "$PY" -c 'from run_agent import AIAgent; import pico.server') >>"$LOG" 2>&1 || die "engine check failed (import run_agent.AIAgent)"
rm -rf "$TMP/hermes-check"
ok "python $("$PY" -c 'import platform; print(platform.python_version())') · engine ready"

# ------------------------------------------------------------------ cli binary
CLI="$PREFIX/bin/pico-cli"
got_cli=0
cli_url="${PICO_CLI_URL:-}"
case "$PICO_REF" in v[0-9]*) [ -z "$cli_url" ] && [ -z "$PICO_SRC" ] && cli_url="$PICO_REPO/releases/download/$PICO_REF/pico-$OS-$ARCH" ;; esac
if [ -n "$cli_url" ]; then
  if fetch_quiet "$cli_url" "$CLI.new"; then chmod +x "$CLI.new"; mv -f "$CLI.new" "$CLI"; got_cli=1; ok "terminal app (release)"
  else rm -f "$CLI.new"; note "no release binary at $cli_url — building instead"; fi
fi
if [ "$got_cli" = 0 ]; then
  BUN="" TEMP_BUN=0
  if have bun; then BUN=$(command -v bun)
  else
    case "$OS-$ARCH" in
      darwin-arm64) b=darwin-aarch64 ;; darwin-x64) b=darwin-x64 ;;
      linux-arm64) b=linux-aarch64 ;; linux-x64) b=linux-x64-baseline ;;
    esac
    [ "$LIBC" = musl ] && b="$b-musl"
    b=$(printf '%s' "$b" | sed 's/-baseline-musl$/-musl-baseline/')
    step "getting bun $BUN_VERSION (build tool, removed after)"
    fetch_quiet "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$b.zip" "$TMP/bun.zip" || die "could not download bun"
    rm -rf "$TMP/bun"
    if have unzip; then run unzip -q -o "$TMP/bun.zip" -d "$TMP/bun"
    else run "$PY" -m zipfile -e "$TMP/bun.zip" "$TMP/bun"; fi
    BUN=$(find "$TMP/bun" -type f -name bun | head -n 1); chmod +x "$BUN"; TEMP_BUN=1
  fi
  step "building terminal app"
  (cd "$SRC/cli" && "$BUN" build src/main.ts --compile --minify --sourcemap=none --outfile "$CLI.new") >>"$LOG" 2>&1 \
    || die "cli build failed"
  mv -f "$CLI.new" "$CLI"
  [ "$TEMP_BUN" = 1 ] && rm -rf "$TMP/bun" "$TMP/bun.zip"
  ok "terminal app (built with bun $("$BUN" --version 2>/dev/null || echo "$BUN_VERSION"))"
fi

# ------------------------------------------------------------------ web app (optional)
WEB="$SRC/web/dist"
if [ "$NO_WEB" = 1 ]; then note "web app skipped (--no-web)"
else
  web_ok=0
  case "$PICO_REF" in v[0-9]*)
    if [ -z "$PICO_SRC" ] && fetch_quiet "$PICO_REPO/releases/download/$PICO_REF/pico-web.tar.gz" "$TMP/web.tgz"; then
      mkdir -p "$WEB" && tar -xzf "$TMP/web.tgz" -C "$WEB" >>"$LOG" 2>&1 && web_ok=1; rm -f "$TMP/web.tgz"
    fi ;;
  esac
  if [ "$web_ok" = 0 ] && have npm; then
    step "building web app"
    if (cd "$SRC/web" && npm ci --no-audit --no-fund --loglevel=error && npm run build) >>"$LOG" 2>&1; then web_ok=1; fi
    rm -rf "$SRC/web/node_modules"
  fi
  if [ "$web_ok" = 1 ]; then ok "web app"
  else note "web app skipped (no release asset or node) — the terminal app works without it"; fi
fi

# ------------------------------------------------------------------ launcher
cat >"$PREFIX/bin/pico" <<EOF
#!/bin/sh
# Pico launcher, written by the installer (re-run it, or \`pico update\`, to refresh).
# Starts the engine from the app's venv if it is not answering, then runs the terminal app.
PICO_PREFIX='$PREFIX'
export PICO_PREFIX
export PICO_HOME="\${PICO_HOME:-$DATA}"
export PICO_HERMES_PATH="\$PICO_PREFIX/hermes-agent"
export PICO_WEB_DIST="\$PICO_PREFIX/src/web/dist"
export HERMES_DISABLE_LAZY_INSTALLS=1
export PICO_ENGINE_CMD='mkdir -p "\$PICO_HOME" && cd "\$PICO_HOME" && exec "\$PICO_PREFIX/venv/bin/python" -m pico.server >>"\$PICO_HOME/engine.log" 2>&1'
case "\${1:-}" in update|uninstall|-v|--version|-h|--help) exec "\$PICO_PREFIX/bin/pico-cli" "\$@" ;; esac
if [ -z "\${PICO_URL:-}" ]; then
  url="http://127.0.0.1:\${PICO_PORT:-7878}/api/health"
  up() { if command -v curl >/dev/null 2>&1; then curl -fs -m 1 "\$url" >/dev/null 2>&1; else "\$PICO_PREFIX/venv/bin/python" -c "import urllib.request,sys; urllib.request.urlopen(sys.argv[1], timeout=1)" "\$url" >/dev/null 2>&1; fi; }
  if ! up; then
    (sh -c "\$PICO_ENGINE_CMD" </dev/null >/dev/null 2>&1 &)
    i=0; while [ \$i -lt 120 ]; do up && break; sleep 0.25; i=\$((i + 1)); done
  fi
fi
exec "\$PICO_PREFIX/bin/pico-cli" "\$@"
EOF
chmod +x "$PREFIX/bin/pico"

# ------------------------------------------------------------------ link + PATH
LINK="$BIN_DIR/pico" linked=0
mkdir -p "$BIN_DIR"
if [ -L "$LINK" ] && case "$(readlink "$LINK")" in "$PREFIX"/*) true ;; *) false ;; esac; then
  ln -sf "$PREFIX/bin/pico" "$LINK"; linked=1
elif [ -e "$LINK" ] || [ -L "$LINK" ]; then
  note "left $LINK alone (it is not from this install) — use $PREFIX/bin/pico"
else
  ln -s "$PREFIX/bin/pico" "$LINK"; linked=1
fi
RUN="pico"
[ "$linked" = 1 ] || RUN="$PREFIX/bin/pico"
if [ "$linked" = 1 ]; then
  case ":$PATH:" in
    *":$BIN_DIR:"*) ok "linked $LINK" ;;
    *)
      shown_dir=$(printf '%s' "$BIN_DIR" | sed "s#^$HOME#\$HOME#")
      case "$(basename "${SHELL:-sh}")" in
        zsh) rc="$HOME/.zshrc"; line="export PATH=\"$shown_dir:\$PATH\"" ;;
        bash) if [ "$OS" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi; line="export PATH=\"$shown_dir:\$PATH\"" ;;
        fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path \"$shown_dir\"" ;;
        *) rc="$HOME/.profile"; line="export PATH=\"$shown_dir:\$PATH\"" ;;
      esac
      if [ "$MODIFY_PATH" = 1 ]; then
        mkdir -p "$(dirname "$rc")"
        if ! grep -qF "$line" "$rc" 2>/dev/null; then printf '\n# added by the pico installer\n%s\n' "$line" >>"$rc"; fi
        ok "linked $LINK · added to PATH in ${rc#"$HOME"/} (open a new terminal)"
        note "  $line"
      else
        ok "linked $LINK"
        note "$BIN_DIR is not on PATH — add it, or run $PREFIX/bin/pico"
        RUN="$PREFIX/bin/pico"
      fi ;;
  esac
fi

# ------------------------------------------------------------------ record + doctor
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat >"$PREFIX/install.json" <<EOF
{
  "version": "$VERSION",
  "commit": "$COMMIT",
  "source": "$SOURCE",
  "repo": "$PICO_REPO",
  "ref": "$PICO_REF",
  "src_path": "$PICO_SRC",
  "hermes_repo": "$HERMES_REPO",
  "hermes_ref": "$HERMES_REF",
  "prefix": "$PREFIX",
  "home": "$DATA",
  "bin_dir": "$BIN_DIR",
  "linked": $([ "$linked" = 1 ] && echo true || echo false),
  "modify_path": $([ "$MODIFY_PATH" = 1 ] && echo true || echo false),
  "no_web": $([ "$NO_WEB" = 1 ] && echo true || echo false),
  "web": $([ -f "$WEB/index.html" ] && echo true || echo false),
  "os": "$OS",
  "arch": "$ARCH",
  "installed_at": "$NOW"
}
EOF
rm -rf "$TMP"

if PICO_HOME="$DATA" "$PREFIX/bin/pico" doctor >>"$LOG" 2>&1; then ok "pico doctor"
else
  PICO_HOME="$DATA" "$PREFIX/bin/pico" doctor || true
  stop_engine
  die "pico doctor failed — engine log: $DATA/engine.log"
fi
stop_engine # the app starts it again on demand

SECS=$(( $(date +%s) - T0 ))
SIZE=$(du -sh "$PREFIX" 2>/dev/null | awk '{print $1}')
echo
DONE=installed; [ "$ACTION" = update ] && DONE=updated
printf '  %s✓ %s%s %s· %ss · %s · run: %s%s%s\n' "$PINK" "$DONE" "$R" "$DIM" "$SECS" "$SIZE" "$R$B" "$RUN" "$R"
