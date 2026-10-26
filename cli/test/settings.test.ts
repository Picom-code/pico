// Usage line, profile pill, compaction tick, tabbed /settings panel, reply styles.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { setAscii, stripAnsi as P, width } from '../src/ansi';
import { Api } from '../src/api';
import { App, replyPreview } from '../src/app';
import { parseKeys } from '../src/keys';
import {
  type SettingsActions, CONFIG_ROWS, changeConfig, lastDays, LOOK_ROWS, type SettingsState, settingsKey, settingsLines, stepValue, TABS,
} from '../src/settings';
import { ctxBar, renderCtx } from '../src/status';
import { applyPrefs, DEFAULT_PREFS, normalizePrefs } from '../src/theme';
import { applyEvent, newTurn, renderTurn, renderUser } from '../src/turn';
import { addDone, emptySession, fmtReset, limitsSegment, normProfile, profilePill, usageLine } from '../src/usage';
import { startMock } from './mock-engine';

afterEach(() => {
  setAscii(false);
  applyPrefs(DEFAULT_PREFS);
});

const report = {
  totals: { turns: 214, input: 1_300_000, output: 100_000, cached: 1_000_000, seconds: 15_840, tools: 1290 },
  cache_hit_pct: 84,
  days: [{ date: '2026-10-26', turns: 31, input: 200_000, output: 12_000, cached: 150_000 }],
  by_model: [{ model: 'qwen3', turns: 151, input: 900_000, output: 80_000, tps: 68.4 }, { model: 'gpt-5.5', turns: 52, input: 400_000, output: 20_000, tps: null }],
  by_harness: [{ harness: 'lean', turns: 160 }, { harness: 'hermes', turns: 54 }],
  today: { turns: 31, input: 200_000, output: 12_000, cached: 150_000 },
};
const NOW = new Date(2026, 9, 26, 12, 0).getTime();
const sess = () => addDone(addDone(emptySession(), { usage: { input: 10_000, output: 800, cached: 8_200 } }), { usage: { input: 2_400, output: 300 } });

// ---------------------------------------------------------------- usage line
describe('usage line', () => {
  test('wide: session in/out/cached, today tokens + turns, 30d total + sparkline', () => {
    const s = P(usageLine({ session: sess(), report, now: NOW }, 120));
    expect(s).toMatch(/^session 12k in · 1.1k out · cached 66% {3}today 212k · 31 turns {3}30d 1.4M [▁▂▃▄▅▆▇█]{7}$/);
    expect(width(s)).toBeLessThanOrEqual(120);
  });
  test('narrow (<70): only session + today', () => {
    expect(P(usageLine({ session: sess(), report, now: NOW }, 60))).toBe('session 14k · today 212k');
  });
  test('drops groups from the right to fit; never wider than cols', () => {
    for (const c of [70, 75, 80, 90, 100]) expect(width(P(usageLine({ session: sess(), report, now: NOW }, c)))).toBeLessThanOrEqual(c);
    expect(P(usageLine({ session: sess(), report, now: NOW }, 72))).not.toContain('30d');
  });
  test('ChatGPT plan instead of cost; $ only when the engine sends cost', () => {
    const s = P(usageLine({ session: sess(), report, chatgpt: true, now: NOW }, 200));
    expect(s).toContain('ChatGPT plan');
    expect(s).not.toContain('$');
    const c = addDone(emptySession(), { usage: { input: 100, output: 10, cost: 0.0123 } });
    expect(P(usageLine({ session: c, now: NOW }, 120))).toContain('$0.01');
  });
  test('limits render Claude-Code-style bars', () => {
    const reset = new Date(2026, 9, 26, 17, 0).getTime() / 1000;
    const s = P(usageLine({ session: sess(), report, limits: { session_pct: 34, resets_at: reset, week_pct: 12 }, now: NOW }, 140));
    expect(s).toContain('session ▰▰▱▱▱▱ 34% · resets 5pm');
    expect(s).toContain('week ▰▱▱▱▱▱ 12%');
    expect(fmtReset(reset, NOW)).toBe('5pm');
    expect(P(limitsSegment({ session_pct: 96 }, NOW, true))).toBe('session ▰▰▰▰▰▰ 96%');
  });
  test('addDone ignores empty slash-command dones; cached from context fraction', () => {
    const s = addDone(emptySession(), { usage: { input: 0, output: 0 } });
    expect(s.turns).toBe(0);
    addDone(s, { usage: { input: 1000, output: 50, last_input: 1000 }, context: { cached: 0.5 } });
    expect(s).toMatchObject({ input: 1000, output: 50, cached: 500, turns: 1 });
  });
  test('ASCII sparkline + bars', () => {
    setAscii(true);
    const s = P(usageLine({ session: sess(), report, limits: { session_pct: 50 }, now: NOW }, 120));
    expect(s).toContain('session ###--- 50%');
  });
});

