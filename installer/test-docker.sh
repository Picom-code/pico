#!/bin/sh
# Linux install test: run install.sh in a throwaway container with the repo mounted read-only.
#   sh installer/test-docker.sh ubuntu:24.04 [spark-key-file]
# The container gets curl + ca-certificates (and git) only; the installer does the rest as a normal user.
set -eu
IMG="${1:-ubuntu:24.04}"
KEYFILE="${2:-}"
REPO=$(cd "$(dirname "$0")/.." && pwd)
mount_key=""
[ -n "$KEYFILE" ] && mount_key="-v $KEYFILE:/run/spark.key:ro"
# shellcheck disable=SC2086
docker run --rm -v "$REPO:/src:ro" $mount_key "$IMG" sh -ec '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null && apt-get install -y -qq curl ca-certificates git >/dev/null
  useradd -m tester
  [ -f /run/spark.key ] && install -o tester -m 600 /run/spark.key /home/tester/.spark.key
  su tester -c "
    set -e; cd ~; export SHELL=/bin/bash
    s=\$(date +%s)
    PICO_SRC=/src sh /src/installer/install.sh --yes
    echo \"install_seconds=\$((\$(date +%s)-s)) size=\$(du -sh ~/.pico-app | cut -f1)\"
    . ~/.bashrc 2>/dev/null || true; export PATH=\$HOME/.local/bin:\$PATH
    grep -A1 \"pico installer\" ~/.bashrc
    pico --version
    pico doctor
    curl -fs localhost:7878/api/health && echo
    if [ -f ~/.spark.key ]; then
      T=\$(cat ~/.pico/token)
      KEY=\$(cat ~/.spark.key)
      curl -fs -X POST -H \"Authorization: Bearer \$T\" -H Content-Type:application/json localhost:7878/api/setup \
        -d \"{\\\"provider\\\":{\\\"kind\\\":\\\"custom\\\",\\\"base_url\\\":\\\"https://gpu.example.ts.net/v1\\\",\\\"model\\\":\\\"deepseek-v4.1-flash\\\",\\\"api_key\\\":\\\"\$KEY\\\"}}\" >/dev/null
      for i in \$(seq 1 40); do curl -fs localhost:7878/api/health | grep -q ready && break; sleep 1; done
      pico -p \"say ok\" || echo \"-p test failed\"
    fi
    PICO_PREFIX=~/.pico-app pico uninstall --yes
    test ! -e ~/.pico-app && test ! -e ~/.local/bin/pico && test -d ~/.pico && echo uninstall_ok
  "
'
