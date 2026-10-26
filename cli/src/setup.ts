// Easy model setup: one small rounded box with 3 choices, used by the first-run wizard, /setup,
// `pico --setup` and `pico --login`.
//   ChatGPT subscription (login)  -> device code box, open browser, poll, pick a model, POST /api/setup
//   Any API (endpoint + key)      -> base URL (presets row) -> key (masked) -> models -> test -> save
//   Local model (scan my hardware)-> the existing hardware wizard
// Pure renderers (setupChoiceLines, apiFormLines, loginBoxLines) are unit-tested; the key is never
// rendered (only '•' while typing, 'hidden' afterwards) and never printed to scrollback.
import { spawn } from 'node:child_process';
import { bold, C, fg, G, t, truncate, width as w } from './ansi';
import type { Api } from './api';
import { fuzzyFilter } from './fuzzy';
import type { Key } from './keys';
import type { LiveScreen, Terminal } from './tty';
import { box, modal } from './ui';
import { spinGlyph } from './theme';

export type SetupChoice = 'openai_login' | 'custom' | 'local';
export const SETUP_CHOICES: { value: SetupChoice; label: string; hint: string }[] = [
  { value: 'openai_login', label: 'ChatGPT subscription (login)', hint: 'use your ChatGPT plan · no key' },
  { value: 'custom', label: 'Any API (endpoint + key)', hint: 'OpenAI, OpenRouter, Groq, Ollama…' },
  { value: 'local', label: 'Local model (scan my hardware)', hint: 'private · free · runs here' },
];

