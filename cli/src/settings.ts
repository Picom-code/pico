// /settings: ONE rounded panel with tabs across the top (Claude Code style):
//   Status · Config · Usage · Look & feel
// ←→ / tab switch tabs, ↑↓ move, enter/space (or + / −) change, esc closes. Every change saves at once
// (engine config via PATCH /api/config, TUI prefs via tui.json) with a brief ✓.
// Renders are pure functions of SettingsState (tested); settingsPanel() wires keys + timers.
import { bold, C, fg, G, isAscii, padRight, shortPath, t, truncate, width as w, wrap } from './ansi';
import { normalizeSubagents } from './agents';
import { type Effort, EFFORT_COLOR, effortLabel, EFFORTS, normalizeEffort } from './effort';
import { dailySeries, fmtDur, fmtTok, sparkline, type UsageReport, type UsageTotals } from './features';
import { ctxBar, cachedPct, fmtCtxPair } from './status';
import {
  ACCENTS, accentIndex, accentName, REASONING_LEVELS, REPLY_STYLES, type ReplyStyle, shimmer, spinGlyph, SPINNERS, TOOLS_LEVELS, type TuiPrefs,
} from './theme';
import type { Key } from './keys';
import type { LiveScreen, Terminal } from './tty';
import { box, modal } from './ui';
import { limitBar, fmtReset, type ProfileCtx, type UsageLimits } from './usage';

export const TABS = ['Status', 'Config', 'Usage', 'Look & feel'] as const;
export type TabName = (typeof TABS)[number];

export interface StatusInfo {
  version: string;
  engineUrl: string;
  health?: { ok?: boolean; version?: string; state?: string } | null;
  healthError?: string;
  model?: string;
  providerLabel?: string;
  provider?: string;
  harness?: string;
  cwd?: string;
  sessionId?: string | null;
  yolo?: boolean;
  chatgptLoggedIn?: boolean | null;
  ctx?: { used: number; max: number; cached?: number };
  profile?: ProfileCtx | null;
}

export interface SettingsState {
  tab: number;
  /** selected row per tab (Config / Look & feel) */
  row: Record<number, number>;
  cfg: any;
  prefs: TuiPrefs;
  efforts: Effort[];
  status: StatusInfo;
  usage?: UsageReport | null;
  limits?: UsageLimits | null;
  chatgpt?: boolean;
  /** last save: ✓ next to the row + footer note */
  flash?: { key: string; text: string; at: number; error?: boolean };
  /** a PATCH in flight for this row key */
  saving?: string;
}

// ---------------------------------------------------------------- config rows
export const COMPACTION_DEFAULT = { auto: true, at_pct: 80, keep_recent: 6, mode: 'summary', notify: true };
export const compaction = (cfg: any) => ({ ...COMPACTION_DEFAULT, ...(cfg?.compaction && typeof cfg.compaction === 'object' ? cfg.compaction : {}) });
const range = (a: number, b: number, step = 1) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step);

export interface ConfigRow {
  key: string;
  section: string;
  label: string;
  explain: string;
  values: (s: SettingsState) => readonly (string | number | boolean)[];
  get: (s: SettingsState) => string | number | boolean;
  /** numbers clamp at the ends; enums cycle */
  clamp?: boolean;
  /** engine patch body for a new value (PATCH /api/config) */
  engine?: (v: any, s: SettingsState) => any;
  /** TUI pref change (tui.json) */
  pref?: (v: any) => Partial<TuiPrefs>;
  fmt?: (v: any) => string;
}

