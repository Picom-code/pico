// Usage readout under the status line (Claude-Code style), profile pill, rate-limit bars.
// Pure functions of state; app.ts owns the state and refreshes /api/usage after each turn.
import { C, type Color, fg, G, isAscii, t, width as w } from './ansi';
import { dailySeries, fmtTok, sparkline, type UsageReport } from './features';

/** Summed `done.usage` for this chat. */
export interface SessionUsage {
  input: number;
  output: number;
  cached: number;
  turns: number;
  /** only when the engine sends a cost (never invented) */
  cost?: number;
}
export const emptySession = (): SessionUsage => ({ input: 0, output: 0, cached: 0, turns: 0 });

/** Future engine field: `usage.limits {session_pct, week_pct, resets_at}` (ChatGPT/Claude-style plan limits). */
export interface UsageLimits {
  session_pct?: number | null;
  week_pct?: number | null;
  resets_at?: number | string | null;
  week_resets_at?: number | string | null;
}

/** Add one done event's usage. Cached tokens come from usage.cached, else context.cached (tokens or fraction). */
export function addDone(s: SessionUsage, d: any): SessionUsage {
  const u = d?.usage;
  if (!u || !(u.input || u.output)) return s;
  s.input += +u.input || 0;
  s.output += +u.output || 0;
  let cached = +u.cached || 0;
  const cc = d?.context?.cached;
  if (!cached && typeof cc === 'number' && cc > 0) cached = cc <= 1 ? Math.round(cc * (+u.last_input || +u.input || 0)) : cc;
  s.cached += Math.min(cached, Math.max(+u.last_input || 0, +u.input || 0) || cached);
  s.turns += 1;
  if (typeof u.cost === 'number') s.cost = (s.cost || 0) + u.cost;
  return s;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round(Math.min(1, part / whole) * 100) : null);
const tok = (x?: { input?: number; output?: number } | null) => (x?.input || 0) + (x?.output || 0);

/** '5pm' / '10:30am' / 'in 2h' for a resets_at (epoch seconds | ms | ISO). */
export function fmtReset(v: number | string | null | undefined, now = Date.now()): string {
  if (v == null || v === '') return '';
  let ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  if (!isFinite(ms)) return '';
  const d = new Date(ms);
  if (ms - now > 24 * 3600_000) return d.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  return `${h}${m ? ':' + String(m).padStart(2, '0') : ''}${d.getHours() < 12 ? 'am' : 'pm'}`;
}

/** '▰▰▱▱▱▱' — accent fill, amber ≥ 80%, red ≥ 95%. */
export function limitBar(p: number, cells = 6): string {
  const g = G();
  const f = Math.max(0, Math.min(100, p)) / 100;
  let full = Math.round(f * cells);
  if (f > 0 && !full) full = 1;
  const color: Color = p >= 95 ? C.err : p >= 80 ? C.amber : C.accent;
  return fg(color)(g.pillOn.repeat(full)) + fg(240)(g.pillOff.repeat(cells - full));
}

/** 'session ▰▰▱▱▱▱ 34% · resets 5pm   week ▰▱▱▱▱▱ 12%' */
export function limitsSegment(l: UsageLimits, now = Date.now(), narrow = false): string {
  const sep = t.faint(` ${G().sep} `);
  const out: string[] = [];
  if (l.session_pct != null) {
    const r = fmtReset(l.resets_at, now);
    out.push(t.dim('session ') + limitBar(+l.session_pct) + ' ' + t.muted(`${Math.round(+l.session_pct)}%`) + (r && !narrow ? sep + t.dim(`resets ${r}`) : ''));
  }
  if (l.week_pct != null && !narrow) {
    const r = fmtReset(l.week_resets_at, now);
    out.push(t.dim('week ') + limitBar(+l.week_pct) + ' ' + t.muted(`${Math.round(+l.week_pct)}%`) + (r ? sep + t.dim(`resets ${r}`) : ''));
  }
  return out.join('   ');
}

export interface UsageLineOpts {
  session: SessionUsage;
  report?: UsageReport | null;
  /** model runs on a ChatGPT subscription (provider openai_login) */
  chatgpt?: boolean;
  limits?: UsageLimits | null;
  now?: number;
}

export const USAGE_NARROW = 70;

