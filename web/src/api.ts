// Pico engine API client. Contract: docs/API.md. Same-origin, relative URLs.

export type Effort = 'low' | 'medium' | 'high' | 'max';
/** Helper (subagent) effort still allows 'off'. */
export type HelperEffort = 'off' | 'low' | 'medium' | 'high';
export type Persona = 'engineer' | 'business' | 'creative' | 'marketing' | 'student' | 'general';

export interface Health { ok: boolean; version: string; state: 'setup' | 'ready' | 'starting_model' | 'error'; model?: string; provider?: string }
export interface Gpu { vendor: string; name: string; vram_gb: number; driver?: string; compute?: string }
export interface SystemInfo {
  os: string; arch: string; cpu: { name: string; cores: number }; ram_gb: number; gpus: Gpu[];
  unified_memory: boolean; disk_free_gb: number; accelerators: string[];
  runtimes?: Record<string, unknown>;
}
export interface Recipe {
  id: string; model: string; family: string; params_b: number; active_b?: number; quant: string; file_gb: number;
  ctx: number; runtime: string; flags?: unknown; est_tps: number; tps_source: 'measured' | 'est';
  strengths: string[]; fits: boolean; why: string;
  features?: { voice?: boolean; image?: boolean; video?: boolean };
}
export interface Recipes { recommended: Recipe; alternatives: Recipe[]; catalog_version: string }
export interface Update { kind: 'model' | 'config'; from: string; to: string; delta: { tps?: number; ctx?: number; quality?: string }; why: string }
export interface ModelInfo { id: string; name: string; provider: string; local: boolean; ctx: number; tps?: number | null; tps_measured?: number | null; last_used?: number | null; provider_label?: string; active?: boolean }
export interface Models { active: string; provider?: string; models: ModelInfo[] }
export interface SessionSummary { id: string; title: string; updated: number | string; pinned: boolean; goal?: string; preview?: string }
export interface Todo { text: string; done: boolean }
export interface DiffInfo { path: string; added: number; removed: number; unified: string; created?: boolean }
export interface ToolInfo { name: string; args?: unknown; result?: string; ok?: boolean; label?: string; seconds?: number; diff?: DiffInfo }
export interface Message {
  id: string; role: 'user' | 'assistant' | 'tool'; content: string; reasoning?: string; tool?: ToolInfo;
  created?: number | string; usage?: { input: number; output: number; cached?: number }; kind?: string;
  summary?: TurnSummaryInfo; context?: CtxInfo; steer?: boolean; followup?: boolean; loop?: { n: number }; plan?: PlanInfo;
}
export interface GoalState { text: string | null; status: 'active' | 'done' | 'cleared'; progress: { done: number; total: number } | null; todos: Todo[] }
export interface PlanStep { text: string; status: 'pending' | 'active' | 'done' }
export interface PlanInfo { title: string; phase: 'planning' | 'awaiting' | 'executing' | 'done'; steps: PlanStep[] }
export interface LoopInfo { active?: boolean; prompt?: string; every_s?: number; until_done?: boolean; runs: number; max_runs: number; next_at: number | null; state: 'running' | 'waiting' | 'stopped' | 'done'; n?: number }
/** Context window usage. `cached` may be a 0..1 ratio or a token count. */
export interface CtxInfo { used: number; max: number; cached?: number }
export interface FileChange { path: string; added: number; removed: number }
export interface TurnSummaryInfo { tools: number; files_changed: FileChange[]; seconds?: number; tps?: number; output_tokens?: number }
export interface Session {
  id: string; title: string; goal?: string; todos: Todo[]; cwd?: string; messages: Message[]; context?: CtxInfo;
  yolo?: boolean; goal_state?: GoalState; loop?: LoopInfo | null; model?: string; effort?: Effort | null; busy?: boolean;
}
export interface UndoResult { ok: boolean; restored?: number | string[]; deleted?: number | string[]; note?: string }
export interface SubagentCfg { enabled: boolean; max_parallel: number; model: string; effort: HelperEffort; max_seconds: number }
export interface MemoryItem { id: string; text: string }
export interface Skill { name: string; description: string; category?: string; enabled: boolean; builtin: boolean; body?: string }
export interface Connector {
  id: string; name: string; what: string; kind: 'mcp' | 'oauth' | 'key'; connected: boolean;
  setup: { fields?: { name: string; label?: string; secret?: boolean; placeholder?: string }[] | string[]; oauth_url?: string };
}
export interface Checkin {
  id: string; title: string; prompt: string; schedule: Record<string, unknown>; enabled?: boolean; created?: number;
  last_run?: number | null; next_run?: number | null; yolo?: boolean; schedule_text?: string; last_status?: null | 'running' | 'ok' | 'error'; session_id?: string;
}
export interface UsageRow { turns: number; input: number; output: number; cached: number; seconds?: number; tools?: number; tps?: number | null }
export interface Usage {
  days_requested: number; totals: UsageRow; cache_hit_pct: number | null;
  days: ({ date: string } & UsageRow)[]; by_model: ({ model: string } & UsageRow)[]; by_harness: ({ harness: string } & UsageRow)[];
  today: { date: string } & UsageRow;
}
export interface Preset { id: string; name: string; base_url: string; needs_key: boolean; note?: string }
export interface ProviderTest { ok: boolean; models?: string[]; model_used?: string; tps?: number; latency_s?: number; error?: { kind: string; message: string } }
export interface InboxItem { id: string; title: string; body: string; session_id?: string; created: number | string; read: boolean }
export interface Pairing { code: string; url: string; expires: number | string; qr: string }
export interface Attachment { name: string; mime: string; data_b64: string }

