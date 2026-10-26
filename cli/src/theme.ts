// TUI look & feel prefs: accent color + spinner style. Persisted to $PICO_HOME/tui.json (only when the
// user saves from /theme); PICO_ACCENT / PICO_SPINNER override for a single run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { C, DEFAULT_ACCENT, fg, isAscii, parseHex, setAccent, t } from './ansi';

export const ACCENTS: { name: string; hex: string }[] = [
  { name: 'hotpink', hex: '#ff2e99' },
  { name: 'mint', hex: '#33ff99' },
  { name: 'cyan', hex: '#00d1ff' },
  { name: 'lavender', hex: '#9e66ff' },
  { name: 'amber', hex: '#ffa800' },
  { name: 'white', hex: '#f5f5f5' },
];

export type SpinnerName = 'braille' | 'dots' | 'moon' | 'equalizer' | 'classic' | 'twinkle' | 'cat' | 'shimmer';
export interface SpinnerDef {
  name: SpinnerName;
  /** ms per frame */
  ms: number;
  frames: string[];
  hint: string;
}
const EQ = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '▆', '▅', '▄', '▃', '▂'];
export const SPINNERS: SpinnerDef[] = [
  { name: 'braille', ms: 80, frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], hint: 'classic dots' },
  { name: 'dots', ms: 160, frames: ['●∙∙', '∙●∙', '∙∙●', '∙●∙'], hint: 'bouncing ball' },
  { name: 'moon', ms: 120, frames: ['◐', '◓', '◑', '◒'], hint: 'phases' },
  { name: 'equalizer', ms: 90, frames: EQ.map((_, i) => [0, 4, 8].map((o) => EQ[(i + o) % EQ.length]).join('')), hint: '3 bars' },
  { name: 'classic', ms: 100, frames: ['|', '/', '-', '\\'], hint: 'old school' },
  { name: 'twinkle', ms: 100, frames: ['✶', '✷', '✸', '✹', '✺', '✹', '✸', '✷'], hint: 'star' },
  { name: 'cat', ms: 320, frames: ['(o.o)', '(•.o)', '(o.•)', '(o.o)'], hint: 'looking around' },
  { name: 'shimmer', ms: 80, frames: [''], hint: 'light sweeps the name' },
];
const ASCII_SPIN = ['|', '/', '-', '\\'];

export type ReasoningLevel = 'hidden' | 'timer' | 'preview' | 'full';
export type ToolsLevel = 'quiet' | 'normal' | 'full';
export const REASONING_LEVELS: ReasoningLevel[] = ['hidden', 'timer', 'preview', 'full'];
export const TOOLS_LEVELS: ToolsLevel[] = ['quiet', 'normal', 'full'];
export interface Verbosity {
  reasoning: ReasoningLevel;
  tools: ToolsLevel;
  summary: boolean;
}
/** How user messages and replies are told apart: band (default) · label · bar · plain (pre-1.0 look). */
export type ReplyStyle = 'band' | 'label' | 'bar' | 'plain';
export const REPLY_STYLES: ReplyStyle[] = ['band', 'label', 'bar', 'plain'];
export interface TuiPrefs extends Verbosity {
  accent: string; // name from ACCENTS or '#rrggbb'
  spinner: SpinnerName;
  reply: ReplyStyle;
  /** dim usage readout under the status line */
  usageLine: boolean;
}
export const DEFAULT_PREFS: TuiPrefs = { accent: 'hotpink', spinner: 'braille', reasoning: 'timer', tools: 'normal', summary: true, reply: 'band', usageLine: false };

/** One-word presets for --verbose / /verbose. */
export const VERBOSITY_PRESETS: Record<string, Verbosity> = {
  quiet: { reasoning: 'hidden', tools: 'quiet', summary: true },
  normal: { reasoning: 'timer', tools: 'normal', summary: true },
  verbose: { reasoning: 'preview', tools: 'normal', summary: true },
  full: { reasoning: 'full', tools: 'full', summary: true },
};
/** Completion words for /verbose and --verbose. */
export const VERBOSITY_WORDS = [
  ...Object.keys(VERBOSITY_PRESETS),
  ...REASONING_LEVELS.map((l) => `reasoning=${l}`),
  ...TOOLS_LEVELS.map((l) => `tools=${l}`),
  'summary=on',
  'summary=off',
];
/**
 * Parse '/verbose quiet', 'reasoning=preview', 'tools=full summary=off', bare 'preview' (a reasoning
 * level) or 'off' (summary). Returns the changed fields, or null when nothing parsed.
 */
export function parseVerbosity(arg: string): Partial<Verbosity> | null {
  const out: Partial<Verbosity> = {};
  let any = false;
  for (const w of arg.trim().toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    const [k, v] = w.includes('=') || w.includes(':') ? w.split(/[=:]/) : ['', w];
    if (!k && VERBOSITY_PRESETS[v]) {
      Object.assign(out, VERBOSITY_PRESETS[v]);
      any = true;
    } else if ((k === 'reasoning' || k === 'thinking' || !k) && (REASONING_LEVELS as string[]).includes(v) && !(k === '' && v === 'full')) {
      out.reasoning = v as ReasoningLevel;
      any = true;
    } else if ((k === 'tools' || k === 'tool') && (TOOLS_LEVELS as string[]).includes(v)) {
      out.tools = v as ToolsLevel;
      any = true;
    } else if ((k === 'summary' || (!k && (v === 'on' || v === 'off'))) && ['on', 'off', 'true', 'false'].includes(v)) {
      out.summary = v === 'on' || v === 'true';
      any = true;
    } else return null;
  }
  return any ? out : null;
}

let current: TuiPrefs = { ...DEFAULT_PREFS };

