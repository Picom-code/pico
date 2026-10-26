// Agentic features: steer, tab completion, /model, /cron, /loop, /usage, goal banner, plan card.
import { afterEach, describe, expect, test } from 'bun:test';
import { setAscii, stripAnsi as P, width } from '../src/ansi';
import { App, modelPickerLines, parseSchedule } from '../src/app';
import { applyCandidate, complete, ghostFor, type Sources } from '../src/complete';
import {
  cronPanelLines, cronRow, dailySeries, fmtCountdown, fmtIn, goalBanner, goalBox, inboxLine, loopSegment, modelPanelLines, modelTps, normalizeGoal,
  planCard, planWaitLine, sparkline, steerLine, usageCard,
} from '../src/features';
import { parseKeys } from '../src/keys';
import { applyEvent, messagesToTurns, newTurn, renderTurn } from '../src/turn';

afterEach(() => setAscii(false));

const mkApp = (cols = 120) => {
  const app = new App({} as any, { version: '0.1.0' });
  (app as any).term = { cols, rows: 30, write() {}, onKey() {}, onResizeEvent() {} };
  (app as any).render = () => {};
  app.model = 'qwen3';
  return app;
};
const press = (app: App, s: string) => {
  for (const k of parseKeys(s)) (app as any).onKey(k);
};

// ---------------------------------------------------------------- steer
describe('steer', () => {
  test('pending dim line → accent ✓ when the engine applies it', () => {
    const t = newTurn('write the post');
    applyEvent(t, 'delta', { text: 'Draft one.' });
    applyEvent(t, 'steer_local', { text: 'shorter please' });
    expect(renderTurn(t, 80, { live: true }).map(P)).toContain('  ↳ steer: shorter please');
    applyEvent(t, 'steer', { text: 'shorter please', applied: true });
    expect(renderTurn(t, 80).map(P)).toContain('  ↳ steer: shorter please ✓');
    expect(P(steerLine('x', 'queued', 40))).toBe('↳ queued: x');
  });
  test('a steer the CLI never sent locally still shows (applied)', () => {
    const t = newTurn('x');
    applyEvent(t, 'steer', { text: 'from the web app', applied: true });
    expect(renderTurn(t, 80).map(P)).toContain('  ↳ steer: from the web app ✓');
  });
  test('409 → queued and sent as the next message after the turn', async () => {
    const app = mkApp();
    const sent: string[] = [];
    app.api = { steer: async () => { const e: any = new Error('no turn running'); e.status = 409; throw e; } } as any;
    app.sessionId = 's1';
    app.streaming = new AbortController();
    app.turn = newTurn('long task');
    (app as any).submit = async (t: string) => void sent.push(t);
    await app.steer('also add tests');
    expect(app.steerQueue).toEqual(['also add tests']);
    expect(P(renderTurn(app.turn!, 80).join('\n'))).toContain('↳ queued: also add tests');
    app.streaming = null;
    (app as any).drainSteers();
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toEqual(['also add tests']);
    expect(app.steerQueue).toEqual([]);
  });
  test('enter while busy steers; "!text" interrupts; status hint shows enter steer · esc stop', () => {
    const app = mkApp();
    const calls: string[] = [];
    (app as any).steer = async (t: string) => void calls.push('steer:' + t);
    (app as any).interruptWith = async (t: string) => void calls.push('new:' + t);
    app.streaming = new AbortController();
    press(app, 'tighten it\r');
    press(app, '!start over\r');
    press(app, 'alt version\x1b\r');
    expect(calls).toEqual(['steer:tighten it', 'new:start over', 'new:alt version']);
    expect(P(app.statusLine(120))).toContain('enter steer · esc stop');
    app.streaming = null;
    expect(P(app.statusLine(120))).not.toContain('enter steer');
  });
});

