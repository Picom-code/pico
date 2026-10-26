// Verbosity levels, setup box, launch flags.
import { afterEach, describe, expect, test } from 'bun:test';
import { setAscii, stripAnsi as P, width } from '../src/ansi';
import { verbosityPreview } from '../src/app';
import { parseArgs, usage } from '../src/main';
import {
  apiFormLines, isLocalUrl, loginBoxLines, newApiForm, normalizeUrl, plainError, PRESETS, resolvePreset, setupChoiceLines, testEndpoint,
} from '../src/setup';
import { DEFAULT_PREFS, parseVerbosity, type Verbosity } from '../src/theme';
import { applyEvent, newTurn, renderToolsQuiet, renderTurn, type ToolPart } from '../src/turn';

afterEach(() => setAscii(false));

const T0 = 1_000_000;
const sample = (live = true) => {
  const t = newTurn('fix calc');
  applyEvent(t, 'reasoning', { text: 'first thought\nthe loop stops one short' }, T0);
  if (!live) applyEvent(t, 'delta', { text: 'ok' }, T0 + 500);
  return t;
};
const tools = () => {
  const t = newTurn('go');
  applyEvent(t, 'tool_start', { id: 'a', name: 'read_file', args: { path: 'a.py' } }, T0);
  applyEvent(t, 'tool_end', { id: 'a', ok: true, seconds: 0.1 }, T0 + 100);
  applyEvent(t, 'tool_start', { id: 'b', name: 'patch', args: { path: 'a.py' } }, T0);
  applyEvent(t, 'tool_end', { id: 'b', ok: true, seconds: 0.1, diff: { path: 'a.py', added: 1, removed: 1, unified: '@@ -1 +1 @@\n-x\n+y' } }, T0 + 100);
  applyEvent(t, 'tool_start', { id: 'c', name: 'terminal', args: { command: 'pytest' } }, T0);
  applyEvent(t, 'tool_progress', { id: 'c', tail: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`) }, T0 + 200);
  return t;
};
const V = (o: Partial<Verbosity>): Verbosity => ({ reasoning: 'timer', tools: 'normal', summary: true, ...o });
const R = (t: any, v: Partial<Verbosity>, live = true) => renderTurn(t, 90, { live, now: T0 + 1000, verbosity: V(v) }).map(P);

describe('verbosity: reasoning', () => {
  test('hidden: no timer, no text; a working line instead so it never looks frozen', () => {
    const out = R(sample(), { reasoning: 'hidden' });
    expect(out.join('\n')).not.toContain('thinking');
    expect(out.join('\n')).toContain('working');
  });
  test('timer (default): shimmer word + seconds, no text', () => {
    const out = R(sample(), {});
    expect(out).toContain('  thinking 1.0s');
    expect(out.join('\n')).not.toContain('loop stops');
  });
  test('preview: timer + the last reasoning line, one row', () => {
    const out = R(sample(), { reasoning: 'preview' });
    expect(out).toContain('    the loop stops one short');
    expect(out.join('\n')).not.toContain('first thought');
  });
  test('full: streams everything, folds to the timer line once the answer starts', () => {
    expect(R(sample(), { reasoning: 'full' }).join('\n')).toContain('first thought');
    const done = R(sample(false), { reasoning: 'full' });
    expect(done.join('\n')).not.toContain('first thought');
    expect(done.some((l) => l.includes('✻ thought 0.5s'))).toBe(true);
  });
  test('ctrl+o (expanded) shows the reasoning at any level', () => {
    const t = sample(false);
    t.expanded = true;
    expect(R(t, { reasoning: 'hidden' }).join('\n')).toContain('first thought');
  });
});

describe('verbosity: tools', () => {
  test("quiet: one roll-up line 'read 1 · edit 1 · ran 1' with a spinner, ✓ when done", () => {
    const out = R(tools(), { tools: 'quiet' });
    expect(out.filter((l) => l.includes('read 1 · edit 1 · ran 1')).length).toBe(1);
    expect(out.join('\n')).not.toContain('┬');
    const t = tools();
    applyEvent(t, 'tool_end', { id: 'c', ok: false, seconds: 2 }, T0 + 2000);
    expect(P(renderToolsQuiet(t.parts as ToolPart[], 80, { now: T0 }))).toMatch(/^✗ read 1 · edit 1 · ran 1  1 failed/);
  });
  test('normal: tree + 4-line tail + diff summary', () => {
    const out = R(tools(), {});
    expect(out).toContain('  ┬ 3 steps');
    expect(out.filter((l) => /line \d+/.test(l)).length).toBe(4);
    expect(out.join('\n')).toContain('(ctrl+o to see)');
  });
  test('full: up to 20 tail lines and expanded diffs', () => {
    const out = R(tools(), { tools: 'full' });
    expect(out.filter((l) => /line \d+/.test(l)).length).toBe(12);
    expect(out.join('\n')).not.toContain('(ctrl+o to see)');
    expect(out.some((l) => l.includes('+y') || l.includes('y'))).toBe(true);
  });
});

describe('verbosity: summary + parsing', () => {
  test('summary off drops the cat sign-off; errors still show', () => {
    const t = newTurn('x');
    applyEvent(t, 'delta', { text: 'hi' });
    applyEvent(t, 'done', { seconds: 1 });
    expect(R(t, { summary: false }, false).join('\n')).not.toContain('done in');
    expect(R(t, {}, false).join('\n')).toContain('done in');
    const e = newTurn('x');
    applyEvent(e, 'error', { message: 'boom' });
    expect(R(e, { summary: false }, false).join('\n')).toContain('boom');
  });
  test('presets, key=value, bare levels; junk rejected', () => {
    expect(parseVerbosity('quiet')).toEqual({ reasoning: 'hidden', tools: 'quiet', summary: true });
    expect(parseVerbosity('reasoning=preview tools=full')).toEqual({ reasoning: 'preview', tools: 'full' });
    expect(parseVerbosity('summary=off')).toEqual({ summary: false });
    expect(parseVerbosity('preview')).toEqual({ reasoning: 'preview' });
    expect(parseVerbosity('full')).toEqual({ reasoning: 'full', tools: 'full', summary: true });
    expect(parseVerbosity('loud')).toBeNull();
  });
  test('look & feel preview follows the levels', () => {
    const q = verbosityPreview({ ...DEFAULT_PREFS, tools: 'quiet', summary: false }, 100, T0).join('\n');
    expect(P(q)).toContain('read 1 · edit 1 · ran 1');
    expect(P(q)).not.toContain('done in');
    const f = P(verbosityPreview({ ...DEFAULT_PREFS, reasoning: 'full' }, 100, T0).join('\n'));
    expect(f).toContain('The loop stops one short.');
    expect(f).toContain('┬ 3 steps');
  });
});

// ---------------------------------------------------------------- setup
describe('setup box', () => {
  test('3 choices in one small rounded box, constant width', () => {
    const l = setupChoiceLines(1, 100);
    const p = l.map(P);
    expect(p.some((x) => x.includes('ChatGPT subscription (login)'))).toBe(true);
    expect(p.some((x) => x.includes('❯ Any API (endpoint + key)'))).toBe(true);
    expect(p.some((x) => x.includes('Local model (scan my hardware)'))).toBe(true);
    expect(new Set(l.map(width)).size).toBe(1);
  });
  test('presets by name; URL normalization; local detection', () => {
    expect(resolvePreset('openrouter')!.base_url).toBe('https://openrouter.ai/api/v1');
    expect(resolvePreset('ollama')!.base_url).toBe('http://localhost:11434/v1');
    expect(resolvePreset('LM Studio')!.base_url).toBe('http://localhost:1234/v1');
    expect(resolvePreset('anthropic')!.id).toBe('anthropic-compatible');
    expect(resolvePreset('https://x/v1')).toBeNull();
    expect(normalizeUrl('api.groq.com/openai/v1/')).toBe('https://api.groq.com/openai/v1');
    expect(normalizeUrl('localhost:8080/v1')).toBe('http://localhost:8080/v1');
    expect(isLocalUrl('http://localhost:11434/v1')).toBe(true);
    expect(PRESETS[0].base_url).toBe('https://api.openai.com/v1');
  });
  test('API key is never rendered: dots while typing, "hidden" afterwards', () => {
    const f = newApiForm();
    f.step = 'key';
    f.key = 'sk-supersecret';
    const typing = apiFormLines(f, 100).join('\n');
    expect(typing).not.toContain('supersecret');
    expect(P(typing)).toContain('••••••••••••••');
    f.step = 'models';
    f.models = ['gpt-4.1'];
    const later = apiFormLines(f, 100).join('\n');
    expect(later).not.toContain('supersecret');
    expect(P(later)).toContain('key   hidden');
  });
  test('plain errors for 401 / 404 / timeout', () => {
    expect(plainError(401, 'models').message).toContain('bad key');
    expect(plainError(404, 'models').message).toContain('wrong URL');
    expect(plainError(null, 'chat', Object.assign(new Error('x'), { name: 'TimeoutError' })).message).toContain('timeout');
  });
  test('falls back to the endpoint directly when the engine has no /api/provider/test', async () => {
    const api: any = { post: async () => { const e: any = new Error('nf'); e.status = 404; throw e; } };
    const calls: string[] = [];
    const fake: any = async (url: string, init: any) => {
      calls.push(url + ' ' + (init?.headers?.Authorization ? 'auth' : 'noauth'));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { completion_tokens: 8 } }));
    };
    const list = await testEndpoint(api, 'https://x/v1', 'k', undefined, fake);
    expect(list).toMatchObject({ ok: true, models: ['m1', 'm2'] });
    const t = await testEndpoint(api, 'https://x/v1', 'k', 'm1', fake);
    expect(t.ok).toBe(true);
    expect(calls).toContain('https://x/v1/chat/completions auth');
    const bad: any = async () => new Response('{}', { status: 401 });
    expect((await testEndpoint(api, 'https://x/v1', 'k', undefined, bad)).error!.message).toContain('bad key');
  });
  test('ChatGPT login box: URL + spaced code, centered; models step', () => {
    const l = loginBoxLines({ state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'AB-12' }, 100, 0).map(P);
    expect(l.some((x) => x.includes('https://auth.openai.com/codex/device'))).toBe(true);
    expect(l.some((x) => x.includes('A B - 1 2'))).toBe(true);
    const m = loginBoxLines({ state: 'models', models: ['gpt-5.5', 'gpt-5-mini'], idx: 1 }, 100).map(P);
    expect(m.some((x) => x.includes('❯ gpt-5-mini'))).toBe(true);
  });
});

// ---------------------------------------------------------------- flags
describe('launch flags', () => {
  test('combine; bare pico = new chat (no resume)', () => {
    const a = parseArgs(['--yolo', '--model', 'gpt-5.5', '--effort', 'med', '--cwd', '/tmp']);
    expect(a).toMatchObject({ yolo: true, model: 'gpt-5.5', effort: 'medium', cwd: '/tmp', cont: false });
    expect(a.resume).toBeUndefined();
    const b = parseArgs([]);
    expect(b.cont).toBe(false);
    expect(b.resume).toBeUndefined();
    expect(b.resumePick).toBeUndefined();
  });
  test('-c, -r [id], -r alone opens the picker', () => {
    expect(parseArgs(['-c']).cont).toBe(true);
    expect(parseArgs(['-r', 's_12']).resume).toBe('s_12');
    expect(parseArgs(['-r']).resumePick).toBe(true);
    expect(parseArgs(['-r', '--yolo'])).toMatchObject({ resumePick: true, yolo: true });
  });
  test('--plan / --goal / --loop / --harness / --verbose / --setup / --login', () => {
    expect(parseArgs(['--plan', 'add a flag']).plan).toBe('add a flag');
    expect(parseArgs(['--goal', 'ship it']).goal).toBe('ship it');
    expect(parseArgs(['--loop', '10m', 'check CI']).loop).toBe('10m check CI');
    expect(parseArgs(['--loop', 'until-done', 'fix tests']).loop).toBe('until-done fix tests');
    expect(parseArgs(['--harness', 'hermes']).harness).toBe('hermes');
    expect(parseArgs(['--verbose', 'quiet']).verbose).toBe('quiet');
    expect(parseArgs(['--setup']).setup).toBe(true);
    expect(parseArgs(['--login']).login).toBe(true);
    expect(parseArgs(['--effort', 'off']).effort).toBe('low'); // 'off' is gone: maps to low
  });
  test('-h: cat + every flag + examples', () => {
    const h = P(usage());
    expect(h).toContain('( o.o )  pico');
    for (const f of ['--yolo', '--model', '--effort', '--cwd', '-c, --continue', '-r, --resume', '-p, --print', '--plan', '--goal', '--loop', '--setup', '--login', '--verbose'])
      expect(h).toContain(f);
    expect(h).not.toContain('--harness'); // dev-only flag, hidden from help
    expect(h).toContain('pico --yolo');
    expect(h).toContain('pico -c');
    expect(h).toContain('pico --model gpt-5.5');
  });
});
