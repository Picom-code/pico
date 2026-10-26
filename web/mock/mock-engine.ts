// Mock Pico engine for UI development. Implements docs/API.md with canned data.
//   bun mock/mock-engine.ts                 → API on :7879 (use with `PICO_MOCK=1 vite`)
//   bun mock/mock-engine.ts --static dist   → also serves the built app at / (token injected)
// Flags: --port N, --state setup|ready (initial health state; default setup), --fast (quick setup job)
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] ?? '' : d; };
const PORT = Number(flag('port', process.env.PICO_MOCK_PORT || '7879'));
const STATIC = flag('static');
const FAST = args.includes('--fast');
const TOKEN = 'mock-token';
let state: 'setup' | 'ready' = (flag('state', 'setup') as 'setup' | 'ready');

const now = () => Math.floor(Date.now() / 1000);
let seq = 100;
const id = (p: string) => `${p}_${(seq++).toString(36)}`;

// ---------- canned data ----------
const system = {
  os: 'windows', arch: 'x86_64', cpu: { name: 'AMD Ryzen 7 7800X3D', cores: 8 }, ram_gb: 32,
  gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4080 SUPER', vram_gb: 16, driver: '566.36', compute: '8.9' }],
  unified_memory: false, disk_free_gb: 412.6, accelerators: ['cuda', 'vulkan', 'cpu'],
  runtimes: { llama_cpp: null, ollama: '0.12.3', lmstudio: null, vllm: null },
};
const R = (o: Record<string, unknown>) => ({ runtime: 'llama.cpp', flags: {}, tps_source: 'measured', fits: true, ...o });
const recipes: Record<string, any> = {
  qwen_coder: R({ id: 'qwen3-coder-30b-a3b-q4', model: 'Qwen3-Coder 30B', family: 'Qwen3', params_b: 30, active_b: 3, quant: 'Q4_K_M', file_gb: 18.6, ctx: 65536, est_tps: 92, strengths: ['coding', 'speed'], why: 'Great at code and very fast on your RTX 4080 — only a small part of it runs at a time.', features: { voice: true, image: true, video: false } }),
  gemma: R({ id: 'gemma3-12b-q5', model: 'Gemma 3 12B', family: 'Gemma 3', params_b: 12, quant: 'Q5_K_M', file_gb: 8.4, ctx: 131072, est_tps: 58, strengths: ['writing', 'vision'], why: 'Writes naturally, can look at images, and leaves room on your graphics card for picture-making.', features: { voice: true, image: true, video: true } }),
  qwen14: R({ id: 'qwen3-14b-q4', model: 'Qwen3 14B', family: 'Qwen3', params_b: 14, quant: 'Q4_K_M', file_gb: 9.0, ctx: 40960, est_tps: 64, strengths: ['writing', 'speed'], why: 'A strong all-rounder that answers quickly.' }),
  mistral: R({ id: 'mistral-small-24b-q4', model: 'Mistral Small 3.2 24B', family: 'Mistral', params_b: 24, quant: 'Q4_K_M', file_gb: 14.3, ctx: 131072, est_tps: 38, tps_source: 'est', strengths: ['writing', 'creative'], why: 'Thoughtful and creative; a bit slower.' }),
  llama70: R({ id: 'llama3.3-70b-q4', model: 'Llama 3.3 70B', family: 'Llama 3', params_b: 70, quant: 'Q4_K_M', file_gb: 42.5, ctx: 131072, est_tps: 4, tps_source: 'est', strengths: ['writing'], fits: false, why: 'Very capable, but needs a bigger graphics card than yours.' }),
};
const byPersona: Record<string, string> = { engineer: 'qwen_coder', business: 'qwen14', creative: 'gemma', marketing: 'gemma', student: 'qwen14', general: 'gemma' };

const models = {
  active: 'qwen3-coder-30b-a3b-q4',
  models: [
    { id: 'qwen3-coder-30b-a3b-q4', name: 'Qwen3-Coder 30B', provider: 'local', local: true, ctx: 65536, tps: 92 },
    { id: 'gemma3-12b-q5', name: 'Gemma 3 12B', provider: 'local', local: true, ctx: 131072, tps: 58 },
    { id: 'gpt-5-chatgpt', name: 'GPT-5 (ChatGPT)', provider: 'openai', local: false, ctx: 272000 },
  ],
};

const updates = {
  available: [
    { kind: 'model', from: 'Qwen3-Coder 30B Q4_K_M', to: 'qwen3.5-coder-35b-a3b-q4', delta: { tps: 12, ctx: 32768, quality: '+3 SWE-bench' }, why: 'Newer model from the same family. Faster on your card and remembers more of the conversation.' },
    { kind: 'config', from: 'llama.cpp b6120', to: 'llama.cpp-b6501-flash', delta: { tps: 7 }, why: 'Runtime update with faster attention for RTX 40-series.' },
  ],
};