// ---------------------------------------------------------------- completion
const SRC: Sources = {
  commands: [{ name: 'model', desc: 'switch model' }, { name: 'memory' }, { name: 'loop' }, { name: 'cron' }, { name: 'effort' }, { name: 'subagents', alias: true }, { name: 'review', skill: true }],
  models: [{ id: 'qwen3-coder', name: 'Qwen3 Coder' }, { id: 'gpt-5.5', name: 'GPT-5.5' }, { id: 'gpt-5-mini' }],
  cronIds: [{ id: 'c_brief', title: 'morning brief' }],
  efforts: ['low', 'medium', 'high'],
  cwd: '/proj',
  readdir: (d) =>
    d === '/proj/' || d === '/proj'
      ? [{ name: 'src', dir: true }, { name: 'README.md', dir: false }, { name: 'package.json', dir: false }]
      : d === '/proj/src/'
        ? [{ name: 'status.ts', dir: false }, { name: 'sse.ts', dir: false }, { name: 'app.ts', dir: false }]
        : [],
};
describe('tab completion', () => {
  test('slash commands: ghost remainder from the top fuzzy match; aliases + skills complete', () => {
    const c = complete('/mo', SRC)!;
    expect(c.items[0].value).toBe('/model');
    expect(ghostFor(c)).toBe('del');
    expect(complete('/sub', SRC)!.items[0].value).toBe('/subagents');
    expect(complete('/rev', SRC)!.items[0].value).toBe('/review');
    expect(complete('/', SRC)!.items.map((i) => i.value)).not.toContain('/subagents');
  });
  test('arguments: model ids (fuzzy on name), loop intervals, cron subcommands + ids, effort levels', () => {
    expect(complete('/model gpt', SRC)!.items.map((i) => i.value)).toEqual(['gpt-5.5', 'gpt-5-mini']);
    expect(complete('/model coder', SRC)!.items[0].value).toBe('qwen3-coder');
    expect(complete('/loop ', SRC)!.items.map((i) => i.value)).toEqual(['stop', 'until-done', '5m', '10m', '30m', '1h']);
    expect(complete('/cron pa', SRC)!.items[0].value).toBe('pause');
    expect(complete('/cron rm ', SRC)!.items).toEqual([{ value: 'c_brief', hint: 'morning brief' }]);
    expect(ghostFor(complete('/effort h', SRC))).toBe('igh');
    expect(complete('/effort ', SRC)!.items.map((i) => i.value)).not.toContain('off');
  });
  test('@path: directory listing, dirs first with /, fuzzy on the last segment, keeps completing into dirs', () => {
    const c = complete('read @', SRC)!;
    expect(c.start).toBe(5);
    expect(c.items.map((i) => i.value)).toEqual(['@src/', '@package.json', '@README.md']);
    expect(applyCandidate('read @', c, c.items[0])).toBe('read @src/'); // no trailing space on dirs
    const d = complete('read @src/st', SRC)!;
    expect(d.items[0].value).toBe('@src/status.ts');
    expect(ghostFor(d)).toBe('atus.ts');
    expect(applyCandidate('read @src/st', d, d.items[0])).toBe('read @src/status.ts ');
  });
  test('app: tab accepts the ghost, repeated tab cycles, candidate row lists matches', () => {
    const app = mkApp();
    app.modelList = SRC.models as any;
    press(app, '/model gpt');
    expect(app.ghost()).toBe('-5.5');
    expect(P(app.candidateLines(120)[0])).toContain('gpt-5.5  gpt-5-mini');
    press(app, '\t'); // extend to the common prefix 'gpt-5'
    expect(app.ed.value).toBe('/model gpt-5');
    press(app, '\t');
    expect(app.ed.value).toBe('/model gpt-5.5 ');
    press(app, '\t');
    expect(app.ed.value).toBe('/model gpt-5-mini ');
    press(app, '\t');
    expect(app.ed.value).toBe('/model gpt-5.5 ');
  });
  test('ghost text is drawn dim after the cursor on the input row', () => {
    const app = mkApp();
    app.modelList = SRC.models as any;
    press(app, '/model qw');
    const row = app.inputBox(120).lines.map(P).find((l) => l.startsWith('›'))!;
    expect(row).toBe('› /model qwen3-coder');
    press(app, '\x1b[C'); // → accepts
    expect(app.ed.value).toBe('/model qwen3-coder ');
  });
});

