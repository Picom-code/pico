// Unit tests for the polish layer: context bar, diff renderer, summary, tool-line state machine,
// subagent panel, /agents panel, glyph fallback, diff-rendering LiveScreen.
import { afterEach, describe, expect, test } from 'bun:test';
import { C, fg, fmtK, fmtSecs, setAscii, setColorMode, stripAnsi, width } from '../src/ansi';
import { applySubagent, normalizeSubagents, renderSubagents, type Subagent } from '../src/agents';
import { agentsPanelLines } from '../src/app';
import { diffSummary, parseUnified, renderDiff } from '../src/diff';
import {
  blinking, cachedPct, catRows, CTX_COLOR, ctxBar, ctxLevel, ctxTick, faceBadge, faceFor, fmtCtxPair, moodAt, moodExtra, renderCtx, renderSummary, summaryParts,
  type CtxState,
} from '../src/status';
import { applyEvent, newTurn, renderToolTree, renderTurn, thinkingLine, toolLabel, toolState, type ToolPart } from '../src/turn';
import { LiveScreen, spinFrame, type Terminal } from '../src/tty';

const P = (s: string) => stripAnsi(s);
afterEach(() => {
  setAscii(false);
  setColorMode('256');
});

describe('context bar', () => {
  test('formats 38k/128k', () => {
    expect(fmtCtxPair(38000, 131072)).toBe('38k/128k');
    expect(fmtCtxPair(1800, 128000)).toBe('1.8k/128k');
    expect(fmtCtxPair(950, 65536)).toBe('950/64k');
    expect(fmtK(272000)).toBe('272k');
    expect(fmtK(92000)).toBe('92k');
  });
  test('color thresholds: accent <80, amber 80-95, red >95', () => {
    expect(ctxLevel(0)).toBe('accent');
    expect(ctxLevel(0.799)).toBe('accent');
    expect(ctxLevel(0.8)).toBe('amber');
    expect(ctxLevel(0.949)).toBe('amber');
    expect(ctxLevel(0.95)).toBe('red');
    expect(CTX_COLOR.accent).toBe(C.accent);
    expect(CTX_COLOR.amber).toBe(214);
  });
  test('pill bar: ▰ filled, ▱ dim, constant width, any usage shows a pill', () => {
    expect(P(ctxBar(0, 10))).toBe('▱'.repeat(10));
    expect(P(ctxBar(0.5, 10))).toBe('▰▰▰▰▰▱▱▱▱▱');
    expect(P(ctxBar(0.01, 10))).toBe('▰▱▱▱▱▱▱▱▱▱');
    expect(P(ctxBar(1, 12))).toBe('▰'.repeat(12));
    expect(width(ctxBar(0.37, 10))).toBe(10);
    expect(ctxBar(0.6, 10, 205)).toContain('\x1b[38;5;205m▰▰▰▰▰▰');
    expect(ctxBar(0.6, 10, 205)).toContain('\x1b[38;5;240m▱▱▱▱'); // dim empties
  });
  test('ASCII fallback', () => {
    setAscii(true);
    expect(P(ctxBar(0.5, 10))).toBe('[#####-----]');
  });
  test('segment: pills + numbers, cached %, /compact hint > 85%', () => {
    const s: CtxState = { used: 9000, max: 131072, shown: 9000, cached: 0.92 };
    expect(P(renderCtx(s))).toBe('▰▱▱▱▱▱▱▱▱▱ 9k/128k cached 92%');
    expect(renderCtx(s)).toContain(fg(C.accent)('▰'));
    const hi: CtxState = { used: 115000, max: 131072, shown: 115000 };
    expect(P(renderCtx(hi))).toContain('run /compact');
    expect(renderCtx(hi)).toContain('\x1b[38;5;214m'); // amber
    expect(renderCtx({ used: 126000, max: 131072, shown: 126000 })).toContain('\x1b[38;5;203m'); // red
    expect(P(renderCtx(hi, Date.now(), true))).toBe('▰▰▰▰▰▱ 115k/128k run /compact');
  });
  test('compacted pulse label', () => {
    const now = 1_000_000;
    const s: CtxState = { used: 18000, max: 131072, shown: 18000, compact: { before: 92000, after: 18000, at: now - 100 } };
    expect(P(renderCtx(s, now))).toContain('↺ compacted 92k→18k');
    expect(renderCtx(s, now)).toContain('38;5;231'); // white pulse during first 450ms
    expect(P(renderCtx(s, now + 5000))).not.toContain('compacted');
  });
  test('animates smoothly toward target', () => {
    const s: CtxState = { used: 100000, max: 131072, shown: 0 };
    ctxTick(s, 80);
    expect(s.shown).toBeGreaterThan(0);
    expect(s.shown).toBeLessThan(100000);
    for (let i = 0; i < 50; i++) ctxTick(s, 80);
    expect(s.shown).toBe(100000);
    expect(ctxTick(s, 80)).toBe(false);
  });
  test('cachedPct accepts fraction or tokens', () => {
    expect(cachedPct(0.92, 1000)).toBe(92);
    expect(cachedPct(500, 1000)).toBe(50);
    expect(cachedPct(undefined, 1000)).toBeNull();
  });
  test('truecolor mode emits RGB', () => {
    setColorMode('truecolor');
    expect(ctxBar(0.6, 10, 205)).toContain('\x1b[38;2;255;95;175m');
    expect(ctxBar(0.6, 10)).toContain('\x1b[38;2;255;46;153m'); // hot pink #ff2e99 exact
  });
});

