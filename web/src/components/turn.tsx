// Assistant-turn building blocks: thinking pill, tool stack, diff cards, helpers (subagents), notices,
// turn summary and the context bar. Pure presentation; Chat.tsx owns the state.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { fmtTok, type CtxInfo, type DiffInfo, type Effort, type GoalState, type LoopInfo, type PlanInfo, type TurnSummaryInfo } from '../api';
import { renderMarkdown } from '../markdown';
import { EFFORT_COLORS, getPref, type ReasoningShown, type ToolDetail } from '../theme';
import { Face, Icon, type Mood } from './ui';

// ---------- view-model types ----------
export interface ToolCard {
  id: string; name: string; args?: unknown; label?: string; running: boolean; ok?: boolean;
  preview?: string; seconds?: number; tail: string[]; diff?: DiffInfo; start: number;
}
export interface Helper {
  id: string; goal: string; model?: string; label?: string; tail?: string[]; running: boolean; ok?: boolean;
  summary?: string; seconds?: number; tokens?: number; start: number;
}
export type Part =
  | { kind: 'thinking'; id: string; text: string; start: number; end?: number }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tools'; id: string; tools: ToolCard[] }
  | { kind: 'helpers'; id: string; agents: Helper[] }
  | { kind: 'approval'; id: string; approvalId: string; command: string; reason?: string; answer?: 'allow' | 'deny' | 'always' }
  | { kind: 'notice'; id: string; nkind: string; text: string }
  | { kind: 'steer'; id: string; text: string; state: 'sent' | 'applied' | 'queued' | 'followup' };
export interface Turn {
  kind: 'turn'; id: string; parts: Part[]; streaming: boolean; effort: Effort; start: number;
  summary?: TurnSummaryInfo; error?: string; undone?: boolean; stopped?: boolean;
}
export type ApprovalPart = Extract<Part, { kind: 'approval' }>;

