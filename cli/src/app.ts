// Interactive chat TUI.
//
// State model: `history` holds every finished scrollback item (banner, turns, command output). Items are
// committed once into the terminal's native scrollback; `redraw()` clears the screen and re-commits them
// all at the current width (resize, /redraw, ctrl+l, ctrl+o on a finished turn, /undo). The live region
// (streaming turn, panels, input, status) is diff-rendered by LiveScreen so nothing flickers.
import { bold, C, fg, fmtCtx, fmtK, G, shortPath, t, truncate, width as w, wrap } from './ansi';
import { BUDGETS, DEFAULT_SUBAGENTS, fmtBudget, normalizeSubagents, type SubagentSettings } from './agents';
import { Api, type ContextInfo, type Health, type ModelInfo, type Skill, type Todo } from './api';
import { BUILTINS, helpLines, type Command } from './commands';
import { type Effort, EFFORT_COLOR, effortLabel, effortList, effortPaint, EFFORTS, isEffort, nextEffort, normalizeEffort } from './effort';
import { Editor } from './editor';
import { collectMentions, listFiles } from './files';
import { fuzzyFilter, fuzzyPositions } from './fuzzy';
import { isNewline, type Key } from './keys';
import { catRows, type CtxState, ctxTick, FACES, type MoodState, moodAt, renderCtx, renderSummary, skeleton } from './status';
import {
  ACCENTS, accentIndex, accentName, applyPrefs, isShimmer, parseVerbosity, prefs, prefsPath, REASONING_LEVELS, savePrefs, setVerbosity, shimmer, spinGlyph, SPINNERS,
  TOOLS_LEVELS, type TuiPrefs, verbosityLabel, VERBOSITY_WORDS,
} from './theme';
import { applyEvent, messagesToTurns, newTurn, noticeLine, renderTodos, renderToolTree, renderTurn, renderUser, type ToolPart, type Turn } from './turn';
import { LiveScreen, spinFrame, Terminal } from './tty';
import { box, confirm, modal, select, textPrompt } from './ui';
import { applyCandidate, type Completion, complete, ghostFor, type Sources } from './complete';
import {
  cronPanelLines, type CronJob, type CronPrompt, goalBanner, goalBox, type GoalState, inboxBadge, inboxLine, type InboxItem, inboxText, loopSegment,
  type LoopState, type ModelEntry, modelPanelLines, normalizeGoal, planWaitLine, providerLabel, toMs, usageCard,
} from './features';
import { catSign } from './status';
import { sideBySide } from './wizard';
import { addDone, emptySession, normProfile, profilePill, type ProfileCtx, type SessionUsage, type UsageLimits, usageLine, USAGE_NARROW } from './usage';
import type { UsageReport } from './features';
import { type SettingsState, settingsPanel } from './settings';

interface Approval {
  id: string;
  command: string;
  reason?: string;
}
interface Overlay {
  kind: 'palette' | 'files';
  items: { label: string; hint?: string; value: string }[];
  idx: number;
  /** text typed after / or @ (matched letters are highlighted) */
  query?: string;
}

/** A finished scrollback item, re-renderable at any width. */
type Item = { kind: 'turn'; turn: Turn } | { kind: 'lines'; render: (cols: number) => string[] };

export interface AppOpts {
  version: string;
  effort?: Effort;
  resume?: string;
  initialPrompt?: string;
  /** launch flags (bare `pico` = a new chat with these applied) */
  resumePick?: boolean;
  yolo?: boolean;
  model?: string;
  harness?: 'lean' | 'hermes';
  plan?: string;
  goal?: string;
  loop?: string;
}

export const NARROW = 60;

export class App {
  term = new Terminal();
  screen = new LiveScreen(this.term);
  ed = new Editor();
  effort: Effort = 'medium';
  /** effort levels shift+tab cycles through (engine may advertise 'max') */
  efforts: Effort[] = EFFORTS;
  /** random welcome quip, fixed per launch */
  quip = QUIPS[Math.floor(Math.random() * QUIPS.length)];
  private lastFace = '';
  sessionId: string | null = null;
  sessionTitle = '';
  goal = '';
  /** structured goal (SSE `goal` / session goal_state); banner above the cat */
  goalState: GoalState | null = null;
  goalExpanded = false;
  goalReachedAt = 0;
  /** last /plan turn ended with a plan waiting for 'go' */
  planWaiting = false;
  loop: LoopState | null = null;
  inbox: InboxItem[] = [];
  inboxUnseen = 0;
  /** steers the engine couldn't take (409 / old engine): sent as one message when the turn ends */
  steerQueue: string[] = [];
  /** the live turn was started by the engine (loop / cron), relayed on the session stream */
  bgTurn = false;
  private bgIgnore = false;
  /** tab completion state: candidates for the token before the cursor; `cycle` after a Tab */
  comp: Completion | null = null;
  compIdx = 0;
  private compCycle: { applied: string } | null = null;
  private compSuppressed = false;
  modelList: ModelEntry[] = [];
  activeModelId = '';
  /** /model picker preview: the status line shows this name while browsing */
  previewModel: string | null = null;
  private sessionCache: { id: string; title?: string }[] = [];
  private cronCache: { id: string; title?: string }[] = [];
  /** lines to print once the live turn is out of the way (inbox notices, celebrations) */
  private deferred: string[][] = [];
  private streamCtl: AbortController | null = null;
  private globalCtl: AbortController | null = null;
  todos: Todo[] = [];
  model = '';
  provider = '';
  health: Health | null = null;
  ctx: CtxState = { used: 0, max: 0, shown: 0 };
  /** summed done.usage for this chat */
  sessUsage: SessionUsage = emptySession();
  usageReport: UsageReport | null = null;
  usageLimits: UsageLimits | null = null;
  profile: ProfileCtx | null = null;
  /** engine config snapshot (approvals, harness, compaction…) */
  config: any = null;
  private usageFetching = false;
  tps = 0;
  yolo = false;
  cwd = process.cwd();
  skills: Skill[] = [];
  history: Item[] = [];
  turn: Turn | null = null;
  turnCommitted = 0;
  streaming: AbortController | null = null;
  approval: Approval | null = null;
  overlay: Overlay | null = null;
  notice = '';
  noticeKind: 'warn' | 'ok' = 'warn';
  noticeTimer: ReturnType<typeof setTimeout> | null = null;
  ctrlCAt = 0;
  modalOpen = false;
  mood: MoodState = { busy: null, lastActivity: Date.now() };
  private ticker: ReturnType<typeof setInterval> | null = null;
  private lastTick = Date.now();
  private lastIdleRender = 0;
  private renderQueued = false;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private quitResolve: (() => void) | null = null;
  private eventsCtl: AbortController | null = null;
  private eventsFor: string | null = null;

  constructor(public api: Api, public opts: AppOpts) {
    if (opts.effort) this.effort = opts.effort;
  }

  // ------------------------------------------------------------ lifecycle
  async run(health: Health): Promise<void> {
    this.health = health;
    this.model = health.model || '';
    this.provider = health.provider || '';
    this.term.start();
    this.term.onKey((k) => this.onKey(k));
    this.term.onResizeEvent(() => this.onResize());
    this.push({ kind: 'lines', render: (cols) => this.bannerLines(cols) });
    this.render();
    void this.loadMeta();
    this.listenGlobal();
    if (this.opts.resume) await this.resume(this.opts.resume);
    this.ticker = setInterval(() => this.tick(), 80);
    void this.launch();
    await new Promise<void>((r) => (this.quitResolve = r));
  }

  /** Apply launch flags in order: --model, -r picker, --yolo, --goal, --plan, --loop, then a prompt. */
  async launch() {
    const o = this.opts;
    if (o.model) await this.switchModel(o.model);
    if (o.resumePick) await this.resume();
    if (o.yolo) await this.yoloOnSilently();
    if (o.goal) await this.submit(`/goal ${o.goal}`);
    if (o.plan) await this.submit(`/plan ${o.plan}`);
    if (o.loop) await this.submit(`/loop ${o.loop}`);
    if (o.initialPrompt) await this.submit(o.initialPrompt);
  }

  /** --yolo: turn it on right after the session is created, without a visible turn. */
  async yoloOnSilently() {
    this.yolo = true;
    this.render();
    try {
      const sid = await this.ensureSession();
      await this.api.send(sid, { text: '/yolo on' }, { done: (d) => typeof d?.yolo === 'boolean' && (this.yolo = d.yolo), '*': () => {} });
    } catch (e: any) {
      this.flash(`--yolo: ${e?.message || e}`);
    }
    this.render();
  }

  closed = false;
  quit() {
    if (this.closed) return;
    this.closed = true;
    if (this.ticker) clearInterval(this.ticker);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.eventsCtl?.abort();
    this.streamCtl?.abort();
    this.globalCtl?.abort();
    if (this.streaming) this.streaming.abort();
    const gap = this.screen.lastBlank ? '' : '\r\n';
    this.screen.clearLive();
    this.term.write(gap + byeLine(this.sessionId) + '\r\n');
    this.term.stop();
    this.quitResolve?.();
  }

  /** Animation clock: 12fps while something moves, ~1fps when idle (face → asleep). */
  private tick() {
    const now = Date.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    const animCtx = ctxTick(this.ctx, dt);
    const compacting = !!this.ctx.compact && now - this.ctx.compact.at < 2700;
    const lingering = !!this.mood.lastEnd && now - this.mood.lastEnd.at < 1700;
    const goalAnim = !!this.goalReachedAt && now - this.goalReachedAt < 5500;
    if (this.streaming || this.turn || animCtx || compacting || lingering || goalAnim) return this.render();
    const m = moodAt(this.mood, now);
    const face = catRows(m, now).rows[1] + m;
    if (face !== this.lastFace) {
      this.lastFace = face;
      return this.render();
    }
    if (now - this.lastIdleRender > 1000) {
      this.lastIdleRender = now;
      this.render();
    }
  }