describe('diff renderer', () => {
  const unified = ['--- a/x', '+++ b/x', '@@ -10,3 +10,4 @@ fn', ' keep', '-old', '+new1', '+new2', ' tail'].join('\n');
  test('parse numbers lines', () => {
    const rows = parseUnified(unified);
    expect(rows.map((r) => r.kind).join('')).toBe('@ -++ ');
    expect(rows[1]).toMatchObject({ old: 10, neu: 10, text: 'keep' });
    expect(rows[2]).toMatchObject({ old: 11, text: 'old' });
    expect(rows[3]).toMatchObject({ neu: 11, text: 'new1' });
  });
  test('header + colored rows', () => {
    const out = renderDiff({ path: 'src/app.ts', added: 2, removed: 1, unified }, 60);
    expect(P(out[0])).toBe('✎ src/app.ts  +2 −1');
    expect(P(out[2])).toMatch(/^10 {3}keep/);
    expect(P(out[3])).toMatch(/^11 - old/);
    expect(out[3]).toContain('\x1b[48;5;52m'); // red-ish bg
    expect(out[4]).toContain('\x1b[48;5;22m'); // green-ish bg
    expect(out[4]).toContain('\x1b[38;5;114m');
    for (const l of out) expect(width(l)).toBeLessThanOrEqual(60);
  });
  test('truncates to 12 rows with ctrl+o hint; expanded shows all', () => {
    const big = ['@@ -1,0 +1,30 @@', ...Array.from({ length: 30 }, (_, i) => `+line ${i}`)].join('\n');
    const d = { path: 'big.ts', added: 30, removed: 0, unified: big };
    const out = renderDiff(d, 70).map(P);
    expect(out.length).toBe(1 + 12 + 1);
    expect(out.at(-1)).toContain('… +19 more (ctrl+o)');
    expect(renderDiff(d, 70, { expanded: true }).length).toBe(1 + 31);
  });
  test('created file header', () => {
    expect(P(renderDiff({ path: 'new.txt', added: 2, removed: 0, created: true, unified: '@@ -0,0 +1,2 @@\n+a\n+b' }, 40)[0])).toBe('✎ new.txt  new  +2');
  });
  test('ASCII fallback: no backgrounds, plain glyphs', () => {
    setAscii(true);
    const out = renderDiff({ path: 'x', added: 2, removed: 1, unified }, 60);
    expect(P(out[0])).toBe('* x  +2 -1');
    expect(out.join('')).not.toContain('\x1b[48');
    expect(P(out.at(-1)!)).toMatch(/^\d+ {3}tail/);
    expect(P(out[1])).toContain('~ fn');
  });
});