const onOff = (v: any) => (v ? 'on' : 'off');
export const CONFIG_ROWS: ConfigRow[] = [
  {
    key: 'effort', section: 'model', label: 'default effort', explain: 'Effort for new chats. shift+tab changes only the current chat.',
    values: (s) => s.efforts, get: (s) => normalizeEffort(s.cfg?.effort_default) || 'medium', engine: (v) => ({ effort_default: v }), fmt: (v) => effortLabel(v),
  },
  {
    key: 'approvals', section: 'model', label: 'approvals', explain: 'ask = confirm risky commands · yolo = run everything without asking (all chats).',
    values: () => ['ask', 'yolo'], get: (s) => s.cfg?.approvals || 'ask', engine: (v) => ({ approvals: v }),
  },
  {
    key: 'subagents', section: 'model', label: 'subagents', explain: 'Helpers that take side-tasks in parallel. /agents for model, effort and time budget.',
    values: () => [true, false], get: (s) => normalizeSubagents(s.cfg?.subagents).enabled, engine: (v, s) => ({ subagents: { ...normalizeSubagents(s.cfg?.subagents), enabled: v } }), fmt: onOff,
  },
  {
    key: 'max_parallel', section: 'model', label: 'max helpers', explain: 'How many helpers may run at once.', clamp: true,
    values: () => range(1, 8), get: (s) => normalizeSubagents(s.cfg?.subagents).max_parallel, engine: (v, s) => ({ subagents: { ...normalizeSubagents(s.cfg?.subagents), max_parallel: v } }),
  },
  {
    key: 'c_auto', section: 'compaction', label: 'auto', explain: 'Summarize older messages automatically when the context fills up.',
    values: () => [true, false], get: (s) => !!compaction(s.cfg).auto, engine: (v, s) => ({ compaction: { ...compaction(s.cfg), auto: v } }), fmt: onOff,
  },
  {
    key: 'c_at', section: 'compaction', label: 'compact at', explain: 'Context fill that triggers auto-compaction (tick on the status bar).', clamp: true,
    values: () => range(50, 95, 5), get: (s) => +compaction(s.cfg).at_pct, engine: (v, s) => ({ compaction: { ...compaction(s.cfg), at_pct: v } }), fmt: (v) => `${v}%`,
  },
  {
    key: 'c_keep', section: 'compaction', label: 'keep recent', explain: 'Newest messages kept word for word when compacting.', clamp: true,
    values: () => range(2, 20), get: (s) => +compaction(s.cfg).keep_recent, engine: (v, s) => ({ compaction: { ...compaction(s.cfg), keep_recent: v } }), fmt: (v) => `${v} messages`,
  },
  {
    key: 'c_mode', section: 'compaction', label: 'mode', explain: 'summary = the model writes a recap · trim = drop the oldest messages (instant).',
    values: () => ['summary', 'trim'], get: (s) => compaction(s.cfg).mode, engine: (v, s) => ({ compaction: { ...compaction(s.cfg), mode: v } }),
  },
  {
    key: 'c_notify', section: 'compaction', label: 'notify', explain: "Show '↺ auto-compacted' in the chat when it happens.",
    values: () => [true, false], get: (s) => !!compaction(s.cfg).notify, engine: (v, s) => ({ compaction: { ...compaction(s.cfg), notify: v } }), fmt: onOff,
  },
  {
    key: 'usageLine', section: 'display', label: 'usage line', explain: 'Dim token readout under the status bar.',
    values: () => [true, false], get: (s) => s.prefs.usageLine, pref: (v) => ({ usageLine: v }), fmt: onOff,
  },
  {
    key: 'reasoning', section: 'display', label: 'reasoning', explain: 'hidden · timer · preview (last thought line) · full.',
    values: () => REASONING_LEVELS, get: (s) => s.prefs.reasoning, pref: (v) => ({ reasoning: v }),
  },
  {
    key: 'tools', section: 'display', label: 'tool detail', explain: 'quiet (one line) · normal (tree + 4-line tail) · full (20 lines + diffs).',
    values: () => TOOLS_LEVELS, get: (s) => s.prefs.tools, pref: (v) => ({ tools: v }),
  },
  {
    key: 'summary', section: 'display', label: 'summary line', explain: "The cat's sign-off under each reply.",
    values: () => [true, false], get: (s) => s.prefs.summary, pref: (v) => ({ summary: v }), fmt: onOff,
  },
];

/** Next value for a row (enums cycle, numbers clamp). */
export function stepValue(row: ConfigRow, s: SettingsState, dir: number): any {
  const vals = row.values(s);
  const cur = row.get(s);
  let i = vals.indexOf(cur as never);
  if (i < 0) i = dir > 0 ? -1 : 0;
  if (row.clamp) return vals[Math.max(0, Math.min(vals.length - 1, i + dir))];
  return vals[(i + dir + vals.length) % vals.length];
}