const config: any = { persona: 'engineer', provider: { kind: 'local', recipe_id: 'qwen3-coder-30b-a3b-q4' }, model: models.active, effort_default: 'low', accent: 'pink', features: { voice: true, image: false, video: false },
  subagents: { enabled: true, max_parallel: 4, model: '', effort: 'low', max_seconds: 300 } };

type Msg = { id: string; role: 'user' | 'assistant' | 'tool'; content: string; reasoning?: string; tool?: any; created: number; turn?: number };
type Sess = { id: string; title: string; updated: number; pinned: boolean; goal?: string; todos: { text: string; done: boolean }[]; cwd?: string; messages: Msg[]; persisted: boolean; ctx: { used: number; max: number; cached?: number }; turns: number };
const sessions = new Map<string, Sess>();
const mk = (title: string, agoMin: number, pinned: boolean, msgs: [string, string][], goal?: string) => {
  const s: Sess = { id: id('s'), title, updated: now() - agoMin * 60, pinned, goal, todos: [], messages: [], persisted: true, ctx: { used: 9800, max: 131072, cached: 0.84 }, turns: 0 };
  for (const [role, content] of msgs) s.messages.push({ id: id('m'), role: role as any, content, created: s.updated });
  sessions.set(s.id, s);
};
mk('Bakery holiday menu ideas', 30, true, [['user', 'Give me 5 holiday specials for a small bakery'], ['assistant', 'Here are five that sell well and use overlapping ingredients:\n\n1. **Cranberry-orange scones**\n2. **Gingerbread loaf** with cream cheese glaze\n3. **Peppermint brownies**\n4. **Chai sugar cookies**\n5. **Mini pecan tarts**']]);
mk('Fix Python CSV import', 180, true, [['user', 'My CSV import breaks on commas inside quotes'], ['assistant', 'Use the `csv` module instead of `split(",")`:\n\n```python\nimport csv\nwith open("data.csv", newline="") as f:\n    for row in csv.reader(f):\n        print(row)\n```']]);
mk('Email to landlord about heater', 60 * 26, false, [['user', 'Draft an email to my landlord, heater is broken'], ['assistant', 'Subject: Heater not working — repair request\n\nHi Sam, …']]);
mk('Explain VRAM vs RAM', 60 * 50, false, [['user', 'What is VRAM?'], ['assistant', 'VRAM is the memory on your graphics card…']]);
mk('Q4 marketing plan', 60 * 24 * 5, false, [['user', 'Outline a Q4 marketing plan'], ['assistant', '## Q4 plan\n- Holiday email series\n- Instagram reels\n- Local partnerships']]);

