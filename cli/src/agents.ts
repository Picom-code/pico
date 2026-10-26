// Subagent panel (grouped live lines) + /agents settings model.
import { bold, C, fg, fmtK, fmtSecs, G, t, truncate, width as w } from './ansi';
import { spinFrame } from './tty';

export interface Subagent {
  id: string;
  goal: string;
  model?: string;
  label?: string;
  tail?: string[];
  start: number;
  end?: number;
  ok?: boolean;
  summary?: string;
  seconds?: number;
  tokens?: number;
}

export function applySubagent(list: Subagent[], ev: string, d: any, now = Date.now()): boolean {
  const id = String(d?.id ?? '');
  const find = () => list.find((x) => x.id === id);
  if (ev === 'subagent_start') {
    if (find()) return false;
    list.push({ id, goal: String(d?.goal ?? ''), model: d?.model, start: now });
    return true;
  }
  if (ev === 'subagent_progress') {
    const a = find();
    if (!a) return false;
    if (d?.label) a.label = String(d.label);
    if (Array.isArray(d?.tail)) a.tail = d.tail.map(String).slice(-2);
    return true;
  }
  if (ev === 'subagent_end') {
    const a = find() ?? (list.push({ id, goal: String(d?.goal ?? id), start: now }), list[list.length - 1]);
    a.end = now;
    a.ok = d?.ok !== false;
    a.summary = d?.summary ?? '';
    a.seconds = d?.seconds;
    a.tokens = d?.tokens;
    return true;
  }
  return false;
}

/**
 * '⎇ 3 subagents' + one line each. Collapses to a single summary line when all finished unless
 * `expanded` (ctrl+o), in which case each agent's summary is shown.
 */
export function renderSubagents(list: Subagent[], width: number, opts: { expanded?: boolean; now?: number } = {}): string[] {
  if (!list.length) return [];
  const g = G();
  const now = opts.now ?? Date.now();
  const done = list.filter((a) => a.end).length;
  const failed = list.filter((a) => a.end && !a.ok).length;
  const all = done === list.length;
  const totalTok = list.reduce((s, a) => s + (a.tokens || 0), 0);
  const maxSecs = Math.max(...list.map((a) => a.seconds ?? ((a.end ?? now) - a.start) / 1000));
  const n = `${list.length} subagent${list.length === 1 ? '' : 's'}`;
  if (all && !opts.expanded) {
    const head = failed ? t.err(g.cross) : t.ok(g.check);
    const bits = [failed ? `${list.length - failed}/${list.length} ok` : 'all done', fmtSecs(maxSecs), totalTok ? `${fmtK(totalTok)} tok` : ''].filter(Boolean);
    return [head + ' ' + t.accent(g.branch) + ' ' + fg(C.text)(n) + '  ' + t.dim(bits.join(` ${g.sep} `)) + t.faint('  ctrl+o')];
  }
  const out = [t.accent(g.branch) + ' ' + bold(fg(C.text)(n)) + t.faint(all ? '' : `  ${done}/${list.length} done`)];
  const goalW = Math.max(12, Math.min(40, Math.floor(width * 0.42)));
  for (const a of list) {
    const icon = a.end ? (a.ok ? t.ok(g.check) : t.err(g.cross)) : t.accent(spinFrame(now));
    const secs = a.seconds ?? ((a.end ?? now) - a.start) / 1000;
    const meta = t.faint(fmtSecs(secs) + (a.tokens ? ` ${g.sep} ${fmtK(a.tokens)} tok` : ''));
    const goal = truncate(a.goal.replace(/\s+/g, ' '), goalW);
    const goalCell = (a.end ? t.muted : fg(C.text))(goal) + ' '.repeat(Math.max(1, goalW - w(goal) + 2));
    const stepRoom = Math.max(0, width - 4 - goalW - 2 - w(meta) - 2);
    const step = a.end ? (opts.expanded ? '' : a.ok ? '' : 'failed') : a.label || 'starting';
    const stepTxt = step && stepRoom > 6 ? t.dim(truncate(step, stepRoom)) + '  ' : '';
    out.push('  ' + icon + ' ' + goalCell + stepTxt + meta);
    if (opts.expanded && a.end && a.summary) {
      for (const l of a.summary.split('\n').filter(Boolean).slice(0, 6)) out.push('    ' + t.faint(g.elbow + ' ') + t.dim(truncate(l, width - 8)));
    } else if (!a.end && a.tail?.length) {
      for (const l of a.tail.slice(-1)) out.push('    ' + t.faint(g.elbow + ' ' + truncate(l, width - 8)));
    }
  }
  return out;
}

// ---------------------------------------------------------------- /agents settings
export interface SubagentSettings {
  enabled: boolean;
  max_parallel: number;
  model: string; // '' = same as main
  effort: 'low' | 'medium' | 'high';
  max_seconds: number;
}
export const DEFAULT_SUBAGENTS: SubagentSettings = { enabled: true, max_parallel: 3, model: '', effort: 'low', max_seconds: 600 };
export const BUDGETS = [60, 120, 300, 600, 900, 1800, 3600];

export function normalizeSubagents(x: any): SubagentSettings {
  const d = { ...DEFAULT_SUBAGENTS };
  if (!x || typeof x !== 'object') return d;
  if (typeof x.enabled === 'boolean') d.enabled = x.enabled;
  if (Number.isFinite(+x.max_parallel)) d.max_parallel = Math.max(1, Math.min(8, Math.round(+x.max_parallel)));
  if (typeof x.model === 'string') d.model = x.model === 'same' ? '' : x.model;
  if (['low', 'medium', 'high'].includes(x.effort)) d.effort = x.effort;
  else if (x.effort === 'off') d.effort = 'low';
  if (Number.isFinite(+x.max_seconds) && +x.max_seconds > 0) d.max_seconds = Math.round(+x.max_seconds);
  return d;
}

export function fmtBudget(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(s % 3600 ? 1 : 0)} h`;
}