// ---------------------------------------------------------------- look & feel rows
export const LOOK_ROWS = [
  { key: 'accent', label: 'accent', explain: 'Color of the cat, spinner, prompt, context bar and sign-off.' },
  { key: 'spinner', label: 'spinner', explain: 'What spins while a tool runs.' },
  { key: 'reply', label: 'reply style', explain: 'band = shaded band on your messages + (^.^) pico header · label · bar (▌) · plain.' },
  { key: 'reasoning', label: 'reasoning', explain: 'hidden · timer · preview (last thought line) · full (stream it, folds when the answer starts).' },
  { key: 'tools', label: 'tools', explain: 'quiet (one line: read 2 · edit 1) · normal (tree + 4-line tail) · full (20 lines + diffs).' },
  { key: 'summary', label: 'summary', explain: "The cat's sign-off line under each reply." },
] as const;
const REPLY_HINT: Record<ReplyStyle, string> = { band: 'shaded band + header', label: 'you / pico labels', bar: '▌ left bars', plain: 'the old look' };
const REASONING_HINT: Record<string, string> = { hidden: 'nothing shown', timer: 'thinking 4.1s', preview: '+ last line', full: 'stream it all' };
const TOOLS_HINT: Record<string, string> = { quiet: 'one line per turn', normal: 'tree + 4-line tail', full: '20 lines + diffs' };

export function lookStep(p: TuiPrefs, key: string, dir: number): TuiPrefs {
  const cyc = <T,>(list: readonly T[], cur: T) => list[(Math.max(0, list.indexOf(cur)) + dir + list.length) % list.length];
  const n = { ...p };
  if (key === 'accent') n.accent = ACCENTS[(accentIndex(p.accent) + dir + ACCENTS.length) % ACCENTS.length].name;
  else if (key === 'spinner') n.spinner = cyc(SPINNERS.map((x) => x.name), p.spinner);
  else if (key === 'reply') n.reply = cyc(REPLY_STYLES, p.reply);
  else if (key === 'reasoning') n.reasoning = cyc(REASONING_LEVELS, p.reasoning);
  else if (key === 'tools') n.tools = cyc(TOOLS_LEVELS, p.tools);
  else if (key === 'summary') n.summary = !p.summary;
  return n;
}

// ---------------------------------------------------------------- render
export const panelInner = (cols: number) => Math.min(Math.max(40, cols - 4), 84);
const LAB = 15;

/** ' Status   Config   Usage   Look & feel ' + underline rule with the active tab in accent. */
export function tabBar(active: number, inner: number): string[] {
  const g = G();
  let top = '';
  let under = '';
  const heavy = isAscii() ? '=' : '━';
  TABS.forEach((name, i) => {
    const lab = ` ${name} `;
    const on = i === active;
    top += (on ? bold(t.accent(lab)) : t.muted(lab)) + ' ';
    under += (on ? t.accent(heavy.repeat(w(lab))) : t.faint(g.rule.repeat(w(lab)))) + t.faint(g.rule);
  });
  const pad = Math.max(0, inner - w(under));
  return [top, under + t.faint(g.rule.repeat(pad))];
}

const kv = (label: string, value: string) => t.muted(padRight(label, LAB)) + value;

