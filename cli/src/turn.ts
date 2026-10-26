import { bgRGB, bold, C, dim, isAscii, fg, fmtSecs, G, italic, NO_COLOR, padRight, t, truncate, width as w, wrap } from './ansi';
//
// Every turn renders as plain, quiet blocks (classic structure, minimal chrome):
//   ────────────────────────────────────  dim rule between turns
//   › fix the off-by-one in calc.py         user line, accent ›
//
//     ✻ thought 2.1s                        thinking (live: shimmering 'thinking' + timer)
//     ┬ 3 steps                             tools as a tree; ✓/✗ + seconds, live tail under
//     ├─ ✓ read calc.py  0.1s               the running one ('╰ 4 passed', dim, ≤4 lines)
//     ├─ ✓ patch calc.py  0.0s
//     │  ✎ calc.py  +1 −1  (ctrl+o to see)  edits collapse to a summary; ctrl+o shows the diff
//     └─ ⠹ pytest -q  0.4s
//        ╰ 4 passed
//
//     The reply prose, wrapped to fit.
//
//     (^.^)✧ done in 4.1s · 3 tools · 1 file +1 −1 · 51 tok/s
//
// Pure: renderTurn(turn, width, opts) -> string[]. Used by the live region and the full redraw.
import { applySubagent, renderSubagents, type Subagent } from './agents';
import type { Message, Todo } from './api';
import { diffSummary, type FileDiff, renderDiff } from './diff';
import type { Effort } from './effort';
import { renderMarkdown } from './markdown';
import { catSign, FACES, renderSummary, type Summary } from './status';
import { isShimmer, replyStyle, type ReplyStyle, shimmer, spinGlyph, type Verbosity, verbosity } from './theme';
import { spinFrame } from './tty';
import { planCard, type PlanState, type SteerState, steerLine } from './features';

export interface ToolPart {
  kind: 'tool';
  id: string;
  name: string;
  args: unknown;
  label?: string;
  start: number;
  end?: number;
  ok?: boolean;
  preview?: string;
  tail?: string[];
  diff?: FileDiff;
  seconds?: number;
  /** how a gated command got through: yolo auto-approval, or the user's y/n/a answer */
  gate?: 'auto' | 'allowed' | 'always' | 'denied';
}
export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; start: number; end?: number }
  | ToolPart
  | { kind: 'notice'; notice: string; text: string }
  | { kind: 'agents'; list: Subagent[] }
  | { kind: 'steer'; text: string; state: SteerState }
  | { kind: 'plan'; plan: PlanState };

export interface TurnDone {
  output?: number;
  input?: number;
  tps?: number;
  seconds?: number;
  summary?: Summary;
}

export interface Turn {
  user: string;
  attachments?: string[];
  parts: Part[];
  done?: TurnDone;
  error?: string;
  interrupted?: boolean;
  started: number;
  effort?: Effort;
  /** ctrl+o: show full diffs, reasoning and subagent summaries */
  expanded?: boolean;
  /** engine message id */
  id?: string;
  /** engine-started turns (loop / cron): dim header instead of the user line, e.g. '↻ loop #3' */
  header?: string;
  /** model that answered (done.model) */
  model?: string;
}

export function newTurn(user: string, attachments: string[] = [], effort?: Effort): Turn {
  return { user, attachments, parts: [], started: Date.now(), effort };
}

export const TAIL_LINES = 4;
/** tools=full keeps this many live output lines */
export const FULL_TAIL_LINES = 20;

const findTool = (turn: Turn, id: unknown) =>
  [...turn.parts].reverse().find((x) => x.kind === 'tool' && (x.id === String(id) || (!id && !x.end))) as ToolPart | undefined;