export interface Preset {
  id: string;
  name: string;
  base_url: string;
  needs_key: boolean;
}
export const PRESETS: Preset[] = [
  { id: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', needs_key: true },
  { id: 'openrouter', name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', needs_key: true },
  { id: 'anthropic-compatible', name: 'Anthropic', base_url: 'https://api.anthropic.com/v1', needs_key: true },
  { id: 'groq', name: 'Groq', base_url: 'https://api.groq.com/openai/v1', needs_key: true },
  { id: 'together', name: 'Together', base_url: 'https://api.together.xyz/v1', needs_key: true },
  { id: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', needs_key: true },
  { id: 'ollama', name: 'Ollama', base_url: 'http://localhost:11434/v1', needs_key: false },
  { id: 'lmstudio', name: 'LM Studio', base_url: 'http://localhost:1234/v1', needs_key: false },
];

/** 'openrouter' / 'ollama' / 'lm studio' typed into the URL field -> that preset's URL. */
export function resolvePreset(typed: string): Preset | null {
  const v = typed.trim().toLowerCase().replace(/\s+/g, '');
  if (!v || /^https?:/.test(v)) return null;
  return PRESETS.find((p) => p.id === v || p.id.replace(/-.*/, '') === v || p.name.toLowerCase().replace(/\s+/g, '') === v) ?? null;
}
export const isLocalUrl = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|192\.168\.|10\.)/i.test(u.trim());
/** Normalize a typed base URL: add http(s)://, drop trailing slashes. */
export function normalizeUrl(u: string): string {
  let s = u.trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = (/^(localhost|127\.|\[::1\]|192\.168\.|10\.)/.test(s) ? 'http://' : 'https://') + s;
  return s;
}

export interface TestResult {
  ok: boolean;
  models?: string[];
  model_used?: string | null;
  tps?: number | null;
  error?: { kind: string; message: string };
}

/** Plain-English error for an HTTP status / network failure (never includes the key). */
export function plainError(status: number | null, what: 'models' | 'chat', e?: any): { kind: string; message: string } {
  if (status === 401 || status === 403) return { kind: 'auth', message: '401 · bad key: the server rejected it' };
  if (status === 404) return { kind: 'not_found', message: what === 'models' ? '404 · wrong URL: it usually ends in /v1' : '404 · that model was not found here' };
  if (status === 429) return { kind: 'other', message: '429 · rate-limited or out of credit' };
  if (status) return { kind: 'other', message: `HTTP ${status} from the server` };
  const m = String(e?.message || e || '');
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed? ?out/i.test(m)) return { kind: 'timeout', message: 'timeout · the server did not answer' };
  if (/refused|ECONNREFUSED|Unable to connect/i.test(m)) return { kind: 'network', message: 'nothing is listening at that address' };
  if (/ENOTFOUND|getaddrinfo|resolve/i.test(m)) return { kind: 'network', message: "couldn't find that server name" };
  return { kind: 'network', message: `couldn't connect (${m.slice(0, 80)})` };
}

/**
 * Test an endpoint: engine route POST /api/provider/test first (it keeps the key server-side and
 * measures tok/s); if the engine is older (404), talk to {base}/models + /chat/completions directly.
 */
export async function testEndpoint(api: Api, base_url: string, api_key: string, model?: string, fetchImpl: typeof fetch = fetch): Promise<TestResult> {
  try {
    return await api.post<TestResult>('/api/provider/test', { base_url, api_key: api_key || undefined, ...(model ? { model } : {}) });
  } catch (e: any) {
    if (e?.status !== 404 && e?.status !== 405) return { ok: false, error: { kind: 'other', message: e?.message || String(e) } };
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (api_key) headers.Authorization = `Bearer ${api_key}`;
  const out: TestResult = { ok: false, models: [] };
  try {
    const r = await fetchImpl(base_url + '/models', { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403 || !model) return { ...out, error: plainError(r.status, 'models') };
    } else {
      const j: any = await r.json().catch(() => ({}));
      const items = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
      out.models = items.map((m: any) => m?.id).filter(Boolean);
    }
  } catch (e) {
    return { ...out, error: plainError(null, 'models', e) };
  }
  if (!model) return { ...out, ok: true };
  const t0 = Date.now();
  try {
    const r = await fetchImpl(base_url + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, max_tokens: 8, temperature: 0, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return { ...out, model_used: model, error: plainError(r.status, 'chat') };
    const j: any = await r.json().catch(() => ({}));
    const toks = +(j?.usage?.completion_tokens || 0);
    const dt = (Date.now() - t0) / 1000;
    return { ...out, ok: true, model_used: model, tps: toks && dt > 0.05 ? Math.round((toks / dt) * 10) / 10 : null };
  } catch (e) {
    return { ...out, model_used: model, error: plainError(null, 'chat', e) };
  }
}

export function openBrowser(url: string) {
  if (process.env.PICO_NO_BROWSER) return;
  const cmd = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  try {
    const p = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch {}
}

// ---------------------------------------------------------------- pure renderers
const innerW = (cols: number) => Math.min(Math.max(44, cols - 4), 72);
const keyHint = (pairs: [string, string][]) => pairs.map(([k, v]) => t.accent(k) + t.faint(' ' + v)).join(t.faint(` ${G().sep} `));

/** The 3-choice box. */
export function setupChoiceLines(idx: number, cols: number, title = 'set up a model'): string[] {
  const g = G();
  const inner = innerW(cols);
  const labW = Math.max(...SETUP_CHOICES.map((c) => w(c.label))) + 3;
  const body = [''];
  SETUP_CHOICES.forEach((c, i) => {
    const on = i === idx;
    const lab = on ? bold(fg(C.text)(c.label)) : t.muted(c.label);
    body.push((on ? t.accent(g.caret) : ' ') + ' ' + lab + ' '.repeat(Math.max(1, labW - w(c.label))) + (on ? t.dim : t.faint)(c.hint));
  });
  body.push('');
  return box(t.accent('(o.o)') + ' ' + title, body, inner, C.faint, keyHint([['↑↓', 'move'], ['enter', 'choose'], ['esc', 'cancel']])).map((l) => '  ' + l);
}

export type ApiStep = 'url' | 'key' | 'loading' | 'models' | 'testing' | 'saving' | 'done';
export interface ApiForm {
  step: ApiStep;
  url: string;
  preset: number; // index into PRESETS (-1 = custom)
  key: string;
  models: string[];
  filter: string;
  modelIdx: number;
  model?: string;
  error?: string;
  ok?: string;
}
export const newApiForm = (): ApiForm => ({ step: 'url', url: PRESETS[0].base_url, preset: 0, key: '', models: [], filter: '', modelIdx: 0 });

export function filteredModels(f: ApiForm): string[] {
  return f.filter ? fuzzyFilter(f.models, f.filter, (m) => m) : f.models;
}

/** The Any API box, one step at a time; completed steps stay as dim summary rows. */
export function apiFormLines(f: ApiForm, cols: number, now = Date.now()): string[] {
  const g = G();
  const inner = innerW(cols);
  const caret = t.accent('▏');
  const body: string[] = [''];
  const done = (k: string, v: string) => body.push(t.ok(g.check) + ' ' + t.dim(k.padEnd(6)) + t.muted(truncate(v, inner - 14)));
  // presets row: a horizontal picker
  const presetsRow = () => {
    const parts = PRESETS.map((p, i) => (i === f.preset ? t.accent(bold(p.name)) : t.faint(p.name)));
    let line = '';
    for (const p of parts) if (w(line) + w(p) + 2 < inner - 4) line += (line ? '  ' : '') + p;
    return line;
  };
  if (f.step === 'url') {
    body.push(t.accent('? ') + bold('base URL') + t.faint('  or type a name: openrouter, groq, ollama…'));
    body.push('  ' + t.accent(g.user + ' ') + fg(C.text)(truncate(f.url, inner - 10)) + caret);
    body.push('  ' + presetsRow());
  } else done('url', f.url);
  if (f.step === 'key') {
    const local = isLocalUrl(f.url) || (f.preset >= 0 && !PRESETS[f.preset].needs_key);
    body.push(t.accent('? ') + bold('API key') + t.faint(local ? '  optional for local servers · enter to skip' : '  hidden as you type'));
    body.push('  ' + t.accent(g.user + ' ') + t.dim('•'.repeat(Math.min(f.key.length, inner - 12))) + caret);
  } else if (f.step !== 'url') done('key', f.key ? 'hidden' : 'none');
  if (f.step === 'loading') body.push(t.accent(spinGlyph(now)) + ' ' + t.muted('asking the server for its models…'));
  if (f.step === 'models' || f.step === 'testing' || f.step === 'saving' || f.step === 'done') {
    if (f.step === 'models') {
      const list = filteredModels(f);
      body.push(t.accent('? ') + bold('model') + t.faint(`  ${f.models.length} available`) + (f.filter ? t.dim('  filter: ') + fg(C.text)(f.filter) + caret : t.faint('  type to filter')));
      const max = 7;
      const start = Math.max(0, Math.min(f.modelIdx - Math.floor(max / 2), list.length - max));
      list.slice(start, start + max).forEach((m, j) => {
        const on = start + j === f.modelIdx;
        body.push((on ? t.accent(g.caret) : ' ') + ' ' + (on ? bold(fg(C.text)(m)) : t.muted(m)));
      });
      if (!list.length) body.push(t.faint(f.models.length ? '  no match' : '  the server listed no models · type a model name, enter to use it'));
      if (list.length > max) body.push(t.faint(`  ${f.modelIdx + 1} of ${list.length}`));
    } else done('model', f.model || '');
  }
  if (f.step === 'testing') body.push(t.accent(spinGlyph(now)) + ' ' + t.muted(`testing ${f.model}…`));
  if (f.step === 'saving') body.push(t.accent(spinGlyph(now)) + ' ' + t.muted('saving…'));
  if (f.ok) body.push(t.ok(g.check + ' ') + t.ok(f.ok));
  if (f.error) body.push(t.err(g.cross + ' ') + t.err(truncate(f.error, inner - 8)));
  body.push('');
  const keys: Record<ApiStep, [string, string][]> = {
    url: [['←→', 'preset'], ['enter', 'next'], ['esc', 'back']],
    key: [['enter', 'next'], ['esc', 'back']],
    loading: [['esc', 'back']],
    models: [['↑↓', 'move'], ['enter', 'test + save'], ['esc', 'back']],
    testing: [['esc', 'back']],
    saving: [],
    done: [['enter', 'start chatting']],
  };
  return box(t.accent(g.dot) + ' any API', body, inner, C.faint, keyHint(keys[f.step])).map((l) => '  ' + l);
}

export type LoginState = 'starting' | 'waiting' | 'models' | 'saving' | 'done' | 'error';
/** ChatGPT login: the URL + code big and centered, a spinner while we poll. */
export function loginBoxLines(s: { state: LoginState; url?: string; code?: string; error?: string; models?: string[]; idx?: number }, cols: number, now = Date.now()): string[] {
  const g = G();
  const inner = innerW(cols);
  const body: string[] = [''];
  const center = (x: string) => ' '.repeat(Math.max(0, Math.floor((inner - 4 - w(x)) / 2))) + x;
  if (s.state === 'starting') body.push(t.accent(spinGlyph(now)) + ' ' + t.muted('asking OpenAI for a login code…'));
  if (s.url && (s.state === 'waiting' || s.state === 'error')) {
    body.push(center(t.dim('1. open')));
    body.push(center(t.accent(bold(s.url))));
    body.push('');
    body.push(center(t.dim('2. enter this code')));
    const code = (s.code || '').split('').join(' ');
    body.push(center(bold(fg(C.text)(code))));
    body.push('');
    if (s.state === 'waiting') body.push(center(t.accent(spinGlyph(now)) + ' ' + t.muted('waiting for you to finish in the browser…')));
  }
  if (s.state === 'models' && s.models) {
    body.push(t.ok(g.check) + ' ' + t.muted('signed in') + t.faint('  pick a model'));
    s.models.slice(0, 8).forEach((m, i) => body.push((i === s.idx ? t.accent(g.caret) : ' ') + ' ' + (i === s.idx ? bold(fg(C.text)(m)) : t.muted(m))));
  }
  if (s.state === 'saving') body.push(t.accent(spinGlyph(now)) + ' ' + t.muted('saving…'));
  if (s.state === 'done') body.push(t.ok(g.check + ' connected'));
  if (s.error) body.push(t.err(g.cross + ' ' + truncate(s.error, inner - 8)));
  body.push('');
  const keys: [string, string][] = s.state === 'models' ? [['↑↓', 'move'], ['enter', 'save'], ['esc', 'cancel']] : [['o', 'open browser again'], ['esc', 'cancel']];
  return box(t.accent('(^.^)') + ' ChatGPT login', body, inner, C.faint, keyHint(keys)).map((l) => '  ' + l);
}

// ---------------------------------------------------------------- flows
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function editLine(v: string, k: Key): string | null {
  if (k.name === 'backspace') return Array.from(v).slice(0, -1).join('');
  if (k.name === 'paste' && k.paste != null) return v + k.paste.replace(/[\r\n]+/g, '').trim();
  if (k.ctrl && k.name === 'u') return '';
  if (k.ch && !k.ctrl && !k.alt) return v + k.ch;
  return null;
}

export async function chooseSetup(term: Terminal, screen: LiveScreen, header: () => string[] = () => [], initial = 0): Promise<SetupChoice | null> {
  let idx = initial;
  return modal<SetupChoice | null>(term, screen, () => setupChoiceLines(idx, term.cols), (k) => {
    if (k.name === 'escape' || k.name === 'q') return null;
    if (k.name === 'up' || k.name === 'k') idx = (idx + 2) % 3;
    else if (k.name === 'down' || k.name === 'j' || k.name === 'tab') idx = (idx + 1) % 3;
    else if (k.ch && /^[1-3]$/.test(k.ch)) return SETUP_CHOICES[+k.ch - 1].value;
    else if (k.name === 'enter') return SETUP_CHOICES[idx].value;
    return undefined;
  }, header);
}

/** POST /api/setup and follow the job (if any). Returns ok + a message. */
async function saveSetup(api: Api, body: any): Promise<{ ok: boolean; message?: string }> {
  try {
    const r = await api.post<{ job_id?: string; ok?: boolean }>('/api/setup', body);
    if (!r?.job_id) return { ok: r?.ok !== false };
    let ok = false;
    let message = '';
    await api.stream('GET', `/api/jobs/${encodeURIComponent(r.job_id)}/events`, undefined, {
      done: (d) => (ok = d?.ok !== false),
      error: (d) => (message = d?.message || 'setup failed'),
      '*': () => {},
    });
    return { ok: ok && !message, message };
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) };
  }
}

/** Any API flow. Resolves with a one-line summary ('model · base') or null when cancelled. */
export async function apiSetupFlow(api: Api, term: Terminal, screen: LiveScreen, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const f = newApiForm();
  const timer = setInterval(() => screen.render({ lines: ['', ...apiFormLines(f, term.cols)] }), 100);
  let gen = 0;
  const loadModels = async () => {
    const my = ++gen;
    f.step = 'loading';
    f.error = undefined;
    const r = await testEndpoint(api, f.url, f.key, undefined, fetchImpl);
    if (my !== gen) return;
    if (r.error && (r.error.kind === 'auth' || r.error.kind === 'network' || r.error.kind === 'timeout' || (r.error.kind === 'not_found' && !r.models?.length))) {
      f.error = r.error.message;
      f.step = r.error.kind === 'auth' ? 'key' : 'url';
      return;
    }
    f.models = r.models || [];
    f.modelIdx = Math.max(0, r.model_used ? f.models.indexOf(r.model_used) : 0);
    f.filter = '';
    f.step = 'models';
  };
  const testAndSave = async (model: string): Promise<boolean> => {
    const my = ++gen;
    f.model = model;
    f.step = 'testing';
    f.error = undefined;
    f.ok = undefined;
    const r = await testEndpoint(api, f.url, f.key, model, fetchImpl);
    if (my !== gen) return false;
    if (!r.ok) {
      f.error = r.error?.message || 'test failed';
      f.step = 'models';
      return false;
    }
    f.ok = `connected${r.tps ? ` ${G().sep} ${Math.round(r.tps)} tok/s` : ''}`;
    f.step = 'saving';
    const s = await saveSetup(api, { provider: { kind: 'custom', base_url: f.url, api_key: f.key || undefined, model }, model });
    if (!s.ok) {
      f.error = `couldn't save: ${s.message || 'engine refused'}`;
      f.step = 'models';
      return false;
    }
    f.step = 'done';
    return true;
  };
  try {
    return await modal<string | null>(term, screen, () => ['', ...apiFormLines(f, term.cols)], async (k) => {
      if (f.step === 'done') return k.name === 'enter' || k.name === 'escape' ? `${f.model} ${G().sep} ${f.url}` : undefined;
      if (k.name === 'escape') {
        gen++;
        f.error = undefined;
        if (f.step === 'url') return null;
        f.step = f.step === 'key' ? 'url' : f.step === 'loading' ? 'key' : f.step === 'models' || f.step === 'testing' ? 'key' : f.step;
        return undefined;
      }
      if (f.step === 'url') {
        if (k.name === 'left' || k.name === 'right') {
          f.preset = (Math.max(0, f.preset) + (k.name === 'right' ? 1 : -1) + PRESETS.length) % PRESETS.length;
          f.url = PRESETS[f.preset].base_url;
        } else if (k.name === 'enter') {
          const p = resolvePreset(f.url);
          if (p) {
            f.preset = PRESETS.indexOf(p);
            f.url = p.base_url;
          }
          f.url = normalizeUrl(f.url);
          if (!/^https?:\/\/[^/]+/.test(f.url)) f.error = 'enter a URL like https://api.example.com/v1';
          else {
            f.error = undefined;
            f.step = 'key';
          }
        } else {
          const v = editLine(f.url, k);
          if (v != null) {
            f.url = v;
            const i = PRESETS.findIndex((p) => p.base_url === v.trim());
            f.preset = i;
          }
        }
        return undefined;
      }
      if (f.step === 'key') {
        if (k.name === 'enter') void loadModels();
        else {
          const v = editLine(f.key, k);
          if (v != null) f.key = v.trim();
        }
        return undefined;
      }
      if (f.step === 'models') {
        const list = filteredModels(f);
        if (k.name === 'up') f.modelIdx = Math.max(0, f.modelIdx - 1);
        else if (k.name === 'down') f.modelIdx = Math.min(Math.max(0, list.length - 1), f.modelIdx + 1);
        else if (k.name === 'enter') {
          const m = list[f.modelIdx] ?? f.filter.trim();
          if (m) void testAndSave(m);
        } else {
          const v = editLine(f.filter, k);
          if (v != null) {
            f.filter = v;
            f.modelIdx = 0;
          }
        }
      }
      return undefined;
    });
  } finally {
    clearInterval(timer);
    f.key = '';
  }
}

const isLoggedIn = (s: string) => ['ok', 'done', 'connected', 'logged_in', 'success'].includes(s);

/** ChatGPT flow. Resolves with the model id or null when cancelled. */
export async function loginFlow(api: Api, term: Terminal, screen: LiveScreen, opts: { pollMs?: number } = {}): Promise<string | null> {
  const st: { state: LoginState; url?: string; code?: string; error?: string; models?: string[]; idx: number } = { state: 'starting', idx: 0 };
  const draw = () => ['', ...loginBoxLines(st, term.cols)];
  const timer = setInterval(() => screen.render({ lines: draw() }), 100);
  let cancelled = false;
  let resolveModal: ((v: string | null) => void) | null = null;
  const run = async () => {
    try {
      const r = await api.post<{ url: string; code: string }>('/api/auth/openai/start');
      st.url = r.url;
      st.code = r.code;
      st.state = 'waiting';
      openBrowser(r.url);
    } catch (e: any) {
      st.state = 'error';
      st.error = e?.status === 404 ? 'this engine has no ChatGPT login yet' : e?.message || String(e);
      return;
    }
    const deadline = Date.now() + 15 * 60_000;
    while (!cancelled && Date.now() < deadline) {
      try {
        const s = await api.get<{ state: string; message?: string }>('/api/auth/openai/status');
        if (isLoggedIn(s.state)) break;
        if (s.state === 'error' || s.state === 'expired') {
          st.state = 'error';
          st.error = s.message || `login ${s.state}`;
          return;
        }
      } catch {}
      await sleep(opts.pollMs ?? 1500);
    }
    if (cancelled) return;
    let models: string[] = [];
    try {
      const m = await api.models();
      models = m.models.filter((x: any) => x.provider === 'openai_login' || /chatgpt/i.test(x.provider_label || '')).map((x) => x.id);
    } catch {}
    st.models = models.length ? models : ['gpt-5.5'];
    st.state = 'models';
  };
  void run();
  try {
    return await modal<string | null>(term, screen, draw, async (k) => {
      if (k.name === 'escape') {
        cancelled = true;
        return null;
      }
      if (st.state === 'waiting' && k.name === 'o' && st.url) openBrowser(st.url);
      if (st.state === 'models' && st.models) {
        if (k.name === 'up') st.idx = Math.max(0, st.idx - 1);
        else if (k.name === 'down') st.idx = Math.min(st.models.length - 1, st.idx + 1);
        else if (k.name === 'enter') {
          const model = st.models[st.idx];
          st.state = 'saving';
          const s = await saveSetup(api, { provider: { kind: 'openai_login', model }, model });
          if (!s.ok) {
            st.state = 'models';
            st.error = `couldn't save: ${s.message || 'engine refused'}`;
            return undefined;
          }
          st.state = 'done';
          return model;
        }
      }
      return undefined;
    });
  } finally {
    clearInterval(timer);
    void resolveModal;
  }
}