// ---------------------------------------------------------------- app wiring
const mkApp = (cols = 120) => {
  const app = new App({} as any, { version: '0.1.0' });
  (app as any).term = { cols, rows: 30, write() {}, onKey() {}, onResizeEvent() {} };
  (app as any).render = () => {};
  app.model = 'qwen3';
  return app;
};

describe('status + usage line in the app', () => {
  test('usage line is off by default; on in prefs shows it after the first done', () => {
    expect(DEFAULT_PREFS.usageLine).toBe(false);
    applyPrefs({ ...DEFAULT_PREFS, usageLine: true });
    const app = mkApp();
    expect(app.usageText(120)).toBe('');
    (app as any).onDoneUsage({ usage: { input: 12_000, output: 1_100 } });
    app.usageReport = report as any;
    expect(P(app.usageText(120))).toStartWith('session 12k in · 1.1k out');
    expect(P(app.usageText(60))).toBe('session 13k · today 212k');
    applyPrefs({ ...DEFAULT_PREFS, usageLine: false });
    expect(app.usageText(120)).toBe('');
  });
  test('profile pill after context; amber > 90%; hidden < 70 cols', () => {
    const app = mkApp();
    app.ctx = { used: 9000, max: 131072, shown: 9000 };
    app.profile = normProfile({ tokens: 210, budget: 300 });
    expect(P(app.statusLine(120))).toMatch(/9k\/128k · you ▰▰▰▱ 210/);
    expect(P(app.statusLine(65))).not.toContain('you');
    expect(profilePill({ tokens: 290, budget: 300 })).toMatch(/38;(5;214|2;255;175;0)m/);
    expect(normProfile({ tokens: 1 })).toBeNull();
  });
  test('context max_effective wins; compaction tick at at_pct', () => {
    const app = mkApp();
    (app as any).applyContext({ used: 10_000, max: 200_000, max_effective: 100_000 });
    expect(app.ctx.max).toBe(100_000);
    app.config = { compaction: { auto: true, at_pct: 80 } };
    app.applyCompactionCfg();
    expect(app.ctx.atPct).toBe(0.8);
    expect(P(ctxBar(0.1, 10, undefined, 0, 0.8))).toBe('▰▱▱▱▱▱▱▱┊▱▱');
    app.ctx.shown = app.ctx.used;
    expect(P(renderCtx(app.ctx))).toContain('┊');
    expect(P(renderCtx(app.ctx, Date.now(), true))).not.toContain('┊'); // narrow: no tick
    app.config = { compaction: { auto: false, at_pct: 80 } };
    app.applyCompactionCfg();
    expect(app.ctx.atPct).toBeUndefined();
  });
  test("auto compaction: flash + dim '↺ auto-compacted (kept last 6)' in the turn", () => {
    const app = mkApp();
    app.turn = newTurn('x');
    (app as any).onCompacted({ before: 92_000, after: 18_000, auto: true, reason: 'threshold', kept: 6 });
    expect(P(renderCtx({ ...app.ctx, shown: app.ctx.used, max: 131072 }))).toContain('↺ compacted 92k→18k');
    expect(renderTurn(app.turn!, 80).map(P)).toContain('  ↺ auto-compacted (kept last 6)');
  });
});

