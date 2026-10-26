import { setColorMode as __scm } from '../src/ansi';
__scm('256'); // tests assert 256-color SGR regardless of COLORTERM
import { describe, expect, test } from 'bun:test';
import { stripAnsi, truncate, width, wrap } from '../src/ansi';
import { Editor } from '../src/editor';
import { EFFORT_COLOR, effortList, EFFORTS, nextEffort, normalizeEffort } from '../src/effort';
import { fuzzyFilter } from '../src/fuzzy';
import { isNewline, KeyParser, parseKeys } from '../src/keys';
import { highlight, inline, renderMarkdown } from '../src/markdown';
import { SSEParser, type SSEEvent } from '../src/sse';
import { applyEvent, newTurn, renderTurn, summarizeArgs } from '../src/turn';
import { parseArgs } from '../src/main';

const plain = (ls: string[]) => ls.map(stripAnsi);

describe('SSE parser', () => {
  const collect = (chunks: string[]) => {
    const out: SSEEvent[] = [];
    const p = new SSEParser((e) => out.push(e));
    for (const c of chunks) p.feed(c);
    p.end();
    return out;
  };
  test('basic events', () => {
    const ev = collect(['event: delta\ndata: {"text":"hi"}\n\nevent: done\ndata: {}\n\n']);
    expect(ev).toEqual([
      { event: 'delta', data: '{"text":"hi"}' },
      { event: 'done', data: '{}' },
    ]);
  });
  test('split at every byte boundary', () => {
    const src = 'event: delta\r\ndata: {"text":"a b"}\r\n\r\n: comment\n\nevent: x\ndata: 1\n\n';
    const ev = collect(src.split(''));
    expect(ev.map((e) => e.event)).toEqual(['delta', 'x']);
    expect(ev[0].data).toBe('{"text":"a b"}');
  });
  test('multi-line data, default event, CR endings, id', () => {
    const ev = collect(['id: 7\rdata: line1\rdata: line2\r\r']);
    expect(ev).toEqual([{ event: 'message', data: 'line1\nline2', id: '7' }]);
  });
  test('flushes trailing event without blank line', () => {
    expect(collect(['event: done\ndata: {"ok":true}'])).toEqual([{ event: 'done', data: '{"ok":true}' }]);
  });
  test('field without space and empty data', () => {
    expect(collect(['event:ping\ndata\n\n'])).toEqual([{ event: 'ping', data: '' }]);
  });
});

describe('markdown renderer', () => {
  test('headings, lists, code fence, quote', () => {
    const md = '# Title\n\n- one\n- **two**\n  - nested\n1. first\n\n```ts\nconst x = "s"; // c\n```\n> quoted';
    const out = plain(renderMarkdown(md, 60));
    expect(out[0]).toBe('Title');
    expect(out).toContain('• one');
    expect(out).toContain('• two');
    expect(out).toContain('  • nested');
    expect(out).toContain('1. first');
    expect(out.some((l) => l.startsWith('╭─ ts ─'))).toBe(true);
    expect(out.some((l) => l.startsWith('│ const x = "s"; // c') && l.endsWith('│'))).toBe(true);
    expect(out.some((l) => l.startsWith('╰──') && l.endsWith('╯'))).toBe(true);
    expect(out).toContain('▎ quoted');
  });
  test('inline styles emit ANSI and strip cleanly', () => {
    const s = inline('a **b** *c* `d` [e](http://x)');
    expect(s).toContain('\x1b[1m');
    expect(s).toContain('\x1b[3m');
    expect(stripAnsi(s)).toBe('a b c d e http://x');
  });
  test('unclosed fence renders as code (streaming)', () => {
    const out = plain(renderMarkdown('text\n```py\nprint(1)', 40));
    expect(out[0]).toBe('text');
    expect(out[1]).toMatch(/^╭─ py ─+╮$/);
    expect(out[2]).toMatch(/^│ print\(1\) +│$/);
  });
  test('wraps long paragraphs to width', () => {
    const out = renderMarkdown('word '.repeat(40), 30);
    for (const l of out) expect(width(l)).toBeLessThanOrEqual(30);
    expect(out.length).toBeGreaterThan(5);
  });
  test('highlight keywords/strings/comments', () => {
    const h = highlight('const s = "x" // hi', 'ts');
    expect(h).toContain('\x1b[38;5;141mconst');
    expect(h).toContain('\x1b[38;5;114m"x"');
    expect(h).toContain('\x1b[38;5;242m// hi');
    expect(stripAnsi(h)).toBe('const s = "x" // hi');
  });
  test('snake_case is not italicized', () => {
    expect(stripAnsi(inline('my_var_name'))).toBe('my_var_name');
    expect(inline('my_var_name')).not.toContain('\x1b[3m');
  });
});

