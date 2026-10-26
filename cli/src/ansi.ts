// Tiny ANSI toolkit: colors (256-color or truecolor), glyphs (Unicode with ASCII fallback), width
// measurement, wrapping, truncation. No dependencies. Respects NO_COLOR.

export const NO_COLOR = !!process.env.NO_COLOR || process.env.TERM === 'dumb';

// ---------------------------------------------------------------- color mode
let TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || '');
/** Force a color mode (tests, or terminals that lie about COLORTERM). */
export function setColorMode(m: '256' | 'truecolor') {
  TRUECOLOR = m === 'truecolor';
}
export const isTruecolor = () => TRUECOLOR;

const BASE16: [number, number, number][] = [
  [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
];
/** xterm 256-color index -> RGB. */
export function rgb256(n: number): [number, number, number] {
  if (n < 16) return BASE16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return [v, v, v];
  }
  const L = [0, 95, 135, 175, 215, 255];
  const i = n - 16;
  return [L[Math.floor(i / 36)], L[Math.floor(i / 6) % 6], L[i % 6]];
}
/** A color: xterm 256 index, or '#rrggbb' (exact in truecolor, nearest 256 index otherwise). */
export type Color = number | string;
const hexCache = new Map<string, [number, number, number, number]>();
/** '#ff2e99' -> [r, g, b, nearest 256 index] */
export function parseHex(h: string): [number, number, number, number] {
  let v = hexCache.get(h);
  if (v) return v;
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  v = [r, g, b, nearest256(r, g, b)];
  hexCache.set(h, v);
  return v;
}
/** Nearest xterm 256-color index (cube 16-231 + grays 232-255). */
export function nearest256(r: number, g: number, b: number): number {
  let best = 16;
  let bd = Infinity;
  for (let i = 16; i < 256; i++) {
    const [R, G2, B] = rgb256(i);
    const d = (R - r) ** 2 + (G2 - g) ** 2 + (B - b) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}
export function colorRGB(c: Color): [number, number, number] {
  if (typeof c === 'string') {
    const [r, g, b] = parseHex(c);
    return [r, g, b];
  }
  return rgb256(c);
}
const sgr = (base: 38 | 48, c: Color) => {
  if (typeof c === 'string') {
    const [r, g, b, n] = parseHex(c);
    return TRUECOLOR ? `\x1b[${base};2;${r};${g};${b}m` : `\x1b[${base};5;${n}m`;
  }
  if (!TRUECOLOR) return `\x1b[${base};5;${c}m`;
  const [r, g, b] = rgb256(c);
  return `\x1b[${base};2;${r};${g};${b}m`;
};
const esc = (s: string) => (NO_COLOR ? '' : s);
export const fg = (n: Color) => (s: string) => (NO_COLOR ? s : `${sgr(38, n)}${s}\x1b[39m`);
export const bg = (n: Color) => (s: string) => (NO_COLOR ? s : `${sgr(48, n)}${s}\x1b[49m`);
/** Exact RGB background in truecolor terminals, 256-color fallback otherwise. */
export const bgRGB = (r: number, g: number, b: number, fallback: number) => (s: string) =>
  NO_COLOR ? s : (TRUECOLOR ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${fallback}m`) + s + '\x1b[49m';
export const fgRGB = (r: number, g: number, b: number, fallback: number) => (s: string) =>
  NO_COLOR ? s : (TRUECOLOR ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${fallback}m`) + s + '\x1b[39m';
export const bold = (s: string) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[22m`);
export const dim = (s: string) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[22m`);
export const italic = (s: string) => (NO_COLOR ? s : `\x1b[3m${s}\x1b[23m`);
export const underline = (s: string) => (NO_COLOR ? s : `\x1b[4m${s}\x1b[24m`);
export const inverse = (s: string) => (NO_COLOR ? s : `\x1b[7m${s}\x1b[27m`);
export const RESET = esc('\x1b[0m');

// Theme: near-black, grays, ONE accent (hot pink by default; /theme changes it at runtime via setAccent).
// Read C.accent at call time, never cache fg(C.accent) in a module-level const.
export const DEFAULT_ACCENT = '#ff2e99';
export const C: {
  accent: Color; accentDim: Color; text: number; muted: number; dim: number; faint: number; rule: number; ok: number; warn: number;
  amber: number; err: number; code: number; cyan: number; pink: Color; violet: number;
} = {
  accent: DEFAULT_ACCENT,
  accentDim: '#b0336f', // muted accent for quiet notices
  text: 252,
  muted: 246,
  dim: 242,
  faint: 238,
  rule: 236,
  ok: 114,
  warn: 179,
  amber: 214,
  err: 203,
  code: 180,
  cyan: 80,
  pink: DEFAULT_ACCENT,
  violet: 141,
};
/** Change the accent everywhere (cat, spinner, ›, context bar, summary…). */
export function setAccent(hex: string) {
  const [r, g, b] = parseHex(hex);
  C.accent = '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  C.pink = C.accent;
  // muted accent: ~60% toward a dark gray
  const mix = (x: number) => Math.round(x * 0.62 + 40 * 0.38);
  C.accentDim = '#' + [mix(r), mix(g), mix(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const t = {
  accent: (s: string) => fg(C.accent)(s),
  accentDim: (s: string) => fg(C.accentDim)(s),
  text: fg(C.text),
  muted: fg(C.muted),
  dim: fg(C.dim),
  faint: fg(C.faint),
  ok: fg(C.ok),
  warn: fg(C.warn),
  amber: fg(C.amber),
  err: fg(C.err),
  code: fg(C.code),
};

// ---------------------------------------------------------------- glyphs
const UNI = {
  check: '✓', cross: '✗', dot: '●', ring: '○', guide: '│', elbow: '⎿', pencil: '✎', minus: '−', ell: '…', sparkle: '✧',
  undo: '↶', compact: '↺', pillOn: '▰', pillOff: '▱', tee: '├─', last: '└─', top: '┬', vline: '│', hook: '╰', branch: '⎇', think: '✻', user: '›', rule: '─', sep: '·', arrow: '→', stop: '■', plus: '+',
  barFull: '━', barHalf: '╸', barEmpty: '━', tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', caret: '❯', lt: '‹', gt: '›',
  spin: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};
export type Glyphs = typeof UNI;
const ASC: Glyphs = {
  check: 'v', cross: 'x', dot: '*', ring: 'o', guide: '|', elbow: '`-', pencil: '*', minus: '-', ell: '...', sparkle: '*',
  undo: '<-', compact: '@', pillOn: '#', pillOff: '-', tee: '|-', last: '`-', top: '+', vline: '|', hook: '`', branch: '>', think: '*', user: '>', rule: '-', sep: '|', arrow: '->', stop: '#', plus: '+',
  barFull: '=', barHalf: '-', barEmpty: '.', tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', caret: '>', lt: '<', gt: '>',
  spin: ['|', '/', '-', '\\'],
};
function detectAscii(): boolean {
  const e = process.env;
  if (e.PICO_ASCII === '1') return true;
  if (e.PICO_ASCII === '0') return false;
  if (process.platform === 'win32') return !(e.WT_SESSION || e.TERM_PROGRAM || /xterm|vt|256/.test(e.TERM || ''));
  const loc = e.LC_ALL || e.LC_CTYPE || e.LANG || '';
  return !!loc && !/utf-?8/i.test(loc);
}
let ASCII = detectAscii();
export function setAscii(on: boolean) {
  ASCII = on;
}
export const isAscii = () => ASCII;
/** Current glyph set (Unicode, or ASCII when PICO_ASCII=1 / non-UTF-8 console). */
export const G = (): Glyphs => (ASCII ? ASC : UNI);

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

/** Display width of a single code point (0, 1 or 2). Small wcwidth covering common wide ranges. */
export function cpWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // combining marks, ZWJ, variation selectors
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function width(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) w += cpWidth(ch.codePointAt(0)!);
  return w;
}

/** Split a string into tokens: ANSI escapes (width 0) and single code points. */
function* tokens(s: string): Generator<[string, number]> {
  let i = 0;
  ANSI_RE.lastIndex = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      ANSI_RE.lastIndex = i;
      const m = ANSI_RE.exec(s);
      if (m && m.index === i) {
        yield [m[0], 0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    yield [ch, cpWidth(cp)];
    i += ch.length;
  }
}

/** Truncate to max display width, ANSI-safe. Adds ellipsis when cut. */
export function truncate(s: string, max: number, ell = G().ell): string {
  if (max <= 0) return '';
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  const lim = max - width(ell);
  for (const [tok, tw] of tokens(s)) {
    if (tw === 0) {
      out += tok;
      continue;
    }
    if (w + tw > lim) break;
    out += tok;
    w += tw;
  }
  return out + (NO_COLOR ? '' : '\x1b[0m') + ell;
}

export function padRight(s: string, n: number): string {
  const w = width(s);
  return w >= n ? s : s + ' '.repeat(n - w);
}

/** Word-wrap a single line (no newlines) to `max` columns, ANSI-aware. Continuation lines get `indent`. */
export function wrap(s: string, max: number, indent = ''): string[] {
  if (max <= 4) return [s];
  if (width(s) <= max) return [s];
  const out: string[] = [];
  let line = '';
  let lineW = 0;
  let word = '';
  let wordW = 0;
  let active = ''; // last SGR sequence seen, re-applied on continuation lines
  const indW = width(indent);
  const flushWord = () => {
    if (!word) return;
    const limit = out.length ? max - indW : max;
    if (lineW + wordW > limit && lineW > 0) {
      out.push(line.replace(/\s+$/, '') + (NO_COLOR ? '' : '\x1b[0m'));
      line = indent + active;
      lineW = 0;
      const trimmed = word.replace(/^ +/, '');
      wordW -= word.length - trimmed.length;
      word = trimmed;
    }
    // hard-break very long words
    while (wordW > (out.length ? max - indW : max)) {
      const limit2 = (out.length ? max - indW : max) - lineW;
      let piece = '';
      let pw = 0;
      let rest = '';
      let cut = false;
      for (const [tok, tw] of tokens(word)) {
        if (cut) {
          rest += tok;
          continue;
        }
        if (pw + tw > limit2) {
          cut = true;
          rest += tok;
          continue;
        }
        piece += tok;
        pw += tw;
      }
      out.push(line + piece + (NO_COLOR ? '' : '\x1b[0m'));
      line = indent + active;
      lineW = 0;
      word = rest;
      wordW = width(rest);
    }
    line += word;
    lineW += wordW;
    word = '';
    wordW = 0;
  };
  for (const [tok, tw] of tokens(s)) {
    if (tw === 0 && tok.startsWith('\x1b[') && tok.endsWith('m')) {
      active = tok === '\x1b[0m' ? '' : active + tok;
      word += tok;
      continue;
    }
    if (tok === ' ') {
      flushWord();
      word = ' ';
      wordW = 1;
      continue;
    }
    if (word === ' ') {
      // start of a new word after space: keep the space attached as leading
    }
    word += tok;
    wordW += tw;
  }
  flushWord();
  if (line) out.push(line);
  return out;
}

export const term = {
  cols: () => Math.max(20, process.stdout.columns || 80),
  rows: () => Math.max(8, process.stdout.rows || 24),
};

export function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

/** Compact token count: 950, 1.8k, 38k; power-of-two sizes use 1024 (131072 -> 128k, 128000 -> 128k). */
export function fmtK(n: number): string {
  n = Math.max(0, Math.round(n || 0));
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n % 1000 === 0) return `${n / 1000}k`;
  if (n % 1024 === 0) return `${n / 1024}k`;
  return `${Math.round(n / 1000)}k`;
}

/** Context window sizes. */
export function fmtCtx(n: number): string {
  return fmtK(n);
}

/** 0.4s · 6.2s · 14s · 2m 5s */
export function fmtSecs(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export function shortPath(p: string, max = 28): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  let s = home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
  if (s.length > max) s = '…' + s.slice(s.length - max + 1);
  return s;
}