/** Apply one SSE event from POST /messages to a turn. Returns true if it changed. */
export function applyEvent(turn: Turn, ev: string, d: any, now = Date.now()): boolean {
  const last = turn.parts[turn.parts.length - 1];
  const closeReasoning = () => {
    for (const p of turn.parts) if (p.kind === 'reasoning' && !p.end) p.end = now;
  };
  switch (ev) {
    case 'delta': {
      if (!d?.text) return false;
      closeReasoning();
      if (last && last.kind === 'text') last.text += d.text;
      else turn.parts.push({ kind: 'text', text: d.text });
      return true;
    }
    case 'reasoning': {
      if (!d?.text) return false;
      if (last && last.kind === 'reasoning' && !last.end) last.text += d.text;
      else turn.parts.push({ kind: 'reasoning', text: d.text, start: now });
      return true;
    }
    case 'tool_start': {
      closeReasoning();
      turn.parts.push({ kind: 'tool', id: String(d?.id ?? ''), name: d?.name ?? 'tool', args: d?.args, label: d?.label, start: now });
      return true;
    }
    case 'tool_progress': {
      const p = findTool(turn, d?.id);
      if (!p || p.end) return false;
      const src: unknown[] = Array.isArray(d?.tail) ? d.tail : String(d?.tail ?? d?.text ?? '').split('\n');
      const lines = src.map((x) => String(x).replace(/\s+$/, '')).filter(Boolean);
      if (!lines.length) return false;
      p.tail = lines.slice(-FULL_TAIL_LINES);
      return true;
    }
    case 'tool_end': {
      let p = findTool(turn, d?.id);
      if (!p) {
        p = { kind: 'tool', id: String(d?.id ?? ''), name: d?.name ?? 'tool', args: undefined, start: now };
        turn.parts.push(p);
      }
      p.end = now;
      p.ok = d?.ok !== false;
      p.preview = d?.result_preview ?? '';
      if (typeof d?.seconds === 'number') p.seconds = d.seconds;
      if (d?.diff && typeof d.diff === 'object' && d.diff.path) p.diff = d.diff;
      p.tail = undefined;
      return true;
    }
    case 'notice': {
      if (!d?.text) return false;
      // yolo auto-approvals belong to the running command: mark it instead of splitting the tool tree
      if (d.kind === 'yolo') {
        const run = findTool(turn, undefined);
        if (run) {
          run.gate = 'auto';
          return true;
        }
      }
      turn.parts.push({ kind: 'notice', notice: d.kind || 'memory', text: String(d.text) });
      return true;
    }
    case 'compact_note':
      turn.parts.push({ kind: 'notice', notice: 'compact', text: String(d?.text || 'auto-compacted') });
      return true;
    case 'subagent_start':
    case 'subagent_progress':
    case 'subagent_end': {
      let grp = turn.parts.find((x) => x.kind === 'agents') as Extract<Part, { kind: 'agents' }> | undefined;
      if (!grp) {
        if (ev !== 'subagent_start') return false;
        closeReasoning();
        grp = { kind: 'agents', list: [] };
        turn.parts.push(grp);
      }
      return applySubagent(grp.list, ev, d, now);
    }
    case 'gate': {
      // the user's answer to an approval prompt, shown under the command it gated
      const run = findTool(turn, undefined);
      if (run) run.gate = d?.gate;
      else turn.parts.push({ kind: 'notice', notice: d?.gate === 'denied' ? 'denied' : 'allowed', text: String(d?.command ?? '') + (d?.gate === 'always' ? ' (always)' : '') });
      return true;
    }
    case 'steer': {
      // engine confirms a steer: flip the matching pending line (or add an applied one)
      const txt = String(d?.text ?? '').trim();
      const mine = turn.parts.find((x) => x.kind === 'steer' && x.state === 'pending' && (!txt || x.text.trim() === txt)) as Extract<Part, { kind: 'steer' }> | undefined;
      if (mine) mine.state = d?.applied === false ? 'queued' : 'applied';
      else if (txt) turn.parts.push({ kind: 'steer', text: txt, state: d?.applied === false ? 'queued' : 'applied' });
      return true;
    }
    case 'steer_local': // the user's own steer, shown immediately (pending)
      turn.parts.push({ kind: 'steer', text: String(d?.text ?? ''), state: d?.state ?? 'pending' });
      return true;
    case 'plan': {
      const steps = Array.isArray(d?.steps) ? d.steps.map((x: any) => ({ text: String(x?.text ?? x ?? ''), status: x?.status === 'done' || x?.status === 'active' ? x.status : 'pending' })) : [];
      const plan = { title: String(d?.title ?? ''), steps };
      const cur = turn.parts.find((x) => x.kind === 'plan') as Extract<Part, { kind: 'plan' }> | undefined;
      if (cur) cur.plan = plan;
      else {
        closeReasoning();
        turn.parts.push({ kind: 'plan', plan });
      }
      return true;
    }
    case 'pause': // e.g. waiting on an approval: stop the thinking timer
      closeReasoning();
      return true;
    case 'done': {
      closeReasoning();
      turn.done = { output: d?.usage?.output, input: d?.usage?.input, tps: d?.tps, seconds: d?.seconds, summary: d?.summary };
      if (d?.model) turn.model = String(d.model);
      if (d?.message_id) turn.id = String(d.message_id);
      return true;
    }
    case 'error': {
      closeReasoning();
      turn.error = d?.message || 'error';
      return true;
    }
  }
  return false;
}

