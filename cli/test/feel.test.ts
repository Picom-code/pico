// Feel/polish layer: yolo gate markers, mischievous + typing cat, blink, help/palette layout,
// approval box, markdown tables, bye line, sane tool labels from engine labels.
import { afterEach, describe, expect, test } from 'bun:test';
import { setAscii, stripAnsi, width } from '../src/ansi';
import { approvalBox, byeLine, overlayPanel } from '../src/app';
import { BUILTINS, helpLines } from '../src/commands';
import { fuzzyPositions } from '../src/fuzzy';
import { renderMarkdown, renderTable } from '../src/markdown';
import { blinking, catRows, faceFor, moodAt, TYPING_MS } from '../src/status';
import { applyEvent, newTurn, noticeLine, renderTurn, toolLabel, type ToolPart } from '../src/turn';
import { LiveScreen, type Terminal } from '../src/tty';

const P = (s: string) => stripAnsi(s);
afterEach(() => setAscii(false));

describe('yolo', () => {
  test('auto-approved notice marks the running command instead of splitting the tree', () => {
    const t = newTurn('clean up');
    applyEvent(t, 'tool_start', { id: 'a', name: 'terminal', args: { command: 'rm -rf ./build' }, label: 'terminal `rm -rf ./build`' });
    applyEvent(t, 'notice', { kind: 'yolo', text: 'auto-approved: rm -rf ./build' });
    applyEvent(t, 'tool_end', { id: 'a', ok: true, seconds: 0.2 });
    const out = renderTurn(t, 80).map(P);
    expect(out).toContain('  └─ ✓ rm -rf ./build  0.2s');
    expect(out).toContain('     → auto-approved');
    expect(t.parts.filter((p) => p.kind === 'notice').length).toBe(0);
    expect(out.join('\n')).not.toMatch(/⚡|🔥/u);
  });
  test('stray yolo notice (no running tool) is a dim → line', () => {
    expect(P(noticeLine('yolo', 'auto-approved: make clean'))).toBe('→ auto-approved make clean');
  });
  test('approval answers render under the gated command', () => {
    const t = newTurn('x');
    applyEvent(t, 'tool_start', { id: 'a', name: 'terminal', args: { command: 'rm x' } });
    applyEvent(t, 'gate', { gate: 'always', command: 'rm x' });
    expect(renderTurn(t, 80).map(P)).toContain('     ✓ always allowed');
    const u = newTurn('y');
    applyEvent(u, 'gate', { gate: 'denied', command: 'rm y' });
    expect(renderTurn(u, 80).map(P).join('\n')).toContain('✗ denied rm y');
  });
  test('cat looks mischievous at rest in yolo, normal otherwise', () => {
    const now = 3000;
    expect(catRows(moodAt({ busy: null, lastActivity: now, yolo: true }, now), now).rows[1]).toBe('( ¬.¬ )');
    expect(catRows(moodAt({ busy: null, lastActivity: now }, now), now).rows[1]).toBe('( o.o )');
    // working still shows the working face
    expect(moodAt({ busy: 'working', lastActivity: now, yolo: true }, now)).toBe('working');
    setAscii(true);
    expect(faceFor('yolo', now)).toBe('>.>');
  });
});

describe('cat touches', () => {
  test('watches the input while you type, then relaxes', () => {
    const now = 50_000;
    expect(moodAt({ busy: null, lastActivity: now, lastType: now - 100 }, now)).toBe('typing');
    expect(faceFor('typing', now + 1)).toBe('•.•');
    expect(moodAt({ busy: null, lastActivity: now, lastType: now - TYPING_MS - 1 }, now)).toBe('idle');
  });
  test('blinks at rest, sometimes twice; never while working', () => {
    expect(blinking('idle', 7000 * 2 + 10)).toBe(true);
    expect(blinking('yolo', 7000 * 2 + 10)).toBe(true);
    expect(blinking('idle', 7000 * 3 + 350)).toBe(true); // double blink cycle
    expect(blinking('idle', 7000 * 2 + 350)).toBe(false);
    expect(blinking('working', 7000 * 2 + 10)).toBe(false);
  });
  test('bye line', () => {
    expect(P(byeLine(null))).toBe('  (^.^)ﾉ bye for now');
    expect(P(byeLine('s_1'))).toBe('  (^.^)ﾉ bye for now · resume with pico -r s_1');
    setAscii(true);
    expect(P(byeLine(null))).toBe('  (^.^)/ bye for now');
  });
});

