// Status-line pieces: context bar (Hermes-style), skeleton face reactions, turn summary.
// Pure functions of state + time so they're unit-testable; app.ts owns the state.
import { C, type Color, fg, fmtK, fmtSecs, G, isAscii, t, width } from './ansi';

// ---------------------------------------------------------------- context bar
export type CtxLevel = 'accent' | 'amber' | 'red';

/** accent < 80% ≤ amber < 95% ≤ red */
export function ctxLevel(frac: number): CtxLevel {
  if (frac >= 0.95) return 'red';
  if (frac >= 0.8) return 'amber';
  return 'accent';
}
/** Level colors (accent is read live so /theme recolors it). */
export const CTX_COLOR: Record<CtxLevel, Color> = {
  get accent() {
    return C.accent;
  },
  amber: C.amber,
  red: C.err,
};
export const PILL_EMPTY = 240;

/** '38k/128k' */
export function fmtCtxPair(used: number, max: number): string {
  return max ? `${fmtK(used)}/${fmtK(max)}` : fmtK(used);
}

/**
 * Pill bar: filled '▰' in the level color, empty '▱' dim. ASCII: '[###-------]'. `pulse` flashes the
 * filled pills white (compaction).
 */
export function ctxBar(frac: number, cells: number, color: Color = CTX_COLOR[ctxLevel(frac)], pulse = 0, tick?: number): string {
  const g = G();
  const f = Math.max(0, Math.min(1, frac));
  let full = Math.round(f * cells);
  if (f > 0 && full === 0) full = 1; // any usage shows at least one pill
  const empty = Math.max(0, cells - full);
  const on = fg(pulse > 0 ? 231 : color);
  let bar = on(g.pillOn.repeat(full)) + fg(PILL_EMPTY)(g.pillOff.repeat(empty));
  // auto-compaction threshold: a faint tick between the pills at that fraction
  if (tick != null && tick > 0 && tick < 1) {
    const at = Math.max(1, Math.min(cells - 1, Math.round(tick * cells)));
    const mark = t.faint(isAscii() ? '|' : '┊');
    const seg = (a: number, b: number) => on(g.pillOn.repeat(Math.max(0, Math.min(b, full) - a))) + fg(PILL_EMPTY)(g.pillOff.repeat(Math.max(0, b - Math.max(a, full))));
    bar = seg(0, at) + mark + seg(at, cells);
  }
  return isAscii() ? t.faint('[') + bar + t.faint(']') : bar;
}

export interface CtxState {
  used: number;
  max: number;
  cached?: number; // fraction 0..1 of input served from cache, or tokens
  shown: number; // animated displayed value
  compact?: { before: number; after: number; at: number };
  /** auto-compaction threshold (fraction of max) for the tick mark */
  atPct?: number;
}

/** Ease the displayed value toward the target (call each frame). Returns true while animating. */
export function ctxTick(s: CtxState, dtMs: number): boolean {
  const d = s.used - s.shown;
  if (Math.abs(d) < 1) {
    s.shown = s.used;
    return false;
  }
  const k = 1 - Math.exp(-dtMs / 120); // ~120ms time constant
  s.shown += d * k;
  if (Math.abs(s.used - s.shown) < 1) s.shown = s.used;
  return true;
}

export function cachedPct(cached: number | undefined, used: number): number | null {
  if (cached == null || !used) return null;
  const f = cached <= 1 ? cached : cached / used;
  if (!(f > 0)) return null;
  return Math.round(Math.min(1, f) * 100);
}

/** Full context segment for the status line: '▰▰▱▱▱▱▱▱▱▱ 9k/128k cached 92%'. `narrow` drops cached + hint. */
export function renderCtx(s: CtxState, now = Date.now(), narrow = false): string {
  if (!s.max && !s.used) return '';
  const compacting = s.compact && now - s.compact.at < 2600;
  const frac = s.max ? s.shown / s.max : 0;
  const lvl = ctxLevel(s.max ? s.used / s.max : 0);
  const color = CTX_COLOR[lvl];
  const pulse = compacting && now - s.compact!.at < 450 ? 1 : 0;
  const cells = narrow ? 6 : 10;
  const bar = s.max ? ctxBar(frac, cells, color, pulse, narrow ? undefined : s.atPct) + ' ' : '';
  const nums = (lvl === 'accent' ? t.dim : fg(color))(fmtCtxPair(Math.round(s.shown), s.max));
  let out = bar + nums;
  if (compacting) {
    out += ' ' + t.accent(`${G().compact} compacted ${fmtK(s.compact!.before)}${G().arrow}${fmtK(s.compact!.after)}`);
    return out;
  }
  if (!narrow) {
    const cp = cachedPct(s.cached, s.used);
    if (cp != null) out += t.dim(` cached ${cp}%`);
  }
  if (s.max && s.used / s.max > 0.85) out += ' ' + fg(color)('run /compact');
  return out;
}

