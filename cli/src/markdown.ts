// Streaming-friendly markdown -> ANSI lines. Deliberately small: fences (with minimal highlighting),
// headings, lists, quotes, rules, inline bold/italic/code/links. Unclosed fences render as code
// (so partial streams look right). Pure function of (src, width) -> string[].
import { bold, C, dim, fg, G, isAscii, italic, padRight, t, truncate, underline, width as w, wrap } from './ansi';

const codeFg = fg(C.code);
const kwFg = fg(141);
const strFg = fg(114);
const numFg = fg(179);
const comFg = fg(242);
const border = fg(238);

const KEYWORDS = new Set(
  (
    'abstract and as async await break case catch class const continue def del do elif else enum except export ' +
    'extends false fn for from func function go if impl import in interface is lambda let match mod mut new nil ' +
    'none not null or package pass pub raise return self static struct super switch this throw true try type ' +
    'typeof undefined use var void while with yield None True False echo then fi done esac local'
  ).split(' '),
);

/** Minimal syntax highlighter: comments, strings, numbers, keywords. Language-agnostic. */
export function highlight(line: string, lang = ''): string {
  if (lang === 'diff') {
    if (line.startsWith('+')) return fg(114)(line);
    if (line.startsWith('-')) return fg(203)(line);
    if (line.startsWith('@@')) return fg(80)(line);
    return codeFg(line);
  }
  const hashComments = /^(py|python|sh|bash|zsh|shell|rb|ruby|yaml|yml|toml|r|perl|ps1|powershell|dockerfile|make|makefile|conf|ini)$/i.test(lang);
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const rest = line.slice(i);
    // comments
    if (rest.startsWith('//') && !hashComments) {
      out += comFg(rest);
      break;
    }
    if (rest.startsWith('#') && (hashComments || !lang) && (i === 0 || /\s/.test(line[i - 1]))) {
      out += comFg(rest);
      break;
    }
    if (rest.startsWith('--') && /^(sql|lua|haskell|hs)$/i.test(lang)) {
      out += comFg(rest);
      break;
    }
    const c = line[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      const s = line.slice(i, Math.min(n, j + 1));
      out += strFg(s);
      i += s.length;
      continue;
    }
    const num = /^\d[\d_.xXa-fA-F]*/.exec(rest);
    if (num && (i === 0 || !/[\w$]/.test(line[i - 1]))) {
      out += numFg(num[0]);
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      out += KEYWORDS.has(word[0]) ? kwFg(word[0]) : codeFg(word[0]);
      i += word[0].length;
      continue;
    }
    out += codeFg(c);
    i++;
  }
  return out;
}

