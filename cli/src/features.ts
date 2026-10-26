// Pure renderers for the agentic features: /model picker rows, /cron list, /loop status segment,
// /usage card + sparkline, goal banner + expanded box, plan card, steer lines, inbox notices.
// Everything is a function of (state, width, now) so it's unit-testable; app.ts owns the state.
import { bold, C, type Color, dim, fg, fmtCtx, fmtK, fmtSecs, G, isAscii, NO_COLOR, padRight, t, truncate, width as w } from './ansi';
import { PILL_EMPTY } from './status';
import { spinGlyph } from './theme';
import { box } from './ui';

// ---------------------------------------------------------------- shared types (engine contract)
export interface GoalTodo {
  text: string;
  done: boolean;
}
export interface GoalState {
  text: string;
  status: 'active' | 'done' | 'cleared';
  progress: { done: number; total: number } | null;
  todos: GoalTodo[];
}
export type StepStatus = 'pending' | 'active' | 'done';
export interface PlanState {
  title: string;
  steps: { text: string; status: StepStatus }[];
}
export interface LoopState {
  active: boolean;
  prompt?: string;
  every_s?: number | null;
  runs?: number;
  max_runs?: number | null;
  next_at?: number | string | null;
  state?: 'running' | 'waiting' | 'stopped' | 'done';
}
export interface CronJob {
  id: string;
  title?: string;
  prompt?: string;
  schedule?: any;
  schedule_text?: string;
  next_run?: number | string | null;
  last_run?: number | string | null;
  last_status?: string | null;
  enabled?: boolean;
  session_id?: string | null;
}
export interface ModelEntry {
  id: string;
  name?: string;
  provider?: string;
  provider_label?: string;
  local?: boolean;
  ctx?: number;
  tps?: number | null;
  tps_measured?: number | null;
  last_used?: number | string | null;
}
export interface UsageTotals {
  turns?: number;
  input?: number;
  output?: number;
  cached?: number;
  seconds?: number;
  tools?: number;
}
export interface UsageReport {
  totals?: UsageTotals;
  cache_hit_pct?: number | null;
  days?: { date: string; turns?: number; input?: number; output?: number; cached?: number }[];
  by_model?: { model: string; turns?: number; input?: number; output?: number; tps?: number | null }[];
  by_harness?: any[];
  today?: UsageTotals & { cache_hit_pct?: number | null };
}
export interface InboxItem {
  id?: string;
  title?: string;
  text?: string;
  preview?: string;
  body?: string;
  session_id?: string | null;
  created?: number | string;
  status?: string;
}

// ---------------------------------------------------------------- time helpers
/** epoch seconds | epoch ms | ISO string -> ms (0 if unknown) */
export function toMs(v: number | string | null | undefined): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (!isNaN(n)) return toMs(n);
  const p = Date.parse(v);
  return isNaN(p) ? 0 : p;
}