export const prefsPath = () => join(process.env.PICO_HOME || join(homedir(), '.pico'), 'tui.json');

export function accentHex(a: string): string {
  const named = ACCENTS.find((x) => x.name === a.toLowerCase());
  if (named) return named.hex;
  if (/^#?[0-9a-f]{6}$/i.test(a)) return a.startsWith('#') ? a.toLowerCase() : '#' + a.toLowerCase();
  return DEFAULT_ACCENT;
}
const isSpinner = (s: unknown): s is SpinnerName => typeof s === 'string' && SPINNERS.some((x) => x.name === s);

export function normalizePrefs(x: any): TuiPrefs {
  const p = { ...DEFAULT_PREFS };
  if (x && typeof x === 'object') {
    if (typeof x.accent === 'string' && (ACCENTS.some((a) => a.name === x.accent.toLowerCase()) || /^#?[0-9a-f]{6}$/i.test(x.accent)))
      p.accent = ACCENTS.some((a) => a.name === x.accent.toLowerCase()) ? x.accent.toLowerCase() : accentHex(x.accent);
    if (isSpinner(x.spinner)) p.spinner = x.spinner;
    if ((REASONING_LEVELS as unknown[]).includes(x.reasoning)) p.reasoning = x.reasoning;
    if ((TOOLS_LEVELS as unknown[]).includes(x.tools)) p.tools = x.tools;
    if (typeof x.summary === 'boolean') p.summary = x.summary;
    if ((REPLY_STYLES as unknown[]).includes(x.reply)) p.reply = x.reply;
    if (typeof x.usageLine === 'boolean') p.usageLine = x.usageLine;
  }
  return p;
}

/** Read tui.json (missing / broken file = defaults), then apply env overrides. Never writes. */
export function loadPrefs(path = prefsPath(), env: Record<string, string | undefined> = process.env): TuiPrefs {
  let raw: any = {};
  try {
    if (existsSync(path)) raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  const p = normalizePrefs(raw);
  if (env.PICO_ACCENT) p.accent = normalizePrefs({ accent: env.PICO_ACCENT }).accent;
  if (isSpinner(env.PICO_SPINNER)) p.spinner = env.PICO_SPINNER;
  if (env.PICO_VERBOSE) Object.assign(p, parseVerbosity(env.PICO_VERBOSE) || {});
  return p;
}

export function savePrefs(p: TuiPrefs, path = prefsPath()) {
  mkdirSync(dirname(path), { recursive: true });
  let prev: any = {};
  try {
    if (existsSync(path)) prev = JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  writeFileSync(path, JSON.stringify({ ...prev, accent: p.accent, spinner: p.spinner, reasoning: p.reasoning, tools: p.tools, summary: p.summary, reply: p.reply, usageLine: p.usageLine }, null, 2) + '\n');
}

/** Make prefs live: recolors the accent and switches the spinner. */
export function applyPrefs(p: TuiPrefs) {
  current = { ...p };
  setAccent(accentHex(p.accent));
}
export const prefs = (): TuiPrefs => current;
/** Current verbosity (read at render time so /theme and /verbose apply live). */
export const verbosity = (): Verbosity => ({ reasoning: current.reasoning, tools: current.tools, summary: current.summary });
/** Change verbosity for this run (callers decide whether to save). */
export function setVerbosity(v: Partial<Verbosity>) {
  current = { ...current, ...v };
}
/** Current reply style (read at render time so the picker applies live). */
export const replyStyle = (): ReplyStyle => current.reply ?? 'band';
/** Change prefs for this run (callers decide whether to save). */
export function setPrefs(p: Partial<TuiPrefs>) {
  current = { ...current, ...p };
}
/** 'reasoning timer · tools normal · summary on' */
export function verbosityLabel(v: Verbosity = verbosity()): string {
  return `reasoning ${v.reasoning} · tools ${v.tools} · summary ${v.summary ? 'on' : 'off'}`;
}

export function spinnerDef(name: SpinnerName = current.spinner): SpinnerDef {
  return SPINNERS.find((s) => s.name === name) ?? SPINNERS[0];
}

/** Current spinner glyph ('' for shimmer). ASCII mode always uses |/-\. */
export function spinGlyph(now = Date.now(), name: SpinnerName = current.spinner): string {
  if (isAscii()) return ASCII_SPIN[Math.floor(now / 100) % ASCII_SPIN.length];
  const d = spinnerDef(name);
  return d.frames[Math.floor(now / d.ms) % d.frames.length];
}

export const isShimmer = (name: SpinnerName = current.spinner) => name === 'shimmer' && !isAscii();

/**
 * Light sweeping across `text`: characters within 1 of the moving head are bright accent, the rest
 * `base`. Period includes a short pause off the right edge so the sweep reads as a pass, not a blink.
 */
export function shimmer(text: string, now = Date.now(), base: (s: string) => string = t.dim, msPerChar = 70): string {
  const chars = Array.from(text);
  if (!chars.length) return '';
  const span = chars.length + 4;
  const head = Math.floor(now / msPerChar) % span - 1;
  const hi = fg(C.accent);
  let out = '';
  let run = '';
  let runHi: boolean | null = null;
  const flush = () => {
    if (run) out += runHi ? hi(run) : base(run);
    run = '';
  };
  chars.forEach((c, i) => {
    const on = Math.abs(i - head) <= 1;
    if (on !== runHi) {
      flush();
      runHi = on;
    }
    run += c;
  });
  flush();
  return out;
}

/** Name for display of an accent value. */
export function accentName(a: string): string {
  const hex = accentHex(a);
  return ACCENTS.find((x) => x.hex === hex)?.name ?? hex;
}
export const accentIndex = (a: string) => Math.max(0, ACCENTS.findIndex((x) => x.hex === accentHex(a)));
export { parseHex };
