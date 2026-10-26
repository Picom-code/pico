// Tab completion: slash commands (+ aliases, skills), their arguments, and @path mentions.
// Pure: complete(textBeforeCursor, sources) -> { start, items }. The app renders the top item's
// remainder as dim ghost text after the cursor and a candidate row when there are several.
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fuzzyFilter, fuzzyScore } from './fuzzy';

export interface Candidate {
  /** full replacement for the token (e.g. '/model', 'gpt-oss-20b', '@src/') */
  value: string;
  hint?: string;
  /** directories: accepting keeps completing (no trailing space) */
  dir?: boolean;
}
export interface Completion {
  /** index in the text where the replaced token starts */
  start: number;
  /** what was typed for this token */
  token: string;
  items: Candidate[];
}
export interface Sources {
  commands: { name: string; desc?: string; alias?: boolean; skill?: boolean }[];
  models?: { id: string; name?: string }[];
  themes?: string[];
  cronIds?: { id: string; title?: string }[];
  sessions?: { id: string; title?: string }[];
  efforts?: string[];
  verbosity?: string[];
  cwd?: string;
  /** all files under cwd (deep fuzzy fallback for @path) */
  files?: string[];
  /** directory lister (tests inject a fake) */
  readdir?: (dir: string) => { name: string; dir: boolean }[];
}

export const CRON_SUBS = ['list', 'add', 'rm', 'pause', 'resume', 'run'];
export const LOOP_ARGS = ['stop', 'until-done', '5m', '10m', '30m', '1h'];

const realReaddir = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') || e.name === '.github')
      .filter((e) => !['node_modules', '.git', '__pycache__', '.DS_Store'].includes(e.name))
      .map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch {
    return [];
  }
};

/** Fuzzy-ranked candidates; prefix matches first (so ghost text has something to show). */
function rank(list: Candidate[], q: string, key: (c: Candidate) => string = (c) => c.value): Candidate[] {
  if (!q) return list.slice();
  return fuzzyFilter(list, q, key);
}

export function complete(before: string, src: Sources): Completion | null {
  // only single-line input completes
  if (before.includes('\n')) return null;
  const tokStart = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\t')) + 1;
  const token = before.slice(tokStart);
  // @path anywhere in the line
  if (token.startsWith('@')) return { start: tokStart, token, items: pathCandidates(token.slice(1), src, src.files) };
  if (!before.startsWith('/')) return null;
  // the command name itself
  if (tokStart === 0) {
    const q = token.slice(1);
    const cmds = src.commands.map((c) => ({ value: '/' + c.name, hint: (c.skill ? 'skill · ' : '') + (c.desc || '') }));
    const items = q ? rank(cmds, q, (c) => c.value.slice(1)) : cmds.filter((c) => !src.commands.find((x) => '/' + x.name === c.value)?.alias);
    return { start: 0, token, items };
  }
  const words = before.split(/\s+/);
  const cmd = words[0].slice(1);
  const argIdx = words.length - 2; // 0 = first argument
  const q = token;
  let list: Candidate[] = [];
  switch (cmd) {
    case 'model':
      if (argIdx === 0) list = (src.models || []).map((m) => ({ value: m.id, hint: m.name && m.name !== m.id ? m.name : undefined }));
      // match on id or display name
      return { start: tokStart, token, items: q ? idThenName(list, q) : list };
    case 'theme':
    case 'settings':
      if (argIdx === 0) list = (src.themes || []).map((v) => ({ value: v }));
      break;
    case 'effort':
      if (argIdx === 0) list = (src.efforts || []).map((v) => ({ value: v }));
      break;
    case 'verbose':
      if (argIdx === 0) list = (src.verbosity || []).map((v) => ({ value: v }));
      break;
    case 'yolo':
      if (argIdx === 0) list = ['on', 'off'].map((v) => ({ value: v }));
      break;
    case 'goal':
      if (argIdx === 0) list = [{ value: 'clear', hint: 'remove the goal' }];
      break;
    case 'loop':
      if (argIdx === 0) list = LOOP_ARGS.map((v) => ({ value: v, hint: v === 'stop' ? 'end the loop' : v === 'until-done' ? 'repeat until the task is done' : `every ${v}` }));
      break;
    case 'cron':
      if (argIdx === 0) list = CRON_SUBS.map((v) => ({ value: v }));
      else if (argIdx === 1 && ['rm', 'pause', 'resume', 'run', 'delete'].includes(words[1])) list = (src.cronIds || []).map((c) => ({ value: c.id, hint: c.title }));
      break;
    case 'resume':
      if (argIdx === 0) {
        list = (src.sessions || []).map((s) => ({ value: s.id, hint: s.title }));
        return { start: tokStart, token, items: q ? idThenName(list, q) : list };
      }
      break;
  }
  return { start: tokStart, token, items: rank(list, q) };
}

/** Rank by id first (keeps list order on ties), then add matches on the display name. */
function idThenName(list: Candidate[], q: string): Candidate[] {
  const byId = fuzzyFilter(list, q, (c) => c.value);
  const seen = new Set(byId.map((c) => c.value));
  return [...byId, ...fuzzyFilter(list, q, (c) => c.hint || '').filter((c) => !seen.has(c.value))];
}

/** @path: entries of the typed directory (dirs end in '/'), fuzzy on the last segment; deep fuzzy fallback. */
export function pathCandidates(q: string, src: Sources, deep?: string[]): Candidate[] {
  const cwd = src.cwd || process.cwd();
  const rd = src.readdir || realReaddir;
  const slash = q.lastIndexOf('/');
  const dirPart = slash >= 0 ? q.slice(0, slash + 1) : '';
  const base = slash >= 0 ? q.slice(slash + 1) : q;
  const abs = dirPart.startsWith('/') || dirPart.startsWith('~') ? resolve(dirPart.replace(/^~/, process.env.HOME || '~')) : join(cwd, dirPart);
  const ents = rd(abs).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  let items: Candidate[] = ents.map((e) => ({ value: '@' + dirPart + e.name + (e.dir ? '/' : ''), dir: e.dir }));
  if (base) items = fuzzyFilter(items, base, (c) => c.value.slice(1 + dirPart.length).replace(/\/$/, ''));
  if (deep && q && items.length < 8) {
    const seen = new Set(items.map((i) => i.value));
    for (const f of fuzzyFilter(deep, q, (x) => x).slice(0, 12)) if (!seen.has('@' + f)) items.push({ value: '@' + f });
  }
  return items.slice(0, 50);
}

/** Dim remainder to show after the cursor: only when the top candidate extends what was typed. */
export function ghostFor(c: Completion | null, idx = 0): string {
  if (!c || !c.items.length) return '';
  const top = c.items[idx]?.value ?? '';
  if (top.length <= c.token.length) return '';
  if (!top.toLowerCase().startsWith(c.token.toLowerCase())) return '';
  return top.slice(c.token.length);
}

/** Apply a candidate: returns the new text (before-cursor part) — dirs and '/cmd' don't add a trailing space for dirs. */
export function applyCandidate(before: string, c: Completion, cand: Candidate): string {
  const tail = cand.dir ? '' : ' ';
  return before.slice(0, c.start) + cand.value.replace(/ /g, cand.value.startsWith('@') ? '\\ ' : ' ') + tail;
}

export { fuzzyScore };