/** Countdown clock: '0:42', '4:12', '1:05:09' ('now' when due). */
export function fmtCountdown(ms: number): string {
  if (!isFinite(ms) || ms <= 500) return 'now';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Coarse future time: 'in 45s', 'in 12m', 'in 3h', 'in 2d' ('due' when past). */
export function fmtIn(ms: number): string {
  if (!isFinite(ms)) return '';
  if (ms <= 0) return 'due';
  const s = ms / 1000;
  if (s < 60) return `in ${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

/** Big token counts: 950, 9.4k, 48k, 2.1M */
export function fmtTok(n: number | undefined | null): string {
  n = Math.max(0, Math.round(n || 0));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  return fmtK(n);
}

/** Durations for totals: '42s', '4m 12s', '3h 2m' */
export function fmtDur(s: number | undefined | null): string {
  s = Math.max(0, s || 0);
  if (s < 3600) return fmtSecs(s);
  const h = Math.floor(s / 3600);
  return `${h}h ${Math.round((s - h * 3600) / 60)}m`;
}

// ---------------------------------------------------------------- pills
/** '▰▰▰▱▱' — n cells, filled in `color`, empty dim. ASCII: '###--'. */
export function pills(done: number, total: number, maxCells = 10, color: Color = C.accent): string {
  const g = G();
  if (!total) return '';
  const cells = Math.min(maxCells, total);
  const full = Math.max(0, Math.min(cells, Math.round((done / total) * cells)));
  return fg(color)(g.pillOn.repeat(full)) + fg(PILL_EMPTY)(g.pillOff.repeat(cells - full));
}

// ---------------------------------------------------------------- steer
export type SteerState = 'pending' | 'applied' | 'queued';
/** '↳ steer: tighten the copy' — dim while pending, accent + ✓ once the engine applied it. */
export function steerLine(text: string, state: SteerState, width: number): string {
  const g = G();
  const hook = isAscii() ? '->' : '↳';
  const body = text.replace(/\s+/g, ' ').trim();
  if (state === 'queued') return truncate(t.faint(hook + ' ') + t.dim('queued: ') + t.muted(body), width);
  if (state === 'applied') return truncate(t.accent(hook + ' steer: ') + fg(C.text)(body) + ' ' + t.accent(g.check), width);
  return truncate(t.faint(hook + ' ') + t.dim('steer: ' + body), width);
}

// ---------------------------------------------------------------- plan card
/**
 * ◇ plan · add a --json flag
 *   ✓ 1  read the parser          (dim)
 *   ⠹ 2  add the flag             (accent; spinner while live, ▸ otherwise)
 *   ○ 3  write tests
 */
export function planCard(p: PlanState, width: number, opts: { live?: boolean; now?: number } = {}): string[] {
  const g = G();
  const now = opts.now ?? Date.now();
  const diamond = isAscii() ? '<>' : '◇';
  const done = p.steps.filter((s) => s.status === 'done').length;
  const head = t.accent(diamond) + ' ' + t.dim('plan') + (p.title ? t.faint(` ${g.sep} `) + fg(C.text)(p.title) : '');
  const count = p.steps.length ? t.faint(`  ${done}/${p.steps.length}`) : '';
  const out = [truncate(head + count, width)];
  const numW = String(p.steps.length).length;
  p.steps.forEach((s, i) => {
    const n = String(i + 1).padStart(numW);
    let mark: string;
    let txt: (x: string) => string;
    if (s.status === 'done') {
      mark = t.ok(g.check);
      txt = (x) => t.faint(x);
    } else if (s.status === 'active') {
      mark = t.accent(opts.live ? spinGlyph(now) : isAscii() ? '>' : '▸');
      txt = (x) => fg(C.text)(x);
    } else {
      mark = t.dim(g.ring);
      txt = (x) => t.muted(x);
    }
    const num = s.status === 'active' ? t.accent(n) : t.faint(n);
    out.push(truncate('  ' + mark + ' ' + num + '  ' + txt(s.text.replace(/\s+/g, ' ').trim()), width));
  });
  return out;
}

/** 'enter go · e edit · esc cancel' under a plan that waits for approval. */
export function planWaitLine(width: number): string {
  const g = G();
  const k = (key: string, what: string) => t.accent(bold(key)) + t.dim(' ' + what);
  const diamond = isAscii() ? '<>' : '◇';
  return truncate('  ' + t.accent(diamond) + ' ' + t.muted('plan ready  ') + [k('enter', 'go'), k('e', 'edit'), k('esc', 'cancel')].join(t.faint(` ${g.sep} `)), width);
}

// ---------------------------------------------------------------- goal
export function normalizeGoal(x: any): GoalState | null {
  if (!x) return null;
  if (typeof x === 'string') return x.trim() ? { text: x.trim(), status: 'active', progress: null, todos: [] } : null;
  if (typeof x !== 'object' || !x.text) return null;
  const status = x.status === 'done' || x.status === 'cleared' ? x.status : 'active';
  const todos: GoalTodo[] = Array.isArray(x.todos) ? x.todos.filter((y: any) => y && y.text).map((y: any) => ({ text: String(y.text), done: !!y.done })) : [];
  let progress = x.progress && typeof x.progress === 'object' && +x.progress.total > 0 ? { done: +x.progress.done || 0, total: +x.progress.total } : null;
  if (!progress && todos.length) progress = { done: todos.filter((y) => y.done).length, total: todos.length };
  return { text: String(x.text), status, progress, todos };
}

/**
 * '◎ goal  ship the installer  ▰▰▰▱▱ 3/5'. `phase`: 'active' (accent glyph, dim text), 'reached'
 * (all green), 'fading' (all faint).
 */
export function goalBanner(goal: GoalState, maxW: number, phase: 'active' | 'reached' | 'fading' = 'active'): string {
  if (maxW < 12) return '';
  const target = isAscii() ? '(o)' : '◎';
  const pr = goal.progress;
  const green = phase === 'reached';
  const faint = phase === 'fading';
  const glyph = faint ? t.faint(target) : green ? t.ok(target) : t.accent(target);
  const label = faint ? t.faint(' goal  ') : green ? t.ok(' goal reached  ') : t.faint(' goal  ');
  const tail = pr ? '  ' + pills(pr.done, pr.total, 5, faint ? C.faint : green ? C.ok : C.accent) + ' ' + (faint ? t.faint : green ? t.ok : t.dim)(`${pr.done}/${pr.total}`) : '';
  const fixed = w(glyph + label) + w(tail);
  const room = maxW - fixed;
  if (room < 6) return truncate(glyph + label + (faint ? t.faint : green ? t.ok : t.muted)(goal.text), maxW);
  return glyph + label + (faint ? t.faint : green ? t.ok : t.muted)(truncate(goal.text, room)) + tail;
}

const strike = (s: string) => (NO_COLOR ? s : `\x1b[9m${s}\x1b[29m`);

/** Expanded goal: rounded box with the checklist (✓ done dim + struck, ▸ active, ○ pending). */
export function goalBox(goal: GoalState, cols: number): string[] {
  const g = G();
  const inner = Math.min(Math.max(36, cols - 4), 78);
  const target = isAscii() ? '(o)' : '◎';
  const body: string[] = [];
  const pr = goal.progress;
  body.push(fg(C.text)(truncate(goal.text, inner - 16)) + (pr ? '  ' + pills(pr.done, pr.total, 8) + t.dim(` ${pr.done}/${pr.total}`) : ''));
  if (goal.status === 'done') body.push(t.ok(`${g.check} reached`));
  if (goal.todos.length) {
    body.push('');
    const firstOpen = goal.todos.findIndex((x) => !x.done);
    goal.todos.slice(0, 12).forEach((td, i) => {
      if (td.done) body.push(t.ok(g.check) + ' ' + dim(t.faint(strike(td.text))));
      else if (i === firstOpen) body.push(t.accent(isAscii() ? '>' : '▸') + ' ' + fg(C.text)(td.text));
      else body.push(t.dim(g.ring) + ' ' + t.muted(td.text));
    });
    if (goal.todos.length > 12) body.push(t.faint(`${g.ell} ${goal.todos.length - 12} more`));
  } else body.push(t.faint('no checklist yet'));
  const footer = t.faint(`ctrl+o close ${g.sep} /goal clear`);
  return box(t.accent(target) + ' goal', body, inner, C.faint, footer).map((l) => '  ' + l);
}

// ---------------------------------------------------------------- loop
/** '↻ loop 3/20 · next 4:12' / '↻ loop 3 · running' ('' when no loop is active). */
export function loopSegment(l: LoopState | null | undefined, now = Date.now()): string {
  if (!l || !l.active || l.state === 'stopped' || l.state === 'done') return '';
  const g = G();
  const glyph = isAscii() ? '@' : '↻';
  const n = l.runs ?? 0;
  const count = l.max_runs ? `${n}/${l.max_runs}` : `${n}`;
  let tail = '';
  if (l.state === 'running') tail = ` ${g.sep} running`;
  else if (l.next_at) tail = ` ${g.sep} next ${fmtCountdown(toMs(l.next_at) - now)}`;
  return t.accent(glyph) + t.dim(` loop ${count}${tail}`);
}

/** Header that replaces the user line for engine-started turns: '↻ loop #3' / '◷ cron · title'. */
export function loopHeader(n: number | string): string {
  return `loop #${n}`;
}

// ---------------------------------------------------------------- cron
export function scheduleText(j: CronJob): string {
  if (j.schedule_text) return j.schedule_text;
  const s = j.schedule;
  if (!s) return '';
  if (typeof s === 'string') return s;
  if (s.text) return s.text;
  if (s.every) return `every ${s.every}`;
  if (s.cron) return s.cron;
  if (s.time) {
    const days: string[] = s.days || [];
    const d = days.length === 7 || !days.length ? 'daily' : days.join(',') === 'mon,tue,wed,thu,fri' ? 'weekdays' : days.join(',');
    return `${d} ${s.time}`;
  }
  return '';
}

export function lastMark(status: string | null | undefined): string {
  const g = G();
  if (!status) return t.faint('last —');
  if (/^(ok|success|done|completed?)$/i.test(status)) return t.dim('last ') + t.ok(g.check);
  if (/^(running)$/i.test(status)) return t.dim('last ') + t.accent(spinGlyph());
  return t.dim('last ') + t.err(g.cross);
}

/** One cron row: '● morning brief   every weekday 8:00   next in 3h   last ✓' */
export function cronRow(j: CronJob, width: number, now = Date.now(), cols = { title: 22, sched: 22 }): string {
  const g = G();
  const on = j.enabled !== false;
  const dot = on ? t.accent(g.dot) : t.faint(g.ring);
  const title = truncate(j.title || j.prompt || j.id, cols.title - 1);
  const sched = truncate(scheduleText(j), cols.sched - 1);
  const next = !on ? 'paused' : j.next_run ? `next ${fmtIn(toMs(j.next_run) - now)}` : '';
  const titleS = (on ? fg(C.text) : t.dim)(title) + ' '.repeat(Math.max(1, cols.title - w(title)));
  const schedS = (on ? t.muted : t.faint)(sched) + ' '.repeat(Math.max(1, cols.sched - w(sched)));
  const nextS = (on ? t.dim : t.faint)(next) + ' '.repeat(Math.max(1, 13 - w(next)));
  return truncate(dot + ' ' + titleS + schedS + nextS + lastMark(j.last_status), width);
}

export type CronPrompt = { kind: 'when' | 'what'; value: string; when?: string } | { kind: 'confirm'; text: string } | null;

/** The /cron box: rows, inline prompts, key footer. */
export function cronPanelLines(jobs: CronJob[], idx: number, cols: number, now = Date.now(), prompt: CronPrompt = null, note = ''): string[] {
  const g = G();
  const inner = Math.min(Math.max(44, cols - 4), 86);
  const titleW = Math.min(26, Math.max(10, ...jobs.map((j) => w(j.title || j.prompt || j.id) + 2)));
  const schedW = Math.min(26, Math.max(10, ...jobs.map((j) => w(scheduleText(j)) + 2)));
  const body: string[] = [''];
  if (!jobs.length) body.push(t.dim('no scheduled jobs yet ') + t.faint(`${g.sep} `) + t.accent('n') + t.dim(' to add one'));
  jobs.forEach((j, i) => {
    const sel = i === idx;
    body.push((sel ? t.accent(g.caret) : ' ') + ' ' + cronRow(j, inner - 4, now, { title: titleW, sched: schedW }));
    if (sel && j.prompt && j.prompt !== j.title) body.push('    ' + t.faint(truncate(j.prompt.replace(/\s+/g, ' '), inner - 8)));
  });
  body.push('');
  if (prompt?.kind === 'when') {
    body.push(t.accent('? ') + bold('when?') + t.faint('  e.g. every weekday at 8am · every 30m · 0 8 * * 1-5'));
    body.push('  ' + t.accent(g.user + ' ') + fg(C.text)(prompt.value) + t.accent('▏'));
  } else if (prompt?.kind === 'what') {
    body.push(t.dim('when: ') + t.muted(prompt.when || ''));
    body.push(t.accent('? ') + bold('what should pico do?'));
    body.push('  ' + t.accent(g.user + ' ') + fg(C.text)(prompt.value) + t.accent('▏'));
  } else if (prompt?.kind === 'confirm') {
    body.push(t.warn(prompt.text) + t.dim('  (y/n)'));
  } else if (note) body.push(note);
  else body.pop();
  if (prompt) body.push('');
  const k = (key: string, what: string) => t.accent(key) + t.faint(' ' + what);
  const footer = prompt
    ? t.faint(`enter ${prompt.kind === 'confirm' ? 'yes' : 'next'} ${g.sep} esc back`)
    : [k('n', 'new'), k('enter', 'run now'), k('space', 'pause'), k('d', 'delete'), k('esc', 'close')].join(t.faint(` ${g.sep} `));
  const clock = isAscii() ? '@' : '◷';
  return box(t.accent(clock) + ' cron' + t.faint(jobs.length ? ` ${g.sep} ${jobs.length}` : ''), body, inner, C.faint, footer).map((l) => '  ' + l);
}

// ---------------------------------------------------------------- inbox
export function inboxText(it: InboxItem): string {
  return String(it.text ?? it.preview ?? it.body ?? '').trim();
}
/** '✉ morning brief: 3 PRs need review' */
export function inboxLine(it: InboxItem, width: number): string {
  const env = isAscii() ? '[m]' : '✉';
  const first = inboxText(it).split('\n').find((l) => l.trim()) || '';
  return truncate(t.accent(env) + ' ' + fg(C.text)(it.title || 'check-in') + (first ? t.faint(': ') + t.dim(first.replace(/\s+/g, ' ')) : ''), width);
}
export function inboxBadge(n: number): string {
  if (!n) return '';
  return t.accent(isAscii() ? '[m]' : '✉') + t.dim(` ${n}`);
}

// ---------------------------------------------------------------- models
export function modelTps(m: ModelEntry): { text: string; measured: boolean } {
  if (m.tps_measured) return { text: `${Math.round(m.tps_measured)} tok/s`, measured: true };
  if (m.tps) return { text: `~${Math.round(m.tps)} tok/s`, measured: false };
  return { text: '—', measured: false };
}
export function providerLabel(m: ModelEntry): string {
  return m.provider_label || (m.local ? `local${m.provider ? ' · ' + m.provider : ''}` : m.provider || 'other');
}

/** Rows in display order: group headers (provider_label) then models. Returns [rowLines, modelIndex->line]. */
export function modelPanelLines(models: ModelEntry[], active: string, idx: number, cols: number): string[] {
  const g = G();
  const inner = Math.min(Math.max(44, cols - 4), 78);
  const groups: { label: string; items: { m: ModelEntry; i: number }[] }[] = [];
  models.forEach((m, i) => {
    const lab = providerLabel(m);
    let gr = groups.find((x) => x.label === lab);
    if (!gr) groups.push((gr = { label: lab, items: [] }));
    gr.items.push({ m, i });
  });
  const nameW = Math.min(34, Math.max(12, ...models.map((m) => w(m.name || m.id) + 2)));
  const body: string[] = [];
  for (const gr of groups) {
    body.push('');
    body.push(t.faint(truncate(gr.label, inner - 4)));
    for (const { m, i } of gr.items) {
      const sel = i === idx;
      const act = m.id === active;
      const dot = act ? t.accent(g.dot) : t.faint(g.ring);
      const name = truncate(m.name || m.id, nameW - 1);
      const nameS = (sel ? (s: string) => bold(fg(C.text)(s)) : act ? fg(C.text) : t.muted)(name) + ' '.repeat(Math.max(1, nameW - w(name)));
      const ctx = m.ctx ? `ctx ${fmtCtx(m.ctx)}` : '';
      const ctxS = t.dim(padRight(ctx, 10));
      const tp = modelTps(m);
      const tpsS = tp.measured ? t.muted(tp.text) : t.faint(tp.text);
      body.push((sel ? t.accent(g.caret) : ' ') + ' ' + dot + ' ' + nameS + ctxS + tpsS + (act ? t.faint('  active') : ''));
    }
  }
  body.push('');
  const footer = t.faint(`↑↓ move ${g.sep} enter switch ${g.sep} esc cancel`);
  return box(t.accent(g.dot) + ' model', body, inner, C.faint, footer).map((l) => '  ' + l);
}

// ---------------------------------------------------------------- usage
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const SPARK_ASCII = ['_', '.', ':', '-', '=', '+', '*', '#'];
/** '▁▂▃▅▇' — one cell per value, scaled to the max (zero = lowest bar). */
export function sparkline(vals: number[]): string {
  const bars = isAscii() ? SPARK_ASCII : SPARK;
  const max = Math.max(0, ...vals);
  if (!max) return bars[0].repeat(vals.length);
  return vals.map((v) => (v > 0 ? bars[Math.max(1, Math.min(7, Math.round((v / max) * 7)))] : bars[0])).join('');
}

/** Last `days` calendar days ending today, filling gaps with zero (dates are YYYY-MM-DD). */
export function dailySeries(days: UsageReport['days'] = [], n = 30, today = new Date()): { date: string; tokens: number }[] {
  const by = new Map((days || []).map((d) => [d.date.slice(0, 10), (d.input || 0) + (d.output || 0)]));
  const out: { date: string; tokens: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ date: key, tokens: by.get(key) || 0 });
  }
  return out;
}

const cachePct = (tot: UsageTotals | undefined, pct?: number | null): number | null => {
  if (pct != null && isFinite(+pct)) return Math.round(+pct);
  if (tot?.input && tot.cached != null) return Math.round((tot.cached / tot.input) * 100);
  return null;
};

/** The /usage card: today + 30d totals, sparkline of tokens/day, per-model table with tok/s. */
export function usageCard(u: UsageReport, cols: number, today = new Date()): string[] {
  const g = G();
  const inner = Math.min(Math.max(44, cols - 4), 80);
  const sep = t.faint(` ${g.sep} `);
  const line = (label: string, tot: UsageTotals | undefined, pct: number | null) => {
    const bits = [
      fg(C.text)(`${tot?.turns ?? 0}`) + t.dim(' turns'),
      fg(C.text)(fmtTok(tot?.input)) + t.dim(' in'),
      fg(C.text)(fmtTok(tot?.output)) + t.dim(' out'),
      ...(pct != null ? [t.accent(`${pct}%`) + t.dim(' cached')] : []),
      ...(tot?.seconds ? [t.dim(fmtDur(tot.seconds))] : []),
    ];
    return t.muted(padRight(label, 9)) + bits.join(sep);
  };
  const body: string[] = [''];
  body.push(line('today', u.today, cachePct(u.today, u.today?.cache_hit_pct)));
  body.push(line('30 days', u.totals, cachePct(u.totals, u.cache_hit_pct)));
  const series = dailySeries(u.days, 30, today);
  const peak = Math.max(0, ...series.map((s) => s.tokens));
  body.push('');
  body.push(t.muted(padRight('tokens', 9)) + t.accent(sparkline(series.map((s) => s.tokens))) + t.faint(`  peak ${fmtTok(peak)}/day`));
  body.push(' '.repeat(9) + t.faint(padRight(series[0].date.slice(5), 15) + padRight('', 15 - 5) + 'today'));
  const rows = (u.by_model || []).slice().sort((a, b) => (b.input || 0) + (b.output || 0) - ((a.input || 0) + (a.output || 0))).slice(0, 6);
  if (rows.length) {
    body.push('');
    const nameW = Math.min(28, Math.max(5, ...rows.map((r) => w(r.model))));
    const hdr = [padRight('model', nameW), 'turns'.padStart(6), 'in'.padStart(7), 'out'.padStart(7), 'tok/s'.padStart(6)];
    body.push(bold(fg(C.text)(hdr.join('  '))));
    body.push(t.faint((isAscii() ? '-' : '─').repeat(w(hdr.join('  ')))));
    for (const r of rows)
      body.push(
        t.muted(padRight(truncate(r.model, nameW), nameW)) + '  ' + t.dim(String(r.turns ?? 0).padStart(6)) + '  ' + t.dim(fmtTok(r.input).padStart(7)) + '  ' +
          t.dim(fmtTok(r.output).padStart(7)) + '  ' + (r.tps ? t.accent(String(Math.round(r.tps)).padStart(6)) : t.faint('—'.padStart(6))),
      );
  }
  body.push('');
  const tools = u.totals?.tools ? `${u.totals.tools} tool calls ${g.sep} ` : '';
  return box(t.accent('(^.^)') + ' usage', body, inner, C.faint, t.faint(`${tools}last 30 days`)).map((l) => '  ' + l);
}
