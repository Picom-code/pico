#!/bin/sh
# Re-render the README terminal SVGs from recorded pty frames (needs: pip install pyte).
# The demo frame comes from the mock engine; its canned reply is swapped for a coherent story.
set -e
cd "$(dirname "$0")/../../.."
PY=${PY:-python3}
T=docs/assets/tools/ansi2svg.py
$PY $T cli/test/frames/picks/picks.json done-signoff docs/assets/demo.svg --rows 60 --title "pico — ~/code/shop" \
  --sub "~/Developer/pico/cli=~/code/shop" --sub "0.1.0-mock=0.1.0" \
  --sub "use a tool and fix calc=the pager test fails. fix it and run the tests" \
  --sub "read src/app.ts=read src/pager.ts" --sub "patch src/app.ts=patch src/pager.ts" \
  --sub "✎ src/app.ts=✎ src/pager.ts" --sub "+13 −2  (ctrl+o=+1 −1  (ctrl+o" --sub "1 file +13 −2=1 file +1 −1" \
  --row "  Summary=>  Fixed" \
  --row "Here is what I found=>  pages() dropped the last partial page:" \
  --row "The entry point is=>  • it floored n / SIZE, so 11 items at 5 per page gave 2" \
  --row "Tests live in=>  • it now rounds up: 11 items give 3 pages" \
  --drop "nested item" \
  --row "1. first=>  1. /undo puts the old file back" \
  --row "2. second=>  2. ctrl+o shows the full diff" \
  --sub "// greet=// pager" --sub "hi(name: string)=pages(n: number)" --sub '`hello ${name}` + 42;=Math.ceil(n / SIZE); ' \
  --row "Note: this is a mock reply.=>  ▎ Want a test for the empty-list case too?" \
  --drop "See docs"
$PY $T cli/test/frames/settings/compaction.json config docs/assets/settings.svg --title "pico — /settings" \
  --sub "~/Developer/pico/cli=~/code/shop" --sub "0.1.0-mock=0.1.0"
# the recorded /model frame has a 2-col-too-wide bottom border (cli bug); trimmed here
$PY $T cli/test/frames/features/model.json picker docs/assets/model.svg --title "pico — /model" \
  --sub "~/Developer/pico/cli=~/code/shop" --sub "0.1.0-mock=0.1.0" --sub "──╯=╯"