/** Re-render on an interval while `active` (live timers). */
export function useNow(active: boolean, ms = 100): number {
  const [n, setN] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setN(Date.now());
    const t = setInterval(() => setN(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return n;
}

export const secs = (s?: number) => (s === undefined || isNaN(s) ? '' : s < 0.1 ? '<0.1s' : s < 10 ? `${s.toFixed(1)}s` : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
export function prettyTool(n: string) { return n.replace(/_/g, ' '); }
export function argHint(a: unknown): string {
  if (a == null) return '';
  if (typeof a === 'string') return a.length > 60 ? a.slice(0, 59) + '…' : a;
  if (typeof a === 'object') {
    const o = a as Record<string, unknown>;
    const v = o.command ?? o.query ?? o.path ?? o.url ?? o.file ?? o.goal ?? Object.values(o)[0];
    return typeof v === 'string' ? (v.length > 60 ? v.slice(0, 59) + '…' : v) : '';
  }
  return '';
}

/** Mood of a turn's avatar face. */
export function turnMood(t: Turn): Mood {
  if (t.error) return 'error';
  if (!t.streaming) return 'idle';
  const last = t.parts[t.parts.length - 1];
  if (t.parts.some((p) => (p.kind === 'tools' && p.tools.some((x) => x.running)) || (p.kind === 'helpers' && p.agents.some((a) => a.running)))) return 'work';
  if (last?.kind === 'thinking' && !last.end) return 'think';
  if (last?.kind === 'approval' && !last.answer) return 'think';
  return 'work';
}

// ---------- thinking ----------
export function ThinkingPill({ p, effort, live }: { p: Extract<Part, { kind: 'thinking' }>; effort: Effort; live: boolean }) {
  const shown = getPref<ReasoningShown>('reasoning', 'timer');
  const [open, setOpen] = useState(shown === 'full');
  const now = useNow(live, 100);
  const t = p.start ? ((p.end ?? now) - p.start) / 1000 : undefined;
  if (shown === 'hidden' && !live) return null;
  const preview = shown === 'preview' || (shown === 'full' && live) ? p.text.trim().split('\n').filter(Boolean).slice(-1)[0] : '';
  return (
    <div class={`think ${open ? 'open' : ''} ${live ? 'live' : ''}`} style={{ '--effort': EFFORT_COLORS[effort] || EFFORT_COLORS.medium } as any}>
      <button class="think-pill" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class={`think-label ${live ? 'shimmer' : ''}`}>{live ? 'thinking' : 'thought'}{t !== undefined && <span class="think-time mono"> {live ? t.toFixed(1) + 's' : secs(t)}</span>}</span>
        {p.text && <span class={`chev ${open ? 'up' : ''}`}><Icon name="chev" size={12} /></span>}
      </button>
      {!open && preview && <div class="think-preview">{preview.length > 140 ? preview.slice(0, 139) + '…' : preview}</div>}
      {open && p.text && <div class="think-body">{p.text}</div>}
    </div>
  );
}

// ---------- tools ----------
export function ToolStack({ tools }: { tools: ToolCard[] }) {
  const detail = getPref<ToolDetail>('tools', 'normal');
  const running = tools.some((t) => t.running);
  const [open, setOpen] = useState(false);
  if (detail === 'quiet' && !running && !open && tools.length > 1) {
    const fails = tools.filter((t) => t.ok === false).length;
    const total = tools.reduce((n, t) => n + (t.seconds || 0), 0);
    return (
      <button class="tool-stack tool-quiet" onClick={() => setOpen(true)}>
        <span class={`tool-ico ${fails ? 'bad' : ''}`}>{fails ? <Icon name="x" size={11} /> : <Icon name="check" size={11} />}</span>
        <span class="tool-label">{plural(tools.length, 'step')}{fails ? ` · ${fails} failed` : ''}</span>
        <span class="tool-time mono">{secs(total)}</span>
        <span class="chev"><Icon name="chev" size={12} /></span>
      </button>
    );
  }
  return <div class={`tool-stack ${running ? 'live' : ''}`}>{tools.map((t) => <ToolRow key={t.id} t={t} full={detail === 'full'} />)}</div>;
}

function ToolRow({ t, full }: { t: ToolCard; full?: boolean }) {
  const [open, setOpen] = useState(!!full && !!t.preview);
  const now = useNow(t.running, 100);
  const state = t.running ? 'running' : t.ok === false ? 'fail' : 'ok';
  const hint = argHint(t.args);
  const elapsed = t.running ? (now - t.start) / 1000 : t.seconds;
  const hasDetail = t.args !== undefined || !!t.preview;
  // Stable keys per line content so only new lines animate in.
  const seen: Record<string, number> = {};
  const tail = t.tail.slice(-4).map((l) => { seen[l] = (seen[l] || 0) + 1; return { l, k: `${l}#${seen[l]}` }; });
  return (
    <div class={`tool ${state} ${open ? 'open' : ''}`}>
      <button class="tool-row" onClick={() => hasDetail && setOpen(!open)} aria-expanded={open} disabled={!hasDetail}>
        <span class="tool-ico">{t.running ? <span class="mini-spin" /> : t.ok === false ? <Icon name="x" size={11} /> : <Icon name="check" size={11} />}</span>
        {t.label ? (
          <span class="tool-label">{t.label.split(/`([^`]+)`/).map((x, i) => (i % 2 ? <code class="tool-code">{x}</code> : x))}</span>
        ) : (
          <><span class="tool-name mono">{prettyTool(t.name)}</span>{hint && <span class="tool-arg mono">{hint}</span>}</>
        )}
        <span class="tool-time mono">{elapsed !== undefined ? secs(elapsed) : ''}</span>
        {hasDetail && <span class={`chev ${open ? 'up' : ''}`}><Icon name="chev" size={12} /></span>}
      </button>
      {t.running && tail.length > 0 && (
        <div class="tool-tail mono" aria-live="off">{tail.map(({ l, k }) => <div key={k}>{l || ' '}</div>)}</div>
      )}
      {open && (
        <div class="tool-detail mono">
          <div class="td-h">{t.name}</div>
          {t.args !== undefined && <pre class="td-args">{typeof t.args === 'string' ? t.args : JSON.stringify(t.args, null, 2)}</pre>}
          {t.preview && <><div class="td-h">result</div><pre class="td-res">{t.preview}</pre></>}
        </div>
      )}
      {t.diff && <DiffCard d={t.diff} />}
    </div>
  );
}

// ---------- diffs ----------
type DL = { t: 'add' | 'del' | 'ctx' | 'hunk'; o?: number; n?: number; text: string };
export function parseDiff(u: string): DL[] {
  const out: DL[] = [];
  let o = 0, n = 0;
  for (const raw of (u || '').replace(/\n$/, '').split('\n')) {
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('\\')) continue;
    const h = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/);
    if (h) { o = +h[1]; n = +h[2]; out.push({ t: 'hunk', text: h[3] || '' }); continue; }
    if (raw.startsWith('+')) out.push({ t: 'add', n: n++, text: raw.slice(1) });
    else if (raw.startsWith('-')) out.push({ t: 'del', o: o++, text: raw.slice(1) });
    else out.push({ t: 'ctx', o: o++, n: n++, text: raw.startsWith(' ') ? raw.slice(1) : raw });
  }
  // Drop trailing blank context lines (an artifact of the final newline).
  while (out.length && out[out.length - 1].t === 'ctx' && !out[out.length - 1].text) out.pop();
  // Drop a leading hunk header when it carries no context text (the line numbers already say it).
  if (out[0]?.t === 'hunk' && !out[0].text) out.shift();
  return out;
}

function FileIcon({ path }: { path: string }) {
  const ext = (path.split('.').pop() || '').toLowerCase().slice(0, 4);
  return <span class={`ficon mono ext-${ext}`} aria-hidden="true">{ext && ext !== path.toLowerCase() ? ext : '·'}</span>;
}

export function DiffCard({ d }: { d: DiffInfo }) {
  const lines = useMemo(() => parseDiff(d.unified), [d.unified]);
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const LIMIT = 10;
  const shown = all ? lines : lines.slice(0, LIMIT);
  const i = d.path.lastIndexOf('/');
  const copy = (e: Event) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(d.unified).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
  };
  return (
    <div class="diff">
      <div class="diff-head">
        <FileIcon path={d.path} />
        <span class="diff-path mono" title={d.path}>{i >= 0 && <span class="dim">{d.path.slice(0, i + 1)}</span>}{d.path.slice(i + 1)}</span>
        {d.created && <span class="diff-new mono">new</span>}
        <span class="diff-stat mono"><span class="add">+{d.added}</span><span class="del">−{d.removed}</span></span>
        <button class={`diff-copy ${copied ? 'done' : ''}`} onClick={copy} title="Copy diff" aria-label="Copy diff">
          {copied ? <Icon name="check" size={13} /> : <Icon name="copy" size={13} />}
        </button>
      </div>
      {lines.length > 0 && (
        <div class="diff-body mono">
          {shown.map((l, k) => l.t === 'hunk' ? (
            <div key={k} class="dl hunk"><span class="ln" /><span class="ln" /><span class="sg" /><span class="tx">{l.text || '⋯'}</span></div>
          ) : (
            <div key={k} class={`dl ${l.t}`}>
              <span class="ln">{l.o ?? ''}</span><span class="ln">{l.n ?? ''}</span>
              <span class="sg">{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}</span>
              <span class="tx">{l.text || ' '}</span>
            </div>
          ))}
          {!all && lines.length > LIMIT && <div class="diff-fade" />}
        </div>
      )}
      {lines.length > LIMIT && (
        <button class="diff-more mono" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${lines.length} lines`}<span class={`chev ${all ? 'up' : ''}`}><Icon name="chev" size={12} /></span>
        </button>
      )}
    </div>
  );
}

// ---------- helpers (subagents) ----------
export function HelpersCard({ agents }: { agents: Helper[] }) {
  const running = agents.filter((a) => a.running).length;
  const done = running === 0;
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? !done;
  const now = useNow(!done, 200);
  const failed = agents.filter((a) => a.ok === false).length;
  const tokens = agents.reduce((s, a) => s + (a.tokens || 0), 0);
  const first = Math.min(...agents.map((a) => a.start || now));
  const wall = done ? Math.max(...agents.map((a) => a.seconds || 0)) : (now - first) / 1000;
  const faces = (
    <span class="h-faces">
      {agents.slice(0, 5).map((a) => <span class="h-face" key={a.id}><Face mood={a.running ? 'work' : a.ok === false ? 'error' : 'happy'} /></span>)}
    </span>
  );
  if (!expanded) {
    return (
      <button class="helpers-chip mono" onClick={() => setOpen(true)} aria-expanded="false">
        <span class={failed ? 'h-fail' : 'h-ok'}>{failed ? '!' : '✓'}</span>
        {plural(agents.length, 'helper')}
        <span class="sep">·</span>{secs(wall)}
        {tokens > 0 && <><span class="sep">·</span>{fmtTok(tokens)} tok</>}
        {faces}
        <span class="chev"><Icon name="chev" size={12} /></span>
      </button>
    );
  }
  return (
    <div class={`helpers ${done ? 'done' : 'live'}`}>
      <div class="h-head">
        {faces}
        <span class="h-title">{done ? `${plural(agents.length, 'helper')} finished` : `${plural(running, 'helper')} working`}</span>
        <span class="h-meta mono">{secs(wall)}{tokens > 0 ? ` · ${fmtTok(tokens)} tok` : ''}</span>
        {done && <button class="icon-btn xs" onClick={() => setOpen(false)} aria-label="Collapse"><span class="chev up"><Icon name="chev" size={13} /></span></button>}
      </div>
      <div class="h-rows">{agents.map((a) => <HelperRow key={a.id} a={a} now={now} />)}</div>
    </div>
  );
}

function HelperRow({ a, now }: { a: Helper; now: number }) {
  const [open, setOpen] = useState(false);
  const el = a.running ? (now - a.start) / 1000 : a.seconds;
  const step = a.running ? a.label || 'starting…' : a.ok === false ? (a.summary?.split('\n')[0] || 'failed') : (a.summary?.split('\n')[0] || 'done');
  return (
    <div class={`h-row ${a.running ? 'running' : a.ok === false ? 'fail' : 'ok'} ${open ? 'open' : ''}`}>
      <button class="h-line" onClick={() => a.summary && setOpen(!open)} disabled={!a.summary} aria-expanded={open}>
        <span class="tool-ico">{a.running ? <span class="mini-spin" /> : a.ok === false ? <Icon name="x" size={11} /> : <Icon name="check" size={11} />}</span>
        <span class="h-main">
          <span class="h-goal">{a.goal}</span>
          <span class="h-step mono" key={step}>{step}</span>
        </span>
        <span class="h-stats mono">
          {a.tokens ? <span>{fmtTok(a.tokens)} tok</span> : null}
          <span class="h-el">{secs(el)}</span>
        </span>
      </button>
      {a.running && a.tail && a.tail.length > 0 && <div class="tool-tail mono h-tail">{a.tail.slice(-2).map((l, i) => <div key={l + i}>{l}</div>)}</div>}
      {open && a.summary && <div class="h-summary md" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.summary) }} />}
    </div>
  );
}

