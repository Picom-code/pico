// /theme prefs (accent + spinner), persistence, live recolor, the perched cat + effort rule, welcome quip.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { C, fg, setAscii, setColorMode, stripAnsi as P, width } from '../src/ansi';
import { App, QUIPS, themePanelLines } from '../src/app';
import { EFFORT_COLOR, effortLabel, nextEffort } from '../src/effort';
import { renderSummary } from '../src/status';
import {
  ACCENTS, accentHex, applyPrefs, DEFAULT_PREFS, isShimmer, loadPrefs, normalizePrefs, prefs, savePrefs, shimmer, spinGlyph, SPINNERS,
} from '../src/theme';
import { spinFrame } from '../src/tty';

const tmp = () => mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pico-theme-'));
afterEach(() => {
  applyPrefs(DEFAULT_PREFS);
  setAscii(false);
  setColorMode('256');
});

describe('prefs load/save', () => {
  test('missing file = defaults, and loading never creates it', () => {
    const p = join(tmp(), 'tui.json');
    expect(loadPrefs(p, {})).toEqual(DEFAULT_PREFS);
    expect(existsSync(p)).toBe(false);
  });
  test('save then load round-trips; keeps unknown keys; creates the dir', () => {
    const p = join(tmp(), 'sub', 'tui.json');
    savePrefs({ accent: 'mint', spinner: 'moon', reasoning: 'timer' as const, tools: 'normal' as const, summary: true, reply: 'band' as const, usageLine: true }, p);
    expect(loadPrefs(p, {})).toEqual({ accent: 'mint', spinner: 'moon', reasoning: 'timer' as const, tools: 'normal' as const, summary: true, reply: 'band', usageLine: true });
    writeFileSync(p, JSON.stringify({ accent: 'cyan', spinner: 'cat', other: 1 }));
    savePrefs({ accent: 'amber', spinner: 'dots', reasoning: 'preview', tools: 'quiet', summary: false, reply: 'bar', usageLine: false }, p);
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ accent: 'amber', spinner: 'dots', reasoning: 'preview', tools: 'quiet', summary: false, reply: 'bar', usageLine: false, other: 1 });
  });
  test('broken / invalid values fall back; hex accents accepted; env overrides', () => {
    const p = join(tmp(), 'tui.json');
    writeFileSync(p, '{not json');
    expect(loadPrefs(p, {})).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs({ accent: 'chartreuse', spinner: 'nope' })).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs({ accent: '#12AB34' }).accent).toBe('#12ab34');
    expect(loadPrefs(p, { PICO_ACCENT: 'lavender', PICO_SPINNER: 'twinkle' })).toEqual({ ...DEFAULT_PREFS, accent: 'lavender', spinner: 'twinkle' });
    expect(loadPrefs(p, { PICO_SPINNER: 'bogus' }).spinner).toBe('braille');
  });
  test('accent palette', () => {
    expect(ACCENTS.map((a) => a.name)).toEqual(['hotpink', 'mint', 'cyan', 'lavender', 'amber', 'white']);
    expect(accentHex('hotpink')).toBe('#ff2e99');
    expect(accentHex('#00D1FF')).toBe('#00d1ff');
  });
});

describe('live recolor', () => {
  test('applyPrefs changes every accent use: cat sign-off, spinner color, effort med, ctx level', () => {
    setColorMode('truecolor');
    expect(renderSummary({})).toContain('\x1b[38;2;255;46;153m(^.^)');
    applyPrefs({ ...DEFAULT_PREFS, accent: 'cyan', spinner: 'braille' });
    expect(C.accent).toBe('#00d1ff');
    expect(renderSummary({})).toContain('\x1b[38;2;0;209;255m(^.^)');
    expect(EFFORT_COLOR.medium).toBe('#00d1ff');
    expect(prefs().accent).toBe('cyan');
    setColorMode('256');
    expect(fg(C.accent)('x')).toBe('\x1b[38;5;45mx\x1b[39m'); // nearest 256 color
  });
});