const memory = [
  { id: 'mem_1', text: 'Runs a small bakery in Austin called Crumb & Co.' },
  { id: 'mem_2', text: 'Prefers short, direct answers with bullet points.' },
  { id: 'mem_3', text: 'Uses Windows 11 with an RTX 4080 SUPER.' },
];
const skills: any[] = [
  { name: 'web-search', description: 'Look things up on the internet', category: 'research', enabled: true, builtin: true, body: '# Web search\n\nUse the search tool to find current information. Cite sources.' },
  { name: 'summarize', description: 'Summarize a document, page, or chat', category: 'writing', enabled: true, builtin: true, body: '# Summarize\n\nProduce 3–7 bullets, then a one-line takeaway.' },
  { name: 'email-drafter', description: 'Write clear, friendly emails in your voice', category: 'writing', enabled: true, builtin: false, body: '# Email drafter\n\n- Keep under 150 words\n- Warm but direct\n- End with a clear ask' },
  { name: 'spreadsheet', description: 'Read and build Excel/CSV files', category: 'productivity', enabled: true, builtin: true, body: '# Spreadsheet\n\nUse openpyxl for .xlsx files.' },
  { name: 'code-review', description: 'Review code for bugs and clarity', category: 'coding', enabled: false, builtin: true, body: '# Code review\n\nLook for bugs first, style second.' },
  { name: 'image-gen', description: 'Make an image from a description', category: 'creative', enabled: true, builtin: true, body: '# Image generation\n\nCalls the local image model.' },
];
const connectors: any[] = [
  { id: 'gmail', name: 'Gmail', what: 'Lets Pico read and draft emails — it never sends without asking.', kind: 'oauth', connected: true, setup: { oauth_url: 'https://accounts.google.com/o/oauth2/auth?mock=1' } },
  { id: 'gcal', name: 'Google Calendar', what: 'Lets Pico see your schedule and suggest times.', kind: 'oauth', connected: false, setup: { oauth_url: 'https://accounts.google.com/o/oauth2/auth?mock=2' } },
  { id: 'notion', name: 'Notion', what: 'Lets Pico search and update your Notion pages.', kind: 'key', connected: false, setup: { fields: [{ name: 'api_key', label: 'Integration key', secret: true, placeholder: 'secret_…' }] } },
  { id: 'github', name: 'GitHub', what: 'Lets Pico read your repos and open pull requests.', kind: 'key', connected: false, setup: { fields: ['token'] } },
  { id: 'files', name: 'Folders on this PC', what: 'Lets Pico read files in folders you pick.', kind: 'mcp', connected: true, setup: { fields: [{ name: 'path', label: 'Folder', placeholder: 'C:\\Users\\you\\Documents' }] } },
  { id: 'slack', name: 'Slack', what: 'Lets Pico read channels you choose and draft replies.', kind: 'oauth', connected: false, setup: { oauth_url: 'https://slack.com/oauth/v2/authorize?mock=1' } },
];
const checkins: any[] = [
  { id: 'ck_1', title: 'Morning briefing', prompt: 'Summarize my calendar and unread emails', schedule: { time: '07:30', days: ['mon', 'tue', 'wed', 'thu', 'fri'] } },
  { id: 'ck_2', title: 'Weekly sales recap', prompt: 'Pull last week sales from the spreadsheet and summarize', schedule: { time: '17:00', days: ['fri'] } },
];
const inbox: any[] = [
  { id: 'ib_1', title: 'Morning briefing', body: '3 meetings today. First at 9:30 with the flour supplier. 2 emails need a reply.', session_id: [...sessions.keys()][0], created: now() - 3600 * 3, read: false },
  { id: 'ib_2', title: 'Weekly sales recap', body: 'Sales up 8% vs last week, led by scones and gingerbread loaf.', session_id: [...sessions.keys()][1], created: now() - 86400 * 2, read: true },
];

// ---------- helpers ----------
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json', ...cors } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

function sse(run: (send: (event: string, data: unknown) => void, signal: AbortSignal) => Promise<void>, req: Request) {
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (event: string, data: unknown) => { try { ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ } };
      try { await run(send, req.signal); } catch { /* aborted */ }
      try { ctrl.close(); } catch { /* closed */ }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...cors } });
}

// event bus for /api/events
const listeners = new Set<(e: string, d: unknown) => void>();
const broadcast = (e: string, d: unknown) => listeners.forEach((l) => l(e, d));

// pending approvals
const approvals = new Map<string, (allow: boolean) => void>();
const stopped = new Set<string>();

// ---------- chat script ----------
const ANSWER = `Here's a quick plan for your **holiday pre-order page**, based on what's in your sales sheet.

## What sells
| Item | Last Dec | Margin |
|---|---:|---:|
| Cranberry scones | 412 | 68% |
| Gingerbread loaf | 236 | 61% |
| Pecan tarts | 180 | 54% |

## Steps
1. Put the **top three** on the page first — they're 70% of December revenue.
2. Offer a *bundle* (scone ×6 + loaf) at a small discount.
3. Close pre-orders on **Dec 20** so you can plan flour.

\`\`\`python
# bundle price with 10% off
price = (6 * 3.50 + 14.00) * 0.9
print(f"\${price:.2f}")   # $31.50
\`\`\`

> Tip: send the page to last year's customers first — they convert about 3× better.

Want me to draft the email to them?`;

const REASONING = `The user wants a pre-order page plan. I should check their sales spreadsheet for last December's best sellers, compute margins, then suggest an ordering. Bundles usually lift average order value. Keep it short — memory says they prefer bullets.`;

const DIFF_APP = `--- a/src/app.ts
+++ b/src/app.ts
@@ -12,9 +12,11 @@ export function createApp(config: AppConfig) {
   const router = new Router();
   router.get('/', home);
-  router.get('/menu', menu);
+  router.get('/menu', withCache(menu, 60));
+  router.get('/preorder', preorder);
+  router.post('/preorder', submitPreorder);
   router.get('/about', about);
 
   return {
     router,
-    listen: (port = 3000) => serve(router, port),
+    listen: (port = config.port ?? 3000) => serve(router, port),
   };
 }`;