/** Inline markdown: `code`, **bold**, __bold__, *italic*, _italic_, [text](url). */
export function inline(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`]+)`/.exec(rest))) {
      out += codeFg(m[1]);
      i += m[0].length;
      continue;
    }
    if ((m = /^\*\*(?=\S)([\s\S]*?\S)\*\*/.exec(rest)) || (m = /^__(?=\S)([\s\S]*?\S)__/.exec(rest))) {
      out += bold(inline(m[1]));
      i += m[0].length;
      continue;
    }
    const wordStart = i === 0 || /\W/.test(s[i - 1]);
    if ((m = /^\*(?=[^\s*])([^*]*?[^\s*]|[^\s*])\*/.exec(rest)) || (wordStart && (m = /^_(?=\S)([^_]*?\S|\S)_(?!\w)/.exec(rest)))) {
      out += italic(inline(m[1]));
      i += m[0].length;
      continue;
    }
    if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      const same = m[1] === m[2] || m[1] === m[2].replace(/^https?:\/\//, '');
      out += underline(fg(C.accent)(m[1])) + (same ? '' : fg(C.faint)(` ${m[2]}`));
      i += m[0].length;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

export interface MdOptions {
  /** prefix for every line (e.g. two-space indent) */
  indent?: string;
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|(\s*:?-{1,}:?\s*\|)+\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/**
 * GitHub-style table -> aligned columns: bold header, dim '─┼─' rule, faint '│' between cells, no
 * outer frame. Columns shrink (widest first) to fit `W`; cells that still don't fit are truncated.
 */
export function renderTable(rows: string[], W: number): string[] {
  const g = { ...G(), ascii: isAscii() };
  const sepIdx = rows.findIndex(isTableSep);
  const aligns: ('l' | 'r' | 'c')[] = sepIdx >= 0 ? cells(rows[sepIdx]).map((c) => (/^:-+:$/.test(c) ? 'c' : /-:$/.test(c) ? 'r' : 'l')) : [];
  const body = rows.filter((_, i) => i !== sepIdx).map((r) => cells(r).map((c) => inline(c)));
  const n = Math.max(...body.map((r) => r.length));
  const colW = Array.from({ length: n }, (_, j) => Math.max(1, ...body.map((r) => w(r[j] ?? ''))));
  const gap = 3; // ' │ '
  const total = () => colW.reduce((a, b) => a + b, 0) + gap * (n - 1);
  while (total() > W) {
    const j = colW.indexOf(Math.max(...colW));
    if (colW[j] <= 4) break;
    colW[j]--;
  }
  const bar = t.faint(g.ascii ? ' | ' : ' │ ');
  const fit = (s: string, j: number) => {
    const c = truncate(s, colW[j]);
    const pad = colW[j] - w(c);
    const a = aligns[j] ?? 'l';
    if (a === 'r') return ' '.repeat(pad) + c;
    if (a === 'c') return ' '.repeat(Math.floor(pad / 2)) + c + ' '.repeat(pad - Math.floor(pad / 2));
    return c + ' '.repeat(pad);
  };
  const out: string[] = [];
  body.forEach((r, i) => {
    const hdr = sepIdx > 0 && i === 0;
    const line = colW.map((_, j) => fit(r[j] ?? '', j)).map((c) => (hdr ? bold(fg(C.text)(c)) : c)).join(bar);
    out.push(truncate(line.replace(/\s+$/, ''), W));
    if (hdr) out.push(t.faint(colW.map((cw) => (g.ascii ? '-' : '─').repeat(cw)).join(g.ascii ? '-+-' : '─┼─')));
  });
  return out;
}

export function renderMarkdown(src: string, width: number, opts: MdOptions = {}): string[] {
  const ind = opts.indent ?? '';
  const W = Math.max(10, width - w(ind));
  const out: string[] = [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let inFence = false;
  let fenceLang = '';
  let fenceMark = '';
  const g = { ...G(), ascii: isAscii() };
  const boxW = Math.max(12, Math.min(W, 100));
  const codeW = boxW - 4;
  const fenceTop = (lang: string) => {
    const lab = ' ' + (lang || 'code') + ' ';
    return ind + border(g.tl + g.h) + dim(lab) + border(g.h.repeat(Math.max(0, boxW - 3 - w(lab))) + g.tr);
  };
  const fenceBottom = () => ind + border(g.bl + g.h.repeat(boxW - 2) + g.br);
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const fm = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(raw);
    if (inFence) {
      if (fm && fm[1][0] === fenceMark[0] && fm[1].length >= fenceMark.length && !fm[2]) {
        inFence = false;
        out.push(fenceBottom());
        continue;
      }
      const code = raw.replace(/\t/g, '  ');
      out.push(ind + border(g.v + ' ') + padRight(truncate(highlight(code, fenceLang), codeW), codeW) + border(' ' + g.v));
      continue;
    }
    if (fm) {
      inFence = true;
      fenceMark = fm[1];
      fenceLang = fm[2] || '';
      out.push(fenceTop(fenceLang));
      continue;
    }
    if (/^\s*$/.test(raw)) {
      if (out.length && out[out.length - 1] !== ind) out.push(ind);
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(raw))) {
      const txt = m[2].replace(/\s*#+\s*$/, '');
      const styled = m[1].length <= 2 ? bold(fg(C.accent)(inline(txt))) : bold(fg(C.text)(inline(txt)));
      if (out.length && out[out.length - 1] !== ind) out.push(ind); // headings always get air above
      for (const l of wrap(styled, W)) out.push(ind + l);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push(ind + t.faint('─'.repeat(Math.min(W, 40))));
      continue;
    }
    if ((m = /^(\s*)>\s?(.*)$/.exec(raw))) {
      for (const l of wrap(italic(t.muted(inline(m[2]))), W - 2)) out.push(ind + fg(C.dim)(g.ascii ? '| ' : '▎ ') + l);
      continue;
    }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(raw))) {
      const depth = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
      const pad = '  '.repeat(depth);
      let bullet = /\d/.test(m[2]) ? t.muted(m[2]) : t.accent(g.ascii ? '*' : '•');
      if (m[3]) bullet = /x/i.test(m[3]) ? t.ok('☑') : t.muted('☐');
      const head = pad + bullet + ' ';
      const hw = w(head);
      const wrapped = wrap(inline(m[4]), W - hw);
      wrapped.forEach((l, i) => out.push(ind + (i === 0 ? head : ' '.repeat(hw)) + l.replace(/^ +/, '')));
      continue;
    }
    if (isTableRow(raw)) {
      const block = [raw];
      while (li + 1 < lines.length && isTableRow(lines[li + 1])) block.push(lines[++li]);
      for (const l of renderTable(block, W)) out.push(ind + l);
      continue;
    }
    for (const l of wrap(inline(raw.replace(/\t/g, '  ')), W)) out.push(ind + l);
  }
  while (out.length && out[out.length - 1] === ind) out.pop();
  return out;
}
