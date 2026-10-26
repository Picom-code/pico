import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  api, ApiError, openEvents, openSessionStream, sendMessage, timeAgo, toDate,
  type Attachment, type CtxInfo, type Effort, type GoalState, type Health, type InboxItem, type LoopInfo, type Message,
  type ModelInfo, type Models, type PlanInfo, type SessionSummary, type Skill, type Todo,
} from '../api';
import { renderMarkdown } from '../markdown';
import { EFFORTS, accentId, applyAccent } from '../theme';
import { Cat, Icon, Spinner, toast, type Mood } from '../components/ui';
import {
  ApprovalCard, ContextPills, GoalBanner, HelpersCard, LoopChip, NoticeChip, PlanCard, SteerNote, ThinkingPill, ToolStack, TurnSummary,
  noticeText, turnMood, useNow,
  type ApprovalPart, type Helper, type Part, type ToolCard, type Turn,
} from '../components/turn';
import { Composer, useOutside } from '../components/composer';
import { Settings, type SettingsTab } from './Settings';

// ---------- view model ----------
type UserItem = { kind: 'user'; id: string; text: string; files?: string[]; leaving?: boolean; tag?: string };
type Item = UserItem | (Turn & { leaving?: boolean });

let uid = 0;
const nid = () => `l${Date.now().toString(36)}${(uid++).toString(36)}`;

function fromMessages(msgs: Message[]): Item[] {
  const out: Item[] = [];
  let turn: Turn | null = null;
  const ensure = (id: string): Turn => {
    if (!turn) { turn = { kind: 'turn', id, parts: [], streaming: false, effort: 'medium', start: 0 }; out.push(turn); }
    return turn;
  };
  for (const m of msgs) {
    if (m.role === 'user') {
      if (m.steer && !m.followup) {
        const t = ensure(m.id);
        t.parts.push({ kind: 'steer', id: m.id, text: m.content, state: 'applied' });
        continue;
      }
      turn = null;
      out.push({ kind: 'user', id: m.id, text: m.content, tag: m.followup ? 'steer' : m.loop ? `loop ${m.loop.n}` : undefined });
      continue;
    }
    if (m.role === 'assistant') {
      const t = ensure(m.id);
      if (m.summary) t.summary = m.summary;
      if (!m.content && !m.reasoning) continue;
      if (m.reasoning) t.parts.push({ kind: 'thinking', id: m.id + 'r', text: m.reasoning, start: 0 });
      if (m.content) t.parts.push({ kind: 'text', id: m.id, text: m.content });
    } else if (m.role === 'tool' && m.tool) {
      const t = ensure(m.id);
      const card: ToolCard = { id: m.id, name: m.tool.name, args: m.tool.args, label: m.tool.label, ok: m.tool.ok ?? true, preview: m.tool.result, running: false, tail: [], diff: m.tool.diff, seconds: m.tool.seconds, start: 0 };
      const last = t.parts[t.parts.length - 1];
      if (last?.kind === 'tools') last.tools.push(card); else t.parts.push({ kind: 'tools', id: m.id, tools: [card] });
    }
  }
  return out;
}

function closeThinking(parts: Part[]): Part[] {
  return parts.map((p) => (p.kind === 'thinking' && !p.end && p.start ? { ...p, end: Date.now() } : p));
}
function mapTools(parts: Part[], id: string, fn: (t: ToolCard) => ToolCard): Part[] {
  return parts.map((p) => (p.kind === 'tools' && p.tools.some((t) => t.id === id) ? { ...p, tools: p.tools.map((t) => (t.id === id ? fn(t) : t)) } : p));
}
function mapHelpers(parts: Part[], id: string, fn: (a: Helper) => Helper): Part[] {
  return parts.map((p) => (p.kind === 'helpers' && p.agents.some((a) => a.id === id) ? { ...p, agents: p.agents.map((a) => (a.id === id ? fn(a) : a)) } : p));
}
const asLines = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split('\n') : []);

const QUIPS = [
  'tests first, then snacks.', 'what are we breaking today?', 'i read the docs so you don\'t have to.', 'small diffs, big naps.',
  'it works on my machine. i am the machine.', 'type something. i\'m all ears. both of them.', 'no meetings, just merges.',
  'let\'s ship it before it gets ideas.', 'i promise not to rm -rf anything you love.', 'coffee for you, tokens for me.',
  'have you tried turning it off and on again?', 'ready when you are. mostly napping until then.',
];

const IDLE_SLEEP_MS = 3 * 60 * 1000;
const NO_GOAL: GoalState = { text: null, status: 'cleared', progress: null, todos: [] };