/** Short one-line summary of tool args: prefers command/path/query-like fields. */
export function summarizeArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') {
    try {
      return summarizeArgs(JSON.parse(args));
    } catch {
      return args;
    }
  }
  if (typeof args !== 'object') return String(args);
  const a = args as Record<string, unknown>;
  for (const k of ['command', 'cmd', 'path', 'file', 'file_path', 'query', 'q', 'url', 'pattern', 'name', 'text', 'goal']) {
    if (typeof a[k] === 'string' && a[k]) return String(a[k]);
  }
  const s = JSON.stringify(a);
  return s === '{}' ? '' : s;
}

// ---------------------------------------------------------------- tool line state machine
export type ToolState = 'running' | 'ok' | 'failed';
export const toolState = (p: ToolPart): ToolState => (!p.end ? 'running' : p.ok ? 'ok' : 'failed');

const VERB: Record<string, string> = {
  read_file: 'read', write_file: 'write', patch: 'patch', edit_file: 'edit', search_files: 'search', web_search: 'search',
  web_extract: 'fetch', list_files: 'ls', delegate_task: 'delegate',
};
/** Human label for a tool step: 'read calc.py', 'pytest -q' (terminal shows the command itself). */
/** verbs the engine already puts at the front of its labels ('edit calc.py', 'web search "x"') */
const LABEL_VERBS = /^(read|write|edit|patch|search|web|open|fetch|ls|memory|update|delegate|create|delete|run|list|recall|remember|view|skill|load|install|enable|disable|find|grep|browse|call)\b/i;
export function toolLabel(p: ToolPart): string {
  const shell = p.name === 'terminal' || p.name === 'shell' || p.name === 'bash';
  let label = (p.label || '').replace(/\s+/g, ' ').trim();
  // engine labels terminal steps as "terminal `cmd`": the tree shows the bare command
  const tick = /^(?:terminal|shell|bash) `(.*)`$/.exec(label);
  if (tick) label = tick[1];
  if (shell) return label || summarizeArgs(p.args).replace(/\s+/g, ' ').trim() || p.name;
  if (label && LABEL_VERBS.test(label)) return label;
  const arg = label || summarizeArgs(p.args).replace(/\s+/g, ' ').trim();
  const verb = VERB[p.name] ?? p.name;
  return arg ? `${verb} ${arg}` : verb;
}

/** Running-tool glyph + label: spinner in accent, or (shimmer) light sweeping across the label. */
function liveLabel(label: string, now: number): string {
  if (isShimmer()) return shimmer(label, now, fg(C.text));
  return t.accent(spinGlyph(now)) + ' ' + fg(C.text)(label);
}

/**
 * One tree row (+ its children) for a tool: '├─ ✓ read calc.py  0.1s'. `last` picks └─ and the child
 * indent. Running tools show their live tail (≤4 lines, dim) as '╰ …'; edits show the diff summary
 * (full diff when expanded); failures show the first error line.
 */