export function statusTab(s: SettingsState, inner: number): string[] {
  const g = G();
  const st = s.status;
  const sep = t.faint(` ${g.sep} `);
  const out: string[] = [];
  const h = st.health;
  const healthS = h?.ok ? t.ok(g.dot) + ' ' + t.dim(h.state || 'ok') : t.err(g.dot) + ' ' + t.err(st.healthError || h?.state || 'unreachable');
  out.push(kv('version', fg(C.text)(`pico ${st.version}`) + (h?.version ? sep + t.dim(`engine ${h.version}`) : '')));
  out.push(kv('engine', t.dim(st.engineUrl) + '  ' + healthS));
  out.push(kv('model', fg(C.text)(st.model || 'no model') + (st.providerLabel ? sep + t.dim(st.providerLabel) : '')));
  out.push(kv('approvals', s.cfg?.approvals === 'yolo' ? t.err('yolo (all chats)') : st.yolo ? t.err('yolo (this chat)') : t.dim('ask')));
  out.push(kv('ChatGPT', st.chatgptLoggedIn == null ? t.faint('unknown') : st.chatgptLoggedIn ? t.ok('signed in') : t.dim('not signed in') + t.faint('  /login')));
  out.push(kv('cwd', t.dim(shortPath(st.cwd || '', inner - LAB - 2))));
  out.push(kv('session', st.sessionId ? t.dim(st.sessionId) : t.faint('not started')));
  const c = st.ctx;
  if (c && (c.used || c.max)) {
    const cp = cachedPct(c.cached, c.used);
    out.push(kv('context', (c.max ? ctxBar(c.used / c.max, 10) + ' ' : '') + t.dim(fmtCtxPair(c.used, c.max)) + (cp != null ? t.dim(` cached ${cp}%`) : '')));
  } else out.push(kv('context', t.faint('empty')));
  out.push('');
  out.push(bold(fg(C.text)('standing prompt')) + t.faint('  sent with every message'));
  const p = st.profile;
  if (!p) out.push(t.faint('engine does not report it yet'));
  else {
    const row = (label: string, n: number | undefined, extra = '') => (n == null ? null : kv('  ' + label, fg(C.text)(fmtTok(n)) + t.dim(' tok') + extra));
    const f = p.budget ? p.tokens / p.budget : 0;
    const bar = p.budget ? '  ' + ctxBar(f, 8, f > 0.9 ? C.amber : C.accent) + ' ' + t.dim(`${fmtTok(p.tokens)}/${fmtTok(p.budget)}`) : '';
    const notes = [p.user_notes != null ? `${p.user_notes} about you` : '', p.memory_notes != null ? `${p.memory_notes} memories` : ''].filter(Boolean).join(` ${g.sep} `);
    for (const r of [
      row('profile', p.tokens, bar),
      notes ? kv('', t.faint('  ' + notes)) : null,
      row('skills index', p.skills_index_tokens),
      row('AGENTS.md', p.agents_md_tokens),
      p.total_standing_tokens != null ? kv('  total', bold(t.accent(fmtTok(p.total_standing_tokens))) + t.dim(' tok') + (p.estimate ? t.faint('  ~estimate') : '')) : null,
    ])
      if (r) out.push(r);
    out.push(t.faint('run ') + t.accent('/lean') + t.faint(' to slim it'));
  }
  return out;
}

export function configTab(s: SettingsState, inner: number, now = Date.now()): string[] {
  const g = G();
  const out: string[] = [];
  const idx = s.row[1] ?? 0;
  let section = '';
  CONFIG_ROWS.forEach((r, i) => {
    if (r.section !== section) {
      if (section) out.push('');
      section = r.section;
      out.push(t.faint(section));
    }
    const on = i === idx;
    const v = r.get(s);
    const txt = r.fmt ? r.fmt(v) : String(v);
    let vS: string;
    if (typeof v === 'boolean') vS = v ? t.accent(g.dot + ' on') : t.dim(g.ring + ' off');
    else if (r.key === 'effort') vS = fg(EFFORT_COLOR[v as Effort] ?? C.accent)(txt);
    else if (r.key === 'approvals' && v === 'yolo') vS = t.err(txt);
    else vS = t.accent(txt);
    const disabled = (r.key === 'max_parallel' && !normalizeSubagents(s.cfg?.subagents).enabled) || (r.section === 'compaction' && r.key !== 'c_auto' && !compaction(s.cfg).auto);
    if (disabled) vS = t.faint(txt);
    const arrows = on && typeof v !== 'boolean';
    const labS = (on ? bold(fg(C.text)(r.label)) : disabled ? t.faint(r.label) : t.muted(r.label)) + ' '.repeat(Math.max(1, LAB - 2 - w(r.label)));
    let mark = '';
    if (s.saving === r.key) mark = '  ' + t.faint(spinGlyph(now));
    else if (s.flash && s.flash.key === r.key && now - s.flash.at < 1600) mark = '  ' + (s.flash.error ? t.err(g.cross) : t.accent(g.check));
    out.push((on ? t.accent(g.caret) : ' ') + ' ' + labS + (arrows ? t.faint(g.lt + ' ') : '') + vS + (arrows ? t.faint(' ' + g.gt) : '') + mark);
    if (on) for (const l of wrap(r.explain, inner - LAB - 2).slice(0, 2)) out.push(' '.repeat(LAB) + t.dim(l));
  });
  return out;
}

const totTok = (x?: { input?: number; output?: number } | null) => (x?.input || 0) + (x?.output || 0);

/** Sum the last n days of report.days (turns/in/out/cached). */
export function lastDays(u: UsageReport | null | undefined, n: number, today = new Date()): UsageTotals {
  const keys = new Set(dailySeries(u?.days, n, today).map((d) => d.date));
  const out: UsageTotals = { turns: 0, input: 0, output: 0, cached: 0 };
  for (const d of u?.days || []) {
    if (!keys.has(d.date.slice(0, 10))) continue;
    out.turns! += d.turns || 0;
    out.input! += d.input || 0;
    out.output! += d.output || 0;
    out.cached! += d.cached || 0;
  }
  return out;
}

