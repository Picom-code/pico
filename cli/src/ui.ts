// Shared UI pieces: skeleton mascot, boxes, and promise-based prompts (select / confirm / text / toggles)
// that render into a LiveScreen.
import { bold, C, fg, G, padRight, t, truncate, width } from './ansi';
import type { Key } from './keys';
import { LiveScreen, Terminal } from './tty';

// Pico Kitty cat (same art as the iOS app). Every row is 7 cols, centered.
export const SKULL = [' /\\_/\\ ', '( o.o )', ' > ^ < '];
export const SKULL_SMALL = SKULL;

const EYES = ['-.-', 'o.-', 'o.o', 'o.o', '^.^', 'o.o'];
/** Animation frames of the cat waking up; tail flicks on odd frames. */
export function skullFrame(i: number): string[] {
  const e = EYES[Math.min(i, 5)];
  return [' /\\_/\\  ', `( ${e} ) `, i % 2 === 0 ? ' > ^ <  ' : ' > ^ < ~'];
}

export function box(title: string, body: string[], w: number, color = C.dim, footer = ''): string[] {
  const g = G();
  const c = fg(color);
  const inner = Math.max(10, w - 4);
  const ttl = title ? ` ${title} ` : '';
  const top = c(g.tl + g.h) + bold(fg(C.text)(ttl)) + c(g.h.repeat(Math.max(0, inner - width(ttl))) + g.h + g.tr);
  const out = [top];
  for (const b of body) out.push(c(g.v + ' ') + padRight(truncate(b, inner), inner) + c(' ' + g.v));
  const ft = footer ? ' ' + footer + ' ' : '';
  const ftW = width(ft);
  out.push(c(g.bl + g.h) + ft + c(g.h.repeat(Math.max(0, inner + 1 - ftW)) + g.br));
  return out;
}

export interface Item<T> {
  label: string;
  value: T;
  hint?: string;
  detail?: string[];
}

type Handler = (k: Key) => void;

/** Run a modal prompt: `draw` returns lines, `key` returns a value to resolve or undefined to continue. */
export function modal<R>(
  term: Terminal,
  screen: LiveScreen,
  draw: () => string[],
  onKey: (k: Key, redraw: () => void) => R | undefined | Promise<R | undefined>,
  header: () => string[] = () => [],
): Promise<R> {
  return new Promise((resolve, reject) => {
    const redraw = () => screen.render({ lines: [...header(), ...draw()] });
    const off = term.onKey(async (k) => {
      if (k.ctrl && k.name === 'c') {
        off();
        reject(new Error('cancelled'));
        return;
      }
      let r: R | undefined;
      try {
        r = await onKey(k, redraw);
      } catch (e) {
        off();
        reject(e);
        return;
      }
      if (r !== undefined) {
        off();
        resolve(r);
      } else redraw();
    });
    redraw();
  });
}

const oneLine = (s: string | undefined) => (s == null ? s : s.replace(/\s*[\r\n]+\s*/g, ' ⏎ ').replace(/\t/g, ' '));

