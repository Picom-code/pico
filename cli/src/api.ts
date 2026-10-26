// Pico engine HTTP+SSE client (contract: docs/API.md). Also finds/starts the engine.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseData, SSEParser } from './sse';
import type { Effort } from './effort';

export type Persona = 'engineer' | 'business' | 'creative' | 'marketing' | 'student' | 'general';
export interface Health { ok: boolean; version: string; state: 'setup' | 'ready' | 'starting_model' | 'error'; model?: string; provider?: string }
export interface Gpu { vendor: string; name: string; vram_gb: number; driver?: string; compute?: string }
export interface SystemInfo {
  os: string; arch: string; cpu: { name: string; cores: number }; ram_gb: number; gpus: Gpu[];
  unified_memory: boolean; disk_free_gb: number; accelerators: string[]; runtimes?: Record<string, unknown>;
}
export interface Recipe {
  id: string; model: string; family: string; params_b: number; active_b?: number; quant: string; file_gb: number;
  ctx: number; runtime: string; flags?: unknown; est_tps: number; tps_source: 'measured' | 'est';
  strengths: string[]; fits: boolean; why: string;
}
export interface Recipes { recommended: Recipe; alternatives: Recipe[]; catalog_version: string }
export interface Update { kind: 'model' | 'config'; from: string; to: string; delta: { tps?: number; ctx?: number; quality?: string }; why: string }
export interface ModelInfo { id: string; name: string; provider: string; local: boolean; ctx: number; tps?: number | null; provider_label?: string; tps_measured?: number | null; last_used?: number | string | null }
export interface SessionSummary { id: string; title: string; updated: number | string; pinned: boolean; goal?: string; preview?: string }
export interface Todo { text: string; done: boolean }
export interface Message {
  id: string; role: 'user' | 'assistant' | 'tool'; content: string; reasoning?: string;
  tool?: { name: string; args?: unknown; result?: string; ok?: boolean }; created?: number | string;
  usage?: { input: number; output: number };
}
export interface ContextInfo { used: number; max: number; cached?: number }
export interface Session { id: string; title: string; goal?: string; goal_state?: any; todos: Todo[]; cwd?: string; messages: Message[]; context?: ContextInfo; yolo?: boolean; loop?: any }
export interface UndoResult { ok: boolean; restored?: string[] | number; deleted?: string[] | number; note?: string }
export interface Skill { name: string; description: string; category?: string; enabled: boolean; builtin: boolean }
export interface Attachment { name: string; mime: string; data_b64: string }
export interface Config { persona?: Persona; model?: string; effort_default?: Effort; accent?: string; provider?: any; features?: any; subagents?: any }

export const picoHome = () => process.env.PICO_HOME || join(homedir(), '.pico');
export const baseUrl = () => (process.env.PICO_URL || `http://127.0.0.1:${process.env.PICO_PORT || 7878}`).replace(/\/+$/, '');