const DIFF_NEW = `--- /dev/null
+++ b/src/routes/preorder.ts
@@ -0,0 +1,9 @@
+import { bundles } from '../data/bundles';
+
+export function preorder(_req: Request) {
+  return render('preorder', { bundles, closes: '2026-12-20' });
+}
+
+export async function submitPreorder(req: Request) {
+  return save(await req.formData());
+}`;
const TEST_TAIL = ['> vitest run --reporter=dot', ' ✓ src/routes/home.test.ts (4)', ' ✓ src/routes/menu.test.ts (6)', ' ✓ src/routes/preorder.test.ts (3)', ' ✓ src/lib/cache.test.ts (5)', '', ' Test Files  4 passed (4)', '      Tests  18 passed (18)'];

const BUILD_ANSWER = `Done — the pre-order page is wired up.

- **\`/preorder\`** shows the three best sellers plus the scone + loaf bundle, and closes on **Dec 20**.
- The menu route is now cached for 60s, so the page stays fast on launch day.
- All 18 tests pass.

\`\`\`ts
router.get('/preorder', preorder);
router.post('/preorder', submitPreorder);
\`\`\`

Want me to draft the email to last year's customers next?`;

const HELPERS_ANSWER = `Here's what the helpers found:

1. **Competitor pricing** — the two nearby bakeries price holiday bundles at **$34–38**, so $31.50 undercuts both.
2. **Last year's emails** — the "early bird" subject line had a **41% open rate**, best of the season.
3. **Supplier lead time** — flour orders need **9 days**, so closing pre-orders Dec 20 still works.

I'd launch the page Monday with the early-bird email.`;