// ---------------------------------------------------------------- settings panel
const state = (tab = 0): SettingsState => ({
  tab,
  row: {},
  cfg: { effort_default: 'medium', approvals: 'ask', harness: 'lean', subagents: { enabled: true, max_parallel: 3 }, compaction: { auto: true, at_pct: 80, keep_recent: 6, mode: 'summary', notify: true } },
  prefs: { ...DEFAULT_PREFS },
  efforts: ['low', 'medium', 'high'],
  usage: report as any,
  status: {
    version: '0.1.0', engineUrl: 'http://127.0.0.1:7878', health: { ok: true, version: '0.1.0', state: 'ready' }, model: 'qwen3', providerLabel: 'This computer', harness: 'lean',
    cwd: '/tmp/x', sessionId: 's_1', chatgptLoggedIn: false, ctx: { used: 9000, max: 131072, cached: 0.9 },
    profile: { tokens: 210, budget: 300, user_notes: 6, memory_notes: 8, skills_index_tokens: 420, agents_md_tokens: 1180, total_standing_tokens: 3410 },
  },
});
const keys = (s: SettingsState, str: string, act: SettingsActions = { patchConfig: async () => ({}), setPrefs: () => {} }) => {
  let r: any;
  for (const k of parseKeys(str)) r = settingsKey(s, k, act);
  return r;
};

describe('/settings panel', () => {
  test('tabs across the top; active tab underlined; same width on every tab', () => {
    const widths = new Set<number>();
    for (let i = 0; i < TABS.length; i++) {
      const lines = settingsLines(state(i), 100, NOW);
      expect(P(lines[1])).toContain(' Status   Config   Usage   Look & feel ');
      for (const l of lines) widths.add(width(P(l)));
    }
    expect(widths.size).toBe(1);
    expect(settingsLines(state(2), 100, NOW)[1]).toContain('\x1b[1m'); // active tab bold
  });
  test('←→ / tab / shift+tab / 1-4 switch tabs; esc closes', () => {
    const s = state(0);
    keys(s, '\x1b[C');
    expect(s.tab).toBe(1);
    keys(s, '\t\t');
    expect(s.tab).toBe(3);
    keys(s, '\x1b[C');
    expect(s.tab).toBe(0);
    keys(s, '\x1b[Z');
    expect(s.tab).toBe(3);
    keys(s, '3');
    expect(s.tab).toBe(2);
    expect(keys(s, '\x1b')).toBe('close');
  });
  test('Status tab: engine, model, ChatGPT, context, standing prompt breakdown + /lean hint', () => {
    const out = settingsLines(state(0), 100, NOW).map(P).join('\n');
    for (const want of ['pico 0.1.0', 'http://127.0.0.1:7878', 'ready', 'qwen3 · This computer', 'not signed in', 's_1', '9k/128k cached 90%', 'standing prompt', 'skills index', '420 tok', 'AGENTS.md', '1.2k tok', '3.4k tok', 'run /lean to slim it', '6 about you · 8 memories'])
      expect(out).toContain(want);
  });
  test('Config tab: sections, compaction rows, ↑↓ moves, values step and clamp', () => {
    const s = state(1);
    let out = settingsLines(s, 100, NOW).map(P).join('\n');
    expect(out).toContain('compaction');
    expect(out).toContain('compact at');
    expect(out).toContain('80%');
    expect(out).toContain('6 messages');
    const at = CONFIG_ROWS.find((r) => r.key === 'c_at')!;
    expect(stepValue(at, s, 1)).toBe(85);
    s.cfg.compaction.at_pct = 95;
    expect(stepValue(at, s, 1)).toBe(95); // clamps
    s.cfg.compaction.at_pct = 50;
    expect(stepValue(at, s, -1)).toBe(50);
    const keep = CONFIG_ROWS.find((r) => r.key === 'c_keep')!;
    s.cfg.compaction.keep_recent = 20;
    expect(stepValue(keep, s, 1)).toBe(20);
    keys(s, '\x1b[B\x1b[B');
    expect(s.row[1]).toBe(2);
    out = settingsLines(s, 100, NOW).map(P).join('\n');
    expect(out).toContain('❯ subagents');
    expect(out).not.toContain('harness');
  });
  test('Config writes: approvals/harness/compaction hit PATCH /api/config with the right body; ✓ flash; errors revert', async () => {
    const bodies: any[] = [];
    const act = { patchConfig: async (b: any) => (bodies.push(b), { ok: true }), setPrefs: () => {} };
    const s = state(1);
    s.row[1] = CONFIG_ROWS.findIndex((r) => r.key === 'approvals');
    await keys(s, '\r', act);
    expect(bodies.at(-1)).toEqual({ approvals: 'yolo' });
    expect(s.cfg.approvals).toBe('yolo');
    expect(P(settingsLines(s, 100, Date.now()).at(-1)!)).toContain('✓ saved approvals yolo');
    s.row[1] = CONFIG_ROWS.findIndex((r) => r.key === 'c_at');
    await keys(s, '+', act);
    expect(bodies.at(-1)).toEqual({ compaction: { auto: true, at_pct: 85, keep_recent: 6, mode: 'summary', notify: true } });
    s.row[1] = CONFIG_ROWS.findIndex((r) => r.key === 'c_mode');
    await keys(s, '\r', act);
    expect(bodies.at(-1).compaction.mode).toBe('trim');
    const bad = { patchConfig: async () => Promise.reject(new Error('400 nope')), setPrefs: () => {} };
    s.row[1] = CONFIG_ROWS.findIndex((r) => r.key === 'effort');
    await changeConfig(s, CONFIG_ROWS[s.row[1]], 1, bad);
    expect(s.cfg.effort_default).toBe('medium');
    expect(s.flash?.error).toBe(true);
  });
  test('Config display rows save TUI prefs (usage line toggle)', () => {
    const saved: any[] = [];
    const s = state(1);
    s.row[1] = CONFIG_ROWS.findIndex((r) => r.key === 'usageLine');
    keys(s, '\r', { patchConfig: async () => ({}), setPrefs: (p: any) => saved.push(p) });
    expect(typeof saved.at(-1).usageLine).toBe('boolean');
  });
  test('Usage tab: today / 7d / 30d bars, sparkline, per-model tok/s, no harness split', () => {
    const out = settingsLines(state(2), 110, NOW).map(P);
    const j = out.join('\n');
    expect(j).toMatch(/today\s+[▰▱]+ 200k in · 12k out · 75% cached · 31 turns/);
    expect(j).toMatch(/7 days/);
    expect(j).toMatch(/30 days\s+▰+ 1.3M in · 100k out · 84% cached · 214 turns · 4h 24m/);
    expect(j).toContain('per day');
    expect(j).toMatch(/qwen3\s+151\s+980k\s+68/);
    expect(j).toMatch(/gpt-5.5\s+52\s+420k\s+—/);
    expect(j).not.toContain('hermes');
    expect(lastDays(report as any, 7, new Date(NOW)).turns).toBe(31);
  });
  test('Usage tab with limits shows plan bars', () => {
    const s = state(2);
    s.limits = { session_pct: 34, week_pct: 12 };
    const j = settingsLines(s, 110, NOW).map(P).join('\n');
    expect(j).toContain('plan limits');
    expect(j).toMatch(/session\s+▰+▱+ 34%/);
  });
  test('Look & feel: reply style row cycles band → label → bar → plain and saves', () => {
    const saved: any[] = [];
    const s = state(3);
    s.row[3] = LOOK_ROWS.findIndex((r) => r.key === 'reply');
    expect(settingsLines(s, 100, NOW).map(P).join('\n')).toContain('band');
    for (const want of ['label', 'bar', 'plain', 'band']) {
      keys(s, '\r', { patchConfig: async () => ({}), setPrefs: (p: any) => saved.push(p) });
      expect(s.prefs.reply).toBe(want as any);
    }
    expect(saved.length).toBe(4);
  });
  test('narrow panel (60 cols) stays within the terminal', () => {
    for (let i = 0; i < 4; i++) for (const l of settingsLines(state(i), 60, NOW)) expect(width(P(l))).toBeLessThanOrEqual(60);
  });
});

