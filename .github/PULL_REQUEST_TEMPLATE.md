## What

<!-- one or two sentences -->

## Why

## Checks
- [ ] `cd engine && python -m pytest -q tests`
- [ ] `cd cli && bun test && bunx tsc --noEmit`
- [ ] `cd web && npm run build` (if web changed)
- [ ] new or updated pty frames for UI changes (`cli/test/drive.py`)
- [ ] lean harness changes: `eval/compare.py` verdict pasted below
- [ ] no secrets, hostnames or personal paths in the diff