// ---------------------------------------------------------------- /model
describe('/model picker', () => {
  const models = [
    { id: 'q', name: 'Qwen3-Coder 30B', provider_label: 'Local · llama.cpp', local: true, ctx: 131072, tps: 72, tps_measured: 68.4 },
    { id: 'o', name: 'gpt-oss 20B', provider_label: 'Local · llama.cpp', local: true, ctx: 131072, tps: 88 },
    { id: 'g', name: 'GPT-5.5', provider_label: 'ChatGPT subscription', ctx: 272000, tps_measured: 51.2 },
    { id: 'm', name: 'GPT-5 mini', provider_label: 'ChatGPT subscription', ctx: 272000 },
  ];
  test('rows grouped by provider: ● name  ctx 128k  51 tok/s (estimate ~, none —), active marked', () => {
    const l = modelPanelLines(models, 'q', 2, 100).map(P);
    expect(l.some((x) => x.includes('Local · llama.cpp'))).toBe(true);
    expect(l.some((x) => /● Qwen3-Coder 30B\s+ctx 128k\s+68 tok\/s\s+active/.test(x))).toBe(true);
    expect(l.some((x) => /○ gpt-oss 20B\s+ctx 128k\s+~88 tok\/s/.test(x))).toBe(true);
    expect(l.some((x) => /❯ ○ GPT-5.5\s+ctx 272k\s+51 tok\/s/.test(x))).toBe(true);
    expect(l.some((x) => /○ GPT-5 mini\s+ctx 272k\s+—/.test(x))).toBe(true);
    expect(modelTps({ id: 'x' }).text).toBe('—');
  });
  test('default effort row (low/med/high, no off) sits in the box; every line is the same width', () => {
    const l = modelPickerLines(models, 'q', 0, 100, ['low', 'medium', 'high'], 'high', true);
    const plain = l.map(P);
    expect(plain.some((x) => /❯ default effort\s+‹ ● high ›\s+new chats/.test(x))).toBe(true);
    expect(plain.at(-1)).toContain('←→ effort');
    const ws = new Set(l.map(width));
    expect(ws.size).toBe(1);
  });
  test('/model <id> fuzzy switches; ctrl+p cycles; done.model updates the status line', async () => {
    const app = mkApp();
    const set: string[] = [];
    app.api = { models: async () => ({ active: 'q', models }), setModel: async (id: string) => void set.push(id) } as any;
    (app as any).print = () => {};
    (app as any).flash = () => {};
    await app.switchModel('mini');
    expect(set).toEqual(['m']);
    expect(app.model).toBe('GPT-5 mini');
    await app.cycleModel(1);
    expect(set[1]).toBe('q'); // wraps
    app.noteModel('g');
    expect(app.model).toBe('GPT-5.5');
  });
});