describe('ansi helpers', () => {
  test('width handles ANSI, CJK and emoji', () => {
    expect(width('\x1b[31mabc\x1b[0m')).toBe(3);
    expect(width('日本')).toBe(4);
    expect(width('hi 👋')).toBe(5);
  });
  test('truncate and wrap respect width', () => {
    expect(stripAnsi(truncate('\x1b[1mhello world\x1b[0m', 6))).toBe('hello…');
    const w = wrap('the quick brown fox jumps over', 10);
    expect(w.map(stripAnsi)).toEqual(['the quick', 'brown fox', 'jumps over']);
  });
});

describe('key parser', () => {
  const k1 = (s: string) => parseKeys(s)[0];
  test('shift+tab (legacy + kitty)', () => {
    expect(k1('\x1b[Z')).toMatchObject({ name: 'tab', shift: true });
    expect(k1('\x1b[9;2u')).toMatchObject({ name: 'tab', shift: true });
  });
  test('enter variants', () => {
    expect(k1('\r')).toMatchObject({ name: 'enter', shift: false });
    expect(isNewline(k1('\r'))).toBe(false);
    expect(isNewline(k1('\x1b[13;2u'))).toBe(true); // kitty shift+enter
    expect(isNewline(k1('\x1b[27;2;13~'))).toBe(true); // xterm modifyOtherKeys shift+enter
    expect(isNewline(k1('\x1b\r'))).toBe(true); // alt+enter (also Windows Terminal)
    expect(isNewline(k1('\n'))).toBe(true); // ctrl+j
  });
  test('arrows, modifiers, ctrl, esc, backspace', () => {
    expect(k1('\x1b[A').name).toBe('up');
    expect(k1('\x1bOB').name).toBe('down');
    expect(k1('\x1b[1;5D')).toMatchObject({ name: 'left', ctrl: true });
    expect(k1('\x03')).toMatchObject({ name: 'c', ctrl: true });
    expect(k1('\x0f')).toMatchObject({ name: 'o', ctrl: true });
    expect(k1('\x1b')).toMatchObject({ name: 'escape' });
    expect(k1('\x1b[27u')).toMatchObject({ name: 'escape' });
    expect(k1('\x7f').name).toBe('backspace');
    expect(k1('\b').name).toBe('backspace'); // Windows conhost
    expect(k1('\x1b[3~').name).toBe('delete');
    expect(k1('\x1bb')).toMatchObject({ name: 'b', alt: true });
  });
  test('printable text incl. unicode, multiple keys per chunk', () => {
    const ks = parseKeys('aB é👋');
    expect(ks.map((k) => k.ch)).toEqual(['a', 'B', ' ', 'é', '👋']);
  });
  test('bracketed paste spanning chunks', () => {
    const p = new KeyParser();
    expect(p.feed('x\x1b[200~line1\r\nli')).toHaveLength(1);
    const ks = p.feed('ne2\x1b[201~y');
    expect(ks[0]).toMatchObject({ name: 'paste', paste: 'line1\nline2' });
    expect(ks[1].ch).toBe('y');
  });
  test('unbracketed multi-line paste heuristic', () => {
    expect(k1('foo\r\nbar')).toMatchObject({ name: 'paste', paste: 'foo\nbar' });
    // typed text + Enter in one chunk is NOT a paste
    const ks = parseKeys('hi\r');
    expect(ks.map((k) => k.name)).toEqual(['h', 'i', 'enter']);
  });
  test('ESC followed by ctrl char = escape then key', () => {
    expect(parseKeys('\x1b\x15').map((k) => [k.name, k.ctrl])).toEqual([['escape', false], ['u', true]]);
    expect(parseKeys('\x1b\x7f')[0]).toMatchObject({ name: 'backspace', alt: true });
  });
});

describe('effort cycling', () => {
  test('cycles low → medium → high → low (no off)', () => {
    let e = EFFORTS[0];
    const seen = [e];
    for (let i = 0; i < 3; i++) seen.push((e = nextEffort(e)));
    expect(seen).toEqual(['low', 'medium', 'high', 'low']);
    expect(nextEffort('low', -1)).toBe('high');
  });
  test("saved/engine 'off' maps to low; med alias; engine list drops off, keeps max", () => {
    expect(normalizeEffort('off')).toBe('low');
    expect(normalizeEffort('med')).toBe('medium');
    expect(normalizeEffort('HIGH')).toBe('high');
    expect(normalizeEffort('turbo')).toBeNull();
    expect(effortList(['off', 'low', 'medium', 'high'])).toEqual(['low', 'medium', 'high']);
    expect(effortList(['off', 'low', 'medium', 'high', 'max'])).toEqual(['low', 'medium', 'high', 'max']);
    expect(effortList(undefined)).toEqual(['low', 'medium', 'high']);
  });
  test('each level has a distinct color', () => {
    expect(new Set(Object.values(EFFORT_COLOR)).size).toBe(4);
    expect(EFFORT_COLOR.low).toBe(80);
    expect(EFFORT_COLOR.high).toBe(214);
  });
});