// ---------- notices ----------
export function noticeText(kind: string, text: string) {
  return kind === 'skill' ? `new skill: ${text}` : kind === 'memory' ? `remembered: ${text}` : text;
}
export function NoticeChip({ kind, text }: { kind: string; text: string }) {
  return (
    <div class="notice mono">
      <span class="n-dot" />
      <span class="n-kind">+ {kind === 'skill' ? 'new skill' : kind === 'memory' ? 'remembered' : kind}</span>
      <span class="n-text">{text}</span>
    </div>
  );
}

// ---------- approval ----------
export function ApprovalCard({ p, onAnswer }: { p: ApprovalPart; onAnswer: (p: ApprovalPart, a: 'allow' | 'deny' | 'always') => void }) {
  return (
    <div class={`approval ${p.answer ? 'answered' : ''}`}>
      <div class="ap-head"><span class="accent mono">!</span> Pico wants to run this. Okay?</div>
      <pre class="ap-cmd mono">{p.command}</pre>
      {p.reason && <p class="ap-reason">{p.reason}</p>}
      {p.answer ? (
        <div class="ap-ans mono">{p.answer === 'deny' ? '× denied' : p.answer === 'always' ? '✓ always allowed' : '✓ allowed'}</div>
      ) : (
        <div class="ap-btns">
          <button class="btn primary sm" onClick={() => onAnswer(p, 'allow')}>Allow</button>
          <button class="btn ghost sm" onClick={() => onAnswer(p, 'deny')}>Deny</button>
          <button class="btn ghost sm" onClick={() => onAnswer(p, 'always')} title="Don't ask again for commands like this">Always</button>
        </div>
      )}
    </div>
  );
}