async function runScripted(s: Sess, text: string, effort: string, send: (e: string, d: unknown) => void, alive: () => boolean, t0: number) {
  const lower = text.toLowerCase();
  const stream = async (event: string, full: string, chunk = 2, delay = 22) => {
    const words = full.split(/(\s+)/);
    for (let i = 0; i < words.length && alive(); i += chunk * 2) { send(event, { text: words.slice(i, i + chunk * 2).join('') }); await sleep(delay); }
  };
  const turn = ++s.turns;
  const toolMsg = (tool: any) => s.messages.push({ id: id('m'), role: 'tool', content: '', tool, created: now(), turn });
  const helpers = /helper|research|parallel|subagent/.test(lower);
  if (effort !== 'off') await stream('reasoning', helpers
    ? 'Three independent questions here — competitor prices, last year\'s email stats, and supplier lead times. These can run in parallel, so I\'ll hand each to a helper and merge the results.'
    : 'I need to add a pre-order route. First look at how the router is set up in src/app.ts, then add the route, create the handler file, and run the tests to make sure nothing broke.', 2, 40);
  if (!alive()) return '';
  let answer = '';
  let tools = 0;
  const files: { path: string; added: number; removed: number }[] = [];
  if (helpers) {
    const hs = [
      { id: 'h1', goal: 'Compare holiday bundle prices at nearby bakeries', steps: ['searching the web', 'reading crumbandcrust.com/menu', 'reading sugarloaf.co/holiday', 'comparing 6 prices'], tokens: 4210, secs: 3.4 },
      { id: 'h2', goal: 'Find last year\'s best performing holiday email', steps: ['opening Gmail', 'scanning 38 sent emails', 'ranking by open rate'], tokens: 2890, secs: 2.6 },
      { id: 'h3', goal: 'Check flour supplier lead times', steps: ['reading supplier-terms.pdf', 'finding delivery schedule'], tokens: 1640, secs: 2.0 },
    ];
    for (const h of hs) { send('subagent_start', { id: h.id, goal: h.goal, model: 'Qwen3-Coder 30B' }); await sleep(120); }
    const startAt = Date.now();
    const done = new Set<string>();
    while (done.size < hs.length && alive()) {
      const el = (Date.now() - startAt) / 1000;
      for (const h of hs) {
        if (done.has(h.id)) continue;
        if (el >= h.secs) {
          done.add(h.id);
          send('subagent_end', { id: h.id, ok: true, seconds: h.secs, tokens: h.tokens, summary: h.id === 'h1' ? 'Crumb & Crust: **$38** (6 scones + loaf). Sugarloaf: **$34** (box of 8 + cocoa). Both close Dec 22.' : h.id === 'h2' ? 'Subject **"Early bird: holiday boxes are back"** — 41% opens, 9% clicks (Nov 18, 2025).' : 'Bread flour: order by the 1st and 15th, **9-day** lead time.' });
        } else {
          const i = Math.min(h.steps.length - 1, Math.floor((el / h.secs) * h.steps.length));
          send('subagent_progress', { id: h.id, label: h.steps[i] });
        }
      }
      await sleep(300);
    }
    tools = 3;
    answer = HELPERS_ANSWER;
  } else {
    send('tool_start', { id: 't1', name: 'read_file', args: { path: 'src/app.ts' }, label: 'Read src/app.ts' });
    await sleep(500);
    send('tool_end', { id: 't1', name: 'read_file', ok: true, result_preview: '48 lines · exports createApp(config)', seconds: 0.4 });
    toolMsg({ name: 'read_file', args: { path: 'src/app.ts' }, label: 'Read src/app.ts', result: '48 lines', ok: true, seconds: 0.4 });
    send('tool_start', { id: 't2', name: 'patch', args: { path: 'src/app.ts' }, label: 'Edit src/app.ts' });
    await sleep(600);
    const d1 = { path: 'src/app.ts', added: 4, removed: 2, unified: DIFF_APP };
    send('tool_end', { id: 't2', name: 'patch', ok: true, result_preview: 'applied 1 hunk', seconds: 0.6, diff: d1 });
    toolMsg({ name: 'patch', args: { path: 'src/app.ts' }, label: 'Edit src/app.ts', result: 'applied 1 hunk', ok: true, seconds: 0.6, diff: d1 });
    send('tool_start', { id: 't3', name: 'write_file', args: { path: 'src/routes/preorder.ts' }, label: 'Create src/routes/preorder.ts' });
    await sleep(450);
    const d2 = { path: 'src/routes/preorder.ts', added: 9, removed: 0, unified: DIFF_NEW, created: true };
    send('tool_end', { id: 't3', name: 'write_file', ok: true, result_preview: 'wrote 9 lines', seconds: 0.4, diff: d2 });
    toolMsg({ name: 'write_file', args: { path: 'src/routes/preorder.ts' }, label: 'Create src/routes/preorder.ts', result: 'wrote 9 lines', ok: true, seconds: 0.4, diff: d2 });
    if (lower.includes('remember') || turn === 1) {
      send('notice', { kind: 'memory', text: 'pre-orders close Dec 20' });
    }
    send('tool_start', { id: 't4', name: 'terminal', args: { command: 'npm test' }, label: 'Run tests' });
    const slow = lower.includes('slow') ? 900 : 380;
    for (let i = 1; i <= TEST_TAIL.length && alive(); i++) { await sleep(slow); send('tool_progress', { id: 't4', tail: TEST_TAIL.slice(Math.max(0, i - 4), i) }); }
    send('tool_end', { id: 't4', name: 'terminal', ok: true, result_preview: TEST_TAIL.join('\n'), seconds: (TEST_TAIL.length * slow) / 1000 });
    toolMsg({ name: 'terminal', args: { command: 'npm test' }, label: 'Run tests', result: '18 passed', ok: true });
    tools = 4;
    files.push({ path: 'src/app.ts', added: 4, removed: 2 }, { path: 'src/routes/preorder.ts', added: 9, removed: 0 });
    answer = BUILD_ANSWER;
  }
  if (lower.includes('skill')) send('notice', { kind: 'skill', text: 'bakery-preorders' });
  await stream('delta', answer, 2, 18);
  const m = text.match(/#ctx=(\d+)/);
  s.ctx.used = m ? Math.round((Number(m[1]) / 100) * s.ctx.max) : Math.min(s.ctx.max, s.ctx.used + 14200);
  const secs = (Date.now() - t0) / 1000;
  const out = Math.round(answer.length / 3.6) + 640;
  send('done', { message_id: id('m'), usage: { input: s.ctx.used, output: out, last_input: s.ctx.used }, tps: 142, seconds: secs,
    context: s.ctx, summary: { tools, files_changed: files, seconds: secs, tps: 142, output_tokens: out } });
  return answer;
}

async function runChat(s: Sess, text: string, effort: string, send: (e: string, d: unknown) => void, signal: AbortSignal) {
  stopped.delete(s.id);
  const t0 = Date.now();
  const alive = () => !signal.aborted && !stopped.has(s.id);
  const stream = async (event: string, full: string, chunk = 3, delay = 18) => {
    const words = full.split(/(\s+)/);
    for (let i = 0; i < words.length && alive(); i += chunk * 2) { send(event, { text: words.slice(i, i + chunk * 2).join('') }); await sleep(delay); }
  };
  const lower = text.toLowerCase();

  if (lower.startsWith('/goal')) {
    s.goal = text.slice(5).trim() || 'Ship the holiday pre-order page';
    send('delta', { text: `Goal set: **${s.goal}**. I'll keep working toward it.` });
    send('done', { message_id: id('m'), usage: { input: 20, output: 12 }, tps: 90, seconds: 0.3 });
    return 'Goal set.';
  }

  if (lower.startsWith('/compact')) {
    const before = s.ctx.used;
    await sleep(900);
    s.ctx.used = Math.round(before * 0.19);
    send('compacted', { before, after: s.ctx.used });
    send('delta', { text: `Compacted the earlier conversation into a summary.` });
    send('done', { message_id: id('m'), usage: { input: s.ctx.used, output: 40 }, tps: 120, seconds: 0.9, compacted: 12, context: s.ctx });
    return 'Compacted the earlier conversation into a summary.';
  }
  if (!(lower.includes('approve') || lower.includes('install'))) return runScripted(s, text, effort, send, alive, t0);

  if (effort !== 'off') await stream('reasoning', REASONING, 2, 22);
  if (!alive()) return '';
  if (!s.goal) s.goal = 'Launch the holiday pre-order page';
  s.todos = [
    { text: 'Read last December sales', done: false },
    { text: 'Rank items by revenue and margin', done: false },
    { text: 'Draft page outline', done: false },
    { text: 'Write customer email', done: false },
  ];
  send('todo', { todos: s.todos });
  await sleep(250);

  send('tool_start', { id: 't1', name: 'read_file', args: { path: 'Documents/sales-2025.xlsx' } });
  await sleep(700);
  send('tool_end', { id: 't1', name: 'read_file', ok: true, result_preview: 'Sheet1: 1,284 rows · columns: date, item, qty, price, cost' });
  s.todos[0].done = true; send('todo', { todos: s.todos });
  send('tool_start', { id: 't2', name: 'python', args: { code: 'df.groupby("item").sum()' } });
  await sleep(600);
  send('tool_end', { id: 't2', name: 'python', ok: true, result_preview: 'cranberry scones 412 · gingerbread loaf 236 · pecan tarts 180' });
  s.todos[1].done = true; send('todo', { todos: s.todos });

  if (lower.includes('approve') || lower.includes('run') || lower.includes('install')) {
    const aid = id('ap');
    send('approval', { id: aid, command: 'pip install openpyxl', reason: 'Needed to write the updated spreadsheet.' });
    const allow = await new Promise<boolean>((resolve) => { approvals.set(aid, resolve); signal.addEventListener('abort', () => resolve(false)); });
    send('tool_start', { id: 't3', name: 'terminal', args: { command: 'pip install openpyxl' } });
    await sleep(500);
    send('tool_end', { id: 't3', name: 'terminal', ok: allow, result_preview: allow ? 'Successfully installed openpyxl-3.1.5' : 'Denied by user' });
  }

  await stream('delta', ANSWER, 2, 16);
  s.todos[2].done = true; send('todo', { todos: s.todos });
  const secs = (Date.now() - t0) / 1000;
  s.ctx.used = Math.min(s.ctx.max, s.ctx.used + 3200);
  send('done', { message_id: id('m'), usage: { input: 1840, output: 312 }, tps: 87.4, seconds: secs, context: s.ctx, summary: { tools: 3, files_changed: [], seconds: secs, tps: 87.4, output_tokens: 312 } });
  return ANSWER;
}

// ---------- router ----------
async function api(req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  if (m === 'OPTIONS') return new Response(null, { headers: cors });
  if (p === '/api/health') return json({ ok: true, version: '0.1.0-mock', state, model: models.models.find((x) => x.id === models.active)?.name, provider: 'local' });
  if (p === '/api/pair/claim' && m === 'POST') return json({ token: TOKEN });

  const auth = req.headers.get('authorization');
  const qtoken = url.searchParams.get('token');
  if (auth !== `Bearer ${TOKEN}` && qtoken !== TOKEN) return json({ message: 'unauthorized' }, 401);
  const body: any = m === 'GET' || m === 'DELETE' ? {} : await req.json().catch(() => ({}));
  await sleep(60 + Math.random() * 120); // feel like a network

  if (p === '/api/system') { await sleep(500); return json(system); }
  if (p === '/api/config') { if (m === 'PATCH') Object.assign(config, body); return json(config); }
  if (p === '/api/_mock/notice' && m === 'POST') { broadcast('notice', body); return json({ ok: true }); }
  if (p === '/api/recipes') {
    const persona = url.searchParams.get('persona') || 'general';
    const rec = recipes[byPersona[persona] || 'gemma'];
    return json({ recommended: rec, alternatives: Object.values(recipes).filter((r) => r !== rec), catalog_version: '2026.10.20' });
  }
  if (p === '/api/updates') return json(updates);
  if (p === '/api/setup' && m === 'POST') { config.persona = body.persona; config.provider = body.provider; config.features = body.features; return json({ job_id: id('job') }); }
  const job = p.match(/^\/api\/jobs\/([^/]+)\/events$/);
  if (job) {
    return sse(async (send, signal) => {
      const total = 18.6e9;
      send('progress', { step: 'runtime', label: 'Installing llama.cpp for CUDA', pct: 2 });
      await sleep(FAST ? 200 : 900);
      const N = FAST ? 25 : 60;
      for (let i = 1; i <= N && !signal.aborted; i++) {
        const b = Math.round((total * i) / N);
        send('progress', { step: 'download', label: 'Downloading Qwen3-Coder 30B', pct: 4 + (i / N) * 86, bytes: b, total });
        await sleep(FAST ? 60 : 140);
      }
      send('progress', { step: 'verify', label: 'Checking the download', pct: 92 });
      await sleep(FAST ? 200 : 700);
      send('progress', { step: 'start', label: 'Starting your model', pct: 97 });
      await sleep(FAST ? 200 : 900);
      state = 'ready';
      send('done', { ok: true });
    }, req);
  }
  if (p === '/api/models') return json(models);
  if (p === '/api/models/active' && m === 'POST') { models.active = body.id; broadcast('model', { state: 'ready' }); return json({ ok: true }); }
  if (p === '/api/auth/openai/start') { authStarted = Date.now(); return json({ url: 'https://auth.openai.com/device', code: 'PICO-7Q4K' }); }
  if (p === '/api/auth/openai/status') return json({ state: Date.now() - authStarted > 6000 ? 'ok' : 'pending' });

  if (p === '/api/sessions' && m === 'GET') {
    return json([...sessions.values()].filter((s) => s.persisted).sort((a, b) => b.updated - a.updated)
      .map(({ id, title, updated, pinned, goal, messages }) => ({ id, title, updated, pinned, goal, preview: messages[messages.length - 1]?.content.slice(0, 80) })));
  }
  if (p === '/api/sessions' && m === 'POST') {
    const s: Sess = { id: id('s'), title: body.title || 'New chat', updated: now(), pinned: false, todos: [], cwd: body.cwd, messages: [], persisted: false, ctx: { used: 6200, max: 131072, cached: 0.92 }, turns: 0 };
    sessions.set(s.id, s);
    return json({ ...s, persisted: undefined, context: s.ctx });
  }
  const sm = p.match(/^\/api\/sessions\/([^/]+)(\/(messages|approve|stop|undo|checkpoints))?$/);
  if (sm) {
    const s = sessions.get(sm[1]);
    if (!s) return json({ message: 'not found' }, 404);
    const sub = sm[3];
    if (!sub && m === 'GET') return json({ id: s.id, title: s.title, goal: s.goal, todos: s.todos, cwd: s.cwd, messages: s.messages, context: s.ctx });
    if (sub === 'checkpoints') return json(s.turns ? [{ id: `cp_${s.turns}`, turn: s.turns, files: 2, created: now() }] : []);
    if (sub === 'undo' && m === 'POST') {
      let i = s.messages.length - 1;
      while (i >= 0 && s.messages[i].role !== 'user') i--;
      if (i < 0) return json({ ok: false, note: 'Nothing to undo' });
      const removed = s.messages.splice(i);
      const changed = removed.filter((x) => x.tool?.diff);
      s.ctx.used = Math.max(4000, s.ctx.used - 14200);
      return json({ ok: true, restored: changed.filter((x) => !x.tool.diff.created).length, deleted: changed.filter((x) => x.tool.diff.created).length, note: `Rewound to before “${removed[0].content.slice(0, 40)}”` });
    }
    if (!sub && m === 'PATCH') { Object.assign(s, body); return json({ ok: true }); }
    if (!sub && m === 'DELETE') { sessions.delete(s.id); return json({ ok: true }); }
    if (sub === 'stop') { stopped.add(s.id); return json({ ok: true }); }
    if (sub === 'approve') { approvals.get(body.id)?.(!!body.allow); approvals.delete(body.id); return json({ ok: true }); }
    if (sub === 'messages' && m === 'POST') {
      const text = String(body.text || '');
      s.messages.push({ id: id('m'), role: 'user', content: text, created: now() });
      if (!s.persisted) { s.persisted = true; s.title = text.replace(/^\/\w+\s*/, '').slice(0, 42) || 'New chat'; }
      s.updated = now();
      return sse(async (send, signal) => {
        const out = await runChat(s, text, body.effort || 'low', send, signal);
        if (out) s.messages.push({ id: id('m'), role: 'assistant', content: out, created: now() });
      }, req);
    }
  }
  if (p === '/api/search') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const hits = [...sessions.values()].filter((s) => s.persisted).flatMap((s) => {
      const msg = s.messages.find((x) => x.content.toLowerCase().includes(q));
      if (!msg && !s.title.toLowerCase().includes(q)) return [];
      return [{ session_id: s.id, title: s.title, snippet: (msg?.content || s.title).slice(0, 120) }];
    });
    return json(hits);
  }

  if (p === '/api/memory' && m === 'GET') return json(memory);
  if (p === '/api/memory' && m === 'POST') { const it = { id: id('mem'), text: body.text }; memory.push(it); return json(it); }
  const mem = p.match(/^\/api\/memory\/(.+)$/);
  if (mem && m === 'DELETE') { const i = memory.findIndex((x) => x.id === mem[1]); if (i >= 0) memory.splice(i, 1); return json({ ok: true }); }

  if (p === '/api/skills') return json(skills.map(({ body: _b, ...s }) => s));
  const sk = p.match(/^\/api\/skills\/([^/]+)(\/toggle)?$/);
  if (sk) {
    const s = skills.find((x) => x.name === decodeURIComponent(sk[1]));
    if (!s) return json({ message: 'not found' }, 404);
    if (sk[2]) { s.enabled = !s.enabled; return json({ ok: true, enabled: s.enabled }); }
    if (m === 'GET') return json(s);
    if (m === 'PUT') { s.description = body.description; s.body = body.body; return json({ ok: true }); }
    if (m === 'DELETE') { skills.splice(skills.indexOf(s), 1); return json({ ok: true }); }
  }

  if (p === '/api/connectors') return json(connectors);
  const cn = p.match(/^\/api\/connectors\/([^/]+)(\/connect)?$/);
  if (cn) {
    const c = connectors.find((x) => x.id === cn[1]);
    if (!c) return json({ message: 'not found' }, 404);
    c.connected = !!cn[2] && m === 'POST';
    return json({ ok: true });
  }

  if (p === '/api/checkins' && m === 'GET') return json(checkins);
  if (p === '/api/checkins' && m === 'POST') { const c = { id: id('ck'), ...body }; checkins.push(c); return json(c); }
  const ck = p.match(/^\/api\/checkins\/(.+)$/);
  if (ck && m === 'DELETE') { const i = checkins.findIndex((x) => x.id === ck[1]); if (i >= 0) checkins.splice(i, 1); return json({ ok: true }); }

  if (p === '/api/inbox') return json(inbox);
  if (p === '/api/events') {
    return sse(async (send, signal) => {
      const l = (e: string, d: unknown) => send(e, d);
      listeners.add(l);
      send('model', { state: 'ready' });
      let n = 0;
      while (!signal.aborted) {
        await sleep(15000);
        if (signal.aborted) break;
        send('ping', {});
        if (++n === 2) {
          const item = { id: id('ib'), title: 'Flour price alert', body: 'Your supplier raised bread flour 6%. Want me to compare two alternatives?', session_id: [...sessions.keys()][0], created: now(), read: false };
          inbox.unshift(item);
          send('inbox', { item });
        }
      }
      listeners.delete(l);
    }, req);
  }

  if (p === '/api/pair' && m === 'POST') return json({ code: '482 913', url: 'http://192.168.1.42:7878', expires: now() + 600, qr: fakeQR('pico://pair?u=http://192.168.1.42:7878&c=482913') });

  return json({ message: `mock: no route ${m} ${p}` }, 404);
}
let authStarted = 0;