describe('editor', () => {
  test('insert, newline, backspace across lines', () => {
    const e = new Editor();
    e.insert('ab');
    e.newline();
    e.insert('cd');
    expect(e.value).toBe('ab\ncd');
    e.home();
    e.backspace();
    expect(e.value).toBe('abcd');
    expect([e.row, e.col]).toEqual([0, 2]);
  });
  test('paste multi-line in the middle', () => {
    const e = new Editor();
    e.insert('XY');
    e.left();
    e.insert('1\n2\n3');
    expect(e.value).toBe('X1\n2\n3Y');
    expect([e.row, e.col]).toEqual([2, 1]);
  });
  test('history up/down restores draft', () => {
    const e = new Editor();
    e.pushHistory('first');
    e.pushHistory('second');
    e.insert('draft');
    e.historyPrev();
    expect(e.value).toBe('second');
    e.historyPrev();
    expect(e.value).toBe('first');
    e.historyNext();
    e.historyNext();
    expect(e.value).toBe('draft');
  });
  test('word ops and token before cursor', () => {
    const e = new Editor();
    e.insert('look at @src/ma');
    expect(e.tokenBeforeCursor()).toBe('@src/ma');
    e.replaceTokenBeforeCursor('@src/main.ts ');
    expect(e.value).toBe('look at @src/main.ts ');
    e.deleteWord();
    expect(e.value).toBe('look at @src/main.');
  });
  test('layout soft-wraps and tracks cursor', () => {
    const e = new Editor();
    e.insert('abcdefghij');
    const l = e.layout(4);
    expect(l.lines).toEqual(['abcd', 'efgh', 'ij']);
    expect([l.row, l.col]).toEqual([2, 2]);
  });
});

describe('turn rendering', () => {
  test('blocks: user, plain reply, tool tree, reasoning collapse, markdown, cat sign-off', () => {
    const t = newTurn('fix it');
    applyEvent(t, 'reasoning', { text: 'hmm' });
    applyEvent(t, 'tool_start', { id: '1', name: 'terminal', args: { command: 'uname -sm' } });
    applyEvent(t, 'tool_end', { id: '1', name: 'terminal', ok: true, result_preview: 'Darwin arm64', seconds: 0.4 });
    applyEvent(t, 'delta', { text: 'Done **now**' });
    applyEvent(t, 'done', { usage: { input: 10, output: 20 }, tps: 50, seconds: 0.4 });
    const lines = plain(renderTurn(t, 80));
    const out = lines.join('\n');
    expect(out).toContain('› fix it');
    expect(out).toMatch(/ {2}✻ thought \d/);
    expect(out).not.toContain('hmm');
    expect(out).toContain('  ┬ 1 step\n  └─ ✓ uname -sm  0.4s');
    expect(out).not.toContain('Darwin arm64'); // result previews only on failure / ctrl+o
    expect(out).toContain('\n  Done now\n');
    expect(lines.at(-1)).toBe('  (^.^)✧ done in 0.4s · 1 tool · 50 tok/s');
    t.expanded = true;
    const ex = plain(renderTurn(t, 80)).join('\n');
    expect(ex).toContain('hmm');
    expect(ex).toContain('╰ Darwin arm64');
    for (const l of renderTurn(t, 50)) expect(width(l)).toBeLessThanOrEqual(50);
  });
  test('summarizeArgs', () => {
    expect(summarizeArgs({ command: 'ls' })).toBe('ls');
    expect(summarizeArgs('{"path":"a.ts"}')).toBe('a.ts');
    expect(summarizeArgs({ x: 1 })).toBe('{"x":1}');
  });
});

describe('misc', () => {
  test('fuzzy palette filter', () => {
    const names = ['model', 'new', 'sessions', 'resume', 'memory', 'search', 'skills'];
    expect(fuzzyFilter(names, 'mo', (x) => x)[0]).toBe('model');
    expect(fuzzyFilter(names, 'ses', (x) => x)[0]).toBe('sessions');
    expect(fuzzyFilter(names, 'zzz', (x) => x)).toEqual([]);
  });
  test('arg parsing', () => {
    expect(parseArgs(['-p', 'hi', '--json', '-e', 'low'])).toMatchObject({ prompt: 'hi', json: true, effort: 'low' });
    expect(parseArgs(['doctor'])).toMatchObject({ cmd: 'doctor' });
    expect(parseArgs(['--effort=high'])).toMatchObject({ effort: 'high' });
  });
});
