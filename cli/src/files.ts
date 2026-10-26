// @file mentions: list files under cwd (bounded walk) and turn mentions into attachments.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { Attachment } from './api';

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', '.cache', '.idea', '.DS_Store', 'Pods', '.build', 'coverage', '.turbo']);
const MAX_FILES = 4000;
export const MAX_ATTACH_BYTES = 256 * 1024;

let cache: { cwd: string; at: number; files: string[] } | null = null;

export function listFiles(cwd: string): string[] {
  if (cache && cache.cwd === cwd && Date.now() - cache.at < 10_000) return cache.files;
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= MAX_FILES || depth > 8) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= MAX_FILES) return;
      if (SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.env.example')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) out.push(relative(cwd, p).split(sep).join('/'));
    }
  };
  walk(cwd, 0);
  cache = { cwd, at: Date.now(), files: out };
  return out;
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.json': 'application/json', '.md': 'text/markdown', '.html': 'text/html', '.csv': 'text/csv',
};
export const mimeOf = (p: string) => MIME[extname(p).toLowerCase()] || 'text/plain';

/** Find @path tokens in text that point at real files under cwd; return attachments. */
export function collectMentions(text: string, cwd: string): { attachments: Attachment[]; names: string[]; skipped: string[] } {
  const attachments: Attachment[] = [];
  const names: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)@((?:[^\s"'`]|\\ )+)/g)) {
    const rel = m[1].replace(/\\ /g, ' ').replace(/[.,;:!?)]+$/, '');
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = resolve(cwd, rel);
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      if (st.size > MAX_ATTACH_BYTES) {
        skipped.push(`${rel} (${Math.round(st.size / 1024)} KB > 256 KB)`);
        continue;
      }
      attachments.push({ name: rel, mime: mimeOf(rel), data_b64: Buffer.from(readFileSync(abs)).toString('base64') });
      names.push(rel);
    } catch {}
  }
  return { attachments, names, skipped };
}
