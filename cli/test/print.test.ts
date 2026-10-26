// Integration: run the real CLI (`bun src/main.ts`) against the mock engine.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startMock } from './mock-engine';

let server: ReturnType<typeof startMock>;
let env: Record<string, string>;

beforeAll(() => {
  server = startMock({ port: 0, fast: true });
  env = { ...process.env, PICO_URL: `http://127.0.0.1:${server.port}`, PICO_TOKEN: 'test-token', NO_COLOR: '1' } as any;
});
afterAll(() => server.stop(true));

const run = async (...args: string[]) => {
  const p = Bun.spawn(['bun', 'src/main.ts', ...args], { cwd: import.meta.dir + '/..', env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

describe('pico -p against mock', () => {
  test('prints answer, exit 0', async () => {
    const r = await run('-p', 'say hi', '-e', 'low');
    expect(r.out).toBe('Hi! 👋\n');
    expect(r.code).toBe(0);
  });
  test('--json emits events', async () => {
    const r = await run('--json', '-p', 'use a tool', '-e', 'low');
    const evs = r.out.trim().split('\n').map((l) => JSON.parse(l));
    expect(evs.map((e) => e.event)).toContain('tool_start');
    expect(evs.at(-1).event).toBe('done');
  });
  test('engine error → exit 1', async () => {
    const r = await run('-p', 'error', '-e', 'low');
    expect(r.code).toBe(1);
    expect(r.err).toContain('model server crashed');
  });
  test('approval is denied non-interactively', async () => {
    const r = await run('-p', 'please approve', '-e', 'low');
    expect(r.err).toContain('denied (non-interactive): rm -rf ./build');
    expect(r.out).toContain('left the build directory alone');
  });
  test('doctor + version', async () => {
    const d = await run('doctor');
    expect(d.out).toContain('engine');
    expect(d.code).toBe(0);
    expect((await run('--version')).out.trim()).toMatch(/^pico \d/);
  });
  test('unreachable engine → exit 2', async () => {
    const p = Bun.spawn(['bun', 'src/main.ts', '-p', 'x', '--no-start'], { cwd: import.meta.dir + '/..', env: { ...env, PICO_URL: 'http://127.0.0.1:1' }, stdout: 'pipe', stderr: 'pipe' });
    expect(await p.exited).toBe(2);
  });
});