/** Usage tab: limit bars (if the engine sends them), today / 7d / 30d with share bars, sparkline, per model. */
export function usageTab(s: SettingsState, inner: number, now = Date.now()): string[] {
  const g = G();
  const u = s.usage;
  const sep = t.faint(` ${g.sep} `);
  const out: string[] = [];
  const L = s.limits;
  if (L && (L.session_pct != null || L.week_pct != null)) {
    out.push(bold(fg(C.text)('plan limits')));
    if (L.session_pct != null) out.push(kv('  session', limitBar(+L.session_pct, 20) + ' ' + fg(C.text)(`${Math.round(+L.session_pct)}%`) + (L.resets_at ? t.dim(`  resets ${fmtReset(L.resets_at, now)}`) : '')));
    if (L.week_pct != null) out.push(kv('  week', limitBar(+L.week_pct, 20) + ' ' + fg(C.text)(`${Math.round(+L.week_pct)}%`) + (L.week_resets_at ? t.dim(`  resets ${fmtReset(L.week_resets_at, now)}`) : '')));
    out.push('');
  } else if (s.chatgpt) out.push(t.dim('ChatGPT plan') + t.faint('  · the engine reports no plan limits yet'), '');
  if (!u) return [...out, t.faint('usage not available from this engine')];
  const today = new Date(now);
  const t30: UsageTotals = u.totals || {};
  const t7 = lastDays(u, 7, today);
  const t1: UsageTotals = u.today || lastDays(u, 1, today);
  const max = Math.max(1, totTok(t30));
  const barW = Math.max(4, Math.min(16, inner - 64));
  const pctOf = (x: UsageTotals, p?: number | null) => (p != null && isFinite(+p) ? Math.round(+p) : x.input && x.cached != null ? Math.round((x.cached / x.input) * 100) : null);
  const line = (label: string, x: UsageTotals, p?: number | null) => {
    const cp = pctOf(x, p);
    const bits = [fg(C.text)(fmtTok(x.input)) + t.dim(' in'), fg(C.text)(fmtTok(x.output)) + t.dim(' out'), ...(cp != null ? [t.accent(`${cp}%`) + t.dim(' cached')] : []), fg(C.text)(`${x.turns ?? 0}`) + t.dim(' turns'), ...(x.seconds ? [t.dim(fmtDur(x.seconds))] : [])];
    const head = t.muted(padRight(label, 9)) + barOf(totTok(x) / max, barW) + ' ';
    while (bits.length > 2 && w(head + bits.join(sep)) > inner) bits.pop(); // narrow: drop time, turns, cache
    return head + bits.join(sep);
  };
  out.push(line('today', t1, (u.today as any)?.cache_hit_pct), line('7 days', t7), line('30 days', t30, u.cache_hit_pct));
  const series = dailySeries(u.days, 30, today);
  const peak = Math.max(0, ...series.map((d) => d.tokens));
  out.push('', t.muted(padRight('per day', 9)) + t.accent(sparkline(series.map((d) => d.tokens))) + t.faint(`  peak ${fmtTok(peak)}`));
  out.push(' '.repeat(9) + t.faint(padRight(series[0].date.slice(5), 25) + 'today'));
  const models = (u.by_model || []).slice().sort((a, b) => totTok(b) - totTok(a)).slice(0, 5);
  if (models.length) {
    const nameW = Math.min(24, Math.max(5, ...models.map((m) => w(m.model))));
    out.push('', bold(fg(C.text)(padRight('model', nameW) + '  ' + 'turns'.padStart(5) + '  ' + 'tokens'.padStart(7) + '  ' + 'tok/s'.padStart(5))));
    for (const m of models)
      out.push(
        t.muted(padRight(truncate(m.model, nameW), nameW)) + '  ' + t.dim(String(m.turns ?? 0).padStart(5)) + '  ' + t.dim(fmtTok(totTok(m)).padStart(7)) + '  ' +
          (m.tps ? t.accent(String(Math.round(m.tps)).padStart(5)) : t.faint('—'.padStart(5))) + '  ' + barOf(totTok(m) / max, 8),
      );
  }
  if (t30.tools) out.push(t.faint(`${t30.tools} tool calls in 30 days`));
  return out;
}