export function Chat({ health, onNeedSetup }: { health: Health | null; onNeedSetup: () => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sid, setSid] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const sidRef = useRef<string | null>(null);
  useEffect(() => { sidRef.current = sid; }, [sid]);
  const [goal, setGoal] = useState<GoalState>(NO_GOAL);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [loop, setLoop] = useState<LoopInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const [loadingSession, setLoadingSession] = useState(false);
  const [efforts, setEfforts] = useState<Effort[]>(EFFORTS);
  const [defaultEffort, setDefaultEffort] = useState<Effort>('medium');
  const [effort, setEffort] = useState<Effort>('medium');
  const [models, setModels] = useState<Models | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [view, setView] = useState<'chat' | 'settings'>(() => (location.hash.startsWith('#settings') ? 'settings' : 'chat'));
  const [sideOpen, setSideOpen] = useState(() => localStorage.getItem('pico.sidebar') !== 'closed' && innerWidth > 860);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [draft, setDraft] = useState('');
  const [ctx, setCtx] = useState<CtxInfo | null>(null);
  const [compacted, setCompacted] = useState<{ before: number; after: number; key: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [yolo, setYolo] = useState(false);
  const [globalYolo, setGlobalYolo] = useState(false);
  const [quip, setQuip] = useState(() => QUIPS[Math.floor(Math.random() * QUIPS.length)]);
  const [flash, setFlash] = useState<{ mood: Mood; key: number } | null>(null);
  const [asleep, setAsleep] = useState(false);
  const lastActive = useRef(Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const turnRef = useRef<string | null>(null);   // the live turn (own or foreign)
  const ownRef = useRef(false);                   // true while our own POST stream is running
  const steerQueue = useRef<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const recentNotices = useRef<Map<string, number>>(new Map());

  const toggleSide = useCallback(() => setSideOpen((o) => { localStorage.setItem('pico.sidebar', o ? 'closed' : 'open'); return !o; }), []);
  const refreshSessions = useCallback(() => api.sessions().then(setSessions).catch(() => {}), []);
  const refreshInbox = useCallback(() => api.inbox().then(setInbox).catch(() => {}), []);
  const refreshModels = useCallback(() => api.models().then(setModels).catch(() => {}), []);

  const poke = () => { lastActive.current = Date.now(); setAsleep(false); };
  useEffect(() => {
    const t = setInterval(() => { if (!busyRef.current && Date.now() - lastActive.current > IDLE_SLEEP_MS) setAsleep(true); }, 5000);
    const wake = () => poke();
    addEventListener('pointermove', wake, { passive: true });
    addEventListener('keydown', wake);
    return () => { clearInterval(t); removeEventListener('pointermove', wake); removeEventListener('keydown', wake); };
  }, []);

  const patchTurn = (fn: (t: Turn) => Turn, id = turnRef.current) =>
    setItems((s) => s.map((it) => (it.kind === 'turn' && it.id === id ? fn(it) : it)));

  const showNotice = (kind: string, text: string, inline: boolean) => {
    const k = `${kind}:${text}`;
    const seen = recentNotices.current.get(k);
    if (seen && Date.now() - seen < 15000) return;
    recentNotices.current.set(k, Date.now());
    if (!(inline && turnRef.current)) { toast(noticeText(kind, text), 'note'); return; }
    patchTurn((t) => ({ ...t, parts: [...closeThinking(t.parts), { kind: 'notice', id: nid(), nkind: kind, text }] }));
  };

  const loadConfig = useCallback(() => api.config().then((c) => {
    const eff = (c.efforts as Effort[] | undefined)?.length ? (c.efforts as Effort[]) : EFFORTS;
    setEfforts(eff);
    const d = (c.effort_default as Effort) || 'medium';
    setDefaultEffort(d);
    if (!sidRef.current) setEffort(eff.includes(d) ? d : 'medium');
    setGlobalYolo(c.approvals === 'yolo');
    const acc = accentId(c.accent as string);
    if (acc && acc !== localStorage.getItem('pico.accent')) applyAccent(acc);
  }).catch(() => {}), []);

  useEffect(() => {
    refreshSessions(); refreshInbox(); refreshModels(); loadConfig();
    api.skills().then(setSkills).catch(() => {});
    const close = openEvents((e) => {
      if (e.event === 'inbox' && e.data?.item) {
        const item = e.data.item as InboxItem;
        setInbox((s) => [item, ...s.filter((x) => x.id !== item.id)]);
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
          try { new Notification(item.title || 'Pico', { body: item.body?.slice(0, 140) }); } catch { /* ignore */ }
        } else toast(`inbox: ${item.title}`, 'note');
        refreshSessions();
      } else if (e.event === 'session' && e.data?.id) {
        refreshSessions();
        if (e.data.title && e.data.id === sidRef.current) setTitle(e.data.title);
      } else if (e.event === 'notice' && e.data?.text) {
        const mine = !e.data.session_id || e.data.session_id === sidRef.current;
        showNotice(e.data.kind || 'memory', e.data.text, mine && busyRef.current);
      } else if (e.event === 'model') {
        refreshModels();
      }
    });
    const onHash = () => setView(location.hash.startsWith('#settings') ? 'settings' : 'chat');
    addEventListener('hashchange', onHash);
    return () => { close(); removeEventListener('hashchange', onHash); };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, plan]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (stick.current !== atBottom) setAtBottom(stick.current);
  };
  const toBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true; setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const goChat = () => { if (location.hash) history.pushState(null, '', location.pathname); setView('chat'); };
  const goSettings = (tab: SettingsTab | '' = '') => { location.hash = `settings${tab ? '/' + tab : ''}`; setView('settings'); };

  const resetChatState = () => {
    setItems([]); setGoal(NO_GOAL); setTodos([]); setPlan(null); setLoop(null); setCtx(null); setCompacted(null);
    steerQueue.current = [];
  };
  const newChat = () => {
    abortRef.current?.abort();
    setSid(null); setTitle(''); resetChatState(); setBusy(false); setDraft(''); setYolo(false);
    setEffort(efforts.includes(defaultEffort) ? defaultEffort : 'medium');
    setQuip(QUIPS[Math.floor(Math.random() * QUIPS.length)]);
    goChat();
    setTimeout(() => dispatchEvent(new Event('pico-focus-composer')), 30);
  };

  const openSession = async (id: string) => {
    goChat();
    if (id === sid) return;
    abortRef.current?.abort();
    setBusy(false); turnRef.current = null; ownRef.current = false;
    setSid(id); setLoadingSession(true); resetChatState();
    try {
      const s = await api.session(id);
      setTitle(s.title); setTodos(s.todos || []); setCtx(s.context || null);
      setGoal(s.goal_state || (s.goal ? { text: s.goal, status: 'active', progress: null, todos: s.todos || [] } : NO_GOAL));
      setLoop(s.loop && s.loop.active ? s.loop : null);
      setYolo(!!s.yolo);
      if (s.effort && efforts.includes(s.effort)) setEffort(s.effort);
      const lastPlan = [...(s.messages || [])].reverse().find((m) => m.plan)?.plan;
      setPlan(lastPlan && lastPlan.phase !== 'done' ? lastPlan : null);
      setItems(fromMessages(s.messages || []));
      stick.current = true; setAtBottom(true);
    } catch (e: any) { toast(e.message || 'Could not open chat', 'err'); }
    finally { setLoadingSession(false); }
  };

  /** Apply one turn-stream event to the turn `turnId`. Shared by our POST stream and the session stream. */
  const applyEvent = (event: string, d: any, turnId: string): boolean => {
    const patch = (fn: (t: Turn) => Turn) => patchTurn(fn, turnId);
    const push = (part: Part) => patch((tu) => ({ ...tu, parts: [...closeThinking(tu.parts), part] }));
    switch (event) {
      case 'reasoning':
        patch((tu) => {
          const last = tu.parts[tu.parts.length - 1];
          if (last?.kind === 'thinking' && !last.end) return { ...tu, parts: [...tu.parts.slice(0, -1), { ...last, text: last.text + (d.text ?? '') }] };
          return { ...tu, parts: [...closeThinking(tu.parts), { kind: 'thinking', id: nid(), text: d.text ?? '', start: Date.now() }] };
        });
        break;
      case 'delta':
        patch((tu) => {
          const parts = closeThinking(tu.parts);
          const last = parts[parts.length - 1];
          if (last?.kind === 'text') return { ...tu, parts: [...parts.slice(0, -1), { ...last, text: last.text + (d.text ?? '') }] };
          return { ...tu, parts: [...parts, { kind: 'text', id: nid(), text: d.text ?? '' }] };
        });
        break;
      case 'tool_start':
        patch((tu) => {
          const parts = closeThinking(tu.parts);
          const card: ToolCard = { id: d.id, name: d.name, args: d.args, label: d.label, running: true, tail: [], start: Date.now() };
          let j = parts.length - 1;
          while (j >= 0 && (parts[j].kind === 'notice' || parts[j].kind === 'steer')) j--;
          const prev = parts[j];
          if (prev?.kind === 'tools') return { ...tu, parts: parts.map((p, i) => (i === j && p.kind === 'tools' ? { ...p, tools: [...p.tools, card] } : p)) };
          return { ...tu, parts: [...parts, { kind: 'tools', id: nid(), tools: [card] }] };
        });
        break;
      case 'tool_progress':
        patch((tu) => ({ ...tu, parts: mapTools(tu.parts, d.id, (c) => ({ ...c, tail: asLines(d.tail).slice(-4) })) }));
        break;
      case 'tool_end':
        patch((tu) => ({ ...tu, parts: mapTools(tu.parts, d.id, (c) => ({
          ...c, running: false, ok: d.ok !== false, preview: d.result_preview ?? c.preview, diff: d.diff || c.diff,
          seconds: typeof d.seconds === 'number' ? d.seconds : (Date.now() - c.start) / 1000,
        })) }));
        break;
      case 'subagent_start':
        patch((tu) => {
          const parts = closeThinking(tu.parts);
          const h: Helper = { id: d.id, goal: d.goal || 'Helper', model: d.model, running: true, start: Date.now() };
          const idx = parts.map((p) => p.kind === 'helpers' && p.agents.some((a) => a.running)).lastIndexOf(true);
          if (idx >= 0) return { ...tu, parts: parts.map((p, i) => (i === idx && p.kind === 'helpers' ? { ...p, agents: [...p.agents, h] } : p)) };
          return { ...tu, parts: [...parts, { kind: 'helpers', id: nid(), agents: [h] }] };
        });
        break;
      case 'subagent_progress':
        patch((tu) => ({ ...tu, parts: mapHelpers(tu.parts, d.id, (a) => ({ ...a, label: d.label ?? a.label, tail: d.tail ? asLines(d.tail) : a.tail })) }));
        break;
      case 'subagent_end':
        patch((tu) => ({ ...tu, parts: mapHelpers(tu.parts, d.id, (a) => ({
          ...a, running: false, ok: d.ok !== false, summary: d.summary, tokens: d.tokens,
          seconds: typeof d.seconds === 'number' ? d.seconds : (Date.now() - a.start) / 1000,
        })) }));
        break;
      case 'todo': setTodos(d.todos || []); break;
      case 'goal': if (d && 'status' in d) setGoal(d.status === 'cleared' ? NO_GOAL : d); break;
      case 'plan': if (d && d.phase) setPlan(d); break;
      case 'loop': if (d) setLoop(d.state === 'stopped' || d.state === 'done' ? null : d); break;
      case 'steer':
        patch((tu) => {
          let hit = false;
          const parts = tu.parts.map((p) => {
            if (!hit && p.kind === 'steer' && p.text === d.text && p.state !== 'applied') { hit = true; return { ...p, state: d.applied ? 'applied' : d.followup ? 'followup' : p.state } as Part; }
            return p;
          });
          if (!hit && d.applied) parts.push({ kind: 'steer', id: nid(), text: d.text, state: 'applied' });
          return { ...tu, parts };
        });
        break;
      case 'approval':
        push({ kind: 'approval', id: nid(), approvalId: d.id, command: d.command, reason: d.reason });
        break;
      case 'notice': showNotice(d.kind || 'memory', d.text || '', true); break;
      case 'compacted':
        setCompacted({ before: d.before, after: d.after, key: Date.now() });
        setCtx((c) => (c ? { ...c, used: d.after } : c));
        setTimeout(() => setCompacted((c) => (c && Date.now() - c.key >= 5900 ? null : c)), 6000);
        break;
      case 'done': {
        if (d.context && d.context.max) setCtx(d.context);
        if (d.goal_state) setGoal(d.goal_state.status === 'cleared' ? NO_GOAL : d.goal_state);
        if (d.plan) setPlan(d.plan);
        if (d.loop) setLoop(d.loop.active === false || d.loop.state === 'stopped' || d.loop.state === 'done' ? null : d.loop);
        if (typeof d.yolo === 'boolean') setYolo(d.yolo);
        const sum = d.summary || (d.tps || d.seconds ? { tools: 0, files_changed: [], seconds: d.seconds, tps: d.tps, output_tokens: d.usage?.output } : undefined);
        patch((tu) => ({ ...tu, parts: closeThinking(tu.parts), streaming: false, stopped: !!d.stopped, summary: sum }));
        return true;
      }
      case 'error':
        patch((tu) => ({ ...tu, streaming: false, error: d.message || 'Something went wrong' }));
        return true;
    }
    return false;
  };

  const finishTurn = (failed: boolean, id: string | null) => {
    setBusy(false);
    turnRef.current = null;
    setFlash({ mood: failed ? 'error' : 'happy', key: Date.now() });
    lastActive.current = Date.now();
    refreshSessions();
    if (id) api.session(id).then((s) => {
      if (sidRef.current !== id) return;
      setTitle(s.title); if (s.context?.max) setCtx(s.context);
      if (s.goal_state) setGoal(s.goal_state.status === 'cleared' ? NO_GOAL : s.goal_state);
    }).catch(() => {});
  };

  // Session stream: turns we didn't start (loop iterations, steer follow-ups, other clients).
  useEffect(() => {
    if (!sid) return;
    let foreign: string | null = null;
    const close = openSessionStream(sid, ({ event, data }) => {
      const d = data || {};
      if (event === 'hello') { if (d.loop && d.loop.active) setLoop(d.loop); if (d.goal_state && d.goal_state.status !== 'cleared') setGoal(d.goal_state); return; }
      if (event === 'loop') { setLoop(d.state === 'stopped' || d.state === 'done' ? null : d); return; }
      if (ownRef.current) return; // our POST stream already delivers these
      if (event === 'turn_start') {
        const tid = nid();
        foreign = tid; turnRef.current = tid;
        setBusy(true); stick.current = true;
        const tag = d.source === 'loop' ? `loop ${d.loop?.n ?? ''}`.trim() : d.source === 'steer' ? 'steer' : d.source === 'chat' ? undefined : d.source;
        setItems((s) => [...s,
          ...(d.text ? [{ kind: 'user', id: nid(), text: d.text, tag } as UserItem] : []),
          { kind: 'turn', id: tid, parts: [], streaming: true, effort, start: Date.now() }]);
        return;
      }
      if (!foreign) return;
      const ended = applyEvent(event, d, foreign);
      if (ended) { const failed = event === 'error'; foreign = null; finishTurn(failed, sid); }
    });
    return close;
  }, [sid]);

  const send = async (text: string, attachments: Attachment[]) => {
    const t = text.trim();
    if (!t && !attachments.length) return;
    if (t === '/new') { newChat(); return; }
    if (busy) { steer(t); return; }
    poke();
    stick.current = true; setAtBottom(true);
    let id = sid;
    setBusy(true);
    const turnId = nid();
    turnRef.current = turnId;
    ownRef.current = true;
    const turnEffort = effort;
    setItems((s) => [...s,
      { kind: 'user', id: nid(), text: t, files: attachments.map((a) => a.name) },
      { kind: 'turn', id: turnId, parts: [], streaming: true, effort: turnEffort, start: Date.now() }]);
    let failed = false;
    try {
      if (!id) {
        const s = await api.createSession({ yolo: yolo || undefined, effort });
        id = s.id; sidRef.current = id; setSid(id);
        setTimeout(refreshSessions, 400);
      }
      const ac = new AbortController();
      abortRef.current = ac;
      await sendMessage(id, { text: t, effort, attachments: attachments.length ? attachments : undefined }, (e) => {
        const ended = applyEvent(e.event, e.data || {}, turnId);
        if (e.event === 'error') failed = true;
        if (ended) ownRef.current = false; // follow-up turns after this arrive via the session stream
      }, ac.signal);
    } catch (e: any) {
      if (e?.name !== 'AbortError') { failed = true; patchTurn((tu) => ({ ...tu, streaming: false, error: e?.message || 'Could not reach Pico' }), turnId); }
    } finally {
      ownRef.current = false;
      abortRef.current = null;
      patchTurn((tu) => ({ ...tu, streaming: false, parts: closeThinking(tu.parts) }), turnId);
      if (turnRef.current === turnId) finishTurn(failed, id);
    }
  };

  /** Enter while a reply runs: talk to it. Queues locally when the engine says nothing's running yet. */
  const steer = async (text: string) => {
    const tid = turnRef.current;
    const partId = nid();
    if (tid) patchTurn((tu) => ({ ...tu, parts: [...tu.parts, { kind: 'steer', id: partId, text, state: 'sent' }] }), tid);
    const setState = (state: 'sent' | 'applied' | 'queued' | 'followup') => tid && patchTurn((tu) => ({ ...tu, parts: tu.parts.map((p) => (p.id === partId && p.kind === 'steer' && p.state !== 'applied' ? { ...p, state } : p)) }), tid);
    const id = sidRef.current;
    if (!id) { steerQueue.current.push(text); setState('queued'); return; }
    try {
      const r = await api.steer(id, text);
      if (r.mode === 'queued') setState('queued');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) { steerQueue.current.push(text); setState('queued'); }
      else toast((e as Error).message || 'Could not steer', 'err');
    }
  };
  // drain locally queued steers once the chat is idle
  useEffect(() => {
    if (busy || !steerQueue.current.length) return;
    const next = steerQueue.current.shift()!;
    const t = setTimeout(() => send(next, []), 120);
    return () => clearTimeout(t);
  }, [busy]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), flash.mood === 'error' ? 4000 : 2600);
    return () => clearTimeout(t);
  }, [flash]);

  const stop = () => {
    if (sid) api.stop(sid).catch(() => {});
    abortRef.current?.abort();
    steerQueue.current = [];
    patchTurn((t) => ({ ...t, streaming: false, stopped: true }));
  };

  // global keys: ⌘B sidebar, ⌘N new chat, ⌘, settings, Esc stop
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSide(); }
      else if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); newChat(); }
      else if (mod && e.key === ',') { e.preventDefault(); goSettings(); }
      else if (e.key === 'Escape' && busyRef.current && !(e.target as HTMLElement)?.closest?.('.composer, .modal')) stop();
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });

  const answerApproval = async (p: ApprovalPart, answer: 'allow' | 'deny' | 'always') => {
    if (!sid) return;
    setItems((s) => s.map((it) => (it.kind === 'turn' && it.parts.some((x) => x.id === p.id)
      ? { ...it, parts: it.parts.map((x) => (x.id === p.id ? { ...x, answer } as Part : x)) } : it)));
    try { await api.approve(sid, { id: p.approvalId, allow: answer !== 'deny', always: answer === 'always' || undefined }); }
    catch (e: any) { toast(e.message || 'Could not send answer', 'err'); }
  };

  const undo = async (turnId: string) => {
    if (!sid || busy) return;
    try {
      const r = await api.undo(sid);
      if (r.ok === false) { toast(r.note || 'Nothing to undo', 'err'); return; }
      const n = Array.isArray(r.restored) ? r.restored.length : r.restored ?? 0;
      const del = Array.isArray(r.deleted) ? r.deleted.length : r.deleted ?? 0;
      toast(n || del ? `Restored ${n + del} file${n + del === 1 ? '' : 's'}` : r.note || 'Undone');
      const idx = items.findIndex((x) => x.id === turnId);
      const userId = idx > 0 && items[idx - 1].kind === 'user' ? items[idx - 1].id : null;
      setItems((s) => s.map((x) => (x.id === turnId || x.id === userId ? { ...x, leaving: true } : x)));
      setTimeout(() => setItems((s) => s.filter((x) => x.id !== turnId && x.id !== userId)), 260);
      api.session(sid).then((s) => { setTodos(s.todos || []); if (s.context?.max) setCtx(s.context); setTitle(s.title); }).catch(() => {});
      refreshSessions();
    } catch (e: any) { toast(e.message || 'Could not undo', 'err'); }
  };

  const togglePin = async (s: SessionSummary) => {
    setSessions((list) => list.map((x) => (x.id === s.id ? { ...x, pinned: !x.pinned } : x)));
    await api.patchSession(s.id, { pinned: !s.pinned }).catch(() => {});
  };
  const removeSession = async (s: SessionSummary) => {
    if (!confirm(`Delete “${s.title || 'this chat'}”?`)) return;
    await api.deleteSession(s.id).catch(() => {});
    if (s.id === sid) newChat();
    refreshSessions();
  };

  const pickModel = async (m: ModelInfo) => {
    try { await api.setModel(m.id, m.provider); toast(`now using ${m.name}`); refreshModels(); }
    catch (e: any) { toast(e.message || 'Could not switch', 'err'); }
  };
  const saveDefaultEffort = async (e: Effort) => {
    setDefaultEffort(e);
    try { await api.patchConfig({ effort_default: e }); } catch (er: any) { toast(er.message || 'Could not save', 'err'); }
  };
  const toggleYolo = async () => {
    const next = !yolo;
    setYolo(next);
    if (sid) {
      try { await api.patchSession(sid, { yolo: next }); } catch (e: any) { setYolo(!next); toast(e.message || 'Could not change', 'err'); return; }
    }
    if (!next && globalYolo) toast('approvals are set to yolo globally (Settings → General)', 'note');
  };
  const clearGoal = async () => {
    if (!sid) { setGoal(NO_GOAL); return; }
    try { await api.patchSession(sid, { goal: null }); setGoal(NO_GOAL); } catch (e: any) { toast(e.message, 'err'); }
  };
  const stopLoop = async () => {
    if (!sid) return;
    setLoop(null);
    await api.stopLoop(sid).catch(() => {});
  };

  const unread = inbox.filter((i) => !i.read).length;
  const liveTurn = items.find((x) => x.kind === 'turn' && x.streaming) as Turn | undefined;
  const lastTurnId = [...items].reverse().find((x) => x.kind === 'turn')?.id;
  const mood: Mood = liveTurn ? turnMood(liveTurn) : flash ? flash.mood : asleep ? 'asleep' : draft.trim() ? 'typing' : 'idle';
  const home = view === 'chat' && !loadingSession && items.length === 0;
  const goalShown: GoalState | null = goal.text && goal.status !== 'cleared' ? goal
    : todos.length && !plan ? { text: 'to-do', status: 'active', progress: { done: todos.filter((t) => t.done).length, total: todos.length }, todos } : null;

  const composer = (
    <Composer
      busy={busy} effort={effort} efforts={efforts} onSetEffort={setEffort}
      skills={skills} draft={draft} setDraft={setDraft} onSend={send} onStop={stop}
      models={models} onPickModel={pickModel} onManageModels={() => goSettings('models')}
      defaultEffort={defaultEffort} onSetDefaultEffort={saveDefaultEffort}
      yolo={yolo || globalYolo} onToggleYolo={toggleYolo}
      mood={mood} perch={!home} sparkle={flash?.mood === 'happy' ? flash.key : undefined}
    />
  );

  return (
    <div class={`app ${sideOpen && view === 'chat' ? 'side-open' : 'side-closed'} ${view}`}>
      <Rail
        view={view} sideOpen={sideOpen} unread={unread} inbox={inbox} mood={mood}
        onNew={newChat} onToggleSide={() => { if (view !== 'chat') { goChat(); if (!sideOpen) toggleSide(); } else toggleSide(); }}
        onGoals={() => goSettings('crons')} onUsage={() => goSettings('usage')} onSettings={() => goSettings()}
        onOpenInbox={(it) => { if (it.session_id) openSession(it.session_id); if (!it.read) api.readInbox(it.id).catch(() => {}); setInbox((s) => s.map((x) => (x.id === it.id ? { ...x, read: true } : x))); }}
      />
      {view === 'chat' && sideOpen && (
        <Sidebar sessions={sessions} activeId={sid} onNew={newChat} onOpen={(id) => { openSession(id); if (innerWidth <= 860) toggleSide(); }} onPin={togglePin} onDelete={removeSession} />
      )}
      {view === 'chat' && sideOpen && <div class="scrim" onClick={toggleSide} />}

      {view === 'settings' ? (
        <Settings onBack={goChat} models={models} refreshModels={refreshModels} onNeedSetup={onNeedSetup} onConfigChanged={loadConfig} />
      ) : (
        <main class="main">
          <header class="topbar" data-tauri-drag-region>
            <div class="topbar-title" data-tauri-drag-region>{title || (home ? '' : 'new chat')}</div>
            {loop && <LoopChip loop={loop} onStop={stopLoop} />}
          </header>

          {home ? (
            <div class="home">
              <Cat mood={flash?.mood === 'error' ? 'error' : asleep ? 'asleep' : mood === 'typing' ? 'typing' : 'happy'} size="xl" mark={false} />
              <p class="quip">“{quip}”</p>
              <div class="home-comp">{composer}</div>
              <p class="home-hint mono">{health?.model ? `${health.model} · ` : ''}shift+tab effort · ⌘B chats</p>
            </div>
          ) : (
            <>
              <div class="scroll" ref={scrollRef} onScroll={onScroll} onClick={onCopyClick}>
                {loadingSession ? (
                  <div class="center-fill"><Spinner /></div>
                ) : (
                  <div class="thread">
                    {items.map((it) => it.kind === 'user'
                      ? <UserView key={it.id} it={it} />
                      : <TurnView key={it.id} t={it} leaving={!!it.leaving} onAnswer={answerApproval}
                          canUndo={!busy && it.id === lastTurnId && !it.streaming} onUndo={() => undo(it.id)} />)}
                    {plan && <PlanCard plan={plan} busy={busy} onGo={() => send('go', [])} />}
                  </div>
                )}
              </div>
              {!atBottom && items.length > 0 && (
                <button class="to-bottom mono" onClick={toBottom} aria-label="Scroll to latest">
                  <Icon name="down" size={13} />{busy ? 'new output' : 'latest'}
                </button>
              )}
              <div class="dock">
                {goalShown && <GoalBanner g={goalShown} onClear={clearGoal} />}
                <div class="dock-meta">
                  {ctx && ctx.max ? <ContextPills ctx={ctx} compacted={compacted} busy={busy} onCompact={() => send('/compact', [])} /> : <span />}
                </div>
                {composer}
              </div>
            </>
          )}
        </main>
      )}
    </div>
  );
}

function onCopyClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest('[data-copy]') as HTMLElement | null;
  if (!btn) return;
  const code = btn.closest('.code')?.querySelector('code')?.textContent ?? '';
  navigator.clipboard?.writeText(code).then(() => {
    btn.textContent = 'copied';
    setTimeout(() => { btn.textContent = 'copy'; }, 1200);
  }).catch(() => {});
}

// ---------- rail ----------
function Rail({ view, sideOpen, unread, inbox, mood, onNew, onToggleSide, onGoals, onUsage, onSettings, onOpenInbox }: {
  view: string; sideOpen: boolean; unread: number; inbox: InboxItem[]; mood: Mood;
  onNew: () => void; onToggleSide: () => void; onGoals: () => void; onUsage: () => void; onSettings: () => void; onOpenInbox: (it: InboxItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside<HTMLDivElement>(() => setOpen(false));
  const sTab = view === 'settings' ? (location.hash.split('/')[1] || 'general') : '';
  return (
    <nav class="rail" data-tauri-drag-region>
      <div class="rail-cat" title="pico" data-tauri-drag-region><Cat mood={mood === 'typing' ? 'idle' : mood} size="xs" mark={false} /></div>
      <button class="rail-btn accent" onClick={onNew} title="New chat (⌘N)" aria-label="New chat"><Icon name="plus" size={18} /></button>
      <button class={`rail-btn ${view === 'chat' && sideOpen ? 'on' : ''}`} onClick={onToggleSide} title="Chats (⌘B)" aria-label="Toggle chats"><Icon name="chats" size={17} /></button>
      <button class={`rail-btn ${sTab === 'crons' ? 'on' : ''}`} onClick={onGoals} title="Goals & crons" aria-label="Goals and crons"><Icon name="target" size={17} /></button>
      <button class={`rail-btn ${sTab === 'usage' ? 'on' : ''}`} onClick={onUsage} title="Usage" aria-label="Usage"><Icon name="bars" size={17} /></button>
      <div class="rail-inbox" ref={ref}>
        <button class={`rail-btn ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Inbox" aria-label={`Inbox, ${unread} unread`}>
          <Icon name="inbox" size={17} />
          {unread > 0 && <span class="rail-badge mono">{unread > 9 ? '9+' : unread}</span>}
        </button>
        {open && (
          <div class="inbox-pop">
            <div class="inbox-h"><span>inbox</span><span class="dim small">cron & background results</span></div>
            {inbox.length === 0 && <div class="side-empty">Nothing yet. Cron results land here.</div>}
            {inbox.slice(0, 30).map((it) => (
              <button key={it.id} class={`inbox-item ${it.read ? '' : 'unread'}`} onClick={() => { setOpen(false); onOpenInbox(it); }}>
                <div class="ii-top"><span class="ii-title">{it.title}</span><span class="mono dim small">{timeAgo(it.created)}</span></div>
                <div class="ii-body">{it.body}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      <span class="rail-spacer" />
      <button class={`rail-btn ${view === 'settings' && sTab !== 'usage' && sTab !== 'crons' ? 'on' : ''}`} onClick={onSettings} title="Settings (⌘,)" aria-label="Settings"><Icon name="gear" size={17} /></button>
    </nav>
  );
}

// ---------- sidebar (by day) ----------
function dayGroup(v: number | string): number {
  const d = toDate(v);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= start) return 0;
  if (t >= start - 86400000) return 1;
  if (t >= start - 7 * 86400000) return 2;
  return 3;
}
const GROUPS = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];

function Sidebar({ sessions, activeId, onNew, onOpen, onPin, onDelete }: {
  sessions: SessionSummary[]; activeId: string | null; onNew: () => void; onOpen: (id: string) => void;
  onPin: (s: SessionSummary) => void; onDelete: (s: SessionSummary) => void;
}) {
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<{ session_id: string; title: string; snippet: string }[] | null>(null);
  useEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    const t = setTimeout(() => api.search(q).then(setHits).catch(() => setHits([])), 220);
    return () => clearTimeout(t);
  }, [q]);
  const grouped = useMemo(() => {
    const g: SessionSummary[][] = [[], [], [], []];
    for (const s of sessions) if (!s.pinned) g[dayGroup(s.updated)].push(s);
    return g;
  }, [sessions]);
  const pinned = sessions.filter((s) => s.pinned);
  const row = (s: SessionSummary) => (
    <div key={s.id} class={`sess ${s.id === activeId ? 'active' : ''}`}>
      <button class="sess-main" onClick={() => onOpen(s.id)} title={s.preview || s.title}>
        <span class="sess-title">{s.title || 'New chat'}</span>
      </button>
      <div class="sess-acts">
        <button class={`icon-btn xs ${s.pinned ? 'pin-on' : ''}`} onClick={() => onPin(s)} title={s.pinned ? 'Unpin' : 'Pin'}><Icon name="pin" size={13} /></button>
        <button class="icon-btn xs" onClick={() => onDelete(s)} title="Delete"><Icon name="trash" size={13} /></button>
      </div>
    </div>
  );
  return (
    <aside class="sidebar">
      <div class="side-top" data-tauri-drag-region>
        <button class="new-chat" onClick={onNew}><span class="nc-plus">＋</span> new chat</button>
        <button class={`icon-btn xs ${searching ? 'on' : ''}`} onClick={() => { setSearching(!searching); setQ(''); }} title="Search chats" aria-label="Search chats"><Icon name="search" size={14} /></button>
      </div>
      {searching && (
        <label class="search">
          <input placeholder="search chats" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} autoFocus
            onKeyDown={(e) => { if (e.key === 'Escape') { setSearching(false); setQ(''); } }} />
        </label>
      )}
      <nav class="side-list">
        {hits ? (
          <>
            <div class="side-h">results</div>
            {hits.length === 0 && <div class="side-empty">Nothing found.</div>}
            {hits.map((h, i) => (
              <button key={h.session_id + i} class="hit" onClick={() => { setQ(''); setSearching(false); onOpen(h.session_id); }}>
                <span class="sess-title">{h.title}</span>
                <span class="hit-snip">{h.snippet}</span>
              </button>
            ))}
          </>
        ) : (
          <>
            {pinned.length > 0 && <><div class="side-h">Pinned</div>{pinned.map(row)}</>}
            {grouped.map((list, i) => list.length ? <div key={i}><div class="side-h">{GROUPS[i]}</div>{list.map(row)}</div> : null)}
            {sessions.length === 0 && <div class="side-empty">Your chats will show up here.</div>}
          </>
        )}
      </nav>
    </aside>
  );
}

// ---------- messages ----------
function UserView({ it }: { it: UserItem }) {
  return (
    <div class={`msg user ${it.leaving ? 'leaving' : ''}`}>
      {it.tag && <span class="u-tag mono">↳ {it.tag}</span>}
      <div class="bubble">
        {it.files && it.files.length > 0 && <div class="att-row">{it.files.map((f) => <span class="att mono" key={f}><Icon name="clip" size={12} /> {f}</span>)}</div>}
        {it.text}
      </div>
    </div>
  );
}

function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class={`md ${streaming ? 'streaming' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Waiting({ start }: { start: number }) {
  const now = useNow(true, 100);
  return <div class="waiting-line"><span class="shimmer">thinking</span> <span class="mono dim">{((now - start) / 1000).toFixed(1)}s</span></div>;
}

function TurnView({ t, leaving, onAnswer, canUndo, onUndo }: {
  t: Turn; leaving: boolean; onAnswer: (p: ApprovalPart, a: 'allow' | 'deny' | 'always') => void; canUndo: boolean; onUndo: () => void;
}) {
  const hasText = t.parts.some((p) => p.kind === 'text' && p.text);
  const toolsFailed = t.parts.some((p) => p.kind === 'tools' && p.tools.some((x) => x.ok === false));
  const lastText = [...t.parts].reverse().find((p) => p.kind === 'text');
  const tail = t.parts[t.parts.length - 1];
  const idle = t.streaming && (t.parts.length === 0 || (tail && (tail.kind === 'steer' || tail.kind === 'notice') ) ||
    (tail?.kind === 'tools' && !tail.tools.some((x) => x.running)));
  return (
    <div class={`msg assistant turn ${t.streaming ? 'live' : ''} ${leaving ? 'leaving' : ''}`}>
      {t.parts.map((p) => {
        switch (p.kind) {
          case 'text': return <Markdown key={p.id} text={p.text} streaming={t.streaming && p === lastText && p === tail} />;
          case 'thinking': return <ThinkingPill key={p.id} p={p} effort={t.effort} live={t.streaming && !p.end && !!p.start} />;
          case 'tools': return <ToolStack key={p.id} tools={p.tools} />;
          case 'helpers': return <HelpersCard key={p.id} agents={p.agents} />;
          case 'approval': return <ApprovalCard key={p.id} p={p} onAnswer={onAnswer} />;
          case 'notice': return <NoticeChip key={p.id} kind={p.nkind} text={p.text} />;
          case 'steer': return <SteerNote key={p.id} text={p.text} state={p.state} />;
          default: return null;
        }
      })}
      {idle && <Waiting start={t.start || Date.now()} />}
      {t.error && <div class="msg-err">{t.error}</div>}
      {!t.streaming && !hasText && !t.error && t.stopped && <div class="dim small mono">stopped</div>}
      {t.summary && !t.streaming && (
        <TurnSummary s={t.summary} ok={!t.error && !toolsFailed} canUndo={canUndo} onUndo={onUndo} />
      )}
    </div>
  );
}