  private onResize() {
    // live region re-flows instantly; scrollback is reprinted once the user stops dragging
    this.screen.reset();
    this.render();
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.redraw(), 150);
  }

  private bannerLines(cols: number): string[] {
    const h = this.health;
    const g = G();
    const model = this.model || h?.model || '';
    const quip = t.dim(`"${this.quip}"`);
    if (cols < NARROW) {
      return ['', t.accent(`(${FACES.done})`) + ' ' + bold(fg(C.text)('pico')) + '  ' + t.dim(truncate(model || 'no model', cols - 16)), quip, ''];
    }
    const info = [
      bold(fg(C.text)('pico')) + t.dim(` v${this.opts.version}`) + (h?.version ? t.faint(` ${g.sep} engine ${h.version}`) : ''),
      t.dim(truncate(model || 'no model', cols - 30)) + (this.ctx.max ? t.faint(` ${g.sep} ${fmtCtx(this.ctx.max)} ctx`) : '') + t.faint(` ${g.sep} `) + t.dim(shortPath(this.cwd, Math.max(16, cols - 50))),
      quip,
    ];
    const out = ['', ...sideBySide(skeleton(FACES.done).map((l) => t.accent(l)), info, 2), '', t.faint(`/ commands ${g.sep} @ files ${g.sep} shift+tab effort ${g.sep} /theme colors ${g.sep} ? help`), ''];
    if (h?.state === 'starting_model') out.push(t.warn('model is still loading — first reply may be slow'), '');
    if (h?.state === 'error') out.push(t.err('engine reports an error state — try `pico doctor`'), '');
    return out;
  }

  private async loadMeta() {
    try {
      const m = await this.api.models();
      this.modelList = m.models as ModelEntry[];
      this.activeModelId = m.active;
      const act = m.models.find((x) => x.id === m.active) as ModelInfo | undefined;
      if (act) {
        this.model = act.name || act.id;
        this.ctx.max = act.ctx || this.ctx.max;
        if (!this.tps && act.tps) this.tps = act.tps;
      } else if (m.active) this.model = m.active;
    } catch {}
    try {
      const cfg = await this.api.config();
      this.config = cfg;
      this.applyCompactionCfg();
      const def = normalizeEffort(cfg.effort_default);
      if (!this.opts.effort && def) this.effort = def;
      this.efforts = effortList((cfg as any).efforts);
      if (!this.efforts.includes(this.effort)) this.effort = 'low';
    } catch {}
    try {
      this.skills = (await this.api.skills()).filter((s) => s.enabled !== false);
    } catch {}
    void this.refreshUsage();
    void this.refreshProfile();
    this.render();
  }

  /** Context bar tick at the auto-compaction threshold (config.compaction.at_pct). */
  applyCompactionCfg() {
    const c = this.config?.compaction;
    this.ctx.atPct = c && c.auto !== false && +c.at_pct > 0 ? +c.at_pct / 100 : undefined;
  }

  /** ChatGPT subscription model (provider openai_login). */
  get chatgpt(): boolean {
    const m = this.modelList.find((x) => x.id === this.activeModelId);
    return (m?.provider || this.config?.provider?.kind || this.provider) === 'openai_login';
  }

  /** GET /api/usage?days=30 (cheap; after each turn). Silent when missing. */
  async refreshUsage() {
    if (this.usageFetching) return;
    this.usageFetching = true;
    try {
      const u = await this.api.usage(30);
      if (u && typeof u === 'object') {
        this.usageReport = u;
        if (u.limits) this.usageLimits = u.limits;
      }
    } catch {
    } finally {
      this.usageFetching = false;
    }
    this.render();
  }

  /** GET /api/profile/context — standing prompt size. Silent when the engine lacks it. */
  async refreshProfile() {
    try {
      const p = normProfile(await this.api.get<any>('/api/profile/context', 5000));
      if (p) this.profile = p;
    } catch {}
    this.render();
  }

  /** Book-keeping shared by every done event (own turns + loop/cron turns). */
  private onDoneUsage(d: any) {
    addDone(this.sessUsage, d);
    if (d?.usage?.limits) this.usageLimits = d.usage.limits;
    const p = normProfile(d?.profile);
    if (p) this.profile = { ...(this.profile || {}), ...p };
    void this.refreshUsage();
  }

  /** The dim usage readout under the status line ('' when turned off). */
  usageText(cols: number, now = Date.now()): string {
    if (!prefs().usageLine) return '';
    if (!this.sessUsage.turns && !this.usageReport) return '';
    return usageLine({ session: this.sessUsage, report: this.usageReport, chatgpt: this.chatgpt, limits: this.usageLimits, now }, cols);
  }

  // ------------------------------------------------------------ scrollback
  /** Add a finished item to history and commit it to scrollback. */
  private push(item: Item) {
    this.history.push(item);
    this.screen.commit(this.itemLines(item, this.history.length - 1, this.term.cols));
  }

  private itemLines(item: Item, idx: number, cols: number): string[] {
    if (item.kind === 'lines') return item.render(cols);
    const firstTurn = this.history.findIndex((x) => x.kind === 'turn');
    return renderTurn(item.turn, cols, { separator: idx > firstTurn && firstTurn >= 0 });
  }

  /** Clear everything and repaint from state: banner, every scrollback item, live region. */
  redraw() {
    if (this.closed || this.modalOpen) return;
    const cols = this.term.cols;
    this.screen.clearAll();
    const lines: string[] = [];
    this.history.forEach((it, i) => lines.push(...this.itemLines(it, i, cols)));
    this.screen.commit(lines);
    this.turnCommitted = 0;
    this.draw();
  }

  print(lines: string[]) {
    const fixed = lines;
    this.push({ kind: 'lines', render: () => fixed });
    this.render();
  }
  /** Print width-aware lines (re-flow on redraw). */
  printFlow(render: (cols: number) => string[]) {
    this.push({ kind: 'lines', render });
    this.render();
  }

  // ------------------------------------------------------------ rendering
  render() {
    if (this.modalOpen || this.closed) return;
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (!this.modalOpen && !this.closed) this.draw();
    });
  }

  /** Short toast in the status line. 'ok' toasts ('✓ copied') are accent, the rest amber. */
  private flash(msg: string, ms = 2000, kind: 'warn' | 'ok' = 'warn') {
    this.notice = msg;
    this.noticeKind = kind;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = '';
      this.render();
    }, ms);
    this.render();
  }

  /**
   * Bottom region: the perched cat (ears + face float above the rule, paws embedded in it), the
   * effort-colored rule with '● med' at its right end, then the input lines with an effort-colored ›.
   * Under NARROW cols the cat hides and the rule is plain.
   */
  inputBox(cols: number, now = Date.now()): { lines: string[]; cursor: { row: number; col: number } } {
    const g = G();
    const paint = effortPaint(this.effort);
    const label = ` ${g.dot} ${effortLabel(this.effort)} `;
    const tailW = 1;
    const lead = '';
    const leadW = 0;
    const perch = cols >= NARROW;
    const lines: string[] = [...this.goalLines(cols, now)];
    if (perch) {
      const { rows, extra } = catRows(moodAt(this.mood, now), now);
      const catW = 7;
      const gap = 2;
      // reserve the widest effort label so the cat doesn't hop when shift+tab changes 'med' -> 'high'
      const maxLabel = Math.max(...this.efforts.map((e) => w(` ${g.dot} ${effortLabel(e)} `)));
      const slack = maxLabel - w(label);
      const catCol = cols - tailW - maxLabel - gap - catW;
      const pad = ' '.repeat(catCol);
      lines.push(pad + t.accent(rows[0]));
      lines.push(pad + t.accent(rows[1]) + (extra ? ' ' + fg(C.amber)(extra) : ''));
      const fill = Math.max(0, catCol - leadW);
      lines.push(lead + paint(g.h.repeat(fill)) + t.accent(rows[2]) + paint(g.h.repeat(gap + slack)) + paint(label) + paint(g.h.repeat(tailW)));
    } else {
      lines.push(lead + paint(g.h.repeat(Math.max(0, cols - leadW - w(label) - tailW))) + paint(label) + paint(g.h.repeat(tailW)));
    }
    const top = lines.length;
    const inner = cols - 3;
    const lay = this.ed.layout(inner);
    const maxRows = Math.max(3, Math.floor(this.term.rows / 3));
    let start = 0;
    if (lay.lines.length > maxRows) start = Math.min(Math.max(0, lay.row - maxRows + 1), lay.lines.length - maxRows);
    const vis = lay.lines.slice(start, start + maxRows);
    const placeholder = this.busy ? `type to steer${g.ell} esc to stop` : cols < NARROW ? 'ask anything' : `ask anything ${g.sep} / for commands ${g.sep} @ to attach`;
    const ghost = this.ghost();
    vis.forEach((l, i) => {
      const prefix = i === 0 && start === 0 ? paint(g.user) + ' ' : '  ';
      let body = this.ed.empty && i === 0 ? t.faint(placeholder) : fg(C.text)(l);
      if (ghost && start + i === lay.row) body += t.faint(truncate(ghost, Math.max(0, inner - w(l))));
      lines.push(prefix + body);
    });
    return { lines, cursor: { row: top + (lay.row - start), col: 2 + lay.col } };
  }

  /** Goal banner (or the expanded checklist box) pinned just above the perched cat. */
  goalLines(cols: number, now = Date.now()): string[] {
    const gs = this.goalState;
    if (!gs || gs.status === 'cleared') return [];
    let phase: 'active' | 'reached' | 'fading' = 'active';
    if (gs.status === 'done') {
      const age = this.goalReachedAt ? now - this.goalReachedAt : Infinity;
      if (age < 2500) phase = 'reached';
      else if (age < 5000) phase = 'fading';
      else return this.goalExpanded ? goalBox(gs, cols) : [];
    }
    if (this.goalExpanded) return goalBox(gs, cols);
    const b = goalBanner(gs, Math.min(cols - 4, 100), phase);
    return b ? ['  ' + b] : [];
  }

  /** a turn is running (ours or engine-started): Enter steers */
  get busy(): boolean {
    return !!this.streaming || this.bgTurn;
  }

  /** Dim remainder after the cursor: top palette match, or the current completion candidate. */
  ghost(): string {
    const ed = this.ed;
    if (ed.empty || ed.col !== ed.lines[ed.row].length || ed.lines.length > 1) return '';
    if (this.overlay?.kind === 'palette' && this.overlay.items.length) {
      const v = '/' + this.overlay.items[this.overlay.idx].value;
      const cur = ed.value;
      return v.toLowerCase().startsWith(cur.toLowerCase()) && v.length > cur.length ? v.slice(cur.length) : '';
    }
    if (this.compCycle) return '';
    return ghostFor(this.comp, this.compIdx);
  }

  /** Dim candidate row under the input when a completion has several matches. */
  candidateLines(cols: number): string[] {
    const c = this.comp;
    if (!c || c.items.length < 2 || this.overlay) return [];
    const g = G();
    const parts: string[] = [];
    let used = 4;
    let shown = 0;
    for (let i = 0; i < c.items.length; i++) {
      const it = c.items[i];
      const label = it.value.startsWith('@') ? it.value.slice(1).replace(/^.*\/(?=.)/, (m) => (it.dir ? m : '')) || it.value.slice(1) : it.value;
      const lw = w(label) + 2;
      if (used + lw > cols - 12) break;
      parts.push(i === this.compIdx ? t.accent(label) : t.dim(label));
      used += lw;
      shown++;
    }
    const more = c.items.length > shown ? t.faint(`  +${c.items.length - shown}`) : '';
    return ['    ' + parts.join('  ') + more + t.faint(`  ${g.sep} tab`)];
  }

  /** 'deepseek-v4.1-flash · ● med · ▰▰▱▱▱▱▱▱▱▱ 9k/128k cached 92% · 51 tok/s' (no face: the cat perches above). */
  statusLine(cols: number, now = Date.now()): string {
    const g = G();
    const narrow = cols < NARROW;
    const sep = t.faint(` ${g.sep} `);
    if (this.notice) return truncate(this.noticeKind === 'ok' ? t.accent(G().check + ' ') + t.muted(this.notice) : t.warn(this.notice), cols);
    const effort = effortPaint(this.effort)(g.dot + ' ' + effortLabel(this.effort));
    const ctx = renderCtx(this.ctx, now, narrow);
    const extras: string[] = [];
    if (this.busy && !narrow) extras.push(t.faint(`enter steer ${g.sep} esc stop`));
    if (!narrow && this.tps) extras.push(t.dim(`${Math.round(this.tps)} tok/s`));
    const yolo = this.yolo ? [t.err('yolo')] : [];
    const prof = cols >= USAGE_NARROW ? profilePill(this.profile) : '';
    const loop = loopSegment(this.loop, now);
    const badges = [...(loop ? [loop] : []), ...(this.inboxUnseen ? [inboxBadge(this.inboxUnseen)] : [])];
    const model = this.previewModel ?? this.model;
    const modelS = (mw: number) => (this.previewModel ? t.accent : t.dim)(truncate(model || 'no model', mw));
    // priority: effort, context, loop/inbox > model name > extras. Extras drop first, then the model shrinks.
    const build = (modelW: number, n: number) =>
      [...(modelW > 3 ? [modelS(modelW)] : []), effort, ...yolo, ...(ctx ? [ctx] : []), ...(prof && n >= 0 ? [prof] : []), ...badges, ...extras.slice(0, Math.max(0, n))].join(sep);
    for (let n = extras.length; n >= 0; n--) if (w(build(32, n)) <= cols) return build(32, n);
    for (let mw = 28; mw >= 4; mw -= 4) if (w(build(mw, 0)) <= cols) return build(mw, 0);
    for (let mw = 28; mw >= 4; mw -= 4) if (w(build(mw, -1)) <= cols) return build(mw, -1); // profile pill drops before the model name vanishes
    return truncate(build(0, -1), cols);
  }

  private draw() {
    const cols = this.term.cols;
    const rows = this.term.rows;
    const now = Date.now();
    // face: thinking while reasoning streams, working otherwise
    if (this.turn && !this.turn.done && !this.turn.error && !this.turn.interrupted) {
      const thinking = this.turn.parts.some((p) => p.kind === 'reasoning' && !p.end);
      this.mood.busy = thinking ? 'thinking' : 'working';
    } else this.mood.busy = null;
    this.mood.yolo = this.yolo;
    // a finishing turn is moved to history below; set the done/error face now so this frame shows it
    if (this.turn && (this.turn.done || this.turn.error || this.turn.interrupted)) this.mood.lastEnd = { at: now, ok: !this.turn.error };
    const box = this.inputBox(cols, now);
    // face: thinking while reasoning streams, working otherwise
    const status = this.statusLine(cols, now);
    const usage = this.usageText(cols, now);
    const above: string[] = [];
    const livePlan = !!this.turn?.parts.some((p) => p.kind === 'plan');
    if (this.todos.length && !livePlan && !this.goalExpanded) above.push(...renderTodos(this.todos, cols), '');
    if (this.approval) above.push(...this.approvalLines(cols));
    if (this.planWaiting && !this.turn) above.push(planWaitLine(cols), '');
    const below: string[] = [];
    if (this.overlay) below.push(...this.overlayLines(cols));
    else below.push(...this.candidateLines(cols));
    const chrome = above.length + box.lines.length + 1 + (usage ? 1 : 0) + below.length;
    let turnLines: string[] = [];
    if (this.turn) {
      const sep = this.history.some((x) => x.kind === 'turn');
      const all = renderTurn(this.turn, cols, { live: true, separator: sep, now });
      const budget = Math.max(4, rows - chrome - 2);
      const finished = !!(this.turn.done || this.turn.error || this.turn.interrupted);
      if (finished) {
        // commit the remainder and move the turn into history (without re-committing what's there)
        this.screen.commit(all.slice(this.turnCommitted));
        this.history.push({ kind: 'turn', turn: this.turn });
        this.turn = null;
        this.turnCommitted = 0;
        this.flushDeferred();
      } else {
        // long replies flow into native scrollback as they grow
        const overflow = all.length - this.turnCommitted - budget;
        if (overflow > 0) {
          this.screen.commit(all.slice(this.turnCommitted, this.turnCommitted + overflow));
          this.turnCommitted += overflow;
        }
        turnLines = all.slice(this.turnCommitted);
      }
    }
    // keep one quiet row between the last block (sign-off, notice) and the perched cat
    const gap = turnLines.length || !this.screen.lastBlank ? [''] : [];
    const pre = [...turnLines, ...gap, ...above];
    const lines = [...pre, ...box.lines, status, ...(usage ? [usage] : []), ...below];
    this.screen.render({ lines, cursor: this.approval ? undefined : { row: pre.length + box.cursor.row, col: box.cursor.col } });
  }

  /** Print queued notices (inbox, goal reached) once no turn is streaming. */
  private flushDeferred() {
    if (this.turn || !this.deferred.length) return;
    const batch = this.deferred.splice(0);
    for (const lines of batch) {
      const gap = this.screen.lastBlank ? [] : [''];
      const fixed = [...gap, ...lines];
      this.history.push({ kind: 'lines', render: () => fixed });
      this.screen.commit(fixed);
    }
  }
  private printSoon(lines: string[]) {
    this.deferred.push(lines);
    if (!this.turn) {
      this.flushDeferred();
      this.render();
    }
  }

  approvalLines(cols: number): string[] {
    return approvalBox(this.approval!, cols);
  }

  overlayLines(cols: number): string[] {
    return overlayPanel(this.overlay!, cols);
  }

  // ------------------------------------------------------------ overlays
  private commands(): Command[] {
    const skills: Command[] = this.skills
      .filter((s) => !BUILTINS.some((b) => b.name === s.name))
      .map((s) => ({ name: s.name, desc: s.description || 'skill', local: false, skill: true }));
    return [...BUILTINS.filter((c) => !c.alias), ...skills];
  }

  private updateOverlay() {
    const v = this.ed.value;
    if (/^\/[^\s]*$/.test(v) && this.ed.lines.length === 1) {
      const q = v.slice(1);
      const items = fuzzyFilter(this.commands(), q, (c) => c.name).map((c) => ({
        label: '/' + c.name + (c.args ? ' ' + c.args : ''),
        hint: (c.skill ? 'skill · ' : '') + c.desc,
        value: c.name,
      }));
      const prevIdx = this.overlay?.kind === 'palette' ? this.overlay.idx : 0;
      this.overlay = { kind: 'palette', items, idx: Math.min(prevIdx, Math.max(0, items.length - 1)), query: q };
      return;
    }
    // @path is handled by tab completion (ghost text + candidate row), not a panel
    this.overlay = null;
  }

  /** Accept the highlighted overlay item. Returns true if the key was consumed. */
  private acceptOverlay(viaEnter: boolean): boolean {
    const o = this.overlay;
    if (!o || !o.items.length) return false;
    const it = o.items[o.idx];
    if (o.kind === 'files') {
      this.ed.replaceTokenBeforeCursor('@' + it.value.replace(/ /g, '\\ ') + ' ');
      this.overlay = null;
      return true;
    }
    const cmd = this.commands().find((c) => c.name === it.value)!;
    if (viaEnter && (!cmd.args || cmd.args.startsWith('['))) {
      this.ed.clear();
      this.overlay = null;
      void this.submit('/' + cmd.name);
      return true;
    }
    this.ed.value = '/' + cmd.name + ' ';
    this.overlay = null;
    return true;
  }

  // ------------------------------------------------------------ keys
  private toggleExpand() {
    if (this.turn) {
      this.turn.expanded = !this.turn.expanded;
      return this.render();
    }
    const last = [...this.history].reverse().find((x) => x.kind === 'turn') as { kind: 'turn'; turn: Turn } | undefined;
    if (!last) return this.flash('nothing to expand');
    last.turn.expanded = !last.turn.expanded;
    this.redraw();
  }

  private onKey(k: Key) {
    if (this.modalOpen) return;
    this.mood.lastActivity = Date.now();
    if (k.ch || k.name === 'backspace' || k.name === 'paste') this.mood.lastType = Date.now();
    if (k.ctrl && k.name === 'c') {
      const now = Date.now();
      if (now - this.ctrlCAt < 1500) return this.quit();
      this.ctrlCAt = now;
      if (this.streaming) {
        void this.stop();
        this.flash('stopped · ctrl+c again to quit', 1500);
      } else if (!this.ed.empty) {
        this.ed.clear();
        this.overlay = null;
        this.flash('cleared · ctrl+c again to quit', 1500);
      } else this.flash('ctrl+c again to quit', 1500);
      return;
    }
    if (k.ctrl && k.name === 'd' && this.ed.empty) return this.quit();
    if (this.approval) {
      if (k.name === 'y' || k.name === 'n' || k.name === 'a' || k.name === 'escape') void this.answerApproval(k.name);
      return;
    }
    if (k.name === 'tab' && k.shift) {
      this.effort = nextEffort(this.effort, 1, this.efforts);
      this.draw(); // recolor the rule + › immediately
      return;
    }
    if (k.ctrl && k.name === 'o') {
      // with a goal pinned and nothing live to expand, ctrl+o opens the goal checklist
      if (this.goalState && this.goalState.status !== 'cleared' && (this.goalExpanded || !this.turn)) {
        this.goalExpanded = !this.goalExpanded;
        return this.render();
      }
      return this.toggleExpand();
    }
    if (k.ctrl && k.name === 'l') return this.redraw();
    if (k.name === 'escape') {
      if (this.overlay) this.overlay = null;
      else if (this.comp && this.comp.items.length > 1 && !this.busy) {
        this.comp = null;
        this.compCycle = null;
        this.compSuppressed = true;
      } else if (this.busy) void this.stop();
      else if (this.goalExpanded) this.goalExpanded = false;
      else if (this.planWaiting) {
        this.planWaiting = false;
        this.flash('plan dismissed', 1200);
      }
      return this.render();
    }
    // a plan waiting for approval: enter = go, e = edit (prefill), only while the input is empty
    if (this.planWaiting && this.ed.empty && !this.busy && !this.overlay) {
      if (k.name === 'enter' && !isNewline(k)) {
        this.planWaiting = false;
        void this.submit('go');
        return this.render();
      }
      if (k.ch === 'e') {
        this.planWaiting = false;
        this.ed.value = 'change the plan: ';
        return this.render();
      }
    }
    // quick model cycle (ctrl+p is only 'up' inside the palette)
    if (k.ctrl && k.name === 'p' && !this.overlay) return void this.cycleModel(1);
    if (this.overlay && this.overlay.items.length) {
      const o = this.overlay;
      if (k.name === 'up' || (k.ctrl && k.name === 'p')) {
        o.idx = (o.idx - 1 + o.items.length) % o.items.length;
        return this.render();
      }
      if (k.name === 'down' || (k.ctrl && k.name === 'n')) {
        o.idx = (o.idx + 1) % o.items.length;
        return this.render();
      }
      if (k.name === 'tab' || (k.name === 'enter' && !isNewline(k)) || (k.name === 'right' && this.ghost())) {
        if (this.acceptOverlay(k.name === 'enter')) {
          this.updateOverlay();
          this.refreshCompletion();
          return this.render();
        }
      }
    }
    // tab completion: accept ghost / cycle candidates
    if (k.name === 'tab' && !k.shift) {
      if (this.tabComplete()) return this.render();
    } else if (k.name === 'right' && !k.ctrl && !k.alt && this.ghost() && this.comp) {
      this.acceptCompletion(this.compIdx);
      return this.render();
    }
    if (k.name !== 'tab') this.compCycle = null;
    const ed = this.ed;
    if (k.name === 'paste' && k.paste != null) ed.insert(k.paste);
    else if (k.name === 'enter') {
      // busy + alt/option+enter: stop the current turn and send this as a new message
      if (k.alt && this.busy && !ed.empty) {
        const v = ed.value;
        ed.pushHistory(v);
        ed.clear();
        void this.interruptWith(v);
        return this.render();
      }
      if (isNewline(k)) ed.newline();
      else if (ed.lines[ed.row][ed.col - 1] === '\\' && ed.col === ed.lines[ed.row].length) {
        ed.backspace();
        ed.newline();
      } else {
        const v = ed.value;
        if (!v.trim()) return;
        ed.pushHistory(v);
        ed.clear();
        this.overlay = null;
        this.comp = null;
        this.compSuppressed = false;
        if (this.busy && !v.trim().startsWith('/')) {
          if (v.trim().startsWith('!')) void this.interruptWith(v.trim().slice(1).trim());
          else void this.steer(v.trim());
          return this.render();
        }
        void this.submit(v);
        return this.render();
      }
    } else if (k.name === 'backspace') {
      if (k.ctrl || k.alt) ed.deleteWord();
      else ed.backspace();
    } else if (k.name === 'delete') ed.del();
    else if (k.name === 'left') k.ctrl || k.alt ? ed.wordLeft() : ed.left();
    else if (k.name === 'right') k.ctrl || k.alt ? ed.wordRight() : ed.right();
    else if (k.name === 'up') {
      if (!ed.up()) ed.historyPrev();
    } else if (k.name === 'down') {
      if (!ed.down()) ed.historyNext();
    } else if (k.name === 'home' || (k.ctrl && k.name === 'a')) ed.home();
    else if (k.name === 'end' || (k.ctrl && k.name === 'e')) ed.end();
    else if (k.ctrl && k.name === 'u') ed.killToStart();
    else if (k.ctrl && k.name === 'k') ed.killToEnd();
    else if (k.ctrl && k.name === 'w') ed.deleteWord();
    else if (k.alt && k.name === 'b') ed.wordLeft();
    else if (k.alt && k.name === 'f') ed.wordRight();
    else if (k.name === 'tab') {
      if (!ed.empty) ed.insert('  ');
      else return;
    }
    else if (k.ch && !k.ctrl) {
      if (k.ch === '?' && ed.empty && !this.streaming) {
        this.printFlow((c) => ['', ...helpLines(c, []), '']);
        return;
      }
      ed.insert(k.ch);
    } else return;
    if (k.name !== 'tab') this.compSuppressed = this.compSuppressed && k.name !== 'backspace' && !k.ch;
    this.updateOverlay();
    this.refreshCompletion();
    this.render();
  }

  // ------------------------------------------------------------ completion
  completionSources(): Sources {
    return {
      commands: [...BUILTINS, ...this.commands().filter((c) => c.skill)],
      models: this.modelList.map((m) => ({ id: m.id, name: m.name })),
      themes: [...ACCENTS.map((a) => a.name), ...SPINNERS.map((s) => s.name)],
      cronIds: this.cronCache,
      sessions: this.sessionCache,
      efforts: this.efforts.map((e) => (e === 'medium' ? 'medium' : e)),
      verbosity: VERBOSITY_WORDS,
      cwd: this.cwd,
      files: this.ed.tokenBeforeCursor().startsWith('@') ? listFiles(this.cwd) : undefined,
    };
  }

  /** Recompute candidates for the token before the cursor (palette handles bare '/cmd'). */
  refreshCompletion() {
    const ed = this.ed;
    if (this.compSuppressed || ed.lines.length > 1 || ed.col !== ed.lines[ed.row].length) {
      this.comp = null;
      return;
    }
    const before = ed.value;
    if (!before || this.overlay?.kind === 'palette') {
      this.comp = null;
      return;
    }
    const c = complete(before, this.completionSources());
    if (c && before.startsWith('/') && c.start > 0) this.warmArgSources(before);
    // the '@' file overlay already lists matches: keep completion for ghost text only
    this.comp = c && c.items.length ? c : null;
    this.compIdx = 0;
  }

  private warmed = new Set<string>();
  /** Lazily fetch completion data the first time an argument is completed. */
  private warmArgSources(before: string) {
    const cmd = before.slice(1).split(/\s+/)[0];
    const key = cmd === 'cron' ? 'cron' : cmd === 'resume' ? 'resume' : cmd === 'model' ? 'model' : '';
    if (!key || this.warmed.has(key)) return;
    this.warmed.add(key);
    const done = () => {
      this.refreshCompletion();
      this.render();
    };
    if (key === 'cron') void this.api.checkins().then((l: CronJob[]) => ((this.cronCache = l.map((j) => ({ id: j.id, title: j.title }))), done())).catch(() => {});
    if (key === 'resume') void this.api.sessions().then((l) => ((this.sessionCache = l.map((x) => ({ id: x.id, title: x.title }))), done())).catch(() => {});
    if (key === 'model' && !this.modelList.length) void this.api.models().then((m) => ((this.modelList = m.models as ModelEntry[]), done())).catch(() => {});
  }

  /** Tab: accept the ghost (single/prefix match) or cycle through candidates. */
  private tabComplete(): boolean {
    const ed = this.ed;
    if (this.compCycle && this.comp) {
      // repeated Tab cycles: restore the original token and apply the next candidate
      this.compIdx = (this.compIdx + 1) % this.comp.items.length;
      const before = this.comp.token;
      ed.value = this.compCycle.applied.slice(0, this.comp.start) + before;
      const nv = applyCandidate(ed.value, this.comp, this.comp.items[this.compIdx]);
      ed.value = nv;
      this.compCycle = { applied: nv };
      return true;
    }
    if (!this.comp) {
      this.compSuppressed = false;
      this.refreshCompletion();
    }
    const c = this.comp;
    if (!c || !c.items.length) return false;
    if (c.items.length === 1) {
      this.acceptCompletion(0);
      return true;
    }
    // several: extend to the longest common prefix first, else start cycling
    const lcp = commonPrefix(c.items.map((i) => i.value));
    if (lcp.length > c.token.length && lcp.toLowerCase().startsWith(c.token.toLowerCase())) {
      ed.value = ed.value.slice(0, c.start) + lcp;
      this.refreshCompletion();
      return true;
    }
    const nv = applyCandidate(ed.value, c, c.items[0]);
    ed.value = nv;
    this.compIdx = 0;
    this.compCycle = { applied: nv };
    return true;
  }

  private acceptCompletion(idx: number) {
    const c = this.comp;
    if (!c) return;
    const cand = c.items[idx];
    this.ed.value = applyCandidate(this.ed.value, c, cand);
    this.compCycle = null;
    this.comp = null;
    this.updateOverlay();
    this.refreshCompletion();
  }

  // ------------------------------------------------------------ actions
  private async withModal<T>(fn: () => Promise<T>): Promise<T | undefined> {
    this.modalOpen = true;
    try {
      return await fn();
    } catch (e: any) {
      if (e?.message !== 'cancelled') this.screen.commit([t.err('  ' + (e?.message || e))]);
      return undefined;
    } finally {
      this.modalOpen = false;
      this.render();
    }
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const s = await this.api.newSession(this.cwd);
    this.sessionId = s.id;
    this.sessionTitle = s.title || '';
    this.listenEvents();
    this.listenStream();
    return s.id;
  }

  /**
   * GET /api/sessions/{id}/stream: turns the engine starts in this session (loop ticks, cron runs) arrive
   * here with the same events as a message stream. Our own turns are already rendered from the POST
   * stream, so while we're streaming the relay is ignored.
   */
  private streamFor: string | null = null;
  private listenStream() {
    if (!this.sessionId || this.streamFor === this.sessionId) return;
    this.streamCtl?.abort();
    const ctl = new AbortController();
    this.streamCtl = ctl;
    this.streamFor = this.sessionId;
    const sid = this.sessionId;
    const relay = (ev: string, d: any) => {
      if (this.streaming || sid !== this.sessionId) return; // our own turn: POST stream renders it
      if (ev === 'user' || ev === 'turn_start' || ev === 'message') {
        const loopN = d?.meta?.loop?.n ?? d?.loop?.n ?? (typeof d?.meta?.loop === 'number' ? d.meta.loop : undefined);
        const cron = d?.meta?.cron || d?.cron;
        if (ev === 'message' && d?.role && d.role !== 'user') return;
        this.startBgTurn(String(d?.text ?? d?.content ?? ''), loopN != null ? `loop #${loopN}` : cron ? `cron ${G().sep} ${cron.title || cron.id || ''}` : undefined);
        return;
      }
      if (!this.turn && ['delta', 'reasoning', 'tool_start', 'plan'].includes(ev) && !this.bgIgnore) this.startBgTurn('', this.loop?.active ? `loop #${(this.loop.runs ?? 0) || '?'}` : undefined);
      if (ev === 'done' || ev === 'error') {
        if (this.bgTurn && this.turn) {
          applyEvent(this.turn, ev, d);
          if (d?.tps) this.tps = d.tps;
          if (ev === 'done') this.applyContext(d?.context, d?.usage);
        }
        if (ev === 'done') this.onDoneUsage(d);
        this.bgTurn = false;
        this.bgIgnore = false;
        this.render();
        void this.refreshSession();
        void this.refreshLoop();
        this.drainSteers();
        return;
      }
      if (ev === 'goal') return this.onGoal(d);
      if (ev === 'loop') return this.onLoop(d);
      if (ev === 'todo') {
        this.todos = Array.isArray(d?.todos) ? d.todos : [];
        return this.render();
      }
      if (this.bgTurn && this.turn && !this.bgIgnore && applyEvent(this.turn, ev, d)) this.render();
    };
    const go = async (attempt: number) => {
      if (ctl.signal.aborted || this.closed) return;
      try {
        await this.api.sessionStream(sid, { '*': (d) => relay(d.__event, d) }, ctl.signal);
        attempt = 0;
      } catch (e: any) {
        if (ctl.signal.aborted || (e?.status && e.status >= 400 && e.status < 500)) return; // route missing: quietly off
      }
      if (attempt < 30) setTimeout(() => go(attempt + 1), Math.min(30000, 800 * 2 ** Math.min(attempt, 5)));
    };
    void go(0);
  }

  private startBgTurn(text: string, header?: string) {
    if (this.turn && !this.turn.done) return;
    this.turn = newTurn(header ? '' : text, [], this.effort);
    if (header) this.turn.header = header;
    this.turnCommitted = 0;
    this.bgTurn = true;
    this.bgIgnore = false;
    this.render();
  }

  /** GET /api/events without a session filter: inbox items + loop state from anywhere. */
  private listenGlobal() {
    this.globalCtl?.abort();
    const ctl = new AbortController();
    this.globalCtl = ctl;
    const go = async (attempt: number) => {
      if (ctl.signal.aborted || this.closed) return;
      try {
        await this.api.events(null, { inbox: (d) => this.onInbox(d), loop: (d) => this.onLoop(d), '*': () => {} }, ctl.signal);
      } catch (e: any) {
        if (ctl.signal.aborted || (e?.status && e.status >= 400 && e.status < 500)) return;
      }
      if (attempt < 20) setTimeout(() => go(attempt + 1), Math.min(30000, 1000 * 2 ** attempt));
    };
    void go(0);
  }

  // ------------------------------------------------------------ inbox / loop / goal state
  private seenInbox = new Set<string>();
  onInbox(d: any) {
    const it: InboxItem = d?.item ?? d;
    if (!it) return;
    const key = it.id || `${it.title}:${inboxText(it).slice(0, 40)}`;
    if (this.seenInbox.has(key)) return;
    this.seenInbox.add(key);
    this.inbox.unshift(it);
    this.inboxUnseen++;
    this.printSoon(['  ' + inboxLine(it, this.term.cols - 4)]);
  }

  onLoop(d: any) {
    if (!d) return;
    if (d.session_id && this.sessionId && d.session_id !== this.sessionId) return;
    const prev = this.loop || { active: false };
    const st = d.state;
    const active = d.active ?? !(st === 'stopped' || st === 'done');
    this.loop = {
      ...prev,
      ...d,
      active,
      runs: d.runs ?? d.n ?? prev.runs,
      state: st ?? prev.state,
    };
    if (!active && prev.active) {
      const g = G();
      this.printSoon(['  ' + t.faint((isAsciiMode() ? '@' : '↻') + ' ') + t.dim(`loop ${st === 'done' ? 'finished' : 'stopped'} after ${this.loop!.runs ?? 0} run${this.loop!.runs === 1 ? '' : 's'}`) + (st === 'done' ? ' ' + t.ok(g.check) : '')]);
    }
    this.render();
  }

  async refreshLoop() {
    if (!this.sessionId) return;
    try {
      const l = await this.api.loop(this.sessionId);
      if (l && typeof l === 'object') {
        const was = this.loop?.active;
        this.loop = { ...l, active: !!l.active, state: l.active ? this.loop?.state ?? 'waiting' : 'stopped' };
        if (!was && l.active) this.listenStream();
      }
      this.render();
    } catch {}
  }

  private async stopLoop(): Promise<void> {
    try {
      await this.api.stopLoop(this.sessionId!);
      this.onLoop({ active: false, state: 'stopped' });
    } catch (e: any) {
      if (e?.status === 404 || e?.status === 405) {
        // old engine: let it handle '/loop stop' as chat text
        return this.submitRaw('/loop stop');
      }
      this.flash(`/loop stop: ${e?.message || e}`);
    }
  }
  private submitRaw(text: string): Promise<void> {
    this.loop = null;
    return this.submit(text + ' ');
  }

  /** goal event / goal_state: banner state; celebrates once on 'done'. */
  onGoal(d: any, fromSession = false) {
    const gs = normalizeGoal(d);
    if (!gs || gs.status === 'cleared') {
      if (this.goalState) this.goalState = null;
      this.goalExpanded = false;
      this.goal = '';
      return this.render();
    }
    const was = this.goalState?.status;
    this.goalState = gs;
    this.goal = gs.text;
    if (gs.status === 'done' && was !== 'done' && !(fromSession && !was)) {
      this.goalReachedAt = Date.now();
      this.mood.lastEnd = { at: Date.now() + 900, ok: true };
      this.printSoon(['  ' + catSign('done') + ' ' + t.ok('goal reached') + t.faint(`  ${G().sep} `) + t.dim(truncate(gs.text, this.term.cols - 30))]);
    } else if (gs.status === 'done' && fromSession && !was) this.goalReachedAt = 1; // already done on resume: no banner
    this.render();
  }

  private clearGoalLocal() {
    this.goalState = null;
    this.goalExpanded = false;
    this.goal = '';
    this.render();
  }

  private async showGoal() {
    if (!this.goalState && this.sessionId) await this.refreshSession();
    if (!this.goalState || this.goalState.status === 'cleared') return this.flash('no goal set · /goal <what you want done>', 2200);
    this.goalExpanded = !this.goalExpanded;
    this.render();
  }

  /** GET /api/events?session_id=… for async notices (memory/skill) + compaction. Silent if unsupported. */
  private listenEvents() {
    if (!this.sessionId || this.eventsFor === this.sessionId) return;
    this.eventsCtl?.abort();
    const ctl = new AbortController();
    this.eventsCtl = ctl;
    this.eventsFor = this.sessionId;
    const sid = this.sessionId;
    const loop = async (attempt: number) => {
      if (ctl.signal.aborted || this.closed) return;
      try {
        await this.api.events(sid, {
          notice: (d) => this.onNotice(d, d?.session_id),
          compacted: (d) => this.onCompacted(d, d?.session_id),
          '*': () => {},
        }, ctl.signal);
      } catch (e: any) {
        if (ctl.signal.aborted || (e?.status && e.status >= 400 && e.status < 500)) return; // endpoint missing: give up quietly
      }
      if (attempt < 20) setTimeout(() => loop(attempt + 1), Math.min(30000, 1000 * 2 ** attempt));
    };
    void loop(0);
  }

  private seenNotices = new Set<string>();
  private onNotice(d: any, sid?: string) {
    if (!d?.text) return;
    if (sid && this.sessionId && sid !== this.sessionId) return;
    const key = `${d.kind}:${d.text}`;
    if (this.seenNotices.has(key)) return; // same notice may arrive via the turn stream and /api/events
    this.seenNotices.add(key);
    if (d.kind === 'memory' || d.kind === 'skill' || d.kind === 'profile') void this.refreshProfile();
    if (this.turn && !this.turn.done) applyEvent(this.turn, 'notice', d);
    else {
      const line = '  ' + noticeLine(d.kind || 'memory', String(d.text));
      this.printFlow(() => (this.screen.lastBlank ? [line] : ['', line]));
    }
    this.render();
  }

  private onCompacted(d: any, sid?: string) {
    if (sid && this.sessionId && sid !== this.sessionId) return;
    const before = +d?.before || this.ctx.used;
    const after = +d?.after || 0;
    this.ctx.compact = { before, after, at: Date.now() };
    this.ctx.used = after;
    if (d?.auto) {
      const keep = d.kept ?? d.keep_recent ?? this.config?.compaction?.keep_recent;
      const text = `auto-compacted${keep ? ` (kept last ${keep})` : ''}`;
      if (this.turn && !this.turn.done) applyEvent(this.turn, 'compact_note', { text });
      else this.printSoon(['  ' + t.faint(G().compact + ' ') + t.dim(text)]);
    }
    this.render();
  }

  private applyContext(c?: Partial<ContextInfo> | null, usage?: any) {
    if (c && typeof c === 'object') {
      // an unmeasured session (used 0) only carries the engine's default max: keep the model's real one
      const max = (c as any).max_effective || c.max;
      if (max && (c.used || !this.ctx.max || (c as any).max_effective)) this.ctx.max = max;
      if (c.used != null) this.ctx.used = c.used;
      if (c.cached != null) this.ctx.cached = c.cached;
    } else if (usage) {
      this.ctx.used = usage.last_input ?? (usage.input || 0) + (usage.output || 0);
    }
  }

  async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.startsWith('/')) {
      const name = trimmed.slice(1).split(/\s+/)[0];
      const arg = trimmed.slice(1 + name.length).trim();
      const cmd = BUILTINS.find((c) => c.name === name);
      // a few engine commands get a richer local UI when typed bare
      if (name === 'goal' && !arg) return this.showGoal();
      if (name === 'goal' && arg === 'clear') this.clearGoalLocal();
      if (name === 'cron' && !arg) return this.cronPanel();
      if (name === 'usage' && !arg) return this.showUsage();
      if (name === 'loop' && arg === 'stop' && this.sessionId && !this.streaming) return this.stopLoop();
      if (name === 'model' && arg) return this.switchModel(arg);
      if (cmd?.local) return this.localCommand(name, arg);
      if (name === 'goal' && arg && arg !== 'clear') {
        this.goal = arg;
        this.goalState = { text: arg, status: 'active', progress: null, todos: [] };
        this.goalReachedAt = 0;
      }
      if (name === 'plan' || name === 'plan!') this.planWaiting = false;
      if (name === 'yolo' && !this.streaming) {
        // badge + cat flip right away; the engine's done.yolo confirms it
        this.yolo = arg === 'on' ? true : arg === 'off' ? false : !this.yolo;
        this.render();
      }
    }
    if (this.streaming) {
      this.flash('still working — esc to stop first');
      this.ed.value = text;
      return;
    }
    if (this.bgTurn) {
      // a loop / cron turn is running: steer it instead
      return this.steer(text.trim());
    }
    this.planWaiting = false;
    const { attachments, names, skipped } = collectMentions(text, this.cwd);
    if (skipped.length) this.screen.commit([t.warn('  skipped ' + skipped.join(', '))]);
    this.turn = newTurn(text, names, this.effort);
    this.turnCommitted = 0;
    const ctl = new AbortController();
    this.streaming = ctl;
    this.render();
    const ap = (ev: string) => (d: any) => {
      if (this.turn && applyEvent(this.turn, ev, d)) this.render();
    };
    try {
      const sid = await this.ensureSession();
      await this.api.send(
        sid,
        { text, effort: this.effort, ...(this.opts.harness ? { harness: this.opts.harness } : {}), ...(attachments.length ? { attachments } : {}) } as any,
        {
          '*': (d) => ap(d.__event)(d),
          delta: ap('delta'),
          reasoning: ap('reasoning'),
          tool_start: ap('tool_start'),
          tool_progress: ap('tool_progress'),
          tool_end: ap('tool_end'),
          subagent_start: ap('subagent_start'),
          subagent_progress: ap('subagent_progress'),
          subagent_end: ap('subagent_end'),
          notice: (d) => this.onNotice(d),
          compacted: (d) => this.onCompacted(d),
          todo: (d) => {
            this.todos = Array.isArray(d?.todos) ? d.todos : [];
            this.render();
          },
          goal: (d) => this.onGoal(d),
          plan: ap('plan'),
          steer: ap('steer'),
          loop: (d) => this.onLoop(d),
          approval: (d) => {
            if (this.turn) applyEvent(this.turn, 'pause', d);
            this.approval = { id: String(d.id), command: d.command ?? '', reason: d.reason };
            this.term.write('\x07');
            this.render();
          },
          done: (d) => {
            if (!this.turn) return;
            applyEvent(this.turn, 'done', d);
            if (d?.tps) this.tps = d.tps;
            if (typeof d?.yolo === 'boolean') this.yolo = d.yolo;
            if (d?.model) this.noteModel(String(d.model));
            if (d?.goal !== undefined && typeof d.goal === 'object') this.onGoal(d.goal);
            if (d?.usage_report && /^\/usage\b/.test(text.trim())) this.deferred.push(usageCard(typeof d.usage_report === 'string' ? JSON.parse(d.usage_report) : d.usage_report, this.term.cols));
            if (d?.plan_waiting || d?.awaiting === 'go' || (/^\/plan\s/.test(text.trim()) && this.turn.parts.some((p) => p.kind === 'plan'))) this.planWaiting = true;
            if (d?.loop) this.onLoop(d.loop);
            this.applyContext(d?.context, d?.usage);
            this.onDoneUsage(d);
            if (typeof d?.compacted === 'number' && d.compacted > 0 && !this.ctx.compact) this.onCompacted({ before: d.compacted, after: this.ctx.used });
            this.render();
          },
          error: ap('error'),
        },
        ctl.signal,
      );
      if (this.turn && !this.turn.done && !this.turn.error) {
        if (ctl.signal.aborted) this.turn.interrupted = true;
        else this.turn.done = {};
      }
    } catch (e: any) {
      if (this.turn) {
        if (ctl.signal.aborted || e?.name === 'AbortError') this.turn.interrupted = true;
        else this.turn.error = e?.message || String(e);
      }
    } finally {
      this.streaming = null;
      this.approval = null;
      this.render();
    }
    void this.refreshSession();
    if (/^\/loop\b/.test(trimmed)) void this.refreshLoop();
    this.drainSteers();
  }

  // ------------------------------------------------------------ steer
  /** Enter while busy: POST steer; show '↳ steer: …' at once, accent ✓ when the engine applies it. */
  async steer(text: string) {
    if (!text) return;
    const turn = this.turn;
    if (turn) applyEvent(turn, 'steer_local', { text, state: 'pending' });
    this.render();
    if (!this.sessionId) return this.queueSteer(text, turn);
    try {
      const r = await this.api.steer(this.sessionId, text);
      if (r?.mode === 'queued') this.markSteer(turn, text, 'queued');
    } catch (e: any) {
      // 409: no turn running any more (or the route is missing): send it as the next message
      this.queueSteer(text, turn, e?.status === 404 || e?.status === 405 ? 'steer not supported by this engine — queued' : '');
    }
  }
  private markSteer(turn: Turn | null, text: string, state: 'queued' | 'applied') {
    const p = turn?.parts.find((x) => x.kind === 'steer' && x.text === text && x.state === 'pending') as { state: string } | undefined;
    if (p) p.state = state;
    this.render();
  }
  private queueSteer(text: string, turn: Turn | null, note = '') {
    this.steerQueue.push(text);
    this.markSteer(turn, text, 'queued');
    if (note) this.flash(note, 1800);
    if (!this.busy) this.drainSteers();
  }
  /** After a turn: send queued steers as one normal message. */
  private drainSteers() {
    if (this.busy || !this.steerQueue.length) return;
    const text = this.steerQueue.splice(0).join('\n');
    setTimeout(() => void this.submit(text), 0);
  }
  /** '!text' / alt+enter while busy: stop the running turn, then send as a new message. */
  async interruptWith(text: string) {
    if (!text) return;
    this.steerQueue = [];
    if (this.streaming) {
      const ctl = this.streaming;
      await this.stop();
      const t0 = Date.now();
      while (this.streaming === ctl && Date.now() - t0 < 2500) await new Promise((r) => setTimeout(r, 40));
    } else if (this.bgTurn) await this.stop();
    void this.submit(text);
  }

  private async refreshSession() {
    if (!this.sessionId) return;
    try {
      const s = await this.api.session(this.sessionId);
      this.sessionTitle = s.title || this.sessionTitle;
      if (s.goal !== undefined) this.goal = s.goal || '';
      if ((s as any).goal_state !== undefined) this.onGoal((s as any).goal_state, true);
      else if (s.goal !== undefined && !this.goalState && s.goal) this.goalState = normalizeGoal(s.goal);
      else if (s.goal === '' && this.goalState?.status === 'active') this.goalState = null;
      if (typeof (s as any).yolo === 'boolean') this.yolo = (s as any).yolo;
      if (Array.isArray(s.todos) && s.todos.length) this.todos = s.todos;
      if (this.todos.length && this.todos.every((x) => x.done)) this.todos = [];
      if (s.context) this.applyContext(s.context);
      this.render();
    } catch {}
  }

  async stop() {
    const ctl = this.streaming;
    if (!ctl && this.bgTurn) {
      // esc during a loop/cron turn stops that turn only (the loop keeps its schedule)
      if (this.turn) this.turn.interrupted = true;
      try {
        if (this.sessionId) await this.api.stop(this.sessionId);
      } catch {}
      this.bgTurn = false;
      this.bgIgnore = true;
      return this.render();
    }
    if (!ctl) return;
    if (this.turn) this.turn.interrupted = true;
    try {
      if (this.sessionId) await this.api.stop(this.sessionId);
    } catch {}
    setTimeout(() => {
      if (this.streaming === ctl) ctl.abort();
    }, 800);
    this.render();
  }

  private async answerApproval(key: string) {
    const a = this.approval;
    if (!a || !this.sessionId) return;
    const g = G();
    const allow = key === 'y' || key === 'a';
    const always = key === 'a';
    this.approval = null;
    // the decision lands inside the live turn block so it reads in order
    if (this.turn) applyEvent(this.turn, 'gate', { gate: !allow ? 'denied' : always ? 'always' : 'allowed', command: truncate(a.command, this.term.cols - 24) });
    else this.screen.commit(['  ' + (allow ? t.ok(`${g.check} allowed`) : t.err(`${g.cross} denied`)) + ' ' + t.dim(truncate(a.command, this.term.cols - 24))]);
    this.render();
    try {
      await this.api.approve(this.sessionId, a.id, allow, always);
    } catch (e: any) {
      this.flash('approve failed: ' + e.message);
    }
  }

  private async undo() {
    const g = G();
    if (this.streaming) return this.flash('still working — esc to stop first');
    if (!this.sessionId) return this.flash('nothing to undo');
    const r = await this.api.undo(this.sessionId);
    if (!r?.ok) return this.print(['  ' + t.warn(`${g.undo} nothing to undo`) + (r?.note ? t.dim('  ' + r.note) : '')]);
    const list = (x: unknown) => (Array.isArray(x) ? x.map(String) : typeof x === 'number' && x ? [`${x} file${x === 1 ? '' : 's'}`] : []);
    const restored = list(r.restored);
    const deleted = list(r.deleted);
    const bits = [restored.length ? `restored ${restored.join(', ')}` : '', deleted.length ? `removed ${deleted.join(', ')}` : ''].filter(Boolean);
    // drop the last turn from scrollback state, repaint, then note what happened
    let idx = -1;
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i].kind === 'turn') { idx = i; break; }
    if (idx >= 0) this.history.splice(idx);
    const line = '  ' + t.accent(g.undo) + ' ' + fg(C.text)('undid last turn') + (bits.length ? t.dim(': ' + bits.join(', ')) : '') + (r.note && !bits.length ? t.dim(`  ${r.note}`) : '');
    this.history.push({ kind: 'lines', render: (cols) => ['', truncate(line, cols)] });
    this.redraw();
    void this.refreshSession();
  }

  private async resume(id?: string) {
    if (!id) {
      const list = await this.api.sessions();
      if (!list.length) return this.print([t.dim('  no sessions yet')]);
      const picked = await this.withModal(() =>
        select(
          this.term,
          this.screen,
          'Resume which session?',
          list.slice(0, 20).map((s) => ({ label: s.title || s.id, value: s.id, hint: `${relTime(s.updated)}${s.goal ? ' · ◎ ' + s.goal : ''}`, detail: s.preview ? [s.preview] : undefined })),
        ),
      );
      if (!picked) return;
      id = picked;
    }
    try {
      const s = await this.api.session(id);
      this.sessionId = s.id;
      this.sessionTitle = s.title || '';
      this.goal = s.goal || '';
      this.goalState = null;
      this.goalReachedAt = 0;
      this.onGoal((s as any).goal_state ?? (s.goal || null), true);
      this.todos = (s.todos || []).filter(() => true);
      if (this.todos.every((x) => x.done)) this.todos = [];
      if (s.cwd) this.cwd = s.cwd;
      if (typeof (s as any).yolo === 'boolean') this.yolo = (s as any).yolo;
      if (s.context) {
        this.applyContext(s.context);
        this.ctx.shown = this.ctx.used;
      }
      const turns = messagesToTurns(s.messages || []);
      const title = s.title || s.id;
      this.printFlow((cols) => ['', '  ' + t.faint(`${G().rule.repeat(2)} resumed: `) + t.muted(truncate(title, cols - 20)) + ' ' + t.faint(G().rule.repeat(2))]);
      for (const tr of turns.slice(-20)) this.push({ kind: 'turn', turn: tr });
      this.listenEvents();
      this.listenStream();
      void this.refreshLoop();
      this.render();
    } catch (e: any) {
      this.print([t.err(`  could not resume ${id}: ${e.message}`)]);
    }
  }

  // ------------------------------------------------------------ /model
  private async fetchModels(): Promise<{ active: string; models: ModelEntry[] } | null> {
    try {
      const m = await this.api.models();
      this.modelList = m.models as ModelEntry[];
      this.activeModelId = m.active;
      return { active: m.active, models: this.modelList };
    } catch (e: any) {
      this.print([t.dim(`  /model: ${e?.message || e}`)]);
      return null;
    }
  }

  /** done.model / switches: keep the status line + ctx max in sync with the engine's active model. */
  noteModel(id: string) {
    const mm = this.modelList.find((x) => x.id === id || x.name === id);
    if (mm) {
      this.activeModelId = mm.id;
      this.model = mm.name || mm.id;
    } else if (id && id !== this.activeModelId) {
      this.activeModelId = id;
      this.model = id;
    }
  }

  private applyModel(mm: ModelEntry) {
    this.activeModelId = mm.id;
    this.model = mm.name || mm.id;
    if (mm.ctx) this.ctx.max = mm.ctx;
    this.tps = mm.tps_measured || mm.tps || 0;
  }

  /** /model <id|name>: switch directly (fuzzy on id + name). */
  async switchModel(q: string) {
    const m = await this.fetchModels();
    if (!m) return;
    const exact = m.models.find((x) => x.id === q || (x.name || '').toLowerCase() === q.toLowerCase());
    const mm = exact ?? fuzzyFilter(m.models, q, (x) => x.id + ' ' + (x.name || ''))[0];
    if (!mm) return this.print([t.warn(`  no model matches “${q}”`) + t.faint('  /model to pick')]);
    if (mm.id === m.active) return this.flash(`already on ${mm.name || mm.id}`, 1500, 'ok');
    try {
      await this.api.setModel(mm.id);
      this.applyModel(mm);
      this.print(['  ' + t.ok(G().check) + ' ' + t.dim('model ') + fg(C.text)(mm.name || mm.id) + t.faint(`  ${providerLabelOf(mm)}`)]);
    } catch (e: any) {
      this.print([t.err(`  /model: ${e?.message || e}`)]);
    }
  }

  /** ctrl+p: next model in the list. */
  async cycleModel(dir: number) {
    if (this.busy) return this.flash('still working — esc to stop first', 1500);
    const m = this.modelList.length ? { active: this.activeModelId, models: this.modelList } : await this.fetchModels();
    if (!m || m.models.length < 2) return this.flash('only one model', 1200);
    const i = Math.max(0, m.models.findIndex((x) => x.id === m.active));
    const mm = m.models[(i + dir + m.models.length) % m.models.length];
    try {
      await this.api.setModel(mm.id);
      this.applyModel(mm);
      this.flash(`model ${mm.name || mm.id}`, 1400, 'ok');
    } catch (e: any) {
      this.flash(`model switch failed: ${e?.message || e}`);
    }
  }

  /** /model: grouped rounded-box picker + 'default effort' row; status line previews the highlighted model. */
  private async modelPicker() {
    const m = await this.fetchModels();
    if (!m) return;
    if (!m.models.length) return this.print([t.dim('  no models available')]);
    let defEffort: Effort = 'medium';
    try {
      const cfg = await this.api.config();
      defEffort = normalizeEffort(cfg.effort_default) ?? defEffort;
    } catch {}
    const startEffort = defEffort;
    const res = await this.withModal(() =>
      modelPicker(this.term, this.screen, m.models, m.active, this.efforts, defEffort, (id, eff) => {
        const mm = m.models.find((x) => x.id === id);
        this.previewModel = mm ? mm.name || mm.id : null;
        defEffort = eff;
        return this.statusLine(this.term.cols);
      }),
    );
    this.previewModel = null;
    if (!res) return this.render();
    const g = G();
    const out: string[] = [];
    if (res.effort !== startEffort) {
      try {
        await this.api.patchConfig({ effort_default: res.effort });
        out.push('  ' + t.ok(g.check) + ' ' + t.dim('new chats start at ') + effortPaint(res.effort)(`${g.dot} ${effortLabel(res.effort)}`));
      } catch (e: any) {
        out.push(t.err(`  default effort: ${e?.message || e}`));
      }
    }
    if (res.id !== m.active) {
      const mm = m.models.find((x) => x.id === res.id)!;
      try {
        await this.api.setModel(res.id);
        this.applyModel(mm);
        out.unshift('  ' + t.ok(g.check) + ' ' + t.dim('model ') + fg(C.text)(mm.name || mm.id) + t.faint(`  ${providerLabelOf(mm)}`));
      } catch (e: any) {
        out.unshift(t.err(`  /model: ${e?.message || e}`));
      }
    }
    if (out.length) this.print(out);
    else this.render();
  }

  // ------------------------------------------------------------ /cron
  private async cronPanel() {
    let jobs: CronJob[];
    try {
      jobs = await this.api.checkins();
    } catch (e: any) {
      if (e?.status === 404) return this.print([t.dim('  /cron needs a newer engine (no /api/checkins)')]);
      return this.print([t.err(`  /cron: ${e?.message || e}`)]);
    }
    this.cronCache = jobs.map((j) => ({ id: j.id, title: j.title }));
    const lines: string[] = [];
    await this.withModal(() =>
      cronPicker(this.term, this.screen, jobs, {
        refresh: async () => (jobs = await this.api.checkins()),
        run: async (j) => {
          await this.api.runCheckin(j.id);
          return `${G().check} started “${j.title || j.id}” · result lands in /inbox`;
        },
        toggle: async (j) => {
          await this.api.patchCheckin(j.id, { enabled: j.enabled === false });
          return `${j.enabled === false ? 'resumed' : 'paused'} “${j.title || j.id}”`;
        },
        remove: async (j) => {
          await this.api.deleteCheckin(j.id);
          lines.push('  ' + t.faint('✗ ') + t.dim(`deleted cron “${j.title || j.id}”`));
          return `deleted “${j.title || j.id}”`;
        },
        add: async (when, what) => {
          const j = await this.api.addCheckin({ prompt: what, schedule: parseSchedule(when), ...(this.sessionId ? { session_id: this.sessionId } : {}) });
          lines.push('  ' + t.ok(G().check) + ' ' + t.dim('cron ') + fg(C.text)(j?.title || what) + t.faint(`  ${j?.schedule_text || when}`));
          return `${G().check} added`;
        },
      }),
    );
    if (lines.length) this.print(lines);
    else this.render();
  }

  // ------------------------------------------------------------ /usage + /inbox
  private async showUsage(): Promise<void> {
    try {
      const u = await this.api.usage(30);
      this.printFlow((c) => ['', ...usageCard(u, c), '']);
    } catch (e: any) {
      if (e?.status === 404) {
        // older engine: it answers '/usage' as chat text
        this.print([t.dim('  usage report not available from this engine — asking it instead')]);
        return this.submit('/usage ');
      }
      this.print([t.err(`  /usage: ${e?.message || e}`)]);
    }
  }

  private async showInbox() {
    this.inboxUnseen = 0;
    let items = this.inbox;
    try {
      const r = await this.api.get<any>('/api/inbox');
      const list = Array.isArray(r) ? r : r?.items;
      if (Array.isArray(list) && list.length) items = list;
    } catch {}
    if (!items.length) return this.print([t.dim('  inbox is empty · cron results land here')]);
    const pick = await this.withModal(() =>
      select(
        this.term,
        this.screen,
        'Inbox',
        items.slice(0, 20).map((it, i) => ({ label: (it.title || 'check-in'), value: i, hint: (it.created ? relTime(it.created) + ' · ' : '') + inboxText(it).split('\n')[0], detail: inboxText(it).split('\n').slice(1, 4).filter(Boolean) })),
        { footer: '↑↓ move · enter open its session · esc close' },
      ),
    );
    if (pick == null) return this.render();
    const it = items[pick];
    if (it.session_id) return this.resume(it.session_id);
    this.print(['', '  ' + inboxLine(it, this.term.cols - 4), ...inboxText(it).split('\n').slice(1).map((l) => '    ' + t.dim(l)), '']);
  }

  // ------------------------------------------------------------ /agents
  private async agentsSettings() {
    let cfg: SubagentSettings = { ...DEFAULT_SUBAGENTS };
    try {
      cfg = normalizeSubagents((await this.api.config()).subagents);
    } catch {}
    let models: { id: string; name: string }[] = [];
    try {
      models = (await this.api.models()).models.map((m) => ({ id: m.id, name: m.name || m.id }));
    } catch {}
    const saved = await this.withModal(() => agentsPicker(this.term, this.screen, cfg, models, this.model));
    if (!saved) return this.render();
    try {
      await this.api.patchConfig({ subagents: saved });
      const g = G();
      const mname = saved.model ? models.find((m) => m.id === saved.model)?.name ?? saved.model : 'same as main';
      this.print([
        '  ' + t.ok(g.check) + ' ' + fg(C.text)('subagents ') + (saved.enabled ? t.accent('on') : t.dim('off')) +
          t.dim(saved.enabled ? ` ${g.sep} ${saved.max_parallel} parallel ${g.sep} ${mname} ${g.sep} ${saved.effort} ${g.sep} ${fmtBudget(saved.max_seconds)}` : ''),
      ]);
    } catch (e: any) {
      this.print([t.err(`  /agents: ${e?.message || e}`)]);
    }
  }

  // ------------------------------------------------------------ /settings
  /** Build the panel state from what we know; slow fetches fill in while it's open. */
  settingsState(tab = 0, row = 0): SettingsState {
    const m = this.modelList.find((x) => x.id === this.activeModelId);
    return {
      tab,
      row: { [tab]: row },
      cfg: this.config || {},
      prefs: { ...prefs() },
      efforts: this.efforts,
      usage: this.usageReport,
      limits: this.usageLimits,
      chatgpt: this.chatgpt,
      status: {
        version: this.opts.version,
        engineUrl: this.api.base,
        health: this.health,
        model: this.model,
        providerLabel: m ? providerLabel(m) : this.provider,
        provider: m?.provider || this.provider,
        harness: this.opts.harness || this.config?.harness,
        cwd: this.cwd,
        sessionId: this.sessionId,
        yolo: this.yolo,
        chatgptLoggedIn: null,
        ctx: { used: this.ctx.used, max: this.ctx.max, cached: this.ctx.cached },
        profile: this.profile,
      },
    };
  }

  async openSettings(tab = 0, row = 0) {
    const s = this.settingsState(tab, row);
    const before = { ...prefs() };
    // refresh in the background: health, config, usage, ChatGPT login, profile
    const api = this.api;
    void api.health().then((h) => (this.health = s.status.health = h), (e) => (s.status.healthError = e?.message || 'unreachable'));
    void api.config().then((c) => (this.config = s.cfg = c)).catch(() => {});
    void api.usage(30).then((u) => (this.usageReport = s.usage = u)).catch(() => {});
    void api.get<any>('/api/auth/openai/status', 4000).then((r) => (s.status.chatgptLoggedIn = !!r?.logged_in)).catch(() => {});
    void api.get<any>('/api/profile/context', 4000).then((p) => { const n = normProfile(p); if (n) this.profile = s.status.profile = n; }).catch(() => {});
    const done = await this.withModal(() =>
      settingsPanel(
        this.term,
        this.screen,
        s,
        {
          patchConfig: (body) => api.patchConfig(body),
          setPrefs: (p) => {
            applyPrefs(p);
            try {
              savePrefs(p);
            } catch {}
          },
        },
        (st) => this.settingsPreview(st),
      ),
    );
    if (done) {
      this.config = done.cfg;
      this.applyCompactionCfg();
      const def = normalizeEffort(done.cfg?.effort_default);
      if (def && !this.opts.effort && !this.sessionId) this.effort = def;
    }
    const p = prefs();
    const changed = JSON.stringify(before) !== JSON.stringify(p);
    if (changed) this.history.push({ kind: 'lines', render: () => ['', '  ' + t.ok(G().check) + ' ' + fg(C.text)('look & feel ') + t.accent(`${p.accent} ${G().sep} ${p.spinner} ${G().sep} ${p.reply}`) + t.dim(`  ${verbosityLabel(p)}`)] });
    this.redraw(); // repaint scrollback in the new accent / reply style
  }

  /** Look & feel preview: a sample exchange in the chosen reply style (+ verbosity rows). */
  settingsPreview(s: SettingsState): string[] {
    const cols = this.term.cols;
    const key = ['accent', 'spinner', 'reply', 'reasoning', 'tools', 'summary'][s.row[3] ?? 0];
    const inner = Math.min(cols - 8, 76);
    if (key === 'reasoning' || key === 'tools') return verbosityPreview(s.prefs, cols).map((l) => l.replace(/^ {2}/, ''));
    return replyPreview(s.prefs, inner);
  }

  // ------------------------------------------------------------ /theme
  private async themeSettings(row = 0) {
    const before = { ...prefs() };
    const saved = await this.withModal(() =>
      themePicker(this.term, this.screen, before, (p) => applyPrefs(p), () => this.previewLines(this.term.cols), row),
    );
    if (!saved) {
      applyPrefs(before);
      return this.redraw();
    }
    applyPrefs(saved);
    try {
      savePrefs(saved);
      this.history.push({ kind: 'lines', render: () => ['', '  ' + t.ok(G().check) + ' ' + fg(C.text)('look & feel ') + t.accent(`${saved.accent} ${G().sep} ${saved.spinner}`) + t.dim(`  ${verbosityLabel(saved)}`) + t.faint(`  ${shortPath(prefsPath(), 40)}`)] });
      setTimeout(() => this.flash('saved', 1800, 'ok'), 0);
    } catch (e: any) {
      this.history.push({ kind: 'lines', render: () => ['  ' + t.err(`/theme: could not save: ${e?.message || e}`)] });
    }
    this.redraw(); // repaint scrollback in the new accent
  }

  /** Sample rows for the /theme live preview (cat, a running tool, context bar, sign-off). */
  previewLines(cols: number, now = Date.now()): string[] {
    const g = G();
    const fake: ToolPart[] = [
      { kind: 'tool', id: 'a', name: 'read_file', args: { path: 'calc.py' }, start: now - 100, end: now, ok: true, seconds: 0.1 },
      { kind: 'tool', id: 'b', name: 'terminal', args: { command: 'pytest -q' }, start: now - 1400, tail: ['4 passed'] },
    ];
    const inner = Math.min(cols - 4, 60);
    return [
      ...renderToolTree(fake, inner, { now }).map((l) => '  ' + l),
      '  ' + renderSummary({ seconds: 4.1, tools: 3, files_changed: [{ path: 'calc.py', added: 1, removed: 1 }], tps: 51 }, true, inner),
      '  ' + renderCtx({ used: 9000, max: 131072, shown: 9000, cached: 0.92 }, now) + t.faint(` ${g.sep} `) + t.accent(g.user) + t.dim(' prompt'),
    ];
  }

  /** /copy: last reply to the clipboard (OSC 52, plus pbcopy / clip / wl-copy when present). */
  private copyLast() {
    const last = [...this.history].reverse().find((x) => x.kind === 'turn' && x.turn.parts.some((p) => p.kind === 'text')) as { kind: 'turn'; turn: Turn } | undefined;
    const text = last ? last.turn.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text).join('').trim() : '';
    if (!text) return this.flash('nothing to copy yet');
    copyToClipboard(text, (s) => this.term.write(s));
    this.flash(`copied ${text.length} chars`, 1600, 'ok');
  }

  private async localCommand(name: string, arg: string) {
    const api = this.api;
    const cols = this.term.cols;
    const g = G();
    try {
      switch (name) {
        case 'help':
          this.printFlow((c) => ['', ...helpLines(c, this.commands()), '']);
          return;
        case 'copy':
          return this.copyLast();
        case 'quit':
          return this.quit();
        case 'clear':
          this.history = [];
          this.screen.clearAll();
          return this.render();
        case 'redraw':
          return this.redraw();
        case 'undo':
          return this.undo();
        case 'agents':
        case 'subagents':
          return this.agentsSettings();
        case 'settings':
        case 'status':
          return this.openSettings(0);
        case 'config':
          return this.openSettings(1);
        case 'theme':
          return this.openSettings(3);
        case 'verbose':
        case 'verbosity': {
          if (!arg) return this.openSettings(3, 3);
          const v = parseVerbosity(arg);
          if (!v) return this.print(['  ' + t.warn('usage: ') + t.dim('/verbose quiet|normal|verbose|full · reasoning=hidden|timer|preview|full · tools=quiet|normal|full · summary=on|off')]);
          setVerbosity(v);
          try {
            savePrefs(prefs());
          } catch {}
          this.history.push({ kind: 'lines', render: () => ['', '  ' + t.ok(G().check) + ' ' + t.dim(verbosityLabel())] });
          return this.redraw();
        }
        case 'effort':
          {
            const e = normalizeEffort(arg);
            if (e && this.efforts.includes(e)) this.effort = e;
            else if (arg) return this.flash(`effort: ${this.efforts.map(effortLabel).join(' · ')}`, 1800);
            else this.effort = nextEffort(this.effort, 1, this.efforts);
          }
          return this.render();
        case 'new':
          this.sessionId = null;
          this.sessionTitle = '';
          this.goal = '';
          this.goalState = null;
          this.goalExpanded = false;
          this.planWaiting = false;
          this.loop = null;
          this.streamCtl?.abort();
          this.streamFor = null;
          this.todos = [];
          this.ctx.used = 0;
          this.ctx.cached = undefined;
          this.sessUsage = emptySession();
          this.eventsCtl?.abort();
          this.eventsFor = null;
          this.printFlow((c) => ['', '  ' + t.faint(g.rule.repeat(2) + ' new session ' + g.rule.repeat(Math.max(2, Math.min(40, c - 20)))), '']);
          return;
        case 'model':
          return this.modelPicker();
        case 'setup':
        case 'login': {
          if (this.busy) return this.flash('still working — esc to stop first');
          const { runSetupBox } = await import('./wizard');
          const res = await this.withModal(() => runSetupBox(this.api, this.term, this.screen, name === 'login' ? 'openai_login' : undefined));
          if (res) await this.loadMeta();
          this.redraw();
          if (!res) return;
          this.print(['', '  ' + t.ok(g.check) + ' ' + t.dim('model ') + fg(C.text)(res)]);
          return;
        }
        case 'inbox':
          return this.showInbox();
        case 'sessions': {
          const list = await api.sessions();
          if (!list.length) return this.print([t.dim('  no sessions yet')]);
          this.print(['', ...list.slice(0, 15).map((s) => '  ' + (s.pinned ? t.accent('★ ') : '  ') + truncate(s.title || '(untitled)', 40).padEnd(42) + t.dim(relTime(s.updated).padEnd(10)) + t.faint(s.id)), t.faint('  /resume to reopen'), '']);
          return;
        }
        case 'resume':
          return this.resume(arg || undefined);
        case 'memory': {
          const mem = await api.get<{ id: string; text: string }[]>('/api/memory');
          this.print(['', '  ' + bold('memory') + t.dim(` · ${mem.length} notes`), ...(mem.length ? mem.map((m) => '  ' + t.accent('•') + ' ' + truncate(m.text, cols - 6)) : [t.dim('  nothing yet — pico learns as you chat')]), '']);
          return;
        }
        case 'skills': {
          const sk = await api.skills();
          this.skills = sk.filter((s) => s.enabled !== false);
          this.print(['', '  ' + bold('skills') + t.dim(` · ${sk.length}`), ...sk.map((s) => '  ' + (s.enabled ? t.ok('●') : t.dim('○')) + ' ' + fg(C.accent)(('/' + s.name).padEnd(22)) + t.dim(truncate(s.description || '', cols - 30))), '']);
          return;
        }
        case 'search': {
          if (!arg) return this.flash('usage: /search <query>');
          const hits = await api.get<{ session_id: string; title: string; snippet: string }[]>(`/api/search?q=${encodeURIComponent(arg)}`);
          this.print(['', ...(hits.length ? hits.slice(0, 10).flatMap((h) => ['  ' + bold(h.title || h.session_id) + ' ' + t.faint(h.session_id), '    ' + t.dim(truncate(h.snippet.replace(/\s+/g, ' '), cols - 6))]) : [t.dim('  no matches')]), '']);
          return;
        }
        case 'checkin': {
          const list = await api.get<{ id: string; title: string; prompt: string; schedule: { time: string; days: string[] } }[]>('/api/checkins');
          this.print(['', '  ' + bold('check-ins') + t.dim(' · background replies'), ...(list.length ? list.map((c) => '  ' + t.accent('◷') + ' ' + c.title.padEnd(28) + t.dim(`${c.schedule?.time ?? ''} ${(c.schedule?.days || []).join(',')}`)) : [t.dim('  none')])]);
          const add = await this.withModal(() => confirm(this.term, this.screen, 'Add a check-in?'));
          if (!add) return this.render();
          const res = await this.withModal(async () => {
            const title = await textPrompt(this.term, this.screen, 'Title');
            const prompt = await textPrompt(this.term, this.screen, 'What should pico do?');
            const time = await textPrompt(this.term, this.screen, 'Time (HH:MM)', { initial: '07:30' });
            return { title, prompt, time };
          });
          if (!res) return;
          await api.post('/api/checkins', { title: res.title, prompt: res.prompt, schedule: { time: res.time, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } });
          this.print([t.ok(`  ${g.check} `) + `check-in “${res.title}” at ${res.time} daily`]);
          return;
        }
        case 'connect': {
          const cat = await api.get<{ id: string; name: string; what: string; kind: string; connected: boolean; setup: { fields?: any[]; oauth_url?: string } }[]>('/api/connectors');
          if (!cat.length) return this.print([t.dim('  no connectors available')]);
          const id = await this.withModal(() => select(this.term, this.screen, 'Connect an app', cat.map((c) => ({ label: (c.connected ? '● ' : '  ') + c.name, value: c.id, hint: c.what }))));
          if (!id) return;
          const c = cat.find((x) => x.id === id)!;
          if (c.setup?.oauth_url) {
            this.print(['  open ' + fg(C.accent)(c.setup.oauth_url) + ' to connect ' + bold(c.name)]);
            return;
          }
          const fields = (c.setup?.fields || []).map((f: any) => (typeof f === 'string' ? { name: f, label: f, secret: /key|token|secret|pass/i.test(f) } : f));
          const vals = await this.withModal(async () => {
            const o: Record<string, string> = {};
            for (const f of fields) o[f.name] = await textPrompt(this.term, this.screen, f.label || f.name, { secret: !!f.secret });
            return o;
          });
          if (!vals) return;
          await api.post(`/api/connectors/${encodeURIComponent(id)}/connect`, { fields: vals });
          this.print([t.ok(`  ${g.check} `) + `connected ${c.name}`]);
          return;
        }
        case 'update': {
          const u = await api.updates();
          if (!u.available?.length) return this.print([t.ok(`  ${g.check} `) + t.muted("you're on the best setup for this machine")]);
          const lines = ['', '  ' + bold('updates available')];
          for (const x of u.available) lines.push('  ' + t.accent('↑') + ' ' + `${x.from} → ${bold(x.to)}` + '  ' + fmtDelta(x.delta), '    ' + t.dim(x.why));
          this.print(lines);
          for (const x of u.available) {
            const ok = await this.withModal(() => confirm(this.term, this.screen, `Apply ${x.kind} update → ${x.to}?`));
            if (!ok) continue;
            try {
              const r = await api.post<{ job_id?: string }>('/api/updates/apply', { kind: x.kind, to: x.to });
              if (r.job_id) {
                const { jobProgress } = await import('./wizard');
                this.modalOpen = true;
                try {
                  await jobProgress(api, this.screen, r.job_id);
                } finally {
                  this.modalOpen = false;
                }
              }
              this.print([t.ok(`  ${g.check} `) + `updated to ${x.to}`]);
              void this.loadMeta();
            } catch (e: any) {
              this.print([t.err(`  update failed: ${e.message}`)]);
            }
          }
          return;
        }
      }
    } catch (e: any) {
      this.print([t.err(`  /${name}: ${e?.message || e}`)]);
    }
  }
}