// ---------- token ----------
declare global { interface Window { __PICO_TOKEN__?: string } }
const TOKEN_KEY = 'pico.token';
export function getToken(): string | null {
  const injected = window.__PICO_TOKEN__;
  if (injected && !injected.startsWith('{{')) return injected;
  try {
    const url = new URL(location.href);
    const t = url.searchParams.get('token');
    if (t) { localStorage.setItem(TOKEN_KEY, t); url.searchParams.delete('token'); history.replaceState(null, '', url.toString()); return t; }
  } catch { /* ignore */ }
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) { localStorage.setItem(TOKEN_KEY, t.trim()); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

function headers(json = true): HeadersInit {
  const h: Record<string, string> = {};
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

export async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: headers(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined });
  if (r.status === 401) { onUnauthorized?.(); throw new ApiError(401, 'Unauthorized'); }
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = j.message || j.error || j.detail || msg; } catch { /* ignore */ }
    throw new ApiError(r.status, msg);
  }
  const text = await r.text();
  return (text ? JSON.parse(text) : {}) as T;
}
const get = <T>(p: string) => req<T>('GET', p);
const post = <T>(p: string, b: unknown = {}) => req<T>('POST', p, b);
const enc = encodeURIComponent;

export const api = {
  health: () => get<Health>('/api/health'),
  system: () => get<SystemInfo>('/api/system'),
  config: () => get<Record<string, unknown>>('/api/config'),
  patchConfig: (c: Record<string, unknown>) => req<Record<string, unknown>>('PATCH', '/api/config', c),
  recipes: (persona: Persona) => get<Recipes>(`/api/recipes?persona=${persona}`),
  updates: () => get<{ available: Update[] }>('/api/updates'),
  setup: (body: unknown) => post<{ job_id: string }>('/api/setup', body),
  models: () => get<Models>('/api/models'),
  setModel: (id: string, provider?: string) => post<{ ok: boolean }>('/api/models/active', provider ? { id, provider } : { id }),
  presets: () => get<Preset[]>('/api/provider/presets'),
  testProvider: (b: { base_url: string; api_key?: string; model?: string }) => post<ProviderTest>('/api/provider/test', { kind: 'custom', ...b }),
  usage: (days = 30) => get<Usage>(`/api/usage?days=${days}`),
  applyUpdate: (kind: string, to: string) => post<{ job_id: string }>('/api/updates/apply', { kind, to }),
  openaiStart: () => post<{ url: string; code: string }>('/api/auth/openai/start'),
  openaiStatus: () => get<{ state: string; url?: string; code?: string; logged_in?: boolean; error?: string }>('/api/auth/openai/status'),
  sessions: () => get<SessionSummary[]>('/api/sessions'),
  createSession: (b: { title?: string; yolo?: boolean; effort?: Effort } = {}) => post<Session>('/api/sessions', b),
  session: (id: string) => get<Session>(`/api/sessions/${enc(id)}`),
  patchSession: (id: string, b: Partial<{ title: string; pinned: boolean; goal: string | null; yolo: boolean; effort: Effort }>) => req<unknown>('PATCH', `/api/sessions/${enc(id)}`, b),
  deleteSession: (id: string) => req<unknown>('DELETE', `/api/sessions/${enc(id)}`),
  approve: (id: string, b: { id: string; allow: boolean; always?: boolean }) => post<unknown>(`/api/sessions/${enc(id)}/approve`, b),
  stop: (id: string) => post<unknown>(`/api/sessions/${enc(id)}/stop`),
  steer: (id: string, text: string) => post<{ ok: boolean; mode: 'steer' | 'queued' }>(`/api/sessions/${enc(id)}/steer`, { text }),
  loop: (id: string) => get<LoopInfo>(`/api/sessions/${enc(id)}/loop`),
  stopLoop: (id: string) => req<unknown>('DELETE', `/api/sessions/${enc(id)}/loop`),
  undo: (id: string) => post<UndoResult>(`/api/sessions/${enc(id)}/undo`),
  checkpoints: (id: string) => get<unknown[]>(`/api/sessions/${enc(id)}/checkpoints`),
  search: (q: string) => get<{ session_id: string; title: string; snippet: string }[]>(`/api/search?q=${enc(q)}`),
  memory: () => get<MemoryItem[]>('/api/memory'),
  addMemory: (text: string) => post<MemoryItem>('/api/memory', { text }),
  deleteMemory: (id: string) => req<unknown>('DELETE', `/api/memory/${enc(id)}`),
  skills: () => get<Skill[]>('/api/skills'),
  skill: (name: string) => get<Skill>(`/api/skills/${enc(name)}`),
  saveSkill: (name: string, b: { description: string; body: string }) => req<unknown>('PUT', `/api/skills/${enc(name)}`, b),
  toggleSkill: (name: string) => post<unknown>(`/api/skills/${enc(name)}/toggle`),
  connectors: () => get<Connector[]>('/api/connectors'),
  connect: (id: string, fields: Record<string, string>) => post<unknown>(`/api/connectors/${enc(id)}/connect`, { fields }),
  disconnect: (id: string) => req<unknown>('DELETE', `/api/connectors/${enc(id)}`),
  checkins: () => get<Checkin[]>('/api/checkins'),
  addCheckin: (c: { title?: string; prompt: string; schedule: Record<string, unknown>; yolo?: boolean }) => post<Checkin>('/api/checkins', c),
  patchCheckin: (id: string, b: Partial<{ enabled: boolean; prompt: string; title: string; yolo: boolean }>) => req<Checkin>('PATCH', `/api/checkins/${enc(id)}`, b),
  runCheckin: (id: string) => post<{ ok: boolean }>(`/api/checkins/${enc(id)}/run`),
  readInbox: (id: string) => post<unknown>(`/api/inbox/${enc(id)}/read`),
  deleteCheckin: (id: string) => req<unknown>('DELETE', `/api/checkins/${enc(id)}`),
  inbox: () => get<InboxItem[]>('/api/inbox'),
  pair: () => post<Pairing>('/api/pair'),
};