describe('turn summary', () => {
  test('cat sign-off: formats all parts', () => {
    const s = { tools: 3, files_changed: [{ path: 'calc.py', added: 1, removed: 1 }], seconds: 4.1, tps: 51.2, output_tokens: 1800 };
    expect(summaryParts(s)).toEqual(['done in 4.1s', '3 tools', '1 file +1 −1', '51 tok/s']);
    expect(P(renderSummary(s))).toBe('(^.^)✧ done in 4.1s · 3 tools · 1 file +1 −1 · 51 tok/s');
    expect(renderSummary(s).startsWith(fg(C.accent)('(^.^)✧'))).toBe(true); // cat in accent
    expect(renderSummary(s)).toContain('\x1b[38;5;242mdone in'); // rest dim
    expect(P(renderSummary(s, false))).toMatch(/^\(x\.x\)! /);
    expect(P(renderSummary(s, true, 30))).toBe('(^.^)✧ done in 4.1s · 3 tools'); // narrow: drop tail parts
  });
  test('singular + omits empties', () => {
    expect(P(renderSummary({ tools: 1, seconds: 0.4 }))).toBe('(^.^)✧ done in 0.4s · 1 tool');
    expect(P(renderSummary({}))).toBe('(^.^)✧ done');
    expect(fmtSecs(125)).toBe('2m 5s');
    setAscii(true);
    expect(P(renderSummary({}))).toBe('(^.^)* done');
  });
  test('derived from parts when engine omits summary', () => {
    const t = newTurn('x');
    applyEvent(t, 'tool_start', { id: '1', name: 'patch' });
    applyEvent(t, 'tool_end', { id: '1', ok: true, seconds: 0.1, diff: { path: 'a.ts', added: 3, removed: 1, unified: '' } });
    applyEvent(t, 'done', { usage: { output: 50 }, seconds: 1.2, tps: 40 });
    expect(P(renderTurn(t, 80).at(-1)!)).toBe('  (^.^)✧ done in 1.2s · 1 tool · 1 file +3 −1 · 40 tok/s');
  });
});