// ---------------------------------------------------------------- /agents picker
interface Setting {
  key: keyof SubagentSettings;
  label: string;
  explain: string;
}
export const AGENT_SETTINGS: Setting[] = [
  { key: 'enabled', label: 'subagents', explain: 'Let pico hand side-tasks to helper agents that work in parallel.' },
  { key: 'max_parallel', label: 'max parallel', explain: 'How many helpers may run at once. More is faster but uses more memory.' },
  { key: 'model', label: 'model', explain: 'Which model the helpers use. A smaller one is quicker and cheaper.' },
  { key: 'effort', label: 'effort', explain: 'How hard helpers think before acting. Low keeps them snappy.' },
  { key: 'max_seconds', label: 'time budget', explain: 'A helper is stopped after this long, so nothing runs away.' },
];

/** Pure render of the /agents panel (tested). */
export function agentsPanelLines(s: SubagentSettings, idx: number, models: { id: string; name: string }[], mainModel: string, cols: number): string[] {
  const g = G();
  const inner = Math.min(Math.max(40, cols - 4), 78);
  const labW = 14;
  const val = (k: keyof SubagentSettings): string => {
    switch (k) {
      case 'enabled':
        return s.enabled ? 'on' : 'off';
      case 'max_parallel':
        return `${s.max_parallel}`;
      case 'model':
        return s.model ? models.find((m) => m.id === s.model)?.name ?? s.model : `same as main${mainModel ? ` (${mainModel})` : ''}`;
      case 'effort':
        return s.effort;
      case 'max_seconds':
        return fmtBudget(s.max_seconds);
    }
  };
  const body: string[] = [''];
  AGENT_SETTINGS.forEach((it, i) => {
    const on = i === idx;
    const disabled = it.key !== 'enabled' && !s.enabled;
    const v = val(it.key);
    let vS: string;
    if (it.key === 'enabled') vS = s.enabled ? t.accent(g.dot + ' on') : t.dim(g.ring + ' off');
    else if (it.key === 'max_parallel') vS = t.accent(v) + ' ' + fg(C.accentDim)(g.barFull.repeat(s.max_parallel)) + fg(C.rule)(g.barEmpty.repeat(8 - s.max_parallel));
    else if (it.key === 'effort') vS = fg(EFFORT_COLOR[s.effort])(v);
    else vS = t.accent(v);
    if (disabled) vS = t.faint(v);
    const arrows = on && it.key !== 'enabled' ? t.faint(g.lt + ' ') : '  ';
    const arrowsR = on && it.key !== 'enabled' ? t.faint(' ' + g.gt) : '';
    const labS = (on ? bold(fg(C.text)(it.label)) : disabled ? t.faint(it.label) : t.muted(it.label)) + ' '.repeat(Math.max(1, labW - w(it.label)));
    body.push((on ? t.accent(g.caret) : ' ') + ' ' + labS + arrows + vS + arrowsR);
    for (const l of wrap(it.explain, inner - 4 - labW - 4).slice(0, 2)) body.push('  ' + ' '.repeat(labW) + '  ' + (on ? t.dim : t.faint)(l));
  });
  body.push('');
  const footer = t.faint(`↑↓ move ${g.sep} ←→ change ${g.sep} enter save ${g.sep} esc cancel`);
  return box(t.accent(g.branch) + ' ' + 'subagents', body, inner, C.faint, footer).map((l) => '  ' + l);
}