export function renderTool(p: ToolPart, width: number, opts: { now?: number; expanded?: boolean; last?: boolean; halted?: boolean; tailLines?: number } = {}): string[] {
  const g = G();
  const now = opts.now ?? Date.now();
  // a turn that errored / was stopped never sends tool_end: freeze its open tools instead of spinning forever
  if (opts.halted && !p.end) {
    const branch = t.faint((opts.last ?? true ? g.last : g.tee) + ' ');
    return [truncate(branch + t.dim(g.stop) + ' ' + t.faint(toolLabel(p)), width)];
  }
  const st = toolState(p);
  const last = opts.last ?? true;
  const branch = t.faint((last ? g.last : g.tee) + ' ');
  const kid = t.faint(last ? '   ' : g.vline + '  ');
  const secs = p.seconds ?? ((p.end ?? now) - p.start) / 1000;
  const secS = t.faint(fmtSecs(secs));
  const room = Math.max(6, width - w(branch) - 2 - 2 - w(fmtSecs(secs)));
  const label = truncate(toolLabel(p), room);
  const head = st === 'running' ? liveLabel(label, now) : (st === 'ok' ? t.ok(g.check) : t.err(g.cross)) + ' ' + t.muted(label);
  const out = [truncate(branch + head + '  ' + secS, width)];
  const inner = width - 3;
  if (p.gate) out.push(kid + gateLine(p.gate));
  if (st === 'running' && p.tail?.length) {
    p.tail.slice(-(opts.tailLines ?? TAIL_LINES)).forEach((l, i) => out.push(kid + t.faint(i === 0 ? g.hook + ' ' : '  ') + t.dim(truncate(l.replace(/\t/g, '  '), inner - 2))));
  } else if (st !== 'running' && p.diff) {
    if (opts.expanded) out.push(...renderDiff(p.diff, inner, { expanded: true }).map((l) => kid + l));
    else out.push(kid + truncate(diffSummary(p.diff), inner));
  } else if (st !== 'running' && p.preview && (st === 'failed' || opts.expanded)) {
    const pv = String(p.preview).trim().split('\n').filter(Boolean);
    const n = opts.expanded ? Math.min(pv.length, 40) : 1;
    pv.slice(0, n).forEach((l, i) => out.push(kid + t.faint(i === 0 ? g.hook + ' ' : '  ') + (st === 'failed' ? t.err : t.dim)(truncate(l, inner - 2))));
    if (pv.length > n) out.push(kid + '  ' + t.faint(`${g.ell} +${pv.length - n} line${pv.length - n === 1 ? '' : 's'}`));
  }
  return out;
}

/** '┬ 3 steps' + one tree row per tool. */
export function renderToolTree(tools: ToolPart[], width: number, opts: { now?: number; expanded?: boolean; halted?: boolean; tailLines?: number } = {}): string[] {
  const g = G();
  const n = tools.length;
  const out = [t.faint(g.top) + ' ' + fg(C.text)(`${n} step${n === 1 ? '' : 's'}`)];
  tools.forEach((p, i) => out.push(...renderTool(p, width, { ...opts, last: i === n - 1 })));
  return out;
}