/** '▰▰▰▱▱▱' share bar (accent). */
function barOf(f: number, cells: number): string {
  const g = G();
  f = Math.max(0, Math.min(1, f || 0));
  let full = Math.round(f * cells);
  if (f > 0 && !full) full = 1;
  return t.accent(g.pillOn.repeat(full)) + fg(240)(g.pillOff.repeat(cells - full));
}

const levelDots = (levels: readonly string[], cur: string) => levels.map((l) => (l === cur ? t.accent(G().dot) : t.faint(G().ring))).join(' ');

export function lookTab(s: SettingsState, inner: number, now = Date.now(), preview: string[] = []): string[] {
  const g = G();
  const p = s.prefs;
  const idx = s.row[3] ?? 0;
  const out: string[] = [];
  LOOK_ROWS.forEach((r, i) => {
    const on = i === idx;
    let vS: string;
    if (r.key === 'accent') {
      const cur = accentIndex(p.accent);
      vS = t.accent(accentName(p.accent).padEnd(9)) + ' ' + ACCENTS.map((a, j) => fg(a.hex)(j === cur ? g.dot : g.ring)).join(' ');
    } else if (r.key === 'spinner') {
      const glyph = p.spinner === 'shimmer' ? shimmer('terminal', now, t.dim) : t.accent(spinGlyph(now, p.spinner));
      vS = t.accent(p.spinner.padEnd(9)) + ' ' + glyph + '  ' + t.faint(SPINNERS.find((x) => x.name === p.spinner)?.hint ?? '');
    } else if (r.key === 'reply') vS = t.accent(p.reply.padEnd(9)) + ' ' + levelDots(REPLY_STYLES, p.reply) + '  ' + t.faint(REPLY_HINT[p.reply]);
    else if (r.key === 'reasoning') vS = t.accent(p.reasoning.padEnd(9)) + ' ' + levelDots(REASONING_LEVELS, p.reasoning) + '  ' + t.faint(REASONING_HINT[p.reasoning]);
    else if (r.key === 'tools') vS = t.accent(p.tools.padEnd(9)) + ' ' + levelDots(TOOLS_LEVELS, p.tools) + '  ' + t.faint(TOOLS_HINT[p.tools]);
    else vS = p.summary ? t.accent(g.dot + ' on') : t.dim(g.ring + ' off');
    const labS = (on ? bold(fg(C.text)(r.label)) : t.muted(r.label)) + ' '.repeat(Math.max(1, LAB - 2 - w(r.label)));
    const mark = s.flash && s.flash.key === r.key && now - s.flash.at < 1600 ? '  ' + t.accent(g.check) : '';
    out.push((on ? t.accent(g.caret) : ' ') + ' ' + labS + (on ? t.faint(g.lt + ' ') : '') + vS + (on ? t.faint(' ' + g.gt) : '') + mark);
    if (on) for (const l of wrap(r.explain, inner - LAB - 2).slice(0, 2)) out.push(' '.repeat(LAB) + t.dim(l));
  });
  if (preview.length) out.push('', t.faint('preview'), ...preview);
  return out;
}

/** Full panel: tabs + active tab body in one rounded box, constant width across tabs. */
export function settingsLines(s: SettingsState, cols: number, now = Date.now(), preview: string[] = []): string[] {
  const g = G();
  const inner = panelInner(cols);
  const cw = inner - 4; // content width inside '│ ' … ' │'
  const body = [...tabBar(s.tab, cw), ''];
  if (s.tab === 0) body.push(...statusTab(s, cw));
  else if (s.tab === 1) body.push(...configTab(s, cw, now));
  else if (s.tab === 2) body.push(...usageTab(s, cw, now));
  else body.push(...lookTab(s, cw, now, preview));
  body.push('');
  const keys = s.tab === 1 || s.tab === 3 ? `${g.lt}${g.gt} tabs ${g.sep} ${isAscii() ? '^v' : '↑↓'} move ${g.sep} enter/space change ${g.sep} esc close` : `${g.lt}${g.gt} tabs ${g.sep} esc close`;
  let footer = t.faint(keys);
  if (s.flash && now - s.flash.at < 1800 && (s.tab === 1 || s.tab === 3)) footer = s.flash.error ? t.err(truncate(s.flash.text, inner - 6)) : t.accent(g.check + ' ') + t.muted(truncate(s.flash.text, inner - 8));
  return box(t.accent('(^.^)') + ' settings', body, inner, C.faint, footer).map((l) => '  ' + l);
}