// ---------- turn summary ----------
export function TurnSummary({ s, ok, onUndo, canUndo }: { s: TurnSummaryInfo; ok: boolean; onUndo?: () => void; canUndo: boolean }) {
  const files = s.files_changed || [];
  const add = files.reduce((n, f) => n + (f.added || 0), 0);
  const del = files.reduce((n, f) => n + (f.removed || 0), 0);
  const bits: preact.ComponentChildren[] = [];
  if (s.tools) bits.push(plural(s.tools, 'tool'));
  if (files.length) bits.push(<>{plural(files.length, 'file')} <span class="add">+{add}</span> <span class="del">−{del}</span></>);
  if (s.output_tokens) bits.push(`${fmtTok(s.output_tokens)} tok`);
  if (s.seconds) bits.push(secs(s.seconds));
  if (s.tps) bits.push(`${Math.round(s.tps)} tok/s`);
  if (!bits.length) return null;
  return (
    <div class="turn-foot">
      <span class="tsum mono" title={files.map((f) => `${f.path}  +${f.added} −${f.removed}`).join('\n') || undefined}>
        <span class={ok ? 'ts-ok' : 'ts-fail'}>{ok ? '✓' : '×'}</span>
        {bits.map((b, i) => <>{i > 0 && <span class="sep">·</span>}<span>{b}</span></>)}
      </span>
      {canUndo && files.length > 0 && onUndo && (
        <button class="undo-btn mono" onClick={onUndo} title="Put the changed files back the way they were before this reply">
          <Icon name="undo" size={13} /> Undo
        </button>
      )}
    </div>
  );
}

