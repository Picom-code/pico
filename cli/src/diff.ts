// Compact colored diff preview for tool_end.diff {path, added, removed, unified, created}.
import { bgRGB, C, fg, fgRGB, G, isAscii, NO_COLOR, padRight, t, truncate, width } from './ansi';

export interface FileDiff {
  path: string;
  added?: number;
  removed?: number;
  unified?: string;
  created?: boolean;
}

export const DIFF_PREVIEW_LINES = 12;

interface Row {
  kind: '+' | '-' | ' ' | '@';
  old?: number;
  neu?: number;
  text: string;
}

/** Parse a unified diff into numbered rows (file headers dropped). */
export function parseUnified(u: string): Row[] {
  const rows: Row[] = [];
  let o = 0;
  let n = 0;
  for (const line of (u || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      o = +h[1];
      n = +h[2];
      rows.push({ kind: '@', text: h[3].trim() });
      continue;
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('+')) rows.push({ kind: '+', neu: n++, text: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ kind: '-', old: o++, text: line.slice(1) });
    else if (line.length || rows.length) rows.push({ kind: ' ', old: o++, neu: n++, text: line.slice(1) });
  }
  while (rows.length && rows[rows.length - 1].kind === ' ' && !rows[rows.length - 1].text) rows.pop();
  return rows;
}

const addBg = bgRGB(22, 46, 30, 22);
const delBg = bgRGB(56, 22, 28, 52);
const addFg = fgRGB(130, 220, 150, 114);
const delFg = fgRGB(240, 120, 130, 203);

/** Header: '✎ src/app.ts  +3 −1' (or '✎ new.txt  new  +5') */
export function diffHeader(d: FileDiff): string {
  const g = G();
  const a = d.added ?? 0;
  const r = d.removed ?? 0;
  return (
    t.accent(g.pencil) + ' ' + fg(C.text)(d.path) + '  ' + (d.created ? t.dim('new') + '  ' : '') + t.ok(`+${a}`) + (d.created && !r ? '' : ' ' + t.err(`${g.minus}${r}`))
  );
}

/** Collapsed edit: '✎ calc.py  +1 −1  (ctrl+o to see)' */
export function diffSummary(d: FileDiff): string {
  return diffHeader(d) + t.faint('  (ctrl+o to see)');
}

/**
 * Render header + hunk lines. `expanded` shows everything; otherwise up to `max` rows plus a
 * '… +N more (ctrl+o)' footer. Every row stays within `width` columns.
 */
export function renderDiff(d: FileDiff, width: number, opts: { expanded?: boolean; max?: number; indent?: string } = {}): string[] {
  const g = G();
  const ind = opts.indent ?? '';
  const max = opts.max ?? DIFF_PREVIEW_LINES;
  const out = [ind + diffHeader(d)];
  const rows = parseUnified(d.unified || '');
  if (!rows.length) return out;
  const nw = Math.max(2, String(Math.max(...rows.map((r) => r.neu ?? r.old ?? 0))).length);
  const vis = opts.expanded ? rows : rows.slice(0, max);
  const inner = Math.max(8, width - width_(ind) - nw - 3);
  const ascii = isAscii() || NO_COLOR;
  for (const r of vis) {
    if (r.kind === '@') {
      out.push(ind + fg(C.faint)(' '.repeat(nw) + ' ' + (ascii ? '~' : '┄') + (r.text ? ' ' + truncate(r.text, inner - 2) : '')));
      continue;
    }
    const num = fg(C.faint)(String(r.kind === '-' ? r.old : r.neu).padStart(nw));
    const sign = r.kind === '+' ? '+' : r.kind === '-' ? '-' : ' ';
    const body = truncate(r.text.replace(/\t/g, '  '), inner - 2);
    if (r.kind === ' ') out.push(ind + num + ' ' + t.dim(' ' + ' ' + body));
    else if (ascii) out.push(ind + num + ' ' + (r.kind === '+' ? t.ok : t.err)(sign + ' ' + body));
    else {
      const paint = r.kind === '+' ? (s: string) => addBg(addFg(s)) : (s: string) => delBg(delFg(s));
      out.push(ind + num + ' ' + paint(padRight(sign + ' ' + body, inner)));
    }
  }
  const hidden = rows.length - vis.length;
  if (hidden > 0) out.push(ind + ' '.repeat(nw + 1) + t.faint(`${g.ell} +${hidden} more (ctrl+o)`));
  return out;
}
const width_ = width;