/**
 * One dim line under the status bar:
 *   wide:   'session 12k in · 1.1k out · cached 82%   today 212k · 31 turns   30d 1.4M ▁▂▅▃▇'
 *   narrow: 'session 12k · today 212k'
 * Limits (when the engine sends them) replace the today/30d part with Claude-Code-style bars. No $ unless
 * the engine sent a cost.
 */
export function usageLine(o: UsageLineOpts, cols: number): string {
  const g = G();
  const sep = t.faint(` ${g.sep} `);
  const gap = '   ';
  const s = o.session;
  const r = o.report;
  const narrow = cols < USAGE_NARROW;
  const num = (x: string) => t.muted(x);
  const fresh = !s.turns; // nothing sent in this chat yet: lead with today
  if (narrow) {
    const bits = fresh ? [] : [t.dim('session ') + num(fmtTok(s.input + s.output))];
    if (o.limits?.session_pct != null) bits.push(limitsSegment(o.limits, o.now, true));
    else if (r?.today) bits.push(t.dim('today ') + num(fmtTok(tok(r.today))));
    return fit(bits, sep, cols);
  }
  const groups: string[] = [];
  const sess = [t.dim('session ') + num(fmtTok(s.input)) + t.dim(' in'), num(fmtTok(s.output)) + t.dim(' out')];
  const cp = pct(s.cached, s.input);
  if (cp != null && cp > 0) sess.push(t.dim('cached ') + num(`${cp}%`));
  if (s.cost != null) sess.push(num(`$${s.cost.toFixed(2)}`));
  if (!fresh) groups.push(sess.join(sep));
  if (o.limits && (o.limits.session_pct != null || o.limits.week_pct != null)) groups.push(limitsSegment(o.limits, o.now));
  else {
    if (r?.today) groups.push(t.dim('today ') + num(fmtTok(tok(r.today))) + sep + num(`${r.today.turns ?? 0}`) + t.dim(' turns'));
    if (r?.totals) {
      const spark = sparkline(dailySeries(r.days, 7, o.now ? new Date(o.now) : new Date()).map((d) => d.tokens));
      groups.push(t.dim('30d ') + num(fmtTok(tok(r.totals))) + '\u0000' + t.faint(spark));
    }
    if (o.chatgpt) groups.push(t.dim('ChatGPT plan'));
  }
  // drop from the right; the sparkline goes before its group does
  for (let n = groups.length; n >= 1; n--) {
    const withSpark = groups.slice(0, n).join(gap).replace('\u0000', ' ');
    if (w(withSpark) <= cols) return withSpark;
    const noSpark = groups.slice(0, n).join(gap).replace(/\u0000.*$/, '');
    if (w(noSpark) <= cols) return noSpark;
  }
  return fresh ? '' : fit([t.dim('session ') + num(fmtTok(s.input + s.output))], sep, cols);
}

function fit(bits: string[], sep: string, cols: number): string {
  for (let n = bits.length; n >= 1; n--) {
    const s = bits.slice(0, n).join(sep);
    if (w(s) <= cols) return s;
  }
  return '';
}

// ---------------------------------------------------------------- profile pill
export interface ProfileCtx {
  tokens: number;
  budget: number;
  notes?: number;
  user_notes?: number;
  memory_notes?: number;
  skills_index_tokens?: number;
  agents_md_tokens?: number;
  total_standing_tokens?: number;
  estimate?: boolean;
}

/** 'you ▰▰▰▱ 210' — dim label, accent fill (amber > 90% of budget), 4 cells. ASCII: 'you [###-] 210'. */
export function profilePill(p: ProfileCtx | null | undefined): string {
  if (!p || !p.budget || p.tokens == null) return '';
  const g = G();
  const f = Math.max(0, Math.min(1, p.tokens / p.budget));
  let full = Math.round(f * 4);
  if (f > 0 && !full) full = 1;
  const color: Color = f > 0.9 ? C.amber : C.accent;
  const bar = fg(color)(g.pillOn.repeat(full)) + fg(240)(g.pillOff.repeat(4 - full));
  return t.dim('you ') + (isAscii() ? t.faint('[') + bar + t.faint(']') : bar) + ' ' + (f > 0.9 ? fg(C.amber) : t.dim)(fmtTok(p.tokens));
}

/** Normalize GET /api/profile/context or done.profile (missing = null). */
export function normProfile(x: any): ProfileCtx | null {
  if (!x || typeof x !== 'object') return null;
  const tokens = +x.tokens;
  const budget = +x.budget;
  if (!isFinite(tokens) || !(budget > 0)) return null;
  return { ...x, tokens, budget };
}
