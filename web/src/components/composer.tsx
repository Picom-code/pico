// Composer: effort-colored edge + › glyph, perched Pico Kitty, model chip (dropdown), yolo + attach chips.
// Enter sends; while a reply runs, Enter steers it; Esc stops; Shift+Tab cycles effort.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fileToAttachment, fmtCtx, type Attachment, type Effort, type ModelInfo, type Models, type Skill } from '../api';
import { EFFORT_COLORS, EFFORT_HINT, EFFORT_SHORT } from '../theme';
import { Cat, Icon, toast, type Mood } from './ui';

const BUILTIN_CMDS = [
  { name: 'goal', description: 'Set a goal Pico keeps working toward' },
  { name: 'plan', description: 'Make a step-by-step plan first, then Go' },
  { name: 'loop', description: 'Re-run a prompt on an interval (/loop 5m check CI)' },
  { name: 'cron', description: 'Schedule a background job (/cron every weekday at 8am -- …)' },
  { name: 'usage', description: 'Token usage for the last 30 days' },
  { name: 'compact', description: 'Summarize this chat to free up memory' },
  { name: 'undo', description: 'Put back the files the last reply changed' },
  { name: 'yolo', description: 'This chat runs commands without asking' },
  { name: 'new', description: 'Start a new chat' },
];

export function useOutside<T extends HTMLElement>(fn: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) fn(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return ref;
}

export const tpsOf = (m: ModelInfo) => m.tps_measured ?? m.tps ?? null;
export const fmtTps = (n: number | null | undefined) => (n == null ? '' : n < 10 ? `${n.toFixed(1)} tok/s` : `${Math.round(n)} tok/s`);

export interface ComposerProps {
  busy: boolean; effort: Effort; efforts: Effort[]; onSetEffort: (e: Effort) => void;
  skills: Skill[]; draft: string; setDraft: (s: string) => void;
  onSend: (t: string, a: Attachment[]) => void; onStop: () => void;
  models: Models | null; onPickModel: (m: ModelInfo) => void; onManageModels: () => void;
  defaultEffort: Effort; onSetDefaultEffort: (e: Effort) => void;
  yolo: boolean; onToggleYolo: () => void;
  mood: Mood; perch?: boolean; sparkle?: number; autoFocus?: boolean; placeholder?: string;
}