// ---------------------------------------------------------------- interaction
export interface SettingsActions {
  /** PATCH /api/config; resolves to the engine's config (or anything) */
  patchConfig: (body: any) => Promise<any>;
  /** apply + save TUI prefs */
  setPrefs: (p: TuiPrefs) => void;
}

/** Apply one key to the state. Returns 'close' on esc/q, otherwise a promise when a save is in flight. */
export function settingsKey(s: SettingsState, k: Key, act: SettingsActions, now = Date.now()): 'close' | Promise<void> | undefined {
  if (k.name === 'escape' || (k.name === 'q' && !k.ctrl)) return 'close';
  const n = TABS.length;
  if (k.name === 'right' || k.name === 'l' || (k.name === 'tab' && !k.shift)) {
    s.tab = (s.tab + 1) % n;
    return;
  }
  if (k.name === 'left' || k.name === 'h' || (k.name === 'tab' && k.shift)) {
    s.tab = (s.tab - 1 + n) % n;
    return;
  }
  if (k.ch && /^[1-4]$/.test(k.ch)) {
    s.tab = +k.ch - 1;
    return;
  }
  const rows = s.tab === 1 ? CONFIG_ROWS.length : s.tab === 3 ? LOOK_ROWS.length : 0;
  if (!rows) return;
  const cur = s.row[s.tab] ?? 0;
  if (k.name === 'up' || k.name === 'k') s.row[s.tab] = (cur - 1 + rows) % rows;
  else if (k.name === 'down' || k.name === 'j') s.row[s.tab] = (cur + 1) % rows;
  else {
    const dir = k.name === 'enter' || k.name === 'space' || k.ch === '+' || k.ch === '=' ? 1 : k.ch === '-' || k.ch === '_' || k.name === 'backspace' ? -1 : 0;
    if (!dir) return;
    if (s.tab === 3) {
      const key = LOOK_ROWS[cur].key;
      s.prefs = lookStep(s.prefs, key, dir);
      act.setPrefs(s.prefs);
      s.flash = { key, text: `saved ${LOOK_ROWS[cur].label}`, at: now };
      return;
    }
    return changeConfig(s, CONFIG_ROWS[cur], dir, act, now);
  }
}

export function changeConfig(s: SettingsState, row: ConfigRow, dir: number, act: SettingsActions, now = Date.now()): Promise<void> | undefined {
  const v = stepValue(row, s, dir);
  const label = `${row.label} ${row.fmt ? row.fmt(v) : String(v)}`;
  if (row.pref) {
    s.prefs = { ...s.prefs, ...row.pref(v) };
    act.setPrefs(s.prefs);
    s.flash = { key: row.key, text: `saved ${label}`, at: now };
    return;
  }
  if (!row.engine) return;
  const body = row.engine(v, s);
  const before = s.cfg;
  s.cfg = { ...(s.cfg || {}), ...body }; // optimistic
  s.saving = row.key;
  return act.patchConfig(body).then(
    (res) => {
      if (res && typeof res === 'object' && !Array.isArray(res) && Object.keys(res).some((k) => k in (s.cfg || {}) && k !== 'ok')) s.cfg = { ...s.cfg, ...res };
      s.saving = undefined;
      s.flash = { key: row.key, text: `saved ${label}`, at: Date.now() };
    },
    (e: any) => {
      s.cfg = before;
      s.saving = undefined;
      s.flash = { key: row.key, text: `${row.label}: ${e?.message || e}`, at: Date.now(), error: true };
    },
  );
}

/** Open the panel (modal). Resolves with the final state when closed. */
export function settingsPanel(term: Terminal, screen: LiveScreen, s: SettingsState, act: SettingsActions, preview: (s: SettingsState) => string[] = () => []): Promise<SettingsState> {
  const draw = () => ['', ...settingsLines(s, term.cols, Date.now(), s.tab === 3 ? preview(s) : [])];
  let timer: ReturnType<typeof setInterval> | null = null;
  const pr = modal<SettingsState>(term, screen, draw, (k, redraw) => {
    const r = settingsKey(s, k, act);
    if (r === 'close') return s;
    if (r) void r.then(redraw);
    return undefined;
  });
  // animate the spinner preview + expire the ✓ flash
  timer = setInterval(() => screen.render({ lines: draw() }), 120);
  return pr.finally(() => timer && clearInterval(timer));
}