// ---------------------------------------------------------------- skeleton face
export type Mood = 'idle' | 'thinking' | 'working' | 'done' | 'error' | 'asleep' | 'typing' | 'yolo';
export const FACES: Record<Mood, string> = {
  idle: 'o.o',
  thinking: 'o.O',
  working: '>.<',
  done: '^.^',
  error: 'x.x',
  asleep: '-.-',
  typing: '•.•', // watching you type
  yolo: '¬.¬', // up to no good
};
const ASCII_FACES: Partial<Record<Mood, string>> = { typing: 'o.o', yolo: '>.>' };
export const face = (m: Mood): string => (isAscii() && ASCII_FACES[m]) || FACES[m];
export const DONE_LINGER_MS = 1500;
export const ASLEEP_AFTER_MS = 60_000;
/** the cat keeps watching the input this long after the last keystroke */
export const TYPING_MS = 1200;

export interface MoodState {
  busy: 'thinking' | 'working' | null; // live state while a turn runs
  lastEnd?: { at: number; ok: boolean }; // when the last turn finished
  lastActivity: number; // keypress / output
  /** last keystroke that edited a non-empty input */
  lastType?: number;
  /** /yolo is on for this chat: the resting face turns mischievous */
  yolo?: boolean;
}

export function moodAt(m: MoodState, now = Date.now()): Mood {
  if (m.busy) return m.busy;
  if (m.lastEnd && now - m.lastEnd.at < DONE_LINGER_MS) return m.lastEnd.ok ? 'done' : 'error';
  if (m.lastType && now - m.lastType < TYPING_MS) return 'typing';
  if (now - m.lastActivity > ASLEEP_AFTER_MS) return 'asleep';
  return m.yolo ? 'yolo' : 'idle';
}

/** Small amber extra shown after the cat's face row. */
export function moodExtra(mood: Mood): string {
  const g = G();
  switch (mood) {
    case 'thinking':
      return '?';
    case 'working':
      return '~';
    case 'done':
      return g.sparkle;
    case 'error':
      return '!';
    case 'asleep':
      return 'zZ';
    default:
      return '';
  }
}

/** Rare blink while resting: eyes shut for ~150ms every ~7s (a double blink every 4th time). */
export function blinking(mood: Mood, now = Date.now()): boolean {
  if (mood !== 'idle' && mood !== 'yolo' && mood !== 'typing') return false;
  const ph = now % 7000;
  if (ph < 150) return true;
  return Math.floor(now / 7000) % 4 === 3 && ph >= 300 && ph < 420;
}

export function faceFor(mood: Mood, now = Date.now()): string {
  return blinking(mood, now) ? FACES.asleep : face(mood);
}

/** Inline mascot: '(^.^)✧' — face in accent, extra in amber. */
export function faceBadge(mood: Mood, now = Date.now()): string {
  const x = moodExtra(mood);
  return t.accent(`(${faceFor(mood, now)})`) + (x ? fg(C.amber)(x) : '');
}

/** The Pico Kitty cat (same art as the iOS app), rows centered on one column. */
export function skeleton(face = FACES.idle): string[] {
  return [' /\\_/\\ ', `( ${face} )`, ' > ^ < '];
}

/** Perched cat rows (plain text, 7 cols wide): [ears, face, paws]; extra goes after the face row. */
export function catRows(mood: Mood, now = Date.now()): { rows: string[]; extra: string } {
  return { rows: skeleton(faceFor(mood, now)), extra: moodExtra(mood) };
}

// ---------------------------------------------------------------- turn summary
export interface Summary {
  tools?: number;
  files_changed?: { path: string; added: number; removed: number }[];
  seconds?: number;
  tps?: number;
  output_tokens?: number;
}

/** ['done in 4.1s', '3 tools', '1 file +1 −1', '51 tok/s'] (plain parts; caller colors) */
export function summaryParts(s: Summary): string[] {
  const g = G();
  const parts: string[] = [s.seconds != null && s.seconds > 0 ? `done in ${fmtSecs(s.seconds)}` : 'done'];
  if (s.tools) parts.push(`${s.tools} tool${s.tools === 1 ? '' : 's'}`);
  const f = s.files_changed || [];
  if (f.length) {
    const a = f.reduce((x, y) => x + (y.added || 0), 0);
    const r = f.reduce((x, y) => x + (y.removed || 0), 0);
    parts.push(`${f.length} file${f.length === 1 ? '' : 's'} +${a} ${g.minus}${r}`);
  }
  if (s.tps) parts.push(`${Math.round(s.tps)} tok/s`);
  return parts;
}

/** Cat sign-off: '(^.^)✧ done in 4.1s · 3 tools · 1 file +1 −1 · 51 tok/s' (cat accent, rest dim). */
export function renderSummary(s: Summary, ok = true, maxWidth = Infinity): string {
  const g = G();
  let parts = summaryParts(s);
  const head = ok ? catSign('done') : catSign('error');
  const hw = ok ? 6 + width(g.sparkle) : 7;
  // narrow terminals: drop trailing parts (tok/s, files…) instead of cutting mid-word
  while (parts.length > 1 && hw + 1 + parts.join(` ${g.sep} `).length > maxWidth) parts = parts.slice(0, -1);
  return head + ' ' + t.dim(parts.join(` ${g.sep} `));
}

/** '(^.^)✧' / '(x.x)!' / '(-.-)' all in accent (error face in red). */
export function catSign(mood: Mood): string {
  const x = mood === 'done' ? G().sparkle : mood === 'error' ? '!' : '';
  return (mood === 'error' ? t.err : t.accent)(`(${face(mood)})${x}`);
}

export const asciiMode = isAscii;