describe('help + palette', () => {
  test('/help: aligned key and command columns, skills section, fits width', () => {
    const cmds = [...BUILTINS.filter((c) => !c.alias), { name: 'weekly-review-planning', desc: 'Weekly reset', local: false, skill: true }];
    const lines = helpLines(100, cmds).map(P);
    expect(lines[0]).toBe('  keys');
    const cmdRows = lines.slice(lines.indexOf('  commands')).filter((l) => /^  \/\S/.test(l));
    const col = cmdRows.map((l) => /^  \/\S+ +/.exec(l)![0].length);
    expect(new Set(col).size).toBe(1); // every description starts in the same column
    expect(lines).toContain('  skills · 1');
    expect(lines.join('\n')).toContain('/weekly-review-planning');
    for (const l of helpLines(50, cmds)) expect(width(l)).toBeLessThanOrEqual(50);
  });
  test('palette highlights fuzzy matches and shows a key hint', () => {
    expect(fuzzyPositions('thm', 'theme')).toEqual([0, 1, 3]);
    expect(fuzzyPositions('em', 'theme')).toEqual([2, 3]);
    const o = { kind: 'palette' as const, items: [{ label: '/theme', hint: 'accent color', value: 'theme' }], idx: 0, query: 'thm' };
    const lines = overlayPanel(o, 80);
    expect(P(lines[0])).toBe('  ❯ /theme  accent color');
    expect(P(lines[1])).toContain('tab complete');
    expect(P(overlayPanel({ ...o, items: [] }, 80)[0])).toBe('  no matching commands');
    // long labels are cut as plain text: no escape fragments leak into the row
    const long = overlayPanel({ kind: 'palette', idx: 0, query: 'lo', items: [{ label: '/loop [5m|until-done|stop] <prompt> and more', value: 'loop', hint: 'x' }] }, 80);
    expect(P(long[0])).not.toMatch(/\[(0|22|39)m/); // no SGR reset fragments in the visible text
    expect(P(long[0])).toContain('/loop [5m|until-done|stop] <…');
  });
});

describe('approval box', () => {
  test('compact box sized to the command, y/n/a footer', () => {
    const lines = approvalBox({ command: 'rm -rf ./build', reason: 'Delete the build dir.' }, 120).map(P);
    expect(lines[0]).toMatch(/^  ╭─ run this\? ─+╮$/);
    expect(lines[1]).toContain('› rm -rf ./build');
    expect(lines[3]).toMatch(/╰─ y allow · n deny · a always ─+╯$/);
    expect(width(lines[0])).toBeLessThan(70);
    for (const l of approvalBox({ command: 'x'.repeat(300) }, 50)) expect(width(l)).toBeLessThanOrEqual(50);
  });
});

describe('markdown tables', () => {
  test('aligned columns, bold header, ─┼─ rule, right-align', () => {
    const md = '| Item | Value |\n|---|---:|\n| add(2, 3) | 5 |\n| mean([1,2,3]) | 2.0 |';
    const out = renderMarkdown(md, 80).map(P);
    expect(out[0]).toBe('Item          │ Value');
    expect(out[1]).toBe('──────────────┼──────');
    expect(out[2]).toBe('add(2, 3)     │     5');
    expect(out[3]).toBe('mean([1,2,3]) │   2.0');
  });
  test('shrinks to fit narrow widths', () => {
    const rows = ['| a very long header cell | another long header |', '|---|---|', '| x | y |'];
    for (const l of renderTable(rows, 30)) expect(width(l)).toBeLessThanOrEqual(30);
  });
  test('headings get a blank line above', () => {
    const out = renderMarkdown('intro\n## Next\nbody', 40).map(P);
    expect(out).toEqual(['intro', '', 'Next', 'body']);
  });
});

describe('tool labels from the engine', () => {
  const mk = (name: string, label?: string, args: unknown = {}): ToolPart => ({ kind: 'tool', id: 'x', name, args, label, start: 0 });
  test("strip 'terminal `…`' wrapper and avoid doubled verbs", () => {
    expect(toolLabel(mk('terminal', 'terminal `python3 test_calc.py`'))).toBe('python3 test_calc.py');
    expect(toolLabel(mk('patch', 'edit calc.py'))).toBe('edit calc.py');
    expect(toolLabel(mk('web_search', 'web search "bun"'))).toBe('web search "bun"');
    expect(toolLabel(mk('read_file', undefined, { path: 'a.py' }))).toBe('read a.py');
  });
});

describe('halted turns', () => {
  test('tools still open when a turn errors stop spinning', () => {
    const t = newTurn('x');
    applyEvent(t, 'tool_start', { id: 'a', name: 'read_file', args: { path: 'calc.py' } });
    applyEvent(t, 'error', { message: 'OperationalError: database or disk is full' });
    const out = renderTurn(t, 80).map(P);
    expect(out).toContain('  └─ ■ read calc.py');
    expect(out.join('\n')).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});

describe('scrollback gap', () => {
  test('LiveScreen tracks whether scrollback ends blank', () => {
    const term = { cols: 40, rows: 20, write: () => {} } as unknown as Terminal;
    const sc = new LiveScreen(term);
    expect(sc.lastBlank).toBe(true);
    sc.commit(['  (^.^)✧ done']);
    expect(sc.lastBlank).toBe(false);
    sc.commit(['\x1b[0m']);
    expect(sc.lastBlank).toBe(true);
  });
});