export function readToken(): string {
  if (process.env.PICO_TOKEN) return process.env.PICO_TOKEN.trim();
  const p = join(picoHome(), 'token');
  try {
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

export class ApiError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

export interface StreamHandlers {
  [event: string]: ((data: any) => void) | undefined;
}

export class Api {
  token = readToken();
  constructor(public base = baseUrl()) {}

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (!this.token) this.token = readToken();
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async req<T = any>(method: string, path: string, body?: unknown, timeoutMs = 30000): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(this.base + path, {
        method,
        headers: this.headers(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      if (!r.ok) {
        let msg = `${r.status} ${r.statusText}`;
        try {
          const j: any = await r.json();
          msg = j.message || j.error || j.detail || msg;
        } catch {}
        if (r.status === 401) msg = `unauthorized — token in ${join(picoHome(), 'token')} rejected`;
        throw new ApiError(r.status, msg);
      }
      const txt = await r.text();
      return (txt ? JSON.parse(txt) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }
  get<T = any>(p: string, timeoutMs?: number) {
    return this.req<T>('GET', p, undefined, timeoutMs);
  }
  post<T = any>(p: string, b: unknown = {}) {
    return this.req<T>('POST', p, b);
  }
  patch<T = any>(p: string, b: unknown = {}) {
    return this.req<T>('PATCH', p, b);
  }

  /** POST/GET an SSE endpoint; dispatches events to handlers. Resolves when the stream ends. */
  async stream(method: string, path: string, body: unknown, on: StreamHandlers, signal?: AbortSignal): Promise<void> {
    const r = await fetch(this.base + path, {
      method,
      headers: { ...this.headers(body !== undefined), Accept: 'text/event-stream' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!r.ok || !r.body) {
      let msg = `${r.status} ${r.statusText}`;
      try {
        const j: any = await r.json();
        msg = j.message || j.error || j.detail || msg;
      } catch {}
      throw new ApiError(r.status, msg);
    }
    const parser = new SSEParser((e) => {
      const fn = on[e.event] || on['*'];
      fn?.(e.event === 'message' || !on[e.event] ? { ...parseData(e.data), __event: e.event } : parseData(e.data));
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.feed(dec.decode(value, { stream: true }));
      }
      parser.end();
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  health(timeoutMs = 2500) {
    return this.get<Health>('/api/health', timeoutMs);
  }
  system() {
    return this.get<SystemInfo>('/api/system');
  }
  config() {
    return this.get<Config>('/api/config');
  }
  recipes(persona: string) {
    return this.get<Recipes>(`/api/recipes?persona=${encodeURIComponent(persona)}`);
  }
  updates() {
    return this.get<{ available: Update[] }>('/api/updates');
  }
  models() {
    return this.get<{ active: string; models: ModelInfo[] }>('/api/models');
  }
  setModel(id: string) {
    return this.post('/api/models/active', { id });
  }
  sessions() {
    return this.get<SessionSummary[]>('/api/sessions');
  }
  newSession(cwd: string) {
    return this.post<Session>('/api/sessions', { cwd });
  }
  session(id: string) {
    return this.get<Session>(`/api/sessions/${encodeURIComponent(id)}`);
  }
  stop(id: string) {
    return this.post(`/api/sessions/${encodeURIComponent(id)}/stop`);
  }
  approve(sid: string, id: string, allow: boolean, always = false) {
    return this.post(`/api/sessions/${encodeURIComponent(sid)}/approve`, { id, allow, always });
  }
  skills() {
    return this.get<Skill[]>('/api/skills');
  }
  patchConfig(body: Partial<Config>) {
    return this.patch('/api/config', body);
  }
  undo(sid: string) {
    return this.post<UndoResult>(`/api/sessions/${encodeURIComponent(sid)}/undo`);
  }
  checkpoints(sid: string) {
    return this.get<any[]>(`/api/sessions/${encodeURIComponent(sid)}/checkpoints`);
  }
  /** Long-lived GET /api/events stream (notices, inbox, model state). */
  events(sid: string | null, on: StreamHandlers, signal?: AbortSignal) {
    return this.stream('GET', `/api/events${sid ? `?session_id=${encodeURIComponent(sid)}` : ''}`, undefined, on, signal);
  }
  /** Steer the running turn: {ok, mode:'steer'|'queued'}; 409 when no turn is running. */
  steer(sid: string, text: string) {
    return this.post<{ ok: boolean; mode?: 'steer' | 'queued' }>(`/api/sessions/${encodeURIComponent(sid)}/steer`, { text });
  }
  usage(days = 30) {
    return this.get<any>(`/api/usage?days=${days}`);
  }
  checkins() {
    return this.get<any>('/api/checkins').then((r) => (Array.isArray(r) ? r : Array.isArray(r?.items) ? r.items : Array.isArray(r?.checkins) ? r.checkins : []));
  }
  addCheckin(body: unknown) {
    return this.post<any>('/api/checkins', body);
  }
  patchCheckin(id: string, body: unknown) {
    return this.patch<any>(`/api/checkins/${encodeURIComponent(id)}`, body);
  }
  deleteCheckin(id: string) {
    return this.req<any>('DELETE', `/api/checkins/${encodeURIComponent(id)}`);
  }
  runCheckin(id: string) {
    return this.post<any>(`/api/checkins/${encodeURIComponent(id)}/run`);
  }
  loop(sid: string) {
    return this.get<any>(`/api/sessions/${encodeURIComponent(sid)}/loop`);
  }
  stopLoop(sid: string) {
    return this.req<any>('DELETE', `/api/sessions/${encodeURIComponent(sid)}/loop`);
  }
  /** Engine-started turns (loop / cron) in this session, as a long-lived SSE stream. */
  sessionStream(sid: string, on: StreamHandlers, signal?: AbortSignal) {
    return this.stream('GET', `/api/sessions/${encodeURIComponent(sid)}/stream`, undefined, on, signal);
  }
  send(sid: string, body: { text: string; effort?: Effort; attachments?: Attachment[] }, on: StreamHandlers, signal?: AbortSignal) {
    return this.stream('POST', `/api/sessions/${encodeURIComponent(sid)}/messages`, body, on, signal);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Health check; if the engine is down, try to start it in the background and wait. */
export async function ensureEngine(api: Api, opts: { start?: boolean; timeoutMs?: number; onStatus?: (s: string) => void } = {}): Promise<Health> {
  try {
    return await api.health();
  } catch {}
  if (opts.start === false) throw new Error(`engine not reachable at ${api.base}`);
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(api.base);
  if (!local) throw new Error(`engine not reachable at ${api.base}`);
  const cmd = process.env.PICO_ENGINE_CMD || (Bun.which('pico-engine') ? 'pico-engine' : '');
  if (!cmd) throw new Error(`engine not running at ${api.base} and no 'pico-engine' on PATH (set PICO_ENGINE_CMD, e.g. "python -m pico.server")`);
  opts.onStatus?.(`starting engine: ${cmd}`);
  try {
    const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    child.on('error', () => {});
    child.unref();
  } catch (e: any) {
    throw new Error(`could not start engine (${cmd}): ${e?.message || e}`);
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 45000);
  while (Date.now() < deadline) {
    await sleep(400);
    try {
      const h = await api.health(1500);
      api.token = readToken(); // engine creates the token on first start
      return h;
    } catch {}
  }
  throw new Error(`engine did not become healthy at ${api.base} within ${Math.round((opts.timeoutMs ?? 45000) / 1000)}s`);
}