export function agentsPicker(
  term: Terminal,
  screen: LiveScreen,
  initial: SubagentSettings,
  models: { id: string; name: string }[],
  mainModel: string,
): Promise<SubagentSettings | null> {
  const s = { ...initial };
  let idx = 0;
  const modelIds = ['', ...models.map((m) => m.id)];
  const change = (dir: number) => {
    const k = AGENT_SETTINGS[idx].key;
    if (k === 'enabled') s.enabled = !s.enabled;
    else if (!s.enabled) return;
    else if (k === 'max_parallel') s.max_parallel = Math.max(1, Math.min(8, s.max_parallel + dir));
    else if (k === 'model') {
      const i = Math.max(0, modelIds.indexOf(s.model));
      s.model = modelIds[(i + dir + modelIds.length) % modelIds.length];
    } else if (k === 'effort') s.effort = EFFORTS[(Math.max(0, EFFORTS.indexOf(s.effort as Effort)) + dir + EFFORTS.length) % EFFORTS.length] as SubagentSettings['effort'];
    else if (k === 'max_seconds') {
      let i = BUDGETS.findIndex((b) => b >= s.max_seconds);
      if (i < 0) i = BUDGETS.length - 1;
      s.max_seconds = BUDGETS[Math.max(0, Math.min(BUDGETS.length - 1, i + dir))];
    }
  };
  return modal<SubagentSettings | null>(
    term,
    screen,
    () => ['', ...agentsPanelLines(s, idx, models, mainModel, term.cols)],
    (k) => {
      if (k.name === 'escape' || k.name === 'q') return null;
      if (k.name === 'enter') return { ...s };
      if (k.name === 'up' || k.name === 'k') idx = (idx - 1 + AGENT_SETTINGS.length) % AGENT_SETTINGS.length;
      else if (k.name === 'down' || k.name === 'j' || k.name === 'tab') idx = (idx + 1) % AGENT_SETTINGS.length;
      else if (k.name === 'right' || k.name === 'l' || k.name === 'space' || k.ch === '+') change(1);
      else if (k.name === 'left' || k.name === 'h' || k.ch === '-') change(-1);
      return undefined;
    },
  );
}

