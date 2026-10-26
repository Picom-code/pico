import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export type Mood = 'idle' | 'think' | 'work' | 'happy' | 'scan' | 'error' | 'asleep' | 'typing';

/** Pico Kitty faces + the little mark floating beside the head. */
export const FACES: Record<Mood, string> = {
  idle: 'o.o', think: 'o.O', work: '>.<', happy: '^.^', scan: '0.0', error: 'x.x', asleep: '-.-', typing: '•.•',
};
export const MARKS: Partial<Record<Mood, string>> = { think: '?', work: '~', happy: '✧', error: '!', asleep: 'zZ' };

/** The 3-line ASCII cat. Rare blink + neon glow via CSS. `sparkle` re-triggers a tiny burst when it changes. */
export function Cat({ mood = 'idle', size = 'md', label, sparkle, mark = true }: { mood?: Mood; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; label?: string; sparkle?: number; mark?: boolean }) {
  const face = FACES[mood];
  const m = mark ? MARKS[mood] : undefined;
  return (
    <div class={`cat cat-${size} cat-${mood}`} role="img" aria-label={label ?? `pico, ${mood}`}>
      {sparkle ? <span class="sparkles" key={sparkle} aria-hidden="true"><i>✦</i><i>✧</i><i>✦</i><i>·</i></span> : null}
      {m && <span class="cat-mark mono" key={mood} aria-hidden="true">{m}</span>}
      <pre aria-hidden="true">
        {' /\\_/\\ \n( '}
        <span class="cat-face">
          <span class="eyes-open">{face}</span>
          <span class="eyes-closed">-.-</span>
        </span>
        {' )\n > ^ < '}
      </pre>
    </div>
  );
}
/** Back-compat alias (wizard etc.). */
export const Skeleton = Cat;

/** One-line cat face, e.g. `(o.o)` — used as avatar and small indicators. */
export function Face({ mood = 'idle', title }: { mood?: Mood; title?: string }) {
  return (
    <span class={`face face-${mood}`} title={title} aria-hidden={title ? undefined : 'true'}>
      (<span class="cat-face"><span class="eyes-open">{FACES[mood]}</span><span class="eyes-closed">-.-</span></span>)
    </span>
  );
}

/** Text that types itself out. */
export function Typed({ text, speed = 28, onDone, class: cls }: { text: string; speed?: number; onDone?: () => void; class?: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setN(text.length); onDone?.(); return; }
    let i = 0;
    const t = setInterval(() => {
      i++;
      setN(i);
      if (i >= text.length) { clearInterval(t); onDone?.(); }
    }, speed);
    return () => clearInterval(t);
  }, [text]);
  return (
    <span class={cls}>
      {text.slice(0, n)}
      <span class={`caret ${n >= text.length ? 'caret-done' : ''}`}>▍</span>
    </span>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      class={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)}
    >
      <span class="knob" />
    </button>
  );
}

export function Spinner() { return <span class="spinner" aria-label="loading" />; }

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div class="modal-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div class="modal-head">
          <h3>{title}</h3>
          <button class="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  );
}

const PATHS: Record<string, JSX.Element> = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  clip: <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />,
  pin: <><path d="M12 17v5" /><path d="M9 10.8V4h6v6.8l3 3.2v2H6v-2z" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  chev: <path d="m6 9 6 6 6-6" />,
  check: <path d="M20 6 9 17l-5-5" />,
  trash: <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
  back: <path d="m15 18-6-6 6-6" />,
  bolt: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  tool: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
  down: <path d="M12 5v14M19 12l-7 7-7-7" />,
  helpers: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.3a5.5 5.5 0 0 1 2.5 4.7" /></>,
  chats: <><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z" /></>,
  target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  bars: <path d="M5 20v-6M12 20V5M19 20v-10" />,
  inbox: <><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" /></>,
  sidebar: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9.5 4.5v15" /></>,
  sparkle: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  loop: <><path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 0 1 4-4h12" /><path d="M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 0 1-4 4H4" /></>,
  play: <path d="M7 5v14l11-7z" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.9-.7-1.3-.7-2.2 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10.5" cy="7.2" r="1" /><circle cx="15" cy="7.5" r="1" /></>,
  plug: <><path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></>,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></>,
  chip: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
  more: <><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>,
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {PATHS[name] ?? null}
    </svg>
  );
}

// Lightweight toast bus
type ToastFn = (msg: string, kind?: 'ok' | 'err' | 'note') => void;
let pushToast: ToastFn = () => {};
export const toast: ToastFn = (m, k) => pushToast(m, k);
export function Toasts() {
  const [items, setItems] = useState<{ id: number; msg: string; kind: string }[]>([]);
  useEffect(() => {
    let n = 0;
    pushToast = (msg, kind = 'ok') => {
      const id = ++n;
      setItems((s) => [...s, { id, msg, kind }]);
      setTimeout(() => setItems((s) => s.map((t) => (t.id === id ? { ...t, kind: t.kind + ' out' } : t))), kind === 'note' ? 4200 : 3000);
      setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), kind === 'note' ? 4450 : 3250);
    };
  }, []);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {items.map((t) => <div key={t.id} class={`toast ${t.kind}`}>{t.kind.startsWith('note') && <span class="t-dot" />}{t.msg}</div>)}
    </div>
  );
}