describe('tool tree', () => {
  const T0 = 1_000_000;
  test('┬ N steps, ├─/└─ rows, live tail ╰ under the running one, ✓/✗ + seconds, parallel tools', () => {
    const t = newTurn('go');
    applyEvent(t, 'tool_start', { id: 'a', name: 'read_file', args: { path: 'calc.py' } }, T0);
    applyEvent(t, 'tool_start', { id: 'b', name: 'patch', args: { path: 'calc.py' } }, T0);
    applyEvent(t, 'tool_start', { id: 'c', name: 'terminal', args: { command: 'pytest -q' } }, T0);
    applyEvent(t, 'tool_end', { id: 'a', ok: true, seconds: 0.1 }, T0 + 100);
    applyEvent(t, 'tool_end', { id: 'b', ok: true, seconds: 0.0, diff: { path: 'calc.py', added: 1, removed: 1, unified: '@@ -1 +1 @@\n-for i in range(n - 1):\n+for i in range(n):' } }, T0 + 100);
    applyEvent(t, 'tool_progress', { id: 'c', tail: ['1', '2', '3', '4', '5', '4 passed'] }, T0 + 300);
    const c = t.parts[2] as ToolPart;
    expect(toolState(c)).toBe('running');
    expect(c.tail).toEqual(['1', '2', '3', '4', '5', '4 passed']); // kept for tools=full; normal renders the last 4
    const tree = renderToolTree(t.parts as ToolPart[], 70, { now: T0 + 400 }).map(P);
    expect(tree[0]).toBe('┬ 3 steps');
    expect(tree[1]).toBe('├─ ✓ read calc.py  0.1s');
    expect(tree[2]).toBe('├─ ✓ patch calc.py  0.0s');
    expect(tree[3]).toBe('│  ✎ calc.py  +1 −1  (ctrl+o to see)');
    expect(tree[4]).toMatch(/^└─ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] pytest -q  0\.4s$/);
    expect(tree.slice(5)).toEqual(['   ╰ 3', '     4', '     5', '     4 passed']);
    const raw = renderToolTree(t.parts as ToolPart[], 70, { now: T0 + 400 });
    expect(raw[1]).toContain('\x1b[38;5;114m✓'); // green check
    expect(raw[4]).toContain(fg(C.accent)(spinFrame(T0 + 400))); // accent spinner
    expect(raw[5]).toContain('\x1b[38;5;242m3'); // dim tail
    // the turn groups consecutive tools under one header
    const live = renderTurn(t, 80, { live: true, now: T0 + 400 }).map(P);
    expect(live.filter((l) => l.includes('┬')).length).toBe(1);
    applyEvent(t, 'tool_end', { id: 'c', ok: false, seconds: 2.1, result_preview: 'E   assert 4 == 5' }, T0 + 2100);
    expect(c.tail).toBeUndefined();
    const done = renderToolTree(t.parts as ToolPart[], 70).map(P);
    expect(done[4]).toBe('└─ ✗ pytest -q  2.1s');
    expect(done[5]).toBe('   ╰ E   assert 4 == 5');
    for (const l of renderToolTree(t.parts as ToolPart[], 30)) expect(width(l)).toBeLessThanOrEqual(30);
  });
  test('summary-only diff; ctrl+o (expanded) shows the full colored diff', () => {
    const t = newTurn('go');
    const unified = '@@ -1,2 +1,2 @@\n x = 1\n-for i in range(n - 1):\n+for i in range(n):';
    applyEvent(t, 'tool_start', { id: 'a', name: 'patch', args: { path: 'calc.py' } });
    applyEvent(t, 'tool_end', { id: 'a', ok: true, seconds: 0.3, diff: { path: 'calc.py', added: 1, removed: 1, unified } });
    const col = renderTurn(t, 80).map(P);
    expect(col).toContain('     ✎ calc.py  +1 −1  (ctrl+o to see)');
    expect(col.join('\n')).not.toContain('range(n)');
    expect(P(diffSummary({ path: 'calc.py', added: 1, removed: 1 }))).toBe('✎ calc.py  +1 −1  (ctrl+o to see)');
    t.expanded = true;
    const ex = renderTurn(t, 80);
    const exP = ex.map(P).join('\n');
    expect(exP).toContain('✎ calc.py  +1 −1');
    expect(exP).not.toContain('ctrl+o to see');
    expect(exP).toContain('- for i in range(n - 1):');
    expect(ex.join('')).toContain('\x1b[48;5;22m'); // green bg row
  });
  test('labels: verbs for file tools, raw command for terminal', () => {
    const mk = (name: string, args: unknown, label?: string): ToolPart => ({ kind: 'tool', id: 'x', name, args, label, start: 0 });
    expect(toolLabel(mk('read_file', { path: 'calc.py' }))).toBe('read calc.py');
    expect(toolLabel(mk('terminal', { command: 'pytest -q' }))).toBe('pytest -q');
    expect(toolLabel(mk('patch', {}, 'src/app.ts'))).toBe('patch src/app.ts');
    expect(toolLabel(mk('mystery', {}))).toBe('mystery');
  });
  test('ASCII: |- `- tree, v/x, |/-\\ spinner', () => {
    setAscii(true);
    const ok: ToolPart = { kind: 'tool', id: 'x', name: 'terminal', args: { command: 'ls' }, start: 0, end: 100, ok: true, seconds: 0.1 };
    const run: ToolPart = { kind: 'tool', id: 'y', name: 'terminal', args: { command: 'make' }, start: 0, tail: ['ok'] };
    const out = renderToolTree([ok, run], 60, { now: 0 }).map(P);
    expect(out).toEqual(['+ 2 steps', '|- v ls  0.1s', '`- | make  0.0s', '   ` ok']);
  });
});