export function Composer(p: ComposerProps) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [sel, setSel] = useState(0);
  const [menu, setMenu] = useState(false);
  const menuRef = useOutside<HTMLDivElement>(() => setMenu(false));
  const { draft, setDraft } = p;

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [draft]);
  useEffect(() => { if (p.autoFocus !== false) ta.current?.focus(); }, []);
  useEffect(() => {
    const h = () => ta.current?.focus();
    addEventListener('pico-focus-composer', h);
    return () => removeEventListener('pico-focus-composer', h);
  }, []);

  const slash = /^\/[\w-]*$/.test(draft) ? draft.slice(1).toLowerCase() : null;
  const cmds = useMemo(() => {
    if (slash === null) return [];
    const all = [
      ...BUILTIN_CMDS.map((c) => ({ ...c, kind: 'built-in' })),
      ...p.skills.filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description, kind: s.category || 'skill' })),
    ];
    return all.filter((c) => c.name.toLowerCase().includes(slash)).slice(0, 10);
  }, [slash, p.skills]);
  useEffect(() => setSel(0), [slash]);
  const pickCmd = (name: string) => { setDraft(`/${name} `); ta.current?.focus(); };

  const cycle = (dir = 1) => {
    const list = p.efforts;
    const i = list.indexOf(p.effort);
    p.onSetEffort(list[(i + dir + list.length) % list.length]);
  };

  const submit = () => {
    if (!draft.trim() && !files.length) return;
    p.onSend(draft, files);
    setDraft(''); setFiles([]);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycle(); return; }
    if (cmds.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % cmds.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + cmds.length) % cmds.length); return; }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickCmd(cmds[sel].name); return; }
      if (e.key === 'Escape') { setDraft(''); return; }
    }
    if (e.key === 'Escape' && p.busy) { e.preventDefault(); p.onStop(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  };

  const addFiles = async (list: FileList | File[]) => {
    const arr = Array.from(list);
    const big = arr.find((f) => f.size > 20 * 1024 * 1024);
    if (big) { toast(`${big.name} is too big (max 20 MB)`, 'err'); return; }
    const atts = await Promise.all(arr.map(fileToAttachment));
    setFiles((f) => [...f, ...atts]);
  };
  const onPaste = (e: ClipboardEvent) => {
    const fs = Array.from(e.clipboardData?.files || []);
    if (fs.length) { e.preventDefault(); addFiles(fs); }
  };

  const active = p.models?.models.find((m) => m.active || m.id === p.models?.active);
  const groups = useMemo(() => {
    const g = new Map<string, ModelInfo[]>();
    for (const m of p.models?.models || []) {
      const k = m.provider_label || (m.local ? 'This computer' : m.provider);
      g.set(k, [...(g.get(k) || []), m]);
    }
    return [...g.entries()];
  }, [p.models]);
  const color = EFFORT_COLORS[p.effort] || EFFORT_COLORS.medium;
  const defIdx = p.efforts.indexOf(p.defaultEffort);
  const stepDefault = (d: number) => p.onSetDefaultEffort(p.efforts[(Math.max(0, defIdx) + d + p.efforts.length) % p.efforts.length]);

  return (
    <div class={`composer-wrap ${p.busy ? 'busy' : ''}`} style={{ '--effort': color } as any}>
      {cmds.length > 0 && (
        <div class="slash-menu" role="listbox">
          {cmds.map((c, i) => (
            <button key={c.name} role="option" aria-selected={i === sel} class={`slash-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); pickCmd(c.name); }}>
              <span class="mono sl-name">/{c.name}</span>
              <span class="sl-desc">{c.description}</span>
              <span class="sl-kind mono">{c.kind}</span>
            </button>
          ))}
        </div>
      )}
      {p.perch !== false && <div class="perch" aria-hidden="true"><Cat mood={p.mood} size="xs" sparkle={p.sparkle} /></div>}
      <div
        class="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files); }}
        onClick={(e) => { if (e.target === e.currentTarget) ta.current?.focus(); }}
      >
        {files.length > 0 && (
          <div class="att-row">
            {files.map((f, i) => (
              <span class="att" key={i}>
                {f.mime.startsWith('image/') ? <img src={`data:${f.mime};base64,${f.data_b64}`} alt="" /> : <Icon name="clip" size={12} />}
                <span class="mono">{f.name}</span>
                <button class="icon-btn xs" onClick={() => setFiles((s) => s.filter((_, k) => k !== i))} aria-label="Remove"><Icon name="x" size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <div class="comp-line">
          <span class="comp-glyph mono" aria-hidden="true">›</span>
          <textarea
            ref={ta} rows={1} value={draft}
            placeholder={p.busy ? 'Steer the reply… (Esc stops)' : p.placeholder || 'Ask anything…  / for commands'}
            onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} onKeyDown={onKey} onPaste={onPaste}
          />
        </div>
        <div class="comp-bar">
          <button class="cchip" onClick={() => fileRef.current?.click()} title="Attach files or images"><Icon name="clip" size={12} /> attach</button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { const el = e.target as HTMLInputElement; if (el.files) addFiles(el.files); el.value = ''; }} />
          <div class="model-wrap" ref={menuRef}>
            <button class={`cchip model-chip ${menu ? 'on' : ''}`} onClick={() => setMenu(!menu)} title={active?.name || 'model'}>
              <span class="mc-name mono">{active?.name || p.models?.active || 'model'}</span><span class={`mc-caret chev ${menu ? 'up' : ''}`}><Icon name="chev" size={11} /></span>
            </button>
            {menu && (
              <div class="model-menu" role="menu">
                {groups.map(([label, list]) => (
                  <div key={label} class="mm-group">
                    <div class="mm-h mono">{label}</div>
                    {list.map((m) => {
                      const on = m.active || m.id === p.models?.active;
                      const t = tpsOf(m);
                      return (
                        <button key={m.id + m.provider} class={`mm-item ${on ? 'on' : ''}`} onClick={() => { setMenu(false); if (!on) p.onPickModel(m); }}>
                          <span class="mm-dot" />
                          <span class="mm-name mono">{m.name}</span>
                          <span class="mm-meta mono">{m.ctx ? fmtCtx(m.ctx) : ''}{t != null ? ` · ${fmtTps(t)}` : ''}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
                {!groups.length && <div class="mm-empty">No models yet.</div>}
                <div class="mm-foot">
                  <span class="dim">default effort</span>
                  <span class="mm-eff mono" style={{ '--effort': EFFORT_COLORS[p.defaultEffort] } as any}>
                    <button onClick={() => stepDefault(-1)} aria-label="Lower default effort">‹</button>
                    <span class="mm-eff-v">● {EFFORT_SHORT[p.defaultEffort]}</span>
                    <button onClick={() => stepDefault(1)} aria-label="Raise default effort">›</button>
                  </span>
                </div>
                <button class="mm-manage" onClick={() => { setMenu(false); p.onManageModels(); }}>Add or manage models…</button>
              </div>
            )}
          </div>
          <button class={`cchip yolo-chip ${p.yolo ? 'on' : ''}`} onClick={p.onToggleYolo} title={p.yolo ? 'yolo: commands run without asking' : 'Pico asks before risky commands'}>yolo</button>
          <span class="comp-spacer" />
          <button class="effort-label mono" onClick={() => cycle()} title={`${EFFORT_HINT[p.effort]} — shift+tab cycles`}>● {EFFORT_SHORT[p.effort]}</button>
          {p.busy ? (
            draft.trim()
              ? <button class="send steer" onClick={submit} aria-label="Steer" title="Steer (Enter)"><Icon name="send" size={15} /></button>
              : <button class="send stop" onClick={p.onStop} aria-label="Stop" title="Stop (Esc)"><Icon name="stop" size={13} /></button>
          ) : (
            <button class="send" onClick={submit} disabled={!draft.trim() && !files.length} aria-label="Send"><Icon name="send" size={15} /></button>
          )}
        </div>
      </div>
    </div>
  );
}
