#!/bin/sh
# Regenerate the settings / usage-line / reply-style frames. Each scenario gets a fresh mock engine on :7980.
cd "$(dirname "$0")/../../.." || exit 1
D=test/frames/settings
run() {
  bun test/mock-engine.ts --port 7980 >/dev/null 2>&1 &
  M=$!
  sleep 1
  uv run -q --with pyte test/drive.py "$@" --url http://127.0.0.1:7980 --out $D >/dev/null 2>&1
  kill $M 2>/dev/null; wait $M 2>/dev/null
}
run settings --name settings-120
run settings --name settings-60 --cols 60 --rows 34
run compaction
for s in band label bar plain; do run reply-$s; done
run reply-band --name reply-ascii --ascii
run reply-band --name reply-band-60 --cols 60 --rows 34
run reply-picker
ls $D