// ---------------------------------------------------------------- /cron + inbox
describe('/cron', () => {
  const now = Date.parse('2026-10-25T09:00:00Z');
  const jobs = [
    { id: 'a', title: 'morning brief', prompt: 'summarize', schedule_text: 'every weekday 8:00', next_run: now / 1000 + 3 * 3600, last_status: 'ok', enabled: true },
    { id: 'b', title: 'watch CI', schedule: { every: '30m' }, next_run: now / 1000 + 12 * 60, last_status: 'error', enabled: true },
    { id: 'c', title: 'deps', schedule: { cron: '0 9 * * 1' }, enabled: false },
  ];
  test('rows: ● title  schedule  next in …  last ✓/✗/—, paused jobs hollow', () => {
    const r = jobs.map((j) => P(cronRow(j, 90, now)));
    expect(r[0]).toMatch(/^● morning brief\s+every weekday 8:00\s+next in 3h\s+last ✓$/);
    expect(r[1]).toMatch(/^● watch CI\s+every 30m\s+next in 12m\s+last ✗$/);
    expect(r[2]).toMatch(/^○ deps\s+0 9 \* \* 1\s+paused\s+last —$/);
  });
  test('panel box: aligned columns, key footer, inline two-step prompt, delete confirm', () => {
    const l = cronPanelLines(jobs, 0, 100, now);
    expect(new Set(l.map(width)).size).toBe(1);
    const plain = l.map(P);
    expect(plain[0]).toContain('◷ cron · 3');
    expect(plain.at(-1)).toContain('n new · enter run now · space pause · d delete · esc close');
    const cols = plain.filter((x) => x.includes('next in')).map((x) => x.indexOf('next in'));
    expect(new Set(cols).size).toBe(1);
    expect(cronPanelLines(jobs, 0, 100, now, { kind: 'when', value: 'every 2h' }).map(P).join('\n')).toContain('› every 2h▏');
    expect(cronPanelLines(jobs, 0, 100, now, { kind: 'what', value: 'x', when: 'every 2h' }).map(P).join('\n')).toContain('when: every 2h');
    expect(cronPanelLines(jobs, 1, 100, now, { kind: 'confirm', text: 'delete “watch CI”?' }).map(P).join('\n')).toContain('delete “watch CI”?  (y/n)');
  });
  test('countdown + relative formatting', () => {
    expect(fmtCountdown(252_000)).toBe('4:12');
    expect(fmtCountdown(42_000)).toBe('0:42');
    expect(fmtCountdown(3_909_000)).toBe('1:05:09');
    expect(fmtCountdown(0)).toBe('now');
    expect(fmtIn(3 * 3600_000)).toBe('in 3h');
    expect(fmtIn(45_000)).toBe('in 45s');
    expect(fmtIn(-1)).toBe('due');
  });
  test('schedule parsing for the inline "when?" prompt', () => {
    expect(parseSchedule('every weekday at 8am')).toEqual({ text: 'every weekday at 8am' });
    expect(parseSchedule('30m')).toEqual({ every: '30m' });
    expect(parseSchedule('every 2h')).toEqual({ every: '2h' });
    expect(parseSchedule('0 8 * * 1-5')).toEqual({ cron: '0 8 * * 1-5' });
  });
  test('inbox: notice line + status badge until viewed', () => {
    expect(P(inboxLine({ title: 'morning brief', text: '3 PRs need review\nmore' }, 80))).toBe('✉ morning brief: 3 PRs need review');
    const app = mkApp();
    (app as any).printSoon = () => {};
    app.onInbox({ item: { id: 'i1', title: 'x', text: 'y' } });
    app.onInbox({ item: { id: 'i1', title: 'x', text: 'y' } }); // deduped
    expect(app.inboxUnseen).toBe(1);
    expect(P(app.statusLine(120))).toContain('✉ 1');
  });
});

// ---------------------------------------------------------------- /loop
describe('/loop', () => {
  test('status segment: count/max + live countdown; running; hidden when stopped', () => {
    const now = 1_000_000;
    expect(P(loopSegment({ active: true, runs: 3, max_runs: 20, next_at: (now + 252_000) / 1000, state: 'waiting' }, now))).toBe('↻ loop 3/20 · next 4:12');
    expect(P(loopSegment({ active: true, runs: 4, max_runs: null, state: 'running' }, now))).toBe('↻ loop 4 · running');
    expect(loopSegment({ active: false, runs: 3 }, now)).toBe('');
    expect(loopSegment({ active: true, runs: 3, state: 'done' }, now)).toBe('');
    setAscii(true);
    expect(P(loopSegment({ active: true, runs: 1, max_runs: 5, state: 'running' }, now))).toBe('@ loop 1/5 | running');
  });
  test('engine-started turns render a dim ↻ loop #n header instead of the user line', () => {
    const t = newTurn('');
    t.header = 'loop #3';
    applyEvent(t, 'delta', { text: 'All green.' });
    applyEvent(t, 'done', {});
    const out = renderTurn(t, 80).map(P);
    expect(out).toContain('↻ loop #3');
    expect(out.some((l) => l.startsWith('›'))).toBe(false);
    const turns = messagesToTurns([{ id: '1', role: 'user', content: 'check ci', meta: { loop: { n: 2 } } } as any, { id: '2', role: 'assistant', content: 'ok' }]);
    expect(turns[0].header).toBe('loop #2');
  });
  test('loop events drive the status line; stop prints a one-line note', () => {
    const app = mkApp();
    const printed: string[][] = [];
    (app as any).printSoon = (l: string[]) => printed.push(l);
    app.sessionId = 's1';
    app.onLoop({ session_id: 's1', n: 2, runs: 2, max_runs: 20, state: 'waiting', next_at: Date.now() / 1000 + 60 });
    expect(P(app.statusLine(140))).toMatch(/↻ loop 2\/20 · next [01]:\d\d/);
    app.onLoop({ session_id: 'other', state: 'stopped' }); // other session: ignored
    expect(app.loop!.active).toBe(true);
    app.onLoop({ session_id: 's1', state: 'stopped', runs: 2 });
    expect(P(app.statusLine(140))).not.toContain('loop');
    expect(P(printed[0][0])).toBe('  ↻ loop stopped after 2 runs');
  });
});