// ---------------------------------------------------------------- reply styles
describe('reply styles', () => {
  const done = () => {
    const t = newTurn('yo testing123');
    applyEvent(t, 'delta', { text: 'Loud and clear.' });
    applyEvent(t, 'done', { seconds: 1.3, tps: 6 });
    return t;
  };
  test('band: full-width background on every user line, accent ›, (^.^) pico header, 2-space reply', () => {
    const raw = renderTurn(done(), 60, { style: 'band' });
    const out = raw.map(P);
    expect(out[0]).toBe('');
    expect(out[1]).toBe(' › yo testing123'.padEnd(60));
    expect(raw[1]).toMatch(/\x1b\[48;(5;236|2;36;36;43)m/);
    expect(out[2]).toBe('');
    expect(out[3]).toBe('(^.^) pico');
    expect(out).toContain('  Loud and clear.');
    expect(out.at(-1)).toMatch(/^ {2}\(\^\.\^\)✧ done in 1.3s/);
    const wrapped = renderUser('word '.repeat(30).trim(), 40, [], 'band');
    expect(wrapped.length).toBeGreaterThan(1);
    for (const l of wrapped) {
      expect(width(P(l))).toBe(40);
      expect(l).toContain('\x1b[48;');
    }
  });
  test('band header face follows the final mood: (x.x) on error', () => {
    const t = newTurn('x');
    applyEvent(t, 'error', { message: 'boom' });
    expect(renderTurn(t, 60, { style: 'band' }).map(P)).toContain('(x.x) pico');
  });
  test('label: you / (^.^) pico, no background', () => {
    const raw = renderTurn(done(), 60, { style: 'label' });
    const out = raw.map(P);
    expect(out.slice(1, 3)).toEqual(['you', '  yo testing123']);
    expect(out).toContain('(^.^) pico');
    expect(raw.join('')).not.toContain('\x1b[48;');
  });
  test('bar: dim ▌ on the user msg, accent ▌ on the reply', () => {
    const out = renderTurn(done(), 60, { style: 'bar' }).map(P);
    expect(out[1]).toBe('▌ yo testing123');
    expect(out).toContain('▌ Loud and clear.');
    expect(out.at(-1)).toMatch(/^▌ \(\^\.\^\)✧/);
  });
  test('plain: the old look', () => {
    const out = renderTurn(done(), 60, { style: 'plain' }).map(P);
    expect(out.slice(0, 4)).toEqual(['', '› yo testing123', '', '  Loud and clear.']);
  });
  test('ASCII fallback: > prefix + pico: label, no band', () => {
    setAscii(true);
    const raw = renderTurn(done(), 60, { style: 'band' });
    const out = raw.map(P);
    expect(out[1]).toBe('> yo testing123');
    expect(out[3]).toBe('pico:');
    expect(raw.join('')).not.toContain('\x1b[48;');
  });
  test('/copy copies the reply text only (no band / header chars)', () => {
    const app = mkApp();
    app.history.push({ kind: 'turn', turn: done() });
    let wrote = '';
    (app as any).term.write = (s: string) => (wrote += s);
    (app as any).copyLast();
    const b64 = wrote.match(/\x1b\]52;c;([^\x07]+)/)?.[1] ?? '';
    expect(Buffer.from(b64, 'base64').toString()).toBe('Loud and clear.');
  });
  test('reply pref persists; unknown values fall back to band', () => {
    expect(normalizePrefs({ reply: 'bar' }).reply).toBe('bar');
    expect(normalizePrefs({ reply: 'neon' }).reply).toBe('band');
    expect(DEFAULT_PREFS.reply).toBe('band');
  });
  test('look & feel preview renders the chosen style', () => {
    expect(replyPreview({ ...DEFAULT_PREFS, reply: 'bar' }, 60).map(P).join('\n')).toContain('▌ Fixed it');
    expect(replyPreview({ ...DEFAULT_PREFS, reply: 'band' }, 60).map(P).join('\n')).toContain('(^.^) pico');
  });
  test('reflow: band re-renders to the new width', () => {
    const t = done();
    expect(width(P(renderTurn(t, 50, { style: 'band' })[1]))).toBe(50);
    expect(width(P(renderTurn(t, 90, { style: 'band' })[1]))).toBe(90);
  });
});

// ---------------------------------------------------------------- mock engine endpoints
describe('config writes against the mock engine', () => {
  let server: ReturnType<typeof startMock>;
  let api: Api;
  beforeAll(() => {
    server = startMock({ port: 0, fast: true });
    api = new Api(`http://127.0.0.1:${server.port}`);
    api.token = 'test-token';
  });
  afterAll(() => server.stop(true));
  test('approvals, compaction land in PATCH /api/config; profile context readable', async () => {
    const s = state(1);
    const act = { patchConfig: (b: any) => api.patchConfig(b), setPrefs: () => {} };
    for (const key of ['approvals', 'c_keep', 'c_notify']) {
      s.row[1] = CONFIG_ROWS.findIndex((r) => r.key === key);
      await keys(s, '\r', act);
    }
    const last = await api.get<any>('/api/mock/last-config');
    expect(last.approvals).toBe('yolo');
    expect(last.compaction).toMatchObject({ keep_recent: 7, notify: false });
    expect(last.patches.map((p: any) => Object.keys(p)[0])).toEqual(['approvals', 'compaction', 'compaction']);
    expect(normProfile(await api.get('/api/profile/context'))).toMatchObject({ tokens: 210, budget: 300 });
  });
});
