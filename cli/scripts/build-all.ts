// Cross-compile the pico binary for every supported platform into dist/.
//   bun scripts/build-all.ts            # all targets
//   bun scripts/build-all.ts linux-x64  # just one
import { $ } from 'bun';

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'windows-x64'];
const want = Bun.argv.slice(2);
const targets = want.length ? TARGETS.filter((t) => want.includes(t)) : TARGETS;

for (const t of targets) {
  const out = `dist/pico-${t}${t.startsWith('windows') ? '.exe' : ''}`;
  await $`bun build src/main.ts --compile --minify --sourcemap=none --target=bun-${t} --outfile ${out}`.quiet();
  const size = (await Bun.file(out).size) / 1024 / 1024;
  console.log(`${out.padEnd(32)} ${size.toFixed(1)} MB`);
}