// ---------------------------------------------------------------- /usage
describe('/usage', () => {
  test('sparkline scales to the max; zero days are the floor', () => {
    expect(sparkline([0, 1, 2, 4, 8])).toBe('▁▂▃▅█');
    expect(sparkline([0, 0])).toBe('▁▁');
    setAscii(true);
    expect(sparkline([0, 8])).toBe('_#');
  });
  test('30-day series fills gaps', () => {
    const s = dailySeries([{ date: '2026-10-24', input: 100, output: 20 }], 3, new Date(2026, 9, 25));
    expect(s).toEqual([{ date: '2026-10-23', tokens: 0 }, { date: '2026-10-24', tokens: 120 }, { date: '2026-10-25', tokens: 0 }]);
  });
  test('card: today + 30d totals, cache %, sparkline, per-model table with tok/s, fixed width', () => {
    const u = {
      totals: { turns: 214, input: 3_310_000, output: 251_000, cached: 2_790_000, seconds: 15840, tools: 1290 },
      cache_hit_pct: 84,
      days: [{ date: '2026-10-25', input: 9000, output: 700 }],
      by_model: [{ model: 'qwen3', turns: 151, input: 2_400_000, output: 180_000, tps: 68.4 }, { model: 'gpt-oss', turns: 2, input: 900, output: 70, tps: null }],
      today: { turns: 8, input: 144_000, output: 11_200, cached: 121_000, seconds: 610 },
    };
    const l = usageCard(u, 100, new Date(2026, 9, 25));
    expect(new Set(l.map(width)).size).toBe(1);
    const p = l.map(P).join('\n');
    expect(p).toContain('today    8 turns · 144k in · 11k out · 84% cached · 10m 10s');
    expect(p).toContain('30 days  214 turns · 3.3M in · 251k out · 84% cached · 4h 24m');
    expect(p).toMatch(/tokens   ▁{29}█  peak 9.7k\/day/);
    expect(p).toMatch(/qwen3\s+151\s+2.4M\s+180k\s+68/);
    expect(p).toMatch(/gpt-oss\s+2\s+900\s+70\s+—/);
    expect(p).toContain('1290 tool calls · last 30 days');
  });
});