// ---------------------------------------------------------------- /theme picker
export const QUIPS = [
  'ready when you are.',
  'what are we breaking today?',
  'tests first, then snacks.',
  'small diffs, big naps.',
  'i read the docs so you don\'t have to.',
  'it works on my machine. which is yours.',
  'git status, then coffee.',
  'no yak too hairy.',
  'let\'s ship something boring and correct.',
  'the bug is probably off by one.',
  'local, private, mildly opinionated.',
  'say the word.',
  'paws on the keyboard.',
  'nothing compiles itself. yet.',
  'one more turn, then lunch.',
];

export const THEME_ROWS = [
  { key: 'accent', label: 'accent', explain: 'Color of the cat, spinner, prompt, context bar and sign-off.' },
  { key: 'spinner', label: 'spinner', explain: 'What spins while a tool runs.' },
  { key: 'reasoning', label: 'reasoning', explain: 'hidden · timer · preview (last thought line) · full (stream it, folds when the answer starts).' },
  { key: 'tools', label: 'tools', explain: 'quiet (one line: read 2 · edit 1) · normal (tree + 4-line tail) · full (20 lines + diffs).' },
  { key: 'summary', label: 'summary', explain: "The cat's sign-off line under each reply." },
] as const;
const REASONING_HINT: Record<string, string> = { hidden: 'nothing shown', timer: 'thinking 4.1s', preview: '+ last line', full: 'stream it all' };
const TOOLS_HINT: Record<string, string> = { quiet: 'one line per turn', normal: 'tree + 4-line tail', full: '20 lines + diffs' };