describe('spinners', () => {
  const frames = (name: any) => SPINNERS.find((s) => s.name === name)!.frames;
  test('every spinner frame set', () => {
    expect(SPINNERS.map((s) => s.name)).toEqual(['braille', 'dots', 'moon', 'equalizer', 'classic', 'twinkle', 'cat', 'shimmer']);
    expect(frames('braille')).toEqual(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
    expect(frames('dots')).toEqual(['●∙∙', '∙●∙', '∙∙●', '∙●∙']);
    expect(frames('moon')).toEqual(['◐', '◓', '◑', '◒']);
    expect(frames('classic')).toEqual(['|', '/', '-', '\\']);
    expect(frames('twinkle')).toEqual(['✶', '✷', '✸', '✹', '✺', '✹', '✸', '✷']);
    expect(frames('cat')).toEqual(['(o.o)', '(•.o)', '(o.•)', '(o.o)']);
    const eq = frames('equalizer');
    expect(eq.length).toBe(12);
    expect(eq[0]).toBe('▁▅▅'); // 3 cells, offset by 4 steps of ▁▂▃▄▅▆▇▆▅▄▃▂
    for (const f of eq) expect(width(f)).toBe(3);
    expect(new Set(eq).size).toBeGreaterThan(6);
    for (const s of SPINNERS) {
      const ws = new Set(s.frames.map(width));
      expect(ws.size).toBe(1); // constant width → no jitter
    }
  });
  test('spinGlyph cycles at the spinner speed; ASCII always |/-\\; shimmer has no glyph', () => {
    expect(spinGlyph(0, 'moon')).toBe('◐');
    expect(spinGlyph(120, 'moon')).toBe('◓');
    expect(spinGlyph(0, 'shimmer')).toBe('');
    applyPrefs({ ...DEFAULT_PREFS, accent: 'hotpink', spinner: 'shimmer' });
    expect(isShimmer()).toBe(true);
    expect(spinFrame(0)).toBe('⠋'); // generic callers still get a glyph
    setAscii(true);
    expect(isShimmer()).toBe(false);
    expect(['|', '/', '-', '\\']).toContain(spinGlyph(0, 'twinkle'));
  });
  test('shimmer keeps the text and lights a moving 3-char window', () => {
    const a = shimmer('terminal', 70 * 3);
    expect(P(a)).toBe('terminal');
    expect(a).toContain(fg(C.accent)('erm'));
    expect(shimmer('terminal', 70 * 6)).toContain(fg(C.accent)('ina'));
  });
});

describe('/theme panel', () => {
  test('rounded box like /agents, swatches, live preview, constant width', () => {
    applyPrefs({ ...DEFAULT_PREFS, accent: 'lavender', spinner: 'moon' });
    const lines = themePanelLines({ ...DEFAULT_PREFS, accent: 'lavender', spinner: 'moon' }, 1, 100, 0, ['  ┬ 1 step', '  └─ ◐ pytest -q  0.4s']);
    const txt = lines.map(P);
    expect(txt[0]).toMatch(/^ {2}╭─ \(\^\.\^\) look & feel ─+╮$/);
    expect(txt.at(-1)).toMatch(/╰─ ↑↓ move · ←→ change · enter save · esc cancel ─+╯$/);
    const all = txt.join('\n');
    expect(all).toContain('accent      lavender  ○ ○ ○ ● ○ ○');
    expect(all).toContain('❯ spinner   ‹ moon      ◐  phases ›');
    expect(all).toContain('preview');
    expect(all).toContain('└─ ◐ pytest -q');
    const w0 = width(lines[0]);
    for (const l of lines) expect(width(l)).toBe(w0);
    expect(lines.join('')).toContain(fg('#ff2e99')('○')); // each swatch in its own color
  });
});

describe('bottom region: perched cat on the effort rule', () => {
  const mk = (cols: number) => {
    const app = new App({} as any, { version: '0.1.0' });
    (app.term as any) = { cols, rows: 30, write() {}, onKey() {}, onResizeEvent() {} };
    app.model = 'deepseek-v4.1-flash';
    app.ctx = { used: 9000, max: 131072, shown: 9000, cached: 0.92 };
    app.tps = 51;
    return app;
  };
  test('cat ears + face float above the rule; paws are embedded in it, aligned to one column', () => {
    for (const cols of [120, 100, 70, 60]) {
      const app = mk(cols);
      app.mood.busy = 'thinking';
      const lines = app.inputBox(cols, 3000).lines.map(P);
      expect(lines.length).toBe(4);
      const col = lines[2].indexOf(' > ^ < ');
      expect(col).toBeGreaterThan(0);
      expect(lines[0].indexOf(' /\\_/\\ ')).toBe(col);
      expect(lines[1].indexOf('( o.O ) ?')).toBe(col);
      expect(lines[2]).toMatch(/^─+ > \^ < ─── ● med ─$/); // slack reserves room for 'high'
      app.effort = 'high';
      expect(P(app.inputBox(cols, 3000).lines[2]).indexOf(' > ^ < ')).toBe(col); // cat doesn't hop
      expect(width(lines[2])).toBe(cols);
      expect(lines[3]).toMatch(/^› /);
    }
  });
  test('narrow (<60): no cat, plain rule; status drops extras', () => {
    const app = mk(50);
    const lines = app.inputBox(50).lines.map(P);
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^─+ ● med ─$/);
    expect(P(app.statusLine(50))).toBe('deepseek-v4.1-flash · ● med · ▰▱▱▱▱▱ 9k/128k');
  });
  test('hermes status line: no face, model · effort · pills · cached · tok/s', () => {
    const app = mk(120);
    expect(P(app.statusLine(120))).toBe('deepseek-v4.1-flash · ● med · ▰▱▱▱▱▱▱▱▱▱ 9k/128k cached 92% · 51 tok/s');
  });
  test('rule + › colored by effort; shift+tab cycle recolors', () => {
    const app = mk(100);
    for (const [e, col] of [['low', 80], ['high', 214]] as const) {
      app.effort = e;
      const l = app.inputBox(100).lines;
      expect(l[2]).toContain(`\x1b[38;5;${col}m─`);
      expect(l[2]).toContain(`● ${effortLabel(e)} `);
      expect(l[3].startsWith(`\x1b[38;5;${col}m›`)).toBe(true);
    }
    app.effort = 'medium';
    expect(app.inputBox(100).lines[3].startsWith(fg(C.accent)('›'))).toBe(true);
    expect(EFFORT_COLOR.max).toBe(203);
    expect(nextEffort('high', 1, ['low', 'medium', 'high', 'max'])).toBe('max');
  });
  test('ASCII: plain rule glyphs, sparkle → *', () => {
    setAscii(true);
    const app = mk(100);
    app.mood.lastEnd = { at: Date.now(), ok: true };
    const l = app.inputBox(100).lines.map(P);
    expect(l[1]).toContain('( ^.^ ) *');
    expect(l[2]).toMatch(/^-+ > \^ < --- \* med -$/);
    expect(P(app.statusLine(100))).toContain('[#---------] 9k/128k');
  });
  test('welcome: cat + info + a quip in dim quotes', () => {
    expect(QUIPS.length).toBeGreaterThanOrEqual(15);
    const app = mk(100);
    app.quip = QUIPS[0];
    const b = (app as any).bannerLines(100).map(P);
    expect(b[1]).toMatch(/^ \/\\_\/\\ {3}pico v0\.1\.0/);
    expect(b[2]).toMatch(/^\( \^\.\^ \) {2}deepseek-v4\.1-flash/);
    expect(b[3]).toContain('"ready when you are."');
    expect((app as any).bannerLines(40).map(P).join('\n')).toContain('"ready when you are."');
  });
});