// ---------- context pills ----------
const fmtMax = (n: number) => (n >= 1_000_000 ? `${+(n / 1048576).toFixed(1)}M` : n % 1024 === 0 ? `${n / 1024}k` : fmtTok(n));
export function ContextPills({ ctx, compacted, onCompact, busy }: {
  ctx: CtxInfo; compacted?: { before: number; after: number; key: number } | null; onCompact: () => void; busy: boolean;
}) {
  const pct = ctx.max ? Math.min(1, ctx.used / ctx.max) : 0;
  const lvl = pct > 0.95 ? 'crit' : pct >= 0.8 ? 'warn' : 'ok';
  const N = 10;
  const on = pct >= 0.05 ? Math.max(1, Math.round(pct * N)) : 0;
  const cached = ctx.cached === undefined || ctx.cached === null ? null
    : ctx.cached <= 1 ? Math.round(ctx.cached * 100) : ctx.used ? Math.round((ctx.cached / ctx.used) * 100) : null;
  return (
    <div class={`ctxpills mono ${lvl}`} title={`Context ${Math.round(pct * 100)}% full — how much of this chat the model keeps in mind at once.`}>
      <span class="cp-bar" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={ctx.max} aria-valuenow={ctx.used}>
        <span class="cp-on">{'▰'.repeat(on)}</span><span class="cp-off">{'▱'.repeat(N - on)}</span>
      </span>
      <span class="cp-num">{fmtTok(ctx.used)}/{fmtMax(ctx.max)}</span>
      {cached !== null && cached > 0 && <span class="cp-dim">· cached {cached}%</span>}
      {compacted && <span class="cp-chip" key={compacted.key}>↺ {fmtTok(compacted.before)} → {fmtTok(compacted.after)}</span>}
      {pct > 0.85 && !busy && <button class="cp-compact" onClick={onCompact} title="Summarize older messages to free up room">Compact</button>}
    </div>
  );
}