/** Pure render of the /theme panel + live preview (tested). */
export function themePanelLines(p: TuiPrefs, idx: number, cols: number, now = Date.now(), preview: string[] = []): string[] {
  const g = G();
  const inner = Math.min(Math.max(40, cols - 4), 78);
  const labW = 10;
  const body: string[] = [''];
  THEME_ROWS.forEach((it, i) => {
    const on = i === idx;
    let vS: string;
    if (it.key === 'accent') {
      const cur = accentIndex(p.accent);
      const sw = ACCENTS.map((a, j) => fg(a.hex)(j === cur ? g.dot : g.ring)).join(' ');
      vS = t.accent(accentName(p.accent).padEnd(9)) + ' ' + sw;
    } else if (it.key === 'spinner') {
      const glyph = p.spinner === 'shimmer' ? shimmer('terminal', now, t.dim) : t.accent(spinGlyph(now, p.spinner));
      vS = t.accent(p.spinner.padEnd(9)) + ' ' + glyph + '  ' + t.faint(SPINNERS.find((x) => x.name === p.spinner)?.hint ?? '');
    } else if (it.key === 'reasoning') {
      vS = t.accent(p.reasoning.padEnd(9)) + ' ' + levelDots(REASONING_LEVELS, p.reasoning) + '  ' + t.faint(REASONING_HINT[p.reasoning]);
    } else if (it.key === 'tools') {
      vS = t.accent(p.tools.padEnd(9)) + ' ' + levelDots(TOOLS_LEVELS, p.tools) + '  ' + t.faint(TOOLS_HINT[p.tools]);
    } else vS = p.summary ? t.accent(g.dot + ' on') : t.dim(g.ring + ' off');
    const arrows = on ? t.faint(g.lt + ' ') : '  ';
    const labS = (on ? bold(fg(C.text)(it.label)) : t.muted(it.label)) + ' '.repeat(Math.max(1, labW - w(it.label)));
    body.push((on ? t.accent(g.caret) : ' ') + ' ' + labS + arrows + vS + (on ? t.faint(' ' + g.gt) : ''));
    if (on) for (const l of wrap(it.explain, inner - 4 - labW - 4).slice(0, 2)) body.push('  ' + ' '.repeat(labW) + '  ' + t.dim(l));
  });
  body.push('');
  if (preview.length) body.push(t.faint('preview'), ...preview.map((l) => l.replace(/^ {2}/, '')), '');
  const footer = t.faint(`↑↓ move ${g.sep} ←→ change ${g.sep} enter save ${g.sep} esc cancel`);
  return box(t.accent('(^.^)') + ' look & feel', body, inner, C.faint, footer).map((l) => '  ' + l);
}