describe('notices, thinking, faces', () => {
  test('notice lines in a turn', () => {
    const t = newTurn('remember my dog');
    applyEvent(t, 'notice', { kind: 'memory', text: 'dog is Biscuit' });
    applyEvent(t, 'notice', { kind: 'skill', text: 'deploy-checklist' });
    const out = renderTurn(t, 80).map(P).join('\n');
    expect(out).toContain('+ remembered: dog is Biscuit');
    expect(out).toContain('+ new skill: deploy-checklist');
  });
  test('thinking: shimmer sweeps the word in accent, live seconds timer', () => {
    const t = newTurn('x', [], 'high');
    applyEvent(t, 'reasoning', { text: 'pondering' }, 1000);
    const live = renderTurn(t, 80, { live: true, now: 5100 });
    const line = live.find((l) => P(l).includes('thinking'))!;
    expect(P(line)).toBe('  thinking 4.1s');
    expect(line).toContain(fg(C.accent)('X').split('X')[0]); // some letters lit in accent
    expect(line).not.toContain('pondering');
    // the lit window moves over time
    const a = thinkingLine(0, 0);
    const b = thinkingLine(0, 270);
    expect(P(a)).toBe('thinking 0.0s');
    expect(a).not.toBe(b);
    // finished: '✻ thought 4.1s  ctrl+o'
    applyEvent(t, 'delta', { text: 'ok' }, 5100);
    expect(renderTurn(t, 80).map(P)).toContain('  ✻ thought 4.1s  ctrl+o');
  });
  test('plain blocks: no ● gutter / │ guide, › user line, rule between turns', () => {
    const t = newTurn('fix the off-by-one');
    applyEvent(t, 'delta', { text: 'Found it.' });
    applyEvent(t, 'done', { seconds: 1 });
    const out = renderTurn(t, 60, { separator: true, style: 'plain' }).map(P);
    expect(out[1]).toBe('─'.repeat(60));
    expect(out).toContain('› fix the off-by-one');
    expect(out).toContain('  Found it.');
    expect(out.join('\n')).not.toMatch(/[●│]/);
    expect(out.at(-2)).toBe('');
  });
  test('faces with amber extras by state; done lingers 1.5s, asleep after 60s, rare blink', () => {
    const now = 100_000;
    expect(moodAt({ busy: 'thinking', lastActivity: now }, now)).toBe('thinking');
    expect(moodAt({ busy: 'working', lastActivity: now }, now)).toBe('working');
    expect(moodAt({ busy: null, lastEnd: { at: now - 1000, ok: true }, lastActivity: now }, now)).toBe('done');
    expect(moodAt({ busy: null, lastEnd: { at: now - 2000, ok: true }, lastActivity: now }, now)).toBe('idle');
    expect(moodAt({ busy: null, lastEnd: { at: now - 100, ok: false }, lastActivity: now }, now)).toBe('error');
    expect(moodAt({ busy: null, lastActivity: now - 61_000 }, now)).toBe('asleep');
    const awake = 3000; // not in a blink window
    const want: Record<string, string> = { idle: '(o.o)', thinking: '(o.O)?', working: '(>.<)~', done: '(^.^)✧', error: '(x.x)!', asleep: '(-.-)zZ' };
    for (const [m, s] of Object.entries(want)) expect(P(faceBadge(m as any, awake))).toBe(s);
    expect(faceBadge('done', awake)).toContain('\x1b[38;5;214m✧'); // amber extra
    const rows = catRows('thinking', awake);
    expect(rows.rows).toEqual([' /\\_/\\ ', '( o.O )', ' > ^ < ']);
    expect(rows.extra).toBe('?');
    expect(blinking('idle', 7000 * 3 + 50)).toBe(true);
    expect(blinking('idle', 7000 * 3 + 500)).toBe(false);
    expect(blinking('working', 50)).toBe(false);
    expect(faceFor('idle', 7000 + 10)).toBe('-.-');
    setAscii(true);
    expect(moodExtra('done')).toBe('*');
  });
});