// ---------------------------------------------------------------- goal
describe('goal', () => {
  const gs = normalizeGoal({ text: 'ship the installer', status: 'active', progress: { done: 3, total: 5 }, todos: [
    { text: 'package', done: true }, { text: 'script', done: true }, { text: 'sign', done: true }, { text: 'test clean box', done: false }, { text: 'notes', done: false },
  ] })!;
  test('banner: ◎ goal  text  ▰▰▰▱▱ 3/5; no progress → just text; truncates to fit', () => {
    expect(P(goalBanner(gs, 80))).toBe('◎ goal  ship the installer  ▰▰▰▱▱ 3/5');
    expect(P(goalBanner(normalizeGoal('write docs')!, 80))).toBe('◎ goal  write docs');
    expect(width(goalBanner(gs, 30))).toBeLessThanOrEqual(30);
    expect(P(goalBanner({ ...gs, status: 'done', progress: { done: 5, total: 5 } }, 80, 'reached'))).toBe('◎ goal reached  ship the installer  ▰▰▰▰▰ 5/5');
    setAscii(true);
    expect(P(goalBanner(gs, 80))).toBe('(o) goal  ship the installer  ###-- 3/5');
  });
  test('progress derived from todos when the engine sends none', () => {
    expect(normalizeGoal({ text: 'x', todos: [{ text: 'a', done: true }, { text: 'b', done: false }] })!.progress).toEqual({ done: 1, total: 2 });
    expect(normalizeGoal({ text: 'x', status: 'cleared' })!.status).toBe('cleared');
    expect(normalizeGoal(null)).toBeNull();
  });
  test('expanded box: ✓ done struck, ▸ first open, ○ pending, aligned', () => {
    const l = goalBox(gs, 100);
    expect(new Set(l.map(width)).size).toBe(1);
    const p = l.map(P);
    expect(p.some((x) => x.includes('✓ package'))).toBe(true);
    expect(l.some((x) => x.includes('\x1b[9mpackage'))).toBe(true);
    expect(p.some((x) => x.includes('▸ test clean box'))).toBe(true);
    expect(p.some((x) => x.includes('○ notes'))).toBe(true);
  });
  test('app: banner pinned above the cat; ctrl+o expands; done celebrates once then fades out', () => {
    const app = mkApp();
    const printed: string[][] = [];
    (app as any).printSoon = (l: string[]) => printed.push(l);
    app.onGoal(gs);
    let box = app.inputBox(120, 1000).lines.map(P);
    expect(box[0]).toBe('  ◎ goal  ship the installer  ▰▰▰▱▱ 3/5');
    expect(box[1]).toContain('/\\_/\\');
    press(app, '\x0f');
    expect(app.goalExpanded).toBe(true);
    expect(app.inputBox(120).lines.map(P)[0]).toContain('◎ goal');
    press(app, '\x0f');
    app.onGoal({ ...gs, status: 'done', progress: { done: 5, total: 5 } });
    app.onGoal({ ...gs, status: 'done', progress: { done: 5, total: 5 } });
    expect(printed.length).toBe(1);
    expect(P(printed[0][0])).toContain('(^.^)✧ goal reached');
    const t0 = app.goalReachedAt;
    expect(P(app.inputBox(120, t0 + 100).lines[0])).toContain('goal reached');
    expect(P(app.inputBox(120, t0 + 3000).lines[0])).toContain('◎ goal  ship');
    expect(P(app.inputBox(120, t0 + 6000).lines[0])).toContain('/\\_/\\'); // gone
    app.onGoal({ text: 'x', status: 'cleared' });
    expect(app.goalState).toBeNull();
  });
});

// ---------------------------------------------------------------- plan
describe('plan card', () => {
  const plan = { title: 'add a --json flag', steps: [{ text: 'read the parser', status: 'done' as const }, { text: 'add flag', status: 'active' as const }, { text: 'write tests', status: 'pending' as const }] };
  test('◇ plan · title, ✓ done dim, ▸ active accent (spinner when live), ○ pending', () => {
    expect(planCard(plan, 80).map(P)).toEqual(['◇ plan · add a --json flag  1/3', '  ✓ 1  read the parser', '  ▸ 2  add flag', '  ○ 3  write tests']);
    const live = planCard(plan, 80, { live: true, now: 0 }).map(P);
    expect(live[2]).toMatch(/^ {2}⠋ 2 {2}add flag$/);
  });
  test('plan events update one card in place inside the turn', () => {
    const t = newTurn('/plan add a --json flag');
    applyEvent(t, 'plan', { title: 'x', steps: [{ text: 'a', status: 'pending' }] });
    applyEvent(t, 'plan', { title: 'x', steps: [{ text: 'a', status: 'done' }, { text: 'b', status: 'active' }] });
    expect(t.parts.filter((p) => p.kind === 'plan').length).toBe(1);
    expect(renderTurn(t, 80).map(P)).toContain('    ✓ 1  a');
  });
  test('waiting prompt: enter go · e edit · esc cancel; enter sends "go"', () => {
    expect(P(planWaitLine(80))).toBe('  ◇ plan ready  enter go · e edit · esc cancel');
    const app = mkApp();
    const sent: string[] = [];
    (app as any).submit = async (t: string) => void sent.push(t);
    app.planWaiting = true;
    press(app, '\r');
    expect(sent).toEqual(['go']);
    app.planWaiting = true;
    press(app, 'e');
    expect(app.ed.value).toBe('change the plan: ');
    app.ed.clear();
    app.planWaiting = true;
    press(app, '\x1b');
    expect(app.planWaiting).toBe(false);
  });
});