const levelDots = (levels: readonly string[], cur: string) => levels.map((l) => (l === cur ? t.accent(G().dot) : t.faint(G().ring))).join(' ');

/** Sample turn for the look & feel preview, rendered with the chosen verbosity (tested). */
export function verbosityPreview(p: TuiPrefs, cols: number, now = Date.now()): string[] {
  const inner = Math.min(cols - 8, 70);
  const turn = newTurn('');
  turn.started = now - 4200;
  turn.parts.push({ kind: 'reasoning', text: 'The loop stops one short.\nrange(n - 1) should be range(n); check the tests next.', start: now - 2100 });
  turn.parts.push(
    { kind: 'tool', id: 'a', name: 'read_file', args: { path: 'calc.py' }, start: now - 3000, end: now - 2900, ok: true, seconds: 0.1 },
    { kind: 'tool', id: 'b', name: 'patch', args: { path: 'calc.py' }, start: now - 2800, end: now - 2800, ok: true, seconds: 0.0, diff: { path: 'calc.py', added: 1, removed: 1, unified: '@@ -3 +3 @@\n-for i in range(n - 1):\n+for i in range(n):' } as any },
    { kind: 'tool', id: 'c', name: 'terminal', args: { command: 'pytest -q' }, start: now - 1400, tail: ['test_calc.py ....', '4 passed in 0.02s'] },
  );
  const vb = { reasoning: p.reasoning, tools: p.tools, summary: p.summary };
  // the live reasoning is shown first (it's what changes most between levels), then the tools
  const live = renderTurn(turn, inner + 4, { live: true, now, verbosity: vb }).filter((l, i, arr) => !(l === '' && (i === 0 || arr[i - 1] === '')));
  const done = newTurn('');
  done.done = { seconds: 4.1, tps: 51, summary: { seconds: 4.1, tools: 3, tps: 51, files_changed: [{ path: 'calc.py', added: 1, removed: 1 }] } };
  done.parts.push({ kind: 'text', text: 'Fixed the off-by-one.' });
  const signoff = renderTurn(done, inner + 4, { verbosity: vb }).filter((l) => l.trim());
  return [...live, '', ...signoff];
}

/** A finished sample exchange rendered in the chosen reply style (look & feel preview, tested). */
export function replyPreview(p: TuiPrefs, inner: number): string[] {
  const turn = newTurn('fix the off-by-one in calc.py');
  turn.parts.push({ kind: 'tool', id: 'a', name: 'patch', args: { path: 'calc.py' }, start: 1, end: 100, ok: true, seconds: 0.1 });
  turn.parts.push({ kind: 'text', text: 'Fixed it: range(n - 1) stopped one short.' });
  turn.done = { seconds: 1.3, tps: 51, summary: { seconds: 1.3, tools: 1, tps: 51 } };
  return renderTurn(turn, inner, { style: p.reply, verbosity: { reasoning: p.reasoning, tools: 'quiet', summary: p.summary } }).slice(1);
}