// ---------- SSE over fetch (POST streams + GET job streams) ----------
export interface SSEEvent { event: string; data: any }

/** Parse a text/event-stream body. Calls onEvent per event. Resolves when the stream ends. */
export async function readSSE(res: Response, onEvent: (e: SSEEvent) => void, signal?: AbortSignal): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flush = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const raw of block.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return;
    const s = data.join('\n');
    let parsed: unknown = s;
    try { parsed = JSON.parse(s); } catch { /* raw string */ }
    onEvent({ event, data: parsed });
  };
  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        flush(block);
      }
    }
    if (buf.trim()) flush(buf);
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

export async function streamSSE(method: string, path: string, body: unknown, onEvent: (e: SSEEvent) => void, signal?: AbortSignal) {
  const res = await fetch(path, {
    method, signal,
    headers: { ...headers(body !== undefined), Accept: 'text/event-stream' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { onUnauthorized?.(); throw new ApiError(401, 'Unauthorized'); }
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.message || j.error || msg; } catch { /* ignore */ }
    throw new ApiError(res.status, msg);
  }
  await readSSE(res, onEvent, signal);
}

export const sendMessage = (sid: string, body: { text: string; effort?: Effort; attachments?: Attachment[] }, onEvent: (e: SSEEvent) => void, signal?: AbortSignal) =>
  streamSSE('POST', `/api/sessions/${enc(sid)}/messages`, body, onEvent, signal);

export const jobEvents = (jobId: string, onEvent: (e: SSEEvent) => void, signal?: AbortSignal) =>
  streamSSE('GET', `/api/jobs/${enc(jobId)}/events`, undefined, onEvent, signal);

/** Long-lived engine event stream. EventSource cannot set headers, so the token rides as ?token=. */
export function openEvents(onEvent: (e: SSEEvent) => void): () => void {
  return openStream('/api/events', ['inbox', 'job', 'model', 'message', 'session', 'notice', 'loop'], onEvent);
}
const SESSION_EVENTS = ['hello', 'turn_start', 'delta', 'reasoning', 'tool_start', 'tool_progress', 'tool_end', 'todo', 'plan', 'goal', 'steer',
  'approval', 'done', 'error', 'loop', 'notice', 'compacted', 'subagent_start', 'subagent_progress', 'subagent_end'];
/** Long-lived per-session stream: every event of every turn in the chat (loops, steer follow-ups, other clients). */
export function openSessionStream(sid: string, onEvent: (e: SSEEvent) => void): () => void {
  return openStream(`/api/sessions/${enc(sid)}/stream`, SESSION_EVENTS, onEvent);
}
function openStream(path: string, types: string[], onEvent: (e: SSEEvent) => void): () => void {
  const t = getToken();
  let es: EventSource | null = null;
  let closed = false;
  let retry = 1000;
  const connect = () => {
    if (closed) return;
    es = new EventSource(`${path}${t ? `?token=${enc(t)}` : ''}`);
    const handle = (type: string) => (ev: MessageEvent) => {
      retry = 1000;
      let data: unknown = ev.data;
      try { data = JSON.parse(ev.data); } catch { /* raw */ }
      onEvent({ event: type, data });
    };
    for (const type of types) es.addEventListener(type, handle(type) as EventListener);
    es.onerror = () => {
      es?.close();
      if (!closed) { setTimeout(connect, retry); retry = Math.min(retry * 2, 30000); }
    };
  };
  connect();
  return () => { closed = true; es?.close(); };
}

export function fileToAttachment(f: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve({ name: f.name, mime: f.type || 'application/octet-stream', data_b64: s.slice(s.indexOf(',') + 1) });
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

export function fmtBytes(n?: number): string {
  if (!n && n !== 0) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}
/** 1834 → '1.8k', 18200 → '18k' (tokens, base 1000). */
export function fmtTok(n?: number): string {
  if (!n) return '0';
  if (n < 1000) return String(Math.round(n));
  return n < 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`;
}
export function fmtCtx(n: number): string { return n >= 1_000_000 ? `${+(n / 1048576).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1024)}k` : String(n); }
export function toDate(v: number | string | undefined): Date {
  if (v === undefined) return new Date();
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  return new Date(v);
}
export function timeAgo(v: number | string | undefined): string {
  const s = (Date.now() - toDate(v).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return toDate(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