export function select<T>(
  term: Terminal,
  screen: LiveScreen,
  title: string,
  rawItems: Item<T>[],
  opts: { initial?: number; header?: () => string[]; footer?: string } = {},
): Promise<T> {
  const cols = term.cols;
  const items = rawItems.map((it) => ({
    ...it,
    label: truncate(oneLine(it.label)!, Math.floor(cols * 0.5)),
    hint: it.hint ? oneLine(it.hint) : undefined,
    detail: it.detail?.map((d) => truncate(oneLine(d)!, cols - 6)),
  }));
  let idx = Math.max(0, Math.min(items.length - 1, opts.initial ?? 0));
  const labW = Math.min(36, Math.max(...items.map((i) => width(i.label))));
  const draw = () => {
    const out = [t.accent('? ') + bold(title)];
    items.forEach((it, i) => {
      const on = i === idx;
      const mark = on ? t.accent('❯ ') : '  ';
      const label = on ? fg(C.text)(bold(it.label)) : t.muted(it.label);
      out.push(truncate(mark + label + (it.hint ? ' '.repeat(Math.max(2, labW - width(it.label) + 2)) + t.dim(it.hint) : ''), cols));
      if (on && it.detail) for (const d of it.detail) out.push('    ' + t.dim(d));
    });
    out.push(t.faint(opts.footer ?? '↑↓ move · enter select'));
    return out;
  };
  return modal<T>(
    term,
    screen,
    draw,
    (k) => {
      if (k.name === 'up' || (k.ctrl && k.name === 'p') || k.name === 'k') idx = (idx - 1 + items.length) % items.length;
      else if (k.name === 'down' || (k.ctrl && k.name === 'n') || k.name === 'j' || (k.name === 'tab' && !k.shift)) idx = (idx + 1) % items.length;
      else if (k.name === 'enter') return items[idx].value;
      else if (k.name === 'escape') throw new Error('cancelled');
      else if (k.ch && /^[1-9]$/.test(k.ch) && +k.ch <= items.length) idx = +k.ch - 1;
      return undefined;
    },
    opts.header,
  );
}

export function toggles(
  term: Terminal,
  screen: LiveScreen,
  title: string,
  items: { key: string; label: string; on: boolean; hint?: string }[],
  header?: () => string[],
): Promise<Record<string, boolean>> {
  let idx = 0;
  const draw = () => {
    const out = [t.accent('? ') + bold(title)];
    items.forEach((it, i) => {
      const box = it.on ? t.ok('◉') : t.dim('○');
      const pad = ' '.repeat(Math.max(2, Math.max(...items.map((x) => width(x.label))) - width(it.label) + 2));
      out.push((i === idx ? t.accent('❯ ') : '  ') + box + ' ' + (i === idx ? bold(it.label) : t.muted(it.label)) + (it.hint ? pad + t.dim(it.hint) : ''));
    });
    out.push(t.faint('↑↓ move · space toggle · enter continue'));
    return out;
  };
  return modal(term, screen, draw, (k) => {
    if (k.name === 'up') idx = (idx - 1 + items.length) % items.length;
    else if (k.name === 'down' || k.name === 'tab') idx = (idx + 1) % items.length;
    else if (k.name === 'space' || k.name === 'x') items[idx].on = !items[idx].on;
    else if (k.name === 'enter') return Object.fromEntries(items.map((i) => [i.key, i.on]));
    return undefined;
  }, header);
}

export function textPrompt(
  term: Terminal,
  screen: LiveScreen,
  label: string,
  opts: { secret?: boolean; initial?: string; header?: () => string[] } = {},
): Promise<string> {
  let v = opts.initial ?? '';
  const draw = () => [t.accent('? ') + bold(label), '  ' + t.accent('› ') + (opts.secret ? '•'.repeat(v.length) : v) + fg(C.accent)('▏')];
  return modal(term, screen, draw, (k) => {
    if (k.name === 'enter') return v;
    if (k.name === 'backspace') v = Array.from(v).slice(0, -1).join('');
    else if (k.name === 'paste' && k.paste) v += k.paste.replace(/\n/g, '');
    else if (k.ctrl && k.name === 'u') v = '';
    else if (k.ch && !k.ctrl) v += k.ch;
    return undefined;
  }, opts.header);
}

export function confirm(term: Terminal, screen: LiveScreen, q: string, header?: () => string[]): Promise<boolean> {
  return modal(term, screen, () => [t.accent('? ') + bold(q) + t.dim('  (y/n)')], (k) => {
    if (k.name === 'y') return true;
    if (k.name === 'n' || k.name === 'escape') return false;
    return undefined;
  }, header);
}

export function bar(pct: number, w: number, color = C.accent): string {
  const p = Math.max(0, Math.min(1, pct));
  const full = Math.floor(p * w);
  const part = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'][Math.floor((p * w - full) * 8)] || '';
  return fg(color)('█'.repeat(full) + part) + fg(C.faint)('░'.repeat(Math.max(0, w - full - (part ? 1 : 0))));
}