/** /theme: ↑↓ move, ←→ change (applied live), enter save, esc cancel. Animated preview at ~12fps. */
export function themePicker(
  term: Terminal,
  screen: LiveScreen,
  initial: TuiPrefs,
  onChange: (p: TuiPrefs) => void,
  preview: () => string[],
  row = 0,
): Promise<TuiPrefs | null> {
  const p = { ...initial };
  let idx = row;
  const cyc = <T,>(list: readonly T[], cur: T, dir: number) => list[(Math.max(0, list.indexOf(cur)) + dir + list.length) % list.length];
  const change = (dir: number) => {
    const key = THEME_ROWS[idx].key;
    if (key === 'accent') p.accent = ACCENTS[(accentIndex(p.accent) + dir + ACCENTS.length) % ACCENTS.length].name;
    else if (key === 'spinner') {
      const i = Math.max(0, SPINNERS.findIndex((x) => x.name === p.spinner));
      p.spinner = SPINNERS[(i + dir + SPINNERS.length) % SPINNERS.length].name;
    } else if (key === 'reasoning') p.reasoning = cyc(REASONING_LEVELS, p.reasoning, dir);
    else if (key === 'tools') p.tools = cyc(TOOLS_LEVELS, p.tools, dir);
    else p.summary = !p.summary;
    onChange({ ...p });
  };
  const draw = () => {
    const pv = preview();
    return ['', ...themePanelLines(p, idx, term.cols, Date.now(), THEME_ROWS[idx].key === 'accent' || THEME_ROWS[idx].key === 'spinner' ? pv : verbosityPreview(p, term.cols).map((l) => '  ' + l))];
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  const pr = modal<TuiPrefs | null>(term, screen, draw, (k) => {
    if (k.name === 'escape' || k.name === 'q') return null;
    if (k.name === 'enter') return { ...p };
    if (k.name === 'up' || k.name === 'k') idx = (idx - 1 + THEME_ROWS.length) % THEME_ROWS.length;
    else if (k.name === 'down' || k.name === 'j' || k.name === 'tab') idx = (idx + 1) % THEME_ROWS.length;
    else if (k.name === 'right' || k.name === 'l' || k.name === 'space') change(1);
    else if (k.name === 'left' || k.name === 'h') change(-1);
    return undefined;
  });
  timer = setInterval(() => screen.render({ lines: draw() }), 80);
  const stop = () => timer && clearInterval(timer);
  return pr.then(
    (v) => (stop(), v),
    (e) => {
      stop();
      throw e;
    },
  );
}

/**
 * Command palette / file picker under the input: '❯ /theme   accent color & spinner'. Matched letters
 * are accent, names share one column, descriptions dim, a faint 'n of N' + key hint closes it.
 */
export function overlayPanel(o: Overlay, cols: number): string[] {
  const g = G();
  if (!o.items.length) return ['  ' + t.faint(o.kind === 'files' ? 'no matching files' : 'no matching commands')];
  const max = 8;
  const start = Math.max(0, Math.min(o.idx - max + 1, o.items.length - max));
  const labW = Math.min(30, Math.max(...o.items.map((i) => w(i.label))) + 2);
  const q = o.query ?? '';
  const out: string[] = [];
  o.items.slice(start, start + max).forEach((it, j) => {
    const on = start + j === o.idx;
    const base = on ? (s: string) => bold(fg(C.text)(s)) : t.muted;
    // plain text only: the label is colored per character below, so no escapes may sit inside it
    const name = w(it.label) <= labW - 1 ? it.label : Array.from(it.label).slice(0, Math.max(1, labW - 2)).join('') + G().ell;
    // the leading / or @ isn't part of what was typed after it
    const off = o.kind === 'palette' ? 1 : 0;
    const hit = new Set(fuzzyPositions(q, it.value).map((x) => x + off));
    let lab = '';
    Array.from(name).forEach((ch, i) => (lab += hit.has(i) ? t.accent(ch) : base(ch)));
    const caret = on ? t.accent(g.caret + ' ') : '  ';
    const hint = it.hint ? t.dim(it.hint) : '';
    out.push(truncate('  ' + caret + lab + ' '.repeat(Math.max(1, labW - w(name))) + hint, cols));
  });
  const more = o.items.length > max ? `${o.idx + 1} of ${o.items.length} ${g.sep} ` : '';
  out.push('    ' + t.faint(`${more}↑↓ ${g.sep} tab complete ${g.sep} enter run ${g.sep} esc close`.replace('enter run', o.kind === 'files' ? 'enter attach' : 'enter run')));
  return out;
}

/** The approval prompt: a small amber-titled box, command in code color, y/n/a keys in the footer. */
export function approvalBox(a: { command: string; reason?: string }, cols: number): string[] {
  const g = G();
  const cmdLines = a.command.split('\n').map((l) => l.replace(/\t/g, '  '));
  const want = Math.max(40, ...cmdLines.map((l) => w(l) + 6), a.reason ? Math.min(w(a.reason) + 6, 72) : 0);
  const inner = Math.max(24, Math.min(cols - 4, 84, want));
  const body: string[] = [];
  for (const l of cmdLines.slice(0, 6)) body.push(...wrap(t.accent(g.user) + ' ' + t.code(l), inner - 4));
  if (cmdLines.length > 6) body.push(t.faint(`  ${g.ell} +${cmdLines.length - 6} lines`));
  if (a.reason) body.push(...wrap(t.dim(a.reason), inner - 4).slice(0, 3));
  const key = (k: string, what: string) => t.accent(bold(k)) + t.dim(' ' + what);
  const footer = [key('y', 'allow'), key('n', 'deny'), key('a', 'always')].join(t.faint(` ${g.sep} `));
  return [...box(t.warn('run this?'), body, inner, C.faint, footer).map((l) => '  ' + l), ''];
}

/** Exit line: the cat waves bye, plus how to come back to this session. */
export function byeLine(sessionId: string | null): string {
  const g = G();
  const cat = t.accent(g.user === '>' ? '(^.^)/' : '(^.^)ﾉ');
  const bye = t.muted(' bye for now');
  if (!sessionId) return '  ' + cat + bye;
  return '  ' + cat + bye + t.faint(` ${g.sep} `) + t.dim('resume with ') + t.muted(`pico -r ${sessionId}`);
}

/** Copy text: OSC 52 (works over ssh in most modern terminals) + the platform clipboard tool if any. */
export function copyToClipboard(text: string, write: (s: string) => void) {
  try {
    write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
  } catch {}
  const tool = process.platform === 'darwin' ? ['pbcopy'] : process.platform === 'win32' ? ['clip'] : process.env.WAYLAND_DISPLAY ? ['wl-copy'] : ['xclip', '-selection', 'clipboard'];
  try {
    const p = Bun.spawn(tool, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
    p.stdin.write(text);
    p.stdin.end();
  } catch {}
}

export function fmtDelta(d: { tps?: number; ctx?: number; quality?: string }): string {
  const bits: string[] = [];
  if (d.tps) bits.push((d.tps > 0 ? t.ok : t.err)(`${d.tps > 0 ? '+' : ''}${d.tps} tok/s`));
  if (d.ctx) bits.push((d.ctx > 0 ? t.ok : t.err)(`${d.ctx > 0 ? '+' : '-'}${fmtCtx(Math.abs(d.ctx))} ctx`));
  if (d.quality) bits.push(t.ok(d.quality));
  return bits.join(t.faint(', '));
}

export function relTime(v: number | string): string {
  const ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  if (!ms || isNaN(ms)) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export { EFFORT_COLOR, fmtK, renderUser, spinFrame };

// ---------------------------------------------------------------- /model picker
const providerLabelOf = (m: ModelEntry) => m.provider_label || (m.local ? 'local' : m.provider || '');

/** Pure render: model box + the 'default effort' footer row (tested). */
export function modelPickerLines(models: ModelEntry[], active: string, idx: number, cols: number, efforts: Effort[], defEffort: Effort, onEffortRow: boolean): string[] {
  const g = G();
  const box = modelPanelLines(models, active, onEffortRow ? -1 : idx, cols);
  // splice the effort row in above the bottom border
  const inner = Math.min(Math.max(44, cols - 4), 78);
  const label = 'default effort';
  const val = effortPaint(defEffort)(`${g.dot} ${effortLabel(defEffort)}`);
  const row = (onEffortRow ? t.accent(g.caret) : ' ') + ' ' + (onEffortRow ? bold(fg(C.text)(label)) : t.muted(label)) + '  ' + (onEffortRow ? t.faint(g.lt + ' ') : '  ') + val + (onEffortRow ? t.faint(' ' + g.gt) : '') + t.faint('  new chats');
  const c = (s: string) => fg(C.faint)(s);
  const ruleRow = '  ' + c(g.v) + ' ' + t.faint(g.h.repeat(inner - 4)) + ' ' + c(g.v);
  const effRow = '  ' + c(g.v + ' ') + row + ' '.repeat(Math.max(0, inner - 4 - w(row))) + c(' ' + g.v);
  const blank = '  ' + c(g.v) + ' '.repeat(inner - 2) + c(g.v);
  const footer = t.faint(`↑↓ move ${g.sep} ←→ effort ${g.sep} enter save ${g.sep} esc cancel`);
  const bottom = '  ' + c(g.bl + g.h) + ' ' + footer + ' ' + c(g.h.repeat(Math.max(0, inner - 5 - w(footer))) + g.br);
  void efforts;
  return [...box.slice(0, -1), ruleRow, effRow, blank, bottom];
}

export function modelPicker(
  term: Terminal,
  screen: LiveScreen,
  models: ModelEntry[],
  active: string,
  efforts: Effort[],
  defEffort: Effort,
  preview: (id: string, eff: Effort) => string,
): Promise<{ id: string; effort: Effort } | null> {
  let idx = Math.max(0, models.findIndex((m) => m.id === active));
  let onEff = false;
  let eff = defEffort;
  const list = efforts;
  const draw = () => ['', ...modelPickerLines(models, active, idx, term.cols, list, eff, onEff), '', '  ' + preview(models[idx].id, eff)];
  return modal(term, screen, draw, (k) => {
    if (k.name === 'escape' || k.name === 'q') return null;
    if (k.name === 'enter') return { id: models[idx].id, effort: eff };
    if (k.name === 'up' || k.name === 'k') {
      if (onEff) onEff = false;
      else if (idx > 0) idx--;
      else onEff = true;
    } else if (k.name === 'down' || k.name === 'j' || k.name === 'tab') {
      if (onEff) {
        onEff = false;
        idx = 0;
      } else if (idx < models.length - 1) idx++;
      else onEff = true;
    } else if (k.name === 'right' || k.name === 'l' || k.name === 'left' || k.name === 'h') {
      const dir = k.name === 'right' || k.name === 'l' ? 1 : -1;
      eff = nextEffort(eff, dir, list);
      onEff = true;
    }
    return undefined;
  });
}

// ---------------------------------------------------------------- /cron picker
/** 'every weekday at 8am' -> {text}, '30m' / 'every 30m' -> {every}, '0 8 * * 1-5' -> {cron}. */
export function parseSchedule(when: string): any {
  const s = when.trim();
  if (/^(\S+\s+){4}\S+$/.test(s) && /^[\d*\/,\-\s]+$/.test(s)) return { cron: s };
  const ev = /^(?:every\s+)?(\d+\s*[smhd])$/i.exec(s);
  if (ev) return { every: ev[1].replace(/\s+/g, '') };
  return { text: s };
}

export interface CronActions {
  refresh: () => Promise<CronJob[]>;
  run: (j: CronJob) => Promise<string>;
  toggle: (j: CronJob) => Promise<string>;
  remove: (j: CronJob) => Promise<string>;
  add: (when: string, what: string) => Promise<string>;
}

export function cronPicker(term: Terminal, screen: LiveScreen, initial: CronJob[], act: CronActions): Promise<boolean> {
  let jobs = initial;
  let idx = 0;
  let prompt: CronPrompt = null;
  let note = '';
  const draw = () => ['', ...cronPanelLines(jobs, idx, term.cols, Date.now(), prompt, note)];
  const timer = setInterval(() => screen.render({ lines: draw() }), 1000);
  const doIt = async (fn: () => Promise<string>) => {
    try {
      note = t.dim(await fn());
      jobs = await act.refresh().catch(() => jobs);
      idx = Math.min(idx, Math.max(0, jobs.length - 1));
    } catch (e: any) {
      note = t.err(String(e?.message || e));
    }
  };
  const pr = modal<boolean>(term, screen, draw, async (k) => {
    if (prompt && prompt.kind !== 'confirm') {
      if (k.name === 'escape') prompt = prompt.kind === 'what' ? { kind: 'when', value: prompt.when || '' } : null;
      else if (k.name === 'enter') {
        const v = prompt.value.trim();
        if (!v) return undefined;
        if (prompt.kind === 'when') prompt = { kind: 'what', value: '', when: v };
        else {
          const when = prompt.when!;
          prompt = null;
          await doIt(() => act.add(when, v));
        }
      } else if (k.name === 'backspace') prompt.value = Array.from(prompt.value).slice(0, -1).join('');
      else if (k.name === 'paste' && k.paste) prompt.value += k.paste.replace(/\n/g, ' ');
      else if (k.ctrl && k.name === 'u') prompt.value = '';
      else if (k.ch && !k.ctrl) prompt.value += k.ch;
      return undefined;
    }
    if (prompt?.kind === 'confirm') {
      const j = jobs[idx];
      prompt = null;
      if ((k.name === 'y' || k.name === 'enter') && j) await doIt(() => act.remove(j));
      return undefined;
    }
    note = '';
    if (k.name === 'escape' || k.name === 'q') return true;
    if (k.name === 'up' || k.name === 'k') idx = Math.max(0, idx - 1);
    else if (k.name === 'down' || k.name === 'j') idx = Math.min(Math.max(0, jobs.length - 1), idx + 1);
    else if (k.name === 'n' || k.name === 'a') prompt = { kind: 'when', value: '' };
    else if (jobs[idx]) {
      const j = jobs[idx];
      if (k.name === 'enter') await doIt(() => act.run(j));
      else if (k.name === 'space') await doIt(() => act.toggle(j));
      else if (k.name === 'd' || k.name === 'delete' || k.name === 'x') prompt = { kind: 'confirm', text: `delete “${j.title || j.id}”?` };
    }
    return undefined;
  });
  return pr.finally(() => clearInterval(timer));
}

function commonPrefix(xs: string[]): string {
  if (!xs.length) return '';
  let p = xs[0];
  for (const x of xs) while (p && !x.toLowerCase().startsWith(p.toLowerCase())) p = p.slice(0, -1);
  return p;
}

const isAsciiMode = () => G().user === '>';