/** quiet tools: verb buckets for the one-line roll-up */
const QUIET_VERB: Record<string, string> = {
  read_file: 'read', list_files: 'read', view: 'read', write_file: 'edit', patch: 'edit', edit_file: 'edit', terminal: 'ran', shell: 'ran', bash: 'ran',
  search_files: 'search', web_search: 'search', web_extract: 'fetch', delegate_task: 'delegate',
};
/** 'read 2 · edit 1 · ran 3' with a spinner while any runs, ✓ when done, ✗ n if some failed. */
export function renderToolsQuiet(tools: ToolPart[], width: number, opts: { now?: number; halted?: boolean } = {}): string {
  const g = G();
  const now = opts.now ?? Date.now();
  const counts = new Map<string, number>();
  for (const p of tools) {
    const v = QUIET_VERB[p.name] ?? (p.name.startsWith('mcp_') ? 'call' : p.name);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const running = tools.some((p) => !p.end) && !opts.halted;
  const failed = tools.filter((p) => p.end && !p.ok).length;
  const head = running ? t.accent(spinGlyph(now)) : opts.halted && tools.some((p) => !p.end) ? t.dim(g.stop) : failed ? t.err(g.cross) : t.ok(g.check);
  const body = [...counts].map(([v, n]) => `${v} ${n}`).join(` ${g.sep} `);
  const secs = tools.reduce((a, p) => a + (p.seconds ?? ((p.end ?? now) - p.start) / 1000), 0);
  return truncate(head + ' ' + t.muted(body) + (failed ? t.err(`  ${failed} failed`) : '') + '  ' + t.faint(fmtSecs(secs)) + (running ? '' : t.faint('  ctrl+o')), width);
}

export interface RenderOpts {
  live?: boolean;
  /** override the user's verbosity prefs (tests, /theme preview) */
  verbosity?: Verbosity;
  /** draw the dim rule above (every turn but the first) */
  separator?: boolean;
  now?: number;
  /** override the reply style pref (tests, look & feel preview) */
  style?: ReplyStyle;
}

export function turnRule(width: number): string {
  return fg(C.rule)(G().rule.repeat(Math.max(4, width)));
}

/** Band background: truecolor #24242b, 256-color 236. */
export const BAND_BG = bgRGB(0x24, 0x24, 0x2b, 236);
/** Band/label/bar need color + Unicode; ASCII or NO_COLOR falls back to '> ' + 'pico:' labels. */
export const effectiveStyle = (s: ReplyStyle): ReplyStyle | 'ascii' => (s !== 'plain' && (isAscii() || NO_COLOR) ? (s === 'label' ? 'label' : 'ascii') : s);

/**
 * The user's message, per reply style:
 *  band  — full-width subtle background band on every wrapped line, accent ›, brighter text
 *  label — dim 'you' label, text indented 2
 *  bar   — dim ▌ left bar
 *  plain — '› text' (continuation lines aligned)
 *  ascii — '> text' (band fallback without color/Unicode)
 */
export function renderUser(text: string, width: number, attachments: string[] = [], style: ReplyStyle = replyStyle()): string[] {
  const g = G();
  const st = effectiveStyle(style);
  const out: string[] = [];
  const inner = Math.max(8, width - 4);
  const lines = text.split('\n').flatMap((l) => wrap(l, inner));
  const att = attachments.length ? (isAscii() ? '+ ' : '⎘ ') + attachments.join(', ') : '';
  if (st === 'band') {
    const row = (s: string) => BAND_BG(padRight(s, width));
    lines.forEach((l, i) => out.push(row(' ' + (i === 0 ? t.accent(g.user) : ' ') + ' ' + bold(fg(255)(l)))));
    if (att) out.push(row('   ' + t.muted(att)));
    return out;
  }
  if (st === 'label') {
    out.push(t.muted('you'));
    lines.forEach((l) => out.push('  ' + fg(C.text)(l)));
  } else if (st === 'bar') {
    lines.forEach((l) => out.push(fg(C.dim)('▌') + ' ' + fg(C.text)(l)));
  } else {
    const mark = st === 'ascii' ? t.accent('>') : t.accent(g.user);
    lines.forEach((l, i) => out.push((i === 0 ? mark + ' ' : '  ') + fg(C.text)(l)));
  }
  if (att) out.push('  ' + t.dim(att));
  return out;
}

/** Face on the reply header: the turn's final mood (or live state while it runs). */
export function replyFace(turn: Turn): string {
  if (turn.error) return FACES.error;
  if (turn.interrupted) return FACES.asleep;
  if (turn.done) return FACES.done;
  return turn.parts.some((p) => p.kind === 'reasoning' && !p.end) ? FACES.thinking : FACES.working;
}

/** '(^.^) pico' — face accent (red on error), name dim. ASCII band fallback: 'pico:'. */
export function replyHeader(turn: Turn, style: ReplyStyle | 'ascii'): string {
  if (style === 'ascii') return t.accent('pico:');
  return (turn.error ? t.err : t.accent)(`(${replyFace(turn)})`) + ' ' + t.dim('pico');
}

/** '→ auto-approved' (yolo) / '✓ allowed' / '✓ always allowed' / '✗ denied', dim, under the command. */
export function gateLine(gate: NonNullable<ToolPart['gate']>): string {
  const g = G();
  if (gate === 'auto') return t.faint(g.arrow + ' ') + t.dim('auto-approved');
  if (gate === 'denied') return t.err(g.cross) + ' ' + t.dim('denied');
  return t.ok(g.check) + ' ' + t.dim(gate === 'always' ? 'always allowed' : 'allowed');
}

export function noticeLine(kind: string, text: string): string {
  const g = G();
  if (kind === 'yolo') return t.faint(g.arrow + ' ') + t.dim('auto-approved ') + t.faint(text.replace(/^auto-approved:\s*/, ''));
  if (kind === 'allowed') return t.ok(g.check) + ' ' + t.dim('allowed ') + t.faint(text);
  if (kind === 'denied') return t.err(g.cross) + ' ' + t.dim('denied ') + t.faint(text);
  if (kind === 'compact') return t.faint(g.compact + ' ') + t.dim(text);
  const what = kind === 'skill' ? 'new skill: ' : kind === 'memory' ? 'remembered: ' : `${kind}: `;
  return t.accentDim(G().plus + ' ' + what) + t.muted(text);
}

/** Turn summary from done.summary, or derived from parts when the engine is older. */
export function turnSummary(turn: Turn): Summary {
  const tools = turn.parts.filter((p) => p.kind === 'tool') as ToolPart[];
  const s: Summary = { ...(turn.done?.summary || {}) };
  if (s.tools == null) s.tools = tools.length;
  if (!s.files_changed) {
    const files = new Map<string, { path: string; added: number; removed: number }>();
    for (const p of tools)
      if (p.diff) {
        const f = files.get(p.diff.path) ?? { path: p.diff.path, added: 0, removed: 0 };
        f.added += p.diff.added || 0;
        f.removed += p.diff.removed || 0;
        files.set(p.diff.path, f);
      }
    s.files_changed = [...files.values()];
  }
  if (s.output_tokens == null) s.output_tokens = turn.done?.output;
  if (s.seconds == null) s.seconds = turn.done?.seconds;
  if (s.tps == null) s.tps = turn.done?.tps;
  return s;
}

/** Live 'thinking 2.1s': the word shimmers in accent, timer dim. */
export function thinkingLine(start: number, now: number): string {
  return shimmer('thinking', now, t.dim, 90) + ' ' + t.faint(fmtSecs((now - start) / 1000));
}

export const BODY_INDENT = '  ';

export function renderTurn(turn: Turn, width: number, opts: RenderOpts = {}): string[] {
  const g = G();
  const now = opts.now ?? Date.now();
  const vb = opts.verbosity ?? verbosity();
  const style = opts.style ?? replyStyle();
  const st = effectiveStyle(style);
  const out: string[] = [];
  if (opts.separator) out.push('', turnRule(width));
  out.push('');
  if (turn.header) out.push(t.faint(isAscii() ? '@ ' : '↻ ') + t.dim(turn.header), '');
  else if (turn.user) out.push(...renderUser(turn.user, width, turn.attachments, style), '');
  if (st === 'band' || st === 'label' || st === 'ascii') out.push(replyHeader(turn, st));
  const inner = Math.max(16, width - 4); // 2 left margin + 2 right margin
  const body: string[] = [];
  let prev: string | null = null;
  const parts = turn.parts;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    // a blank row between different kinds of blocks (prose / steps / thinking / notices)
    const kind = p.kind === 'tool' ? 'tool' : p.kind === 'steer' ? 'notice' : p.kind;
    // reasoning=hidden: nothing at all (ctrl+o still reveals it)
    if (p.kind === 'reasoning' && vb.reasoning === 'hidden' && !turn.expanded) continue;
    if (prev && prev !== kind && !(prev === 'notice' && kind === 'notice')) body.push('');
    prev = kind;
    if (p.kind === 'reasoning') {
      const dur = fmtSecs(((p.end ?? now) - p.start) / 1000);
      if (!p.end) body.push(thinkingLine(p.start, now));
      else body.push(t.faint(g.think) + ' ' + t.dim(`thought ${dur}`) + (turn.expanded ? '' : t.faint('  ctrl+o')));
      const lines = () => p.text.trim().split('\n').flatMap((x) => wrap(x, inner - 2));
      if (turn.expanded || (vb.reasoning === 'full' && !p.end)) for (const l of lines()) body.push('  ' + italic(t.dim(l)));
      else if (vb.reasoning === 'preview' && !p.end) {
        const last = p.text.trim().split('\n').filter((x) => x.trim()).pop();
        if (last) body.push('  ' + italic(t.dim(truncate(last.trim(), inner - 2))));
      }
      continue;
    }
    if (p.kind === 'tool') {
      const group: ToolPart[] = [p];
      while (i + 1 < parts.length && parts[i + 1].kind === 'tool') group.push(parts[++i] as ToolPart);
      const halted = !!(turn.error || turn.interrupted);
      if (vb.tools === 'quiet' && !turn.expanded) body.push(renderToolsQuiet(group, inner, { now, halted }));
      else if (vb.tools === 'full') body.push(...renderToolTree(group, inner, { now, expanded: true, halted, tailLines: FULL_TAIL_LINES }));
      else body.push(...renderToolTree(group, inner, { now, expanded: turn.expanded, halted }));
      continue;
    }
    if (p.kind === 'notice') {
      body.push(noticeLine(p.notice, p.text));
      continue;
    }
    if (p.kind === 'steer') {
      body.push(steerLine(p.text, p.state, inner));
      continue;
    }
    if (p.kind === 'plan') {
      body.push(...planCard(p.plan, inner, { live: opts.live && !(turn.done || turn.error || turn.interrupted), now }));
      continue;
    }
    if (p.kind === 'agents') {
      body.push(...renderSubagents(p.list, inner, { expanded: turn.expanded, now }));
      continue;
    }
    body.push(...renderMarkdown(p.text, inner));
  }
  const finished = !!(turn.done || turn.error || turn.interrupted);
  if (opts.live && !finished) {
    const lastP = turn.parts[turn.parts.length - 1];
    const busy =
      turn.parts.some((x) => (x.kind === 'tool' && !x.end && vb.tools !== 'quiet') || (x.kind === 'reasoning' && !x.end && vb.reasoning !== 'hidden')) || (lastP?.kind === 'agents' && lastP.list.some((a) => !a.end));
    const quietTools = vb.tools === 'quiet' && turn.parts.some((x) => x.kind === 'tool' && !x.end);
    if (!busy && !quietTools && (!lastP || lastP.kind !== 'text')) {
      if (body.length) body.push('');
      const word = isShimmer() ? shimmer('working', now, t.muted) : t.accent(spinGlyph(now)) + ' ' + t.muted('working');
      body.push(word + t.faint(`  ${fmtSecs((now - turn.started) / 1000)} ${g.sep} esc to stop`));
    }
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  let closing = '';
  if (turn.interrupted) closing = t.warn('(-.-) stopped');
  else if (turn.error) closing = catSign('error') + ' ' + t.err(truncate(turn.error, inner - 8));
  else if (turn.done && vb.summary) closing = renderSummary(turnSummary(turn), true, inner);
  if (st === 'bar') {
    const b = t.accent('▌') + ' ';
    for (const l of body) out.push(l ? b + l : t.accent('▌'));
    if (closing) out.push(...(body.length ? [t.accent('▌')] : []), b + closing);
    return out;
  }
  for (const l of body) out.push(l ? BODY_INDENT + l : '');
  if (closing) out.push(...(body.length ? [''] : []), BODY_INDENT + closing);
  return out;
}

/** Convert stored session messages to turns (for /resume and redraw). */
export function messagesToTurns(msgs: Message[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const m of msgs) {
    if (m.role === 'user') {
      const loop = (m as any).meta?.loop ?? (m as any).loop;
      cur = { user: m.content, parts: [], started: 0, ...(loop ? { header: loopHeaderText(loop) } : {}) };
      turns.push(cur);
      continue;
    }
    if (!cur) {
      cur = { user: '', parts: [], started: 0 };
      turns.push(cur);
    }
    if (m.role === 'assistant') {
      if (m.reasoning) cur.parts.push({ kind: 'reasoning', text: m.reasoning, start: 0, end: 0 });
      if (m.content) cur.parts.push({ kind: 'text', text: m.content });
      cur.done = m.usage ? { output: m.usage.output, input: m.usage.input } : cur.done ?? {};
      cur.id = m.id;
    } else if (m.role === 'tool') {
      cur.parts.push({ kind: 'tool', id: m.id, name: m.tool?.name ?? 'tool', args: m.tool?.args, start: 0, end: 0, seconds: 0, ok: m.tool?.ok !== false, preview: m.tool?.result ?? m.content });
    }
  }
  return turns;
}

export function renderTodos(todos: Todo[], width: number): string[] {
  if (!todos?.length) return [];
  const g = G();
  const done = todos.filter((x) => x.done).length;
  const out = ['  ' + t.dim('todo ') + t.faint(`${done}/${todos.length}`)];
  const firstOpen = todos.findIndex((x) => !x.done);
  todos.slice(0, 8).forEach((td, i) => {
    const mark = td.done ? t.ok(g.check) : i === firstOpen ? t.accent('▸') : t.dim(g.ring);
    const txt = td.done ? dim(t.dim(td.text)) : i === firstOpen ? fg(C.text)(td.text) : t.muted(td.text);
    out.push('  ' + mark + ' ' + truncate(txt, width - 6));
  });
  if (todos.length > 8) out.push('    ' + t.faint(`${g.ell} ${todos.length - 8} more`));
  return out;
}

function loopHeaderText(loop: any): string {
  const n = typeof loop === 'object' ? loop.n : loop;
  return `loop #${n ?? '?'}`;
}