describe('subagents', () => {
  test('grouped panel, live steps, collapse when all finish, ctrl+o expands', () => {
    const list: Subagent[] = [];
    const t0 = 1000;
    applySubagent(list, 'subagent_start', { id: 'a', goal: 'Survey the renderer' }, t0);
    applySubagent(list, 'subagent_start', { id: 'b', goal: 'Write tests' }, t0);
    applySubagent(list, 'subagent_progress', { id: 'a', label: 'reading tty.ts' }, t0);
    let out = renderSubagents(list, 80, { now: t0 + 1500 }).map(P);
    expect(out[0]).toBe('⎇ 2 subagents  0/2 done');
    expect(out[1]).toMatch(/Survey the renderer +reading tty\.ts {2}1\.5s$/);
    applySubagent(list, 'subagent_end', { id: 'a', ok: true, summary: 'all good', seconds: 1.4, tokens: 3120 }, t0 + 1400);
    applySubagent(list, 'subagent_end', { id: 'b', ok: false, summary: 'no box', seconds: 1.0, tokens: 900 }, t0 + 1500);
    out = renderSubagents(list, 80).map(P);
    expect(out).toEqual(['✗ ⎇ 2 subagents  1/2 ok · 1.4s · 4k tok  ctrl+o']);
    const ex = renderSubagents(list, 80, { expanded: true }).map(P);
    expect(ex[0]).toBe('⎇ 2 subagents');
    expect(ex.join('\n')).toContain('⎿ all good');
    expect(ex.join('\n')).toContain('3.1k tok');
    for (const l of renderSubagents(list, 40, { expanded: true })) expect(width(l)).toBeLessThanOrEqual(40);
  });
  test('settings normalization', () => {
    expect(normalizeSubagents({ max_parallel: 99, effort: 'nope', model: 'same' })).toMatchObject({ max_parallel: 8, effort: 'low', model: '' });
    expect(normalizeSubagents(null).enabled).toBe(true);
  });
  test('/agents panel: rounded box, accent values, explanations', () => {
    const s = normalizeSubagents({ enabled: true, max_parallel: 3, model: 'gpt-oss-20b', effort: 'medium', max_seconds: 600 });
    const lines = agentsPanelLines(s, 1, [{ id: 'gpt-oss-20b', name: 'gpt-oss 20B' }], 'Qwen', 80);
    const txt = lines.map(P);
    expect(txt[0]).toMatch(/^ {2}╭─ ⎇ subagents ─+╮$/);
    expect(txt.at(-1)).toMatch(/╯$/);
    expect(txt.join('\n')).toContain('❯ max parallel  ‹ 3 ━━━━━━━━ ›');
    expect(txt.join('\n')).toContain('gpt-oss 20B');
    expect(txt.join('\n')).toContain('10 min');
    expect(txt.join('\n')).toContain('How many helpers may run at once');
    expect(txt.join('\n')).not.toContain('…');
    expect(lines.join('')).toContain(fg(C.accent)('3'));
    const w0 = width(lines[0]);
    for (const l of lines) expect(width(l)).toBe(w0);
  });
});

describe('LiveScreen diff rendering', () => {
  const fake = () => {
    const writes: string[] = [];
    const term = { cols: 40, rows: 20, write: (s: string) => writes.push(s) } as unknown as Terminal;
    return { term, writes };
  };
  test('only changed rows are rewritten; identical frames write nothing', () => {
    const { term, writes } = fake();
    const sc = new LiveScreen(term);
    sc.render({ lines: ['a', 'b', 'c'] });
    const first = writes.length;
    sc.render({ lines: ['a', 'b', 'c'] });
    expect(writes.length).toBe(first);
    sc.render({ lines: ['a', 'X', 'c'] });
    const last = writes.at(-1)!;
    expect(last).toContain('X');
    expect(last).not.toContain('a\x1b');
    expect(last).not.toContain('\x1b[J'); // no clear-to-end on a same-height update
  });
  test('commit forces a full redraw with the committed line', () => {
    const { term, writes } = fake();
    const sc = new LiveScreen(term);
    sc.render({ lines: ['a'] });
    sc.commit(['done']);
    sc.render({ lines: ['a'] });
    expect(writes.at(-1)).toContain('done');
    expect(writes.at(-1)).toContain('\x1b[J');
  });
});