// ---------- steer note ----------
export function SteerNote({ text, state }: { text: string; state: 'sent' | 'applied' | 'queued' | 'followup' }) {
  return (
    <div class={`steer-note ${state}`}>
      <span class="sn-arrow mono">↳</span><span class="sn-k">steer:</span><span class="sn-t">{text}</span>
      <span class="sn-s mono">{state === 'applied' ? '✓' : state === 'queued' ? 'queued' : state === 'followup' ? 'next turn' : <span class="mini-spin" />}</span>
    </div>
  );
}

// ---------- goal banner ----------
export function GoalBanner({ g, onClear }: { g: GoalState; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const p = g.progress;
  const N = 5;
  const on = p && p.total ? Math.round((p.done / p.total) * N) : 0;
  return (
    <div class={`goalb ${open ? 'open' : ''} ${g.status}`}>
      <button class="goalb-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="gb-ico mono">◎</span><span class="gb-k">goal</span>
        <span class="gb-text">{g.text}</span>
        {g.status === 'done' && <span class="gb-done mono">done ✧</span>}
        {p && p.total > 0 && <span class="gb-prog mono"><span class="cp-on">{'▰'.repeat(on)}</span><span class="cp-off">{'▱'.repeat(N - on)}</span> {p.done}/{p.total}</span>}
        <span class={`chev ${open ? 'up' : ''}`}><Icon name="chev" size={12} /></span>
      </button>
      {open && (
        <div class="goalb-body">
          {g.todos.length === 0 ? <div class="gb-empty">No checklist yet — Pico adds one as it works.</div> : (
            <ul class="checklist">
              {g.todos.map((t, i) => <li key={i} class={t.done ? 'done' : ''}><span class="ck mono">{t.done ? '✓' : '○'}</span>{t.text}</li>)}
            </ul>
          )}
          <button class="gb-clear" onClick={onClear}>clear goal</button>
        </div>
      )}
    </div>
  );
}

// ---------- plan card ----------
export function PlanCard({ plan, onGo, busy }: { plan: PlanInfo; onGo: () => void; busy: boolean }) {
  const phaseLabel: Record<string, string> = { planning: 'planning…', awaiting: 'ready when you are', executing: 'working through it', done: 'done' };
  const done = plan.steps.filter((s) => s.status === 'done').length;
  return (
    <div class={`plan ${plan.phase}`}>
      <div class="plan-head">
        <span class="plan-k mono">plan</span>
        <span class="plan-title" title={plan.title}>{plan.title.split(/(?<=[.!?])\s/)[0].replace(/[.]$/, '')}</span>
        <span class={`plan-phase mono ${plan.phase === 'planning' || plan.phase === 'executing' ? 'shimmer' : ''}`}>{phaseLabel[plan.phase] || plan.phase}</span>
        {plan.steps.length > 0 && <span class="plan-count mono">{done}/{plan.steps.length}</span>}
      </div>
      {plan.steps.length > 0 && (
        <ol class="plan-steps">
          {plan.steps.map((s, i) => (
            <li key={i} class={s.status}><span class="ps-ico mono">{s.status === 'done' ? '✓' : s.status === 'active' ? '▸' : '○'}</span><span>{s.text}</span></li>
          ))}
        </ol>
      )}
      {plan.phase === 'awaiting' && (
        <div class="plan-foot"><span class="dim small">Go runs it; anything else revises the plan.</span><button class="btn primary sm" disabled={busy} onClick={onGo}>Go</button></div>
      )}
    </div>
  );
}

// ---------- loop chip ----------
export function LoopChip({ loop, onStop }: { loop: LoopInfo; onStop: () => void }) {
  const now = useNow(!!loop.next_at, 1000);
  const left = loop.next_at ? Math.max(0, Math.round(loop.next_at - now / 1000)) : null;
  const mmss = left === null ? '' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return (
    <span class={`loopchip mono ${loop.state}`}>
      <span class="lc-ico">↻</span> loop {loop.runs}/{loop.max_runs}
      {loop.state === 'running' ? <span class="dim"> · running</span> : mmss ? <span class="dim"> · next {mmss}</span> : null}
      <button class="lc-x" onClick={onStop} title="Stop loop" aria-label="Stop loop"><Icon name="x" size={11} /></button>
    </span>
  );
}
