// Mock Pico engine implementing docs/API.md with canned streaming responses.
//   bun test/mock-engine.ts [--port 7979] [--setup] [--token secret] [--fast]
// Prompts containing keywords trigger scenarios: "tool", "approve", "todo", "think", "error", "long", "agents",
// "remember", "compact", "fill" (context to ~90%), "half" (~60%).
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string', default: '7979' },
    setup: { type: 'boolean', default: false },
    token: { type: 'string', default: 'test-token' },
    fast: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

export function startMock(opts: { port?: number; setup?: boolean; token?: string; fast?: boolean } = {}) {
  const TOKEN = opts.token ?? 'test-token';
  const speed = opts.fast ? 0.1 : 1;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * speed));
  let state: 'setup' | 'ready' = opts.setup ? 'setup' : 'ready';
  let activeModel = 'qwen3-coder-30b-a3b';
  const sessions = new Map<string, any>();
  let approvals: string = 'ask';
  let harness: string = 'lean';
  let compaction: any = { auto: true, at_pct: 80, keep_recent: 6, mode: 'summary', notify: true };
  const patches: any[] = [];
  const profileCtx = { tokens: 210, budget: 300, notes: 14, user_notes: 6, memory_notes: 8, skills_index_tokens: 420, agents_md_tokens: 1180, total_standing_tokens: 3410, estimate: false };
  const pending = new Map<string, (v: { allow: boolean; always?: boolean }) => void>();
  const stops = new Set<string>();
  const jobs = new Map<string, number>();
  let n = 0;
  let subagents: any = { enabled: true, max_parallel: 3, model: '', effort: 'low', max_seconds: 600 };
  const eventSubs = new Set<(ev: string, d: unknown) => void>();
  const broadcast = (ev: string, d: unknown) => {
    for (const f of eventSubs) f(ev, d);
  };
  const id = (p: string) => `${p}_${(++n).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const models: any[] = [
    { id: 'qwen3-coder-30b-a3b', name: 'Qwen3-Coder 30B-A3B', provider: 'llama.cpp', provider_label: 'Local · llama.cpp', local: true, ctx: 131072, tps: 72, tps_measured: 68.4 },
    { id: 'gpt-oss-20b', name: 'gpt-oss 20B', provider: 'llama.cpp', provider_label: 'Local · llama.cpp', local: true, ctx: 131072, tps: 88, tps_measured: null },
    { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai_login', provider_label: 'ChatGPT subscription', local: false, ctx: 272000, tps: null, tps_measured: 51.2 },
    { id: 'gpt-5-mini', name: 'GPT-5 mini', provider: 'openai_login', provider_label: 'ChatGPT subscription', local: false, ctx: 272000, tps: null, tps_measured: null },
  ];
  let effortDefault = 'medium';
  let loginPolls = 0;
  let lastSetup: any = null;
  // ---- new-feature state: checkins, loops, session relay streams
  const checkins: any[] = [
    { id: 'c_brief', title: 'morning brief', prompt: 'summarize my inbox and calendar', schedule: { text: 'every weekday at 8am' }, schedule_text: 'every weekday 8:00', next_run: Date.now() / 1000 + 3 * 3600, last_run: Date.now() / 1000 - 21 * 3600, last_status: 'ok', enabled: true, session_id: null },
    { id: 'c_ci', title: 'watch CI', prompt: 'check the CI status of main and tell me if it broke', schedule: { every: '30m' }, schedule_text: 'every 30m', next_run: Date.now() / 1000 + 12 * 60, last_run: Date.now() / 1000 - 18 * 60, last_status: 'error', enabled: true, session_id: null },
    { id: 'c_deps', title: 'dependency bumps', prompt: 'look for outdated deps', schedule: { cron: '0 9 * * 1' }, schedule_text: 'mondays 9:00', next_run: null, last_run: null, last_status: null, enabled: false, session_id: null },
  ];
  const streamSubs = new Map<string, Set<(ev: string, d: unknown) => void>>();
  const relay = (sid: string, ev: string, d: unknown) => {
    for (const f of streamSubs.get(sid) || []) f(ev, d);
  };
  const loops = new Map<string, any>();
  const recipe = (o: any) => ({ flags: ['-fa', '--jinja'], runtime: 'llama.cpp', tps_source: 'measured', fits: true, ...o });
  const recipes = {
    recommended: recipe({ id: 'qwen3-coder-30b-q4', model: 'Qwen3-Coder 30B-A3B', family: 'qwen3', params_b: 30, active_b: 3, quant: 'Q4_K_M', file_gb: 18.6, ctx: 65536, est_tps: 72, strengths: ['coding', 'speed'], why: 'Best coding model that fits your 64 GB with room for context.' }),
    alternatives: [
      recipe({ id: 'gpt-oss-20b-mxfp4', model: 'gpt-oss 20B', family: 'gpt-oss', params_b: 21, active_b: 3.6, quant: 'MXFP4', file_gb: 12.1, ctx: 131072, est_tps: 88, strengths: ['speed', 'writing'], why: 'Faster, longer context, a little weaker at code.' }),
      recipe({ id: 'gemma3-12b-q4', model: 'Gemma 3 12B', family: 'gemma3', params_b: 12, quant: 'Q4_K_M', file_gb: 7.3, ctx: 32768, est_tps: 45, tps_source: 'est', strengths: ['vision', 'writing'], why: 'Small and sees images.' }),
    ],
    catalog_version: '2026.10.20',
  };

  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
  const sse = (gen: (send: (ev: string, d: unknown) => void, signal: AbortSignal) => Promise<void>, req: Request) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctl) {
        const send = (ev: string, d: unknown) => {
          try {
            ctl.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`));
          } catch {}
        };
        try {
          ctl.enqueue(enc.encode(': hello\n\n'));
          await gen(send, req.signal);
        } catch {}
        try {
          ctl.close();
        } catch {}
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  };

  async function streamReply(s: any, text: string, effort: string, send: (ev: string, d: unknown) => void, signal: AbortSignal) {
    const started = Date.now();
    const stopped = () => stops.has(s.id) || signal.aborted;
    const lower = text.toLowerCase();
    const say = async (str: string, chunk = 6, delay = 25) => {
      for (let i = 0; i < str.length && !stopped(); i += chunk) {
        takeSteers();
        send('delta', { text: str.slice(i, i + chunk) });
        await sleep(delay);
      }
      takeSteers();
    };
    const takeSteers = () => {
      while (s.steers?.length) {
        const st = s.steers.shift();
        send('steer', { text: st, applied: true });
        send('delta', { text: `\n\n_(steered: ${st})_\n\n` });
      }
    };
    let reply = '';
    if (lower.includes('ponder')) {
      const lines = ['The test fails on the last element, so the loop bound is suspect.', 'range(n - 1) stops one short; it should be range(n).', 'I will read calc.py, patch the bound, then run the tests.'];
      for (const l of lines) {
        for (let i = 0; i < l.length && !stopped(); i += 6) {
          send('reasoning', { text: l.slice(i, i + 6) });
          await sleep(40);
        }
        send('reasoning', { text: '\n' });
      }
    } else if ((effort !== 'off' && effort !== 'low') || lower.includes('think')) {
      const th = `The user said "${text.slice(0, 40)}". Let me consider the codebase layout first, then decide which tool to use. Effort is ${effort}.`;
      for (let i = 0; i < th.length && !stopped(); i += 8) {
        send('reasoning', { text: th.slice(i, i + 8) });
        await sleep(30);
      }
    }
    if (lower.includes('todo')) {
      s.todos = [
        { text: 'Read the project layout', done: false },
        { text: 'Write the failing test', done: false },
        { text: 'Fix the bug', done: false },
      ];
      send('todo', { todos: s.todos });
      await sleep(300);
      s.todos[0].done = true;
      send('todo', { todos: s.todos });
      await sleep(300);
    }
    let tools = 0;
    s.lastChange = null;
    const files: { path: string; added: number; removed: number }[] = [];
    if (lower.includes('tool') || lower.includes('todo')) {
      // two parallel tools: a terminal with live progress, then an edit with a diff
      send('tool_start', { id: 't1', name: 'terminal', args: { command: 'npm test' }, label: 'npm test' });
      send('tool_start', { id: 't2', name: 'read_file', args: { path: 'src/app.ts' } });
      await sleep(250);
      send('tool_end', { id: 't2', name: 'read_file', ok: true, result_preview: '1| // Interactive chat TUI.\n2| import x', seconds: 0.2 });
      const out = ['> pico@0.1.0 test', '> bun test', 'test/unit.test.ts:', '(pass) context bar > thresholds', '(pass) diff renderer > truncation', '(pass) summary > formatting'];
      for (let i = 1; i <= out.length; i++) {
        send('tool_progress', { id: 't1', tail: out.slice(Math.max(0, i - 4), i) });
        await sleep(260);
      }
      await sleep(lower.includes('slow') ? 2500 : 0);
      send('tool_end', { id: 't1', name: 'terminal', ok: true, result_preview: '42 pass, 0 fail', seconds: 2.1 });
      send('tool_start', { id: 't3', name: 'patch', args: { path: 'src/app.ts' } });
      await sleep(300);
      const unified = [
        '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -40,7 +40,9 @@ export class App {',
        '   model = \'\';', '-  ctxMax = 0;', '-  ctxUsed = 0;', '+  ctx: CtxState = { used: 0, max: 0, shown: 0 };', '+  mood: MoodState = { busy: null, lastActivity: Date.now() };',
        '+  history: Item[] = [];', '   tps = 0;', '   cwd = process.cwd();',
        '@@ -120,4 +122,12 @@ export class App {',
        ...Array.from({ length: 10 }, (_, i) => `+  // redraw step ${i + 1}`), '   render() {',
      ].join('\n');
      send('tool_end', { id: 't3', name: 'patch', ok: true, result_preview: 'patched', seconds: 0.3, diff: { path: 'src/app.ts', added: 13, removed: 2, unified, created: false } });
      tools = 3;
      files.push({ path: 'src/app.ts', added: 13, removed: 2 });
      s.lastChange = { restored: ['src/app.ts'], deleted: [] as string[] };
      if (lower.includes('new file')) {
        send('tool_start', { id: 't4', name: 'write_file', args: { path: 'new.txt' } });
        await sleep(150);
        send('tool_end', { id: 't4', name: 'write_file', ok: true, seconds: 0.1, diff: { path: 'new.txt', added: 2, removed: 0, created: true, unified: '@@ -0,0 +1,2 @@\n+hello\n+world' } });
        tools++;
        files.push({ path: 'new.txt', added: 2, removed: 0 });
        s.lastChange.deleted.push('new.txt');
      }
    }
    if (lower.includes('agents')) {
      const goals = ['Survey the renderer for flicker', 'Write tests for the context bar', 'Check Windows console fallbacks'];
      goals.forEach((g, i) => send('subagent_start', { id: `a${i}`, goal: g, model: 'gpt-oss-20b' }));
      const steps = [['reading src/tty.ts', 'diffing frames', 'measuring bytes/frame'], ['writing status.test.ts', 'running bun test'], ['grepping for win32', 'checking PICO_ASCII', 'reading ansi.ts']];
      for (let k = 0; k < 3; k++) {
        for (let i = 0; i < 3; i++) if (steps[i][k]) send('subagent_progress', { id: `a${i}`, label: steps[i][k], tail: [`$ ${steps[i][k]}`] });
        await sleep(450);
        if (k === 1) send('subagent_end', { id: 'a1', ok: true, summary: 'Added 6 tests covering 49/50/80/95% thresholds.\nAll pass.', seconds: 1.0, tokens: 1840 });
      }
      await sleep(lower.includes('slow') ? 2500 : 0);
      send('subagent_end', { id: 'a0', ok: true, summary: 'Renderer only rewrites changed rows; ~40 bytes per spinner frame.', seconds: 1.4, tokens: 3120 });
      send('subagent_end', { id: 'a2', ok: false, summary: 'conhost check needs a Windows box; skipped.', seconds: 1.4, tokens: 960 });
    }
    if (lower.includes('remember')) {
      send('notice', { kind: 'memory', text: 'dog is Biscuit' });
      setTimeout(() => broadcast('notice', { session_id: s.id, kind: 'skill', text: 'deploy-checklist' }), 600 * speed + 300);
    }
    if (lower.includes('approve') && s.yolo) {
      send('tool_start', { id: 't3', name: 'terminal', args: { command: 'rm -rf ./build' }, label: 'terminal `rm -rf ./build`' });
      send('notice', { kind: 'yolo', text: 'auto-approved: rm -rf ./build' });
      await sleep(200);
      send('tool_end', { id: 't3', name: 'terminal', ok: true, result_preview: '' });
      reply += 'Cleaned the build directory.\n\n';
    } else if (lower.includes('approve')) {
      const aid = id('ap');
      send('approval', { id: aid, command: 'rm -rf ./build', reason: 'Delete the build directory to force a clean rebuild.' });
      const ans = await new Promise<{ allow: boolean; always?: boolean }>((res) => {
        pending.set(aid, res);
        signal.addEventListener('abort', () => res({ allow: false }));
      });
      if (ans.allow) {
        send('tool_start', { id: 't3', name: 'terminal', args: { command: 'rm -rf ./build' } });
        await sleep(200);
        send('tool_end', { id: 't3', name: 'terminal', ok: true, result_preview: '' });
        reply += 'Cleaned the build directory.\n\n';
      } else reply += 'Okay, I left the build directory alone.\n\n';
    }
    if (lower.includes('slowly')) {
      // long-running prose so a steer can land mid-reply
      for (let i = 0; i < 14 && !stopped(); i++) {
        takeSteers();
        send('delta', { text: `Working through part ${i + 1} of the answer. ` });
        await sleep(350);
      }
      takeSteers();
    }
    if (lower.includes('goal step') && s.goalState) {
      const gs = s.goalState;
      const k = gs.todos.findIndex((x: any) => !x.done);
      if (k >= 0) gs.todos[k].done = true;
      gs.progress = { done: gs.todos.filter((x: any) => x.done).length, total: gs.todos.length };
      if (gs.progress.done === gs.progress.total) gs.status = 'done';
      send('goal', gs);
    }
    if (lower.includes('error')) {
      send('error', { message: 'model server crashed (mock)' });
      return;
    }
    if (lower.includes('say hi') || lower === 'hi') reply += 'Hi! 👋';
    else if (lower.includes('testing123')) reply += 'Loud and clear.';
    else if (lower.includes('long')) reply += Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long answer.`).join('\n');
    else
      reply +=
        '## Summary\n\nHere is what I found in **your project**:\n\n- The entry point is `src/main.ts`\n- Tests live in *test/*\n  - nested item\n1. first\n2. second\n\n```ts\n// greet\nexport function hi(name: string) {\n  return `hello ${name}` + 42;\n}\n```\n\n> Note: this is a mock reply.\n\nSee [docs](https://pico.dev/docs).';
    if (lower.includes('todo')) {
      s.todos.forEach((x: any) => (x.done = true));
      send('todo', { todos: s.todos });
    }
    if (lower.includes('autocompact')) {
      const before = Math.max(s.ctxUsed || 0, Math.round(s.ctxMax * 0.86));
      s.ctxUsed = Math.round(before * 0.2);
      send('compacted', { before, after: s.ctxUsed, auto: true, reason: 'threshold', kept: compaction.keep_recent });
    }
    await say(reply);
    const secs = (Date.now() - started) / 1000;
    const output = Math.round(reply.length / 4) + 40;
    if (lower.includes('fill')) s.ctxUsed = Math.round(s.ctxMax * 0.9);
    else if (lower.includes('half')) s.ctxUsed = Math.round(s.ctxMax * 0.62);
    else s.ctxUsed = (s.ctxUsed || 0) + 9000 + output;
    if (lower.includes('compact') && !lower.includes('autocompact')) {
      const before = s.ctxUsed;
      s.ctxUsed = Math.round(before * 0.2);
      send('compacted', { before, after: s.ctxUsed });
    }
    s.messages.push({ id: id('m'), role: 'assistant', content: reply, created: Date.now() / 1000, usage: { input: 1200, output } });
    send('done', {
      model: activeModel,
      message_id: id('m'), usage: { input: s.ctxUsed - output, output, last_input: s.ctxUsed }, tps: 142.3, seconds: Math.round(secs * 10) / 10,
      context: { used: s.ctxUsed, max: s.ctxMax, cached: 0.92 },
      profile: { tokens: profileCtx.tokens, budget: profileCtx.budget },
      harness,
      summary: { tools, files_changed: files, seconds: Math.round(secs * 10) / 10, tps: 142.3, output_tokens: output },
      yolo: !!s.yolo,
    });
  }

  function stopLoop(s: any, state: 'stopped' | 'done') {
    const L = loops.get(s.id);
    if (!L) return;
    clearTimeout(L.timer);
    loops.delete(s.id);
    broadcast('loop', { session_id: s.id, n: L.runs, runs: L.runs, max_runs: L.max_runs, next_at: null, state, active: false });
  }
  function startLoop(s: any, prompt: string, every_s: number, max_runs: number) {
    if (loops.has(s.id)) stopLoop(s, 'stopped');
    const L: any = { prompt, every_s, runs: 0, max_runs, next_at: Date.now() / 1000 + 1.2, timer: null };
    loops.set(s.id, L);
    const tick = async () => {
      if (loops.get(s.id) !== L) return;
      L.runs++;
      broadcast('loop', { session_id: s.id, n: L.runs, runs: L.runs, max_runs: L.max_runs, next_at: null, state: 'running', active: true });
      const send = (ev: string, d: unknown) => relay(s.id, ev, d);
      s.messages.push({ id: id('m'), role: 'user', content: prompt, created: Date.now() / 1000, meta: { loop: { n: L.runs } } });
      send('user', { text: prompt, meta: { loop: { n: L.runs } } });
      stops.delete(s.id);
      s.running = true;
      try {
        await streamReply(s, `${prompt} say hi`, 'low', send, new AbortController().signal);
      } finally {
        s.running = false;
      }
      if (loops.get(s.id) !== L) return;
      if (L.runs >= L.max_runs) return stopLoop(s, 'done');
      L.next_at = Date.now() / 1000 + L.every_s;
      broadcast('loop', { session_id: s.id, n: L.runs, runs: L.runs, max_runs: L.max_runs, next_at: L.next_at, state: 'waiting', active: true });
      L.timer = setTimeout(tick, L.every_s * 1000);
    };
    L.timer = setTimeout(tick, 1200);
  }

  const server = Bun.serve({
    port: opts.port ?? 7979,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const m = req.method;
      if (p === '/api/health') return json({ ok: true, version: '0.1.0-mock', state, model: state === 'ready' ? activeModel : null, provider: state === 'ready' ? 'local' : null });
      if (p === '/api/pair/claim') return json({ token: TOKEN });
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}` && url.searchParams.get('token') !== TOKEN) return json({ error: 'unauthorized' }, 401);
      const body: any = m === 'GET' || m === 'DELETE' ? {} : await req.json().catch(() => ({}));
      let mm: RegExpMatchArray | null;

      if (p === '/api/system')
        return json({
          os: 'macOS 26.3', arch: 'arm64', cpu: { name: 'Apple M4 Max', cores: 16 }, ram_gb: 64,
          gpus: [{ vendor: 'apple', name: 'Apple M4 Max GPU (40-core)', vram_gb: 48, driver: 'Metal 4', compute: 'metal' }],
          unified_memory: true, disk_free_gb: 412, accelerators: ['metal', 'cpu'], runtimes: { llama_cpp: 'b6500', ollama: null, lmstudio: null, vllm: null },
        });
      if (p === '/api/config' && m === 'GET') return json({ persona: 'engineer', provider: { kind: 'local' }, model: activeModel, effort_default: effortDefault, accent: 'pink', features: { voice: false, image: false, video: false }, subagents, approvals, harness, compaction, efforts: ['low', 'medium', 'high'] });
      if (p === '/api/config' && m === 'PATCH') {
        patches.push(body);
        if (body.approvals && !['ask', 'auto', 'yolo'].includes(body.approvals)) return json({ error: 'approvals must be ask, auto or yolo' }, 400);
        if (body.harness && !['lean', 'hermes'].includes(body.harness)) return json({ error: 'harness must be lean or hermes' }, 400);
        if (body.subagents) subagents = { ...subagents, ...body.subagents };
        if (body.effort_default) effortDefault = body.effort_default;
        if (body.approvals) approvals = body.approvals;
        if (body.harness) harness = body.harness;
        if (body.compaction) compaction = { ...compaction, ...body.compaction };
        return json({ ok: true });
      }
      if (p === '/api/mock/last-config') return json({ subagents, effort_default: effortDefault, approvals, harness, compaction, patches });
      if (p === '/api/profile/context') return json(profileCtx);
      if (p === '/api/events')
        return sse(async (send, signal) => {
          const sid = url.searchParams.get('session_id');
          const f = (ev: string, d: any) => (!sid || !d?.session_id || d.session_id === sid) && send(ev, d);
          eventSubs.add(f);
          await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
          eventSubs.delete(f);
        }, req);
      if (p === '/api/recipes') return json(recipes);
      if (p === '/api/updates') return json({ available: [{ kind: 'model', from: 'qwen3-coder-30b-a3b', to: 'qwen3.5-coder-35b-a3b', delta: { tps: 12, ctx: 32768, quality: '+3 SWE-bench' }, why: 'Newer release, same memory footprint.' }] });
      if (p === '/api/updates/apply') {
        const jid = id('job');
        jobs.set(jid, 0);
        return json({ job_id: jid });
      }
      if (p === '/api/mock/last-setup') return json(lastSetup ?? {});
      if (p === '/api/setup' && m === 'POST') {
        lastSetup = body;
        const kind = body?.provider?.kind;
        if (kind === 'custom' || kind === 'openai_login') {
          const mid = body.model || body.provider.model;
          if (mid && !models.some((x) => x.id === mid))
            models.push({ id: mid, name: mid, provider: kind, provider_label: kind === 'custom' ? 'Custom API' : 'ChatGPT subscription', local: false, ctx: 128000, tps: null, tps_measured: null });
          if (mid) activeModel = mid;
          state = 'ready';
          return json({ ok: true });
        }
        const jid = id('job');
        jobs.set(jid, 0);
        return json({ job_id: jid });
      }
      if ((mm = p.match(/^\/api\/jobs\/([^/]+)\/events$/))) {
        const jid = mm[1];
        if (!jobs.has(jid)) return json({ error: 'no job' }, 404);
        return sse(async (send) => {
          const total = 1_800_000_000;
          send('progress', { step: 'runtime', label: 'Installing llama.cpp (metal)', pct: 0, bytes: 0, total: 0 });
          await sleep(500);
          for (let i = 0; i <= 20; i++) {
            send('progress', { step: 'download', label: 'Downloading Qwen3-Coder 30B-A3B Q4_K_M', pct: 5 + i * 4, bytes: Math.round((total * i) / 20), total });
            await sleep(120);
          }
          send('progress', { step: 'start', label: 'Starting model', pct: 95, bytes: 0, total: 0 });
          await sleep(400);
          send('progress', { step: 'verify', label: 'Saying hello', pct: 100, bytes: 0, total: 0 });
          await sleep(200);
          state = 'ready';
          send('done', { ok: true });
        }, req);
      }
      if (p === '/api/models') return json({ active: activeModel, models });
      if (p === '/api/models/active') {
        if (!models.some((x) => x.id === body.id)) return json({ error: `unknown model ${body.id}` }, 400);
        activeModel = body.id;
        return json({ ok: true, active: activeModel });
      }
      if (p === '/api/usage') {
        const days = Array.from({ length: 30 }, (_, i) => {
          const d = new Date();
          d.setDate(d.getDate() - (29 - i));
          const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const k = [0, 0, 3, 8, 12, 5, 0, 1, 9, 14, 22, 18, 7, 0, 0, 11, 25, 31, 19, 8, 2, 0, 6, 17, 28, 35, 24, 12, 20, 16][i];
          return { date, turns: Math.round(k / 2), input: k * 9000, output: k * 700, cached: k * 7600 };
        });
        return json({
          totals: { turns: 214, input: 3_310_000, output: 251_000, cached: 2_790_000, seconds: 15_840, tools: 1290 },
          cache_hit_pct: 84,
          days,
          by_model: [
            { model: 'qwen3-coder-30b-a3b', turns: 151, input: 2_400_000, output: 180_000, tps: 68.4 },
            { model: 'gpt-5.5', turns: 52, input: 820_000, output: 64_000, tps: 51.2 },
            { model: 'gpt-oss-20b', turns: 11, input: 90_000, output: 7_000, tps: null },
          ],
          by_harness: [{ harness: 'lean', turns: 160 }, { harness: 'hermes', turns: 54 }],
          today: { turns: 8, input: 144_000, output: 11_200, cached: 121_000, seconds: 610, tools: 41, cache_hit_pct: 84 },
        });
      }
      if (p === '/api/auth/openai/start') {
        loginPolls = 0;
        return json({ url: 'https://auth.openai.com/codex/device', code: 'PICO-1234' });
      }
      // pending for the first ~3 polls, then logged in (so frames can show the waiting box)
      if (p === '/api/auth/openai/status') return json({ state: ++loginPolls > 3 ? 'logged_in' : 'pending' });
      if (p === '/api/provider/test') {
        // simulated OpenAI-compatible endpoints: 'nope' in the URL = 404, key 'bad' = 401, ':9' port = refused
        const u = String(body.base_url || '');
        const key = String(body.api_key || '');
        const ids = /localhost:11434/.test(u) ? ['llama3.2:3b', 'qwen2.5-coder:7b'] : ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'o4-mini', 'text-embedding-3-small'];
        if (/:9\b|:9\//.test(u)) return json({ ok: false, models: [], error: { kind: 'network', message: 'Nothing is listening at that address. Is the server running?' } });
        if (/nope/.test(u)) return json({ ok: false, models: [], error: { kind: 'not_found', message: "404 · wrong URL: the server answered but that URL wasn't found (it usually ends in /v1)" } });
        if (key === 'bad' || (!key && /openai\.com/.test(u))) return json({ ok: false, models: [], error: { kind: 'auth', message: '401 · bad key: the server rejected the API key' } });
        await sleep(250);
        return json({ ok: true, models: ids, model_used: body.model || ids[0], tps: body.model ? 51.4 : null, latency_s: 0.4 });
      }

      if (p === '/api/sessions' && m === 'GET')
        return json(
          [...sessions.values()]
            .filter((s) => s.messages.length)
            .reverse()
            .map((s) => ({ id: s.id, title: s.title, updated: s.updated, pinned: false, goal: s.goal, preview: s.messages[s.messages.length - 1]?.content?.slice(0, 80) })),
        );
      if (p === '/api/sessions' && m === 'POST') {
        const s: any = { id: id('s'), title: body.title || '', cwd: body.cwd, goal: '', todos: [], messages: [] as any[], updated: Date.now() / 1000, ctxUsed: 0, ctxMax: 131072, lastChange: null };
        sessions.set(s.id, s);
        return json({ id: s.id, title: s.title, goal: '', todos: [], cwd: s.cwd, messages: [] });
      }
      if ((mm = p.match(/^\/api\/sessions\/([^/]+)$/))) {
        const s = sessions.get(mm[1]);
        if (!s) return json({ error: 'not found' }, 404);
        if (m === 'DELETE') {
          sessions.delete(s.id);
          return json({ ok: true });
        }
        if (m === 'PATCH') Object.assign(s, body);
        return json({ id: s.id, title: s.title, goal: s.goal, todos: s.todos, cwd: s.cwd, messages: s.messages, context: { used: s.ctxUsed, max: s.ctxMax, cached: 0.92 }, yolo: !!s.yolo, goal_state: s.goalState ?? null });
      }
      if ((mm = p.match(/^\/api\/sessions\/([^/]+)\/stream$/))) {
        const sid = mm[1];
        return sse(async (send, signal) => {
          let set = streamSubs.get(sid);
          if (!set) streamSubs.set(sid, (set = new Set()));
          set.add(send);
          await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
          set.delete(send);
        }, req);
      }
      if ((mm = p.match(/^\/api\/sessions\/([^/]+)\/steer$/)) && m === 'POST') {
        const s = sessions.get(mm[1]);
        if (!s) return json({ error: 'not found' }, 404);
        if (!s.running) return json({ error: 'no turn running' }, 409);
        (s.steers ||= []).push(String(body.text || ''));
        return json({ ok: true, mode: 'steer' });
      }
      if ((mm = p.match(/^\/api\/sessions\/([^/]+)\/loop$/))) {
        const s = sessions.get(mm[1]);
        if (!s) return json({ error: 'not found' }, 404);
        const L = loops.get(s.id);
        if (m === 'DELETE') {
          if (L) stopLoop(s, 'stopped');
          return json({ ok: true });
        }
        return json(L ? { active: true, prompt: L.prompt, every_s: L.every_s, runs: L.runs, max_runs: L.max_runs, next_at: L.next_at } : { active: false });
      }
      if ((mm = p.match(/^\/api\/sessions\/([^/]+)\/messages$/)) && m === 'POST') {
        const s = sessions.get(mm[1]);
        if (!s) return json({ error: 'not found' }, 404);
        const text: string = body.text || '';
        stops.delete(s.id);
        if (!s.title) s.title = text.slice(0, 40);
        s.updated = Date.now() / 1000;
        s.messages.push({ id: id('m'), role: 'user', content: text, created: Date.now() / 1000 });
        if (/^\/yolo\b/.test(text)) {
          const a = text.slice(5).trim();
          s.yolo = a === 'on' ? true : a === 'off' ? false : !s.yolo;
          return sse(async (send) => {
            send('delta', { text: s.yolo ? 'yolo on: commands run without asking in this chat. /yolo again to turn it off.' : 'yolo off: Pico asks before risky commands again.' });
            send('done', { message_id: id('m'), usage: { input: 0, output: 0 }, tps: null, seconds: 0, yolo: !!s.yolo });
          }, req);
        }
        if (text.trim() === '/goal clear') {
          s.goal = '';
          s.goalState = { text: '', status: 'cleared', progress: null, todos: [] };
          return sse(async (send) => {
            send('goal', s.goalState);
            send('delta', { text: 'Goal cleared.' });
            send('done', { message_id: id('m'), usage: { input: 0, output: 0 }, tps: 0, seconds: 0 });
          }, req);
        }
        if (text.startsWith('/goal ')) {
          s.goal = text.slice(6);
          const todos = ['package the CLI binary', 'write the install script', 'sign + notarize', 'test on a clean machine', 'publish release notes'].map((t, i) => ({ text: t, done: i < 3 }));
          s.goalState = { text: s.goal, status: 'active', progress: { done: 3, total: 5 }, todos };
          return sse(async (send) => {
            send('goal', s.goalState);
            send('delta', { text: `Goal set: **${s.goal}**` });
            send('done', { message_id: id('m'), usage: { input: 10, output: 5 }, tps: 0, seconds: 0, goal: s.goalState });
          }, req);
        }
        const planM = /^\/plan(!?)\s+(.+)/s.exec(text);
        if (planM || (text.trim().toLowerCase() === 'go' && s.plan)) {
          s.running = true;
          return sse(async (send, signal) => {
            try {
              if (planM) {
                const steps = ['read the arg parser', 'add a --json flag', 'emit one JSON event per line', 'write tests', 'update the README'];
                s.plan = { title: planM[2].slice(0, 40), steps: [] as any[] };
                for (const st of steps) {
                  s.plan.steps.push({ text: st, status: 'pending' });
                  send('plan', s.plan);
                  await sleep(180);
                }
                if (!planM[1]) {
                  send('delta', { text: 'Here is the plan. Say **go** to start, or tell me what to change.' });
                  send('done', { model: activeModel, message_id: id('m'), usage: { input: 900, output: 120 }, tps: 60, seconds: 1.2, plan_waiting: true });
                  return;
                }
              }
              for (let i = 0; i < s.plan.steps.length && !signal.aborted && !stops.has(s.id); i++) {
                s.plan.steps[i].status = 'active';
                send('plan', s.plan);
                await sleep(i === 1 ? 1400 : 500);
                s.plan.steps[i].status = 'done';
                send('plan', s.plan);
              }
              send('delta', { text: 'Done: `--json` emits one event per line; tests pass.' });
              send('done', { model: activeModel, message_id: id('m'), usage: { input: 1400, output: 300 }, tps: 64, seconds: 3.1, summary: { tools: 0, seconds: 3.1, tps: 64 } });
              s.plan = null;
            } finally {
              s.running = false;
            }
          }, req);
        }
        if (/^\/usage\b/.test(text)) {
          return sse(async (send) => {
            send('delta', { text: 'Usage (30 days): 214 turns.' });
            send('done', { message_id: id('m'), usage: { input: 0, output: 0 }, tps: 0, seconds: 0, usage_report: { totals: { turns: 214 } } });
          }, req);
        }
        const loopM = /^\/loop\b\s*(.*)$/s.exec(text);
        if (loopM) {
          const a = loopM[1].trim();
          return sse(async (send) => {
            if (a === 'stop') {
              if (loops.has(s.id)) stopLoop(s, 'stopped');
              send('delta', { text: 'Loop stopped.' });
            } else if (!a) {
              const L = loops.get(s.id);
              send('delta', { text: L ? `Looping every ${L.every_s}s: ${L.prompt} (run ${L.runs}/${L.max_runs})` : 'No loop running.' });
            } else {
              const until = a.startsWith('until-done');
              const iv = /^(\d+)([smh])\s+/.exec(a);
              const every_s = until ? 4 : iv ? +iv[1] * ({ s: 1, m: 60, h: 3600 } as any)[iv[2]] : 600;
              const prompt = until ? a.slice(10).trim() : iv ? a.slice(iv[0].length) : a;
              startLoop(s, prompt, every_s, until ? 5 : 20);
              send('delta', { text: `Looping ${until ? 'until done' : `every ${iv ? iv[1] + iv[2] : '10m'}`}: ${prompt}` });
              send('done', { message_id: id('m'), usage: { input: 0, output: 0 }, tps: 0, seconds: 0, loop: { session_id: s.id, active: true, n: 0, runs: 0, max_runs: until ? 5 : 20, state: 'waiting', next_at: Date.now() / 1000 + 1.2 } });
              return;
            }
            send('done', { message_id: id('m'), usage: { input: 0, output: 0 }, tps: 0, seconds: 0 });
          }, req);
        }
        if (/^\/cron\b/.test(text)) {
          return sse(async (send) => {
            send('delta', { text: `Cron: ${checkins.length} jobs.` });
            send('done', { message_id: id('m'), usage: { input: 0, output: 0 }, tps: 0, seconds: 0, crons: checkins });
          }, req);
        }
        const atts = (body.attachments || []).map((a: any) => `${a.name} (${Buffer.from(a.data_b64, 'base64').length} bytes)`);
        return sse(async (send, signal) => {
          s.running = true;
          try {
            if (atts.length) send('delta', { text: `Got attachments: ${atts.join(', ')}\n\n` });
            await streamReply(s, text, body.effort || 'medium', send, signal);
          } finally {
            s.running = false;
          }
        }, req);
      }
      if ((mm = p.match(/^\/api\/sessions\/([^/]+)\/undo$/)) && m === 'POST') {
        const s = sessions.get(mm[1]);
        if (!s) return json({ error: 'not found' }, 404);
        let ui = -1;
        for (let i = s.messages.length - 1; i >= 0; i--) if (s.messages[i].role === 'user') { ui = i; break; }
        if (ui < 0) return json({ ok: false, restored: [], deleted: [], note: 'nothing to undo' });
        s.messages.splice(ui);
        const ch = s.lastChange || { restored: [], deleted: [] };
        s.lastChange = null;
        s.ctxUsed = Math.max(0, s.ctxUsed - 9000);
        return json({ ok: true, restored: ch.restored, deleted: ch.deleted, note: ch.restored.length || ch.deleted.length ? '' : 'no file changes' });
      }
      if ((mm = p.match(/^\/api\/sessions\/([^/]+)\/checkpoints$/))) {
        const s = sessions.get(mm[1]);
        if (!s) return json({ error: 'not found' }, 404);
        return json(s.messages.filter((x: any) => x.role === 'user').map((x: any, i: number) => ({ id: `cp${i}`, message_id: x.id, created: x.created, files: [] })));
      }
      if ((mm = p.match(/^\/api\/sessions\/([^/]+)\/stop$/))) {
        stops.add(mm[1]);
        return json({ ok: true });
      }
      if ((mm = p.match(/^\/api\/sessions\/([^/]+)\/approve$/))) {
        pending.get(body.id)?.({ allow: !!body.allow, always: body.always });
        pending.delete(body.id);
        return json({ ok: true });
      }
      if (p === '/api/search') return json([{ session_id: 's_1', title: 'Fix the build', snippet: `…matched ${url.searchParams.get('q')} in a chat…` }]);
      if (p === '/api/memory') return json([{ id: 'm1', text: 'Prefers TypeScript and bun.' }, { id: 'm2', text: 'Works in ~/Developer.' }]);
      if (p === '/api/skills')
        return json([
          { name: 'review', description: 'Review the current diff', category: 'dev', enabled: true, builtin: true },
          { name: 'release-notes', description: 'Draft release notes from git log', category: 'dev', enabled: true, builtin: false },
        ]);
      if (p === '/api/connectors') return json([{ id: 'github', name: 'GitHub', what: 'Read issues and PRs.', kind: 'key', connected: false, setup: { fields: ['token'] } }]);
      if ((mm = p.match(/^\/api\/connectors\/([^/]+)\/connect$/))) return json({ ok: true });
      if (p === '/api/checkins' && m === 'GET') return json(checkins);
      if (p === '/api/checkins' && m === 'POST') {
        const sch = body.schedule || {};
        const text = sch.text || (sch.every ? `every ${sch.every}` : sch.cron || `${sch.time || ''}`);
        const c = { id: id('c'), title: body.title || String(body.prompt || '').split(/\s+/).slice(0, 4).join(' '), prompt: body.prompt, schedule: sch, schedule_text: text.replace(/ at (\d+)am/, ' $1:00'), next_run: Date.now() / 1000 + 3600, last_run: null, last_status: null, enabled: true, session_id: body.session_id || null };
        checkins.push(c);
        return json(c);
      }
      if ((mm = p.match(/^\/api\/checkins\/([^/]+)$/))) {
        const i = checkins.findIndex((c) => c.id === mm![1]);
        if (i < 0) return json({ error: 'not found' }, 404);
        if (m === 'DELETE') {
          checkins.splice(i, 1);
          return json({ ok: true });
        }
        if (m === 'PATCH') Object.assign(checkins[i], body);
        return json(checkins[i]);
      }
      if ((mm = p.match(/^\/api\/checkins\/([^/]+)\/run$/))) {
        const c = checkins.find((x) => x.id === mm![1]);
        if (!c) return json({ error: 'not found' }, 404);
        c.last_status = 'running';
        setTimeout(() => {
          c.last_status = 'ok';
          c.last_run = Date.now() / 1000;
          broadcast('inbox', { item: { id: id('i'), title: c.title, text: '3 PRs need review; CI is green.\nCalendar: standup at 10.', session_id: null, created: Date.now() / 1000 } });
        }, 900 * speed + 200);
        return json({ ok: true });
      }
      if (p === '/api/mock/inbox') {
        broadcast('inbox', { item: { id: id('i'), title: body.title || 'watch CI', text: body.text || 'main is red: test_api.py::test_steer failed', session_id: null, created: Date.now() / 1000 } });
        return json({ ok: true });
      }
      return json({ error: `mock: no route ${m} ${p}` }, 404);
    },
  });
  return server;
}

if (import.meta.main) {
  const s = startMock({ port: +values.port!, setup: values.setup, token: values.token, fast: values.fast });
  console.log(`mock pico engine on http://127.0.0.1:${s.port} (state=${values.setup ? 'setup' : 'ready'}, token=${values.token})`);
}