function fakeQR(seed: string): string {
  // Not a real QR code — a deterministic QR-looking pattern for UI work.
  const n = 29;
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const rnd = () => ((h = Math.imul(h ^ (h >>> 13), 1274126177)) >>> 0) / 4294967296;
  const cells: string[] = [];
  const finder = (x: number, y: number) => cells.push(`<path d="M${x} ${y}h7v7h-7zM${x + 1} ${y + 1}v5h5v-5zM${x + 2} ${y + 2}h3v3h-3z" fill-rule="evenodd"/>`);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const inFinder = (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
    if (!inFinder && rnd() > 0.52) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
  }
  finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ${n + 2} ${n + 2}" shape-rendering="crispEdges" fill="#0b0b0c">${cells.join('')}</svg>`;
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return api(req, url);
    if (STATIC) {
      const root = join(process.cwd(), STATIC);
      let file = join(root, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(root) || !existsSync(file)) file = join(root, 'index.html');
      if (file.endsWith('index.html')) {
        const html = (await Bun.file(file).text()).replace('</head>', `<script>window.__PICO_TOKEN__=${JSON.stringify(TOKEN)}</script></head>`);
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return new Response(Bun.file(file));
    }
    return new Response('pico mock engine — API only. Run vite with PICO_MOCK=1, or pass --static dist.', { status: 404 });
  },
});
console.log(`pico mock engine on http://127.0.0.1:${server.port}  state=${state}${STATIC ? `  static=${STATIC}` : ''}  token=${TOKEN}`);
