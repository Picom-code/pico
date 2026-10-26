import { useEffect, useState } from 'preact/hooks';
import {
  api, fmtCtx, fmtTok, clearToken, jobEvents,
  type Checkin, type Connector, type Effort, type HelperEffort, type SubagentCfg, type MemoryItem, type ModelInfo, type Models,
  type Pairing, type Preset, type ProviderTest, type Skill, type Usage,
} from '../api';
import {
  ACCENTS, EFFORT_COLORS, HELPER_EFFORTS, applyAccent, applyMotion, currentAccent, getPref, motionOn, setPref,
  type ReasoningShown, type ToolDetail,
} from '../theme';
import { Cat, Face, Icon, Modal, Spinner, Toggle, toast } from '../components/ui';
import { fmtTps, tpsOf } from '../components/composer';

const TABS = [
  { id: 'general', label: 'General', icon: 'gear' },
  { id: 'models', label: 'Models', icon: 'chip' },
  { id: 'look', label: 'Look & feel', icon: 'palette' },
  { id: 'helpers', label: 'Helpers', icon: 'helpers' },
  { id: 'crons', label: 'Crons', icon: 'clock' },
  { id: 'usage', label: 'Usage', icon: 'bars' },
  { id: 'connections', label: 'Connections', icon: 'plug' },
  { id: 'memory', label: 'Memory', icon: 'file', minor: true },
  { id: 'skills', label: 'Skills', icon: 'bolt', minor: true },
  { id: 'phone', label: 'Phone', icon: 'phone', minor: true },
  { id: 'about', label: 'About', icon: 'info', minor: true },
] as const;
export type SettingsTab = (typeof TABS)[number]['id'];

const tabFromHash = (): SettingsTab => {
  const t = location.hash.split('/')[1] as SettingsTab;
  if ((t as string) === 'model') return 'models';
  if ((t as string) === 'checkins') return 'crons';
  return TABS.some((x) => x.id === t) ? t : 'general';
};

export function Settings({ onBack, models, refreshModels, onNeedSetup, onConfigChanged }: {
  onBack: () => void; models: Models | null; refreshModels: () => void; onNeedSetup: () => void; onConfigChanged: () => void;
}) {
  const [tab, setTabState] = useState<SettingsTab>(tabFromHash);
  useEffect(() => {
    const h = () => setTabState(tabFromHash());
    addEventListener('hashchange', h);
    return () => removeEventListener('hashchange', h);
  }, []);
  const setTab = (t: SettingsTab) => { history.replaceState(null, '', `#settings/${t}`); setTabState(t); dispatchEvent(new HashChangeEvent('hashchange')); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('.modal, input, textarea')) onBack(); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);

  return (
    <main class="main settings">
      <div class="set-layout">
        <nav class="set-tabs" data-tauri-drag-region>
          <div class="set-title" data-tauri-drag-region>Settings</div>
          {TABS.map((t, i) => (
            <>
              {'minor' in t && t.minor && !('minor' in TABS[i - 1]) && <div class="set-sep" />}
              <button key={t.id} class={`set-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
                <Icon name={t.icon} size={15} />{t.label}
              </button>
            </>
          ))}
        </nav>
        <div class="set-body" key={tab}>
          <header class="set-top" data-tauri-drag-region>
            <h1 data-tauri-drag-region>{TABS.find((t) => t.id === tab)?.label}</h1>
            <button class="icon-btn xs" onClick={onBack} title="Back to chat (Esc)" aria-label="Back to chat"><Icon name="x" size={15} /></button>
          </header>
          {tab === 'general' && <GeneralTab onChanged={onConfigChanged} />}
          {tab === 'models' && <ModelsTab models={models} refreshModels={refreshModels} onNeedSetup={onNeedSetup} />}
          {tab === 'look' && <LookTab />}
          {tab === 'helpers' && <HelpersTab models={models} />}
          {tab === 'crons' && <CronsTab />}
          {tab === 'usage' && <UsageTab />}
          {tab === 'connections' && <ConnectionsTab />}
          {tab === 'memory' && <MemoryTab />}
          {tab === 'skills' && <SkillsTab />}
          {tab === 'phone' && <PhoneTab />}
          {tab === 'about' && <AboutTab />}
        </div>
      </div>
    </main>
  );
}

function Section({ title, sub, children, right }: { title?: string; sub?: string; children: preact.ComponentChildren; right?: preact.ComponentChildren }) {
  return (
    <section class="set-sec">
      {(title || right) && (
        <div class="set-sec-head">
          <div>{title && <h2>{title}</h2>}{sub && <p class="muted">{sub}</p>}</div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

function Row({ label, sub, children }: { label: string; sub?: string; children: preact.ComponentChildren }) {
  return (
    <div class="prow">
      <div class="prow-l"><div class="prow-t">{label}</div>{sub && <div class="prow-s">{sub}</div>}</div>
      <div class="prow-c">{children}</div>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, color }: { value: T; options: readonly T[] | T[]; onChange: (v: T) => void; color?: (v: T) => string | undefined }) {
  return (
    <div class="pseg">
      {options.map((o) => (
        <button key={o} class={`pseg-b ${value === o ? 'sel' : ''}`} style={color ? { '--c': color(o) } as any : undefined} onClick={() => onChange(o)}>
          {color && <span class="pseg-dot" />}{o}
        </button>
      ))}
    </div>
  );
}

// ---------- General ----------
function GeneralTab({ onChanged }: { onChanged: () => void }) {
  const [cfg, setCfg] = useState<Record<string, any> | null>(null);
  const [reasoning, setReasoning] = useState<ReasoningShown>(getPref('reasoning', 'timer'));
  const [tools, setTools] = useState<ToolDetail>(getPref('tools', 'normal'));
  useEffect(() => { api.config().then(setCfg).catch(() => setCfg({})); }, []);
  const patch = async (b: Record<string, unknown>) => {
    setCfg((c) => ({ ...(c || {}), ...b }));
    try { setCfg(await api.patchConfig(b)); onChanged(); } catch (e: any) { toast(e.message || 'Could not save', 'err'); }
  };
  if (!cfg) return <div class="pad"><Spinner /></div>;
  const efforts: Effort[] = cfg.efforts?.length ? cfg.efforts : ['low', 'medium', 'high'];
  const approvals = cfg.approvals === 'yolo' ? 'yolo' : 'ask';
  return (
    <div class="pgroup">
      <Row label="Approvals" sub={approvals === 'yolo' ? 'Commands run without asking. Careful.' : 'Pico asks before risky commands.'}>
        <div class="pseg">
          <button class={`pseg-b ${approvals === 'ask' ? 'sel' : ''}`} onClick={() => patch({ approvals: 'ask' })}>ask</button>
          <button class={`pseg-b danger ${approvals === 'yolo' ? 'sel' : ''}`} onClick={() => patch({ approvals: 'yolo' })}>yolo</button>
        </div>
      </Row>
      <Row label="Default effort" sub="How hard new chats think. Shift+Tab in the composer changes it per message.">
        <Seg value={(cfg.effort_default || 'medium') as Effort} options={efforts} onChange={(v) => patch({ effort_default: v })} color={(v) => EFFORT_COLORS[v]} />
      </Row>
      <Row label="Reasoning shown" sub="How much of Pico's thinking you see.">
        <Seg value={reasoning} options={['hidden', 'timer', 'preview', 'full'] as ReasoningShown[]} onChange={(v) => { setReasoning(v); setPref('reasoning', v); }} />
      </Row>
      <Row label="Tool detail" sub="quiet folds finished steps into one line; full opens results.">
        <Seg value={tools} options={['quiet', 'normal', 'full'] as ToolDetail[]} onChange={(v) => { setTools(v); setPref('tools', v); }} />
      </Row>
    </div>
  );
}

// ---------- Models ----------
function ModelsTab({ models, refreshModels, onNeedSetup }: { models: Models | null; refreshModels: () => void; onNeedSetup: () => void }) {
  const [adding, setAdding] = useState<null | 'pick' | 'chatgpt' | 'api'>(null);
  useEffect(() => { refreshModels(); }, []);
  const switchTo = async (m: ModelInfo) => {
    try { await api.setModel(m.id, m.provider); toast(`now using ${m.name}`); refreshModels(); }
    catch (e: any) { toast(e.message, 'err'); }
  };
  const groups = new Map<string, ModelInfo[]>();
  for (const m of models?.models || []) { const k = m.provider_label || m.provider; groups.set(k, [...(groups.get(k) || []), m]); }
  return (
    <>
      <Section title="Your models" right={!adding && <button class="btn sm" onClick={() => setAdding('pick')}><Icon name="plus" size={14} /> Add model</button>}>
        {!models ? <Spinner /> : (
          <div class="pgroup">
            {[...groups.entries()].map(([label, list]) => (
              <div key={label}>
                <div class="pg-h mono">{label}</div>
                {list.map((m) => {
                  const on = m.active || m.id === models.active;
                  const t = tpsOf(m);
                  return (
                    <button key={m.id + m.provider} class={`mrow ${on ? 'on' : ''}`} onClick={() => !on && switchTo(m)}>
                      <span class="mm-dot" />
                      <span class="mrow-name mono">{m.name}</span>
                      <span class="mrow-meta mono">{m.ctx ? fmtCtx(m.ctx) + ' ctx' : ''}{t != null ? ` · ${fmtTps(t)}${m.tps_measured == null ? ' est' : ''}` : ''}</span>
                      {on ? <span class="badge accent-badge mono">active</span> : <span class="mrow-use">use</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </Section>
      {adding && (
        <Section title="Add a model" right={<button class="icon-btn xs" onClick={() => setAdding(null)} aria-label="Cancel"><Icon name="x" size={14} /></button>}>
          {adding === 'pick' && (
            <div class="addgrid">
              <button class="addcard" onClick={() => setAdding('chatgpt')}><span class="ac-ico mono">◐</span><b>ChatGPT login</b><span class="dim small">Use your ChatGPT plan's models. Sign in once.</span></button>
              <button class="addcard" onClick={() => setAdding('api')}><span class="ac-ico mono">{'{ }'}</span><b>Any API</b><span class="dim small">OpenRouter, Groq, DeepSeek, Ollama, LM Studio… paste a key.</span></button>
              <button class="addcard" onClick={onNeedSetup}><span class="ac-ico mono">▣</span><b>Local</b><span class="dim small">Download a model that runs on this computer.</span></button>
            </div>
          )}
          {adding === 'chatgpt' && <ChatGPTLogin onDone={() => { setAdding(null); refreshModels(); }} />}
          {adding === 'api' && <ApiSetup onDone={() => { setAdding(null); refreshModels(); }} />}
        </Section>
      )}
    </>
  );
}

function runSetup(body: unknown): Promise<void> {
  return api.setup(body).then(({ job_id }) => new Promise<void>((resolve, reject) => {
    jobEvents(job_id, (e) => {
      if (e.event === 'done') (e.data?.ok === false ? reject(new Error(e.data?.message || 'Setup failed')) : resolve());
      if (e.event === 'error') reject(new Error(e.data?.message || 'Setup failed'));
    }).then(() => resolve()).catch(reject);
  }));
}

function ChatGPTLogin({ onDone }: { onDone: () => void }) {
  const [st, setSt] = useState<{ state: string; url?: string; code?: string; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try { const r = await api.openaiStart(); setSt({ state: 'pending', ...r }); window.open(r.url, '_blank', 'noopener'); }
    catch (e: any) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (st?.state !== 'pending') return;
    const t = setInterval(async () => {
      try {
        const s = await api.openaiStatus();
        if (s.state === 'done' || s.logged_in) {
          clearInterval(t); setSt({ state: 'done' });
          await runSetup({ provider: { kind: 'openai_login' } }).catch((e) => toast(e.message, 'err'));
          toast('ChatGPT connected'); onDone();
        } else if (s.state === 'error') { clearInterval(t); setSt({ state: 'error', error: s.error }); }
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(t);
  }, [st?.state]);
  return (
    <div class="card form">
      {!st && <><p class="muted">Opens a ChatGPT sign-in page. Enter the code it shows you there.</p><div><button class="btn primary" disabled={busy} onClick={start}>{busy ? <Spinner /> : 'Sign in with ChatGPT'}</button></div></>}
      {st?.state === 'pending' && (
        <>
          <p class="muted">Enter this code on the page that just opened (<a href={st.url} target="_blank" rel="noopener">open it again</a>):</p>
          <div class="device-code mono" onClick={() => navigator.clipboard?.writeText(st.code || '')}>{st.code}</div>
          <div class="waiting dim"><Spinner /> waiting for you to finish…</div>
        </>
      )}
      {st?.state === 'done' && <div class="ok-line">✓ connected</div>}
      {st?.state === 'error' && <><div class="err">{st.error || 'That didn’t work.'}</div><div><button class="btn" onClick={start}>Try again</button></div></>}
    </div>
  );
}

function ApiSetup({ onDone }: { onDone: () => void }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [pid, setPid] = useState('openrouter');
  const [base, setBase] = useState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [test, setTest] = useState<ProviderTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.presets().then((p) => { setPresets(p); const d = p.find((x) => x.id === 'openrouter') || p[0]; if (d) { setPid(d.id); setBase(d.base_url); } }).catch(() => {}); }, []);
  const preset = presets.find((p) => p.id === pid);
  const pick = (p: Preset) => { setPid(p.id); setBase(p.base_url); setTest(null); };
  const runTest = async () => {
    setTesting(true); setTest(null);
    try { const r = await api.testProvider({ base_url: base.trim(), api_key: key.trim() || undefined, model: model.trim() || undefined }); setTest(r); if (r.ok && !model && r.model_used) setModel(r.model_used); }
    catch (e: any) { setTest({ ok: false, error: { kind: 'other', message: e.message } }); }
    finally { setTesting(false); }
  };
  const save = async () => {
    setSaving(true);
    try { await runSetup({ provider: { kind: 'custom', base_url: base.trim(), api_key: key.trim() || undefined, model: model.trim() || test?.model_used } }); toast('Model added'); onDone(); }
    catch (e: any) { toast(e.message, 'err'); }
    finally { setSaving(false); }
  };
  return (
    <div class="card form">
      <div class="preset-row">
        {presets.map((p) => <button key={p.id} class={`pchip ${p.id === pid ? 'sel' : ''}`} onClick={() => pick(p)}>{p.name}</button>)}
      </div>
      {preset?.note && <p class="dim small">{preset.note}</p>}
      <label>Address<input class="input mono" value={base} placeholder="https://…/v1" onInput={(e) => { setBase((e.target as HTMLInputElement).value); setTest(null); }} /></label>
      {(preset?.needs_key ?? true) && <label>API key<input class="input mono" type="password" autoComplete="off" value={key} placeholder="paste key" onInput={(e) => { setKey((e.target as HTMLInputElement).value); setTest(null); }} /></label>}
      <label>Model <span class="dim small">(optional — the test picks one)</span>
        {test?.models?.length ? (
          <select class="input select mono" value={model} onChange={(e) => setModel((e.target as HTMLSelectElement).value)}>
            {test.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : <input class="input mono" value={model} placeholder="e.g. deepseek/deepseek-chat" onInput={(e) => setModel((e.target as HTMLInputElement).value)} />}
      </label>
      <div class="test-row">
        <button class="btn" disabled={!base.trim() || testing} onClick={runTest}>{testing ? <Spinner /> : 'Test'}</button>
        {test && (test.ok
          ? <span class="ok-line mono">● connected{test.tps ? ` · ${Math.round(test.tps)} tok/s` : ''}{test.latency_s ? ` · ${test.latency_s.toFixed(1)}s` : ''}</span>
          : <span class="err small">{test.error?.message || 'failed'}</span>)}
        <span class="comp-spacer" />
        <button class="btn primary" disabled={!test?.ok || saving} onClick={save}>{saving ? <Spinner /> : 'Use this model'}</button>
      </div>
    </div>
  );
}

// ---------- Memory ----------
function MemoryTab() {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [text, setText] = useState('');
  const load = () => api.memory().then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, []);
  const add = async (e: Event) => {
    e.preventDefault();
    if (!text.trim()) return;
    try { await api.addMemory(text.trim()); setText(''); load(); } catch (er: any) { toast(er.message, 'err'); }
  };
  const del = async (id: string) => { setItems((s) => (s || []).filter((m) => m.id !== id)); await api.deleteMemory(id).catch(() => load()); };
  return (
    <Section title="Memory" sub="Things Pico remembers about you across chats. Pico adds to this on its own; you can too.">
      <form class="inline-form" onSubmit={add}>
        <input class="input" placeholder="e.g. I run a bakery in Austin and prefer short answers" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <button class="btn primary" type="submit" disabled={!text.trim()}>Add</button>
      </form>
      {items === null ? <Spinner /> : items.length === 0 ? <div class="card muted">Nothing remembered yet.</div> : (
        <ul class="list">
          {items.map((m) => (
            <li class="card mem" key={m.id}>
              <span>{m.text}</span>
              <button class="icon-btn xs" onClick={() => del(m.id)} aria-label="Forget"><Icon name="trash" size={14} /></button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------- Skills ----------
function SkillsTab() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [view, setView] = useState<Skill | null>(null);
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState('');
  const [body, setBody] = useState('');
  const load = () => api.skills().then(setSkills).catch(() => setSkills([]));
  useEffect(() => { load(); }, []);

  const toggle = async (s: Skill) => {
    setSkills((list) => (list || []).map((x) => (x.name === s.name ? { ...x, enabled: !x.enabled } : x)));
    await api.toggleSkill(s.name).catch(() => load());
  };
  const open = async (s: Skill) => {
    try { const full = await api.skill(s.name); setView(full); setDesc(full.description); setBody(full.body || ''); setEditing(false); }
    catch (e: any) { toast(e.message, 'err'); }
  };
  const save = async () => {
    if (!view) return;
    try { await api.saveSkill(view.name, { description: desc, body }); toast('Saved'); setView({ ...view, description: desc, body }); setEditing(false); load(); }
    catch (e: any) { toast(e.message, 'err'); }
  };

  const groups = (skills || []).reduce<Record<string, Skill[]>>((acc, s) => { (acc[s.category || 'other'] ||= []).push(s); return acc; }, {});
  return (
    <Section title="Skills" sub="Know-how Pico can use. Turn off anything you don't want. Type / in chat to use one directly.">
      {skills === null ? <Spinner /> : Object.entries(groups).map(([cat, list]) => (
        <div key={cat} class="skill-group">
          <div class="side-h mono">{cat}</div>
          <div class="list">
            {list.map((s) => (
              <div class="card skill" key={s.name}>
                <button class="skill-main" onClick={() => open(s)}>
                  <span class="mono">{s.name}</span>{s.builtin && <span class="badge mono">built-in</span>}
                  <span class="muted small">{s.description}</span>
                </button>
                <Toggle on={s.enabled} onChange={() => toggle(s)} label={`Enable ${s.name}`} />
              </div>
            ))}
          </div>
        </div>
      ))}
      {view && (
        <Modal title={view.name} onClose={() => setView(null)} wide>
          {editing ? (
            <div class="form">
              <label>Description<input class="input" value={desc} onInput={(e) => setDesc((e.target as HTMLInputElement).value)} /></label>
              <label>Instructions<textarea class="input mono code-edit" value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} /></label>
              <div class="wiz-actions"><button class="btn ghost" onClick={() => setEditing(false)}>Cancel</button><button class="btn primary" onClick={save}>Save</button></div>
            </div>
          ) : (
            <>
              <p class="muted">{view.description}</p>
              <pre class="skill-body mono">{view.body}</pre>
              <div class="wiz-actions"><span /><button class="btn ghost" onClick={() => setEditing(true)}><Icon name="edit" size={14} /> Edit</button></div>
            </>
          )}
        </Modal>
      )}
    </Section>
  );
}

// ---------- Connections ----------
function ConnectionsTab() {
  const [list, setList] = useState<Connector[] | null>(null);
  const [form, setForm] = useState<Connector | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const load = () => api.connectors().then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  const fields = (c: Connector) => (c.setup.fields || []).map((f) => (typeof f === 'string' ? { name: f, label: f, secret: /key|token|secret|password/i.test(f) } : f));

  const start = (c: Connector) => {
    if (c.kind === 'oauth' && c.setup.oauth_url) {
      window.open(c.setup.oauth_url, '_blank', 'noopener');
      toast('Finish connecting in the new tab');
      setTimeout(load, 4000);
      return;
    }
    setVals({}); setForm(c);
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!form) return;
    try { await api.connect(form.id, vals); toast(`${form.name} connected`); setForm(null); load(); }
    catch (er: any) { toast(er.message, 'err'); }
  };
  const disconnect = async (c: Connector) => { await api.disconnect(c.id).catch(() => {}); load(); };

  return (
    <Section title="Connections" sub="Let Pico use your other apps. Each one only does what it says.">
      {list === null ? <Spinner /> : (
        <div class="conn-grid">
          {list.map((c) => (
            <div class={`card conn ${c.connected ? 'on' : ''}`} key={c.id}>
              <div class="conn-top"><span class="conn-name">{c.name}</span>{c.connected && <span class="badge accent-badge mono">connected</span>}</div>
              <p class="muted small">{c.what}</p>
              {c.connected
                ? <button class="btn ghost sm" onClick={() => disconnect(c)}>Disconnect</button>
                : <button class="btn sm" onClick={() => start(c)}>Connect</button>}
            </div>
          ))}
        </div>
      )}
      {form && (
        <Modal title={`Connect ${form.name}`} onClose={() => setForm(null)}>
          <p class="muted">{form.what}</p>
          <form class="form" onSubmit={submit}>
            {fields(form).map((f) => (
              <label key={f.name}>{f.label || f.name}
                <input class="input mono" type={f.secret ? 'password' : 'text'} placeholder={f.placeholder} value={vals[f.name] || ''}
                  onInput={(e) => setVals({ ...vals, [f.name]: (e.target as HTMLInputElement).value })} />
              </label>
            ))}
            <div class="wiz-actions"><button type="button" class="btn ghost" onClick={() => setForm(null)}>Cancel</button><button class="btn primary" type="submit">Connect</button></div>
          </form>
        </Modal>
      )}
    </Section>
  );
}

// ---------- Crons ----------
const when = (t?: number | null) => {
  if (!t) return '—';
  const d = new Date(t * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
function CronsTab() {
  const [list, setList] = useState<Checkin[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [sched, setSched] = useState('');
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [err, setErr] = useState('');
  const load = () => api.checkins().then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  const save = async (e: Event) => {
    e.preventDefault();
    if (!prompt.trim() || !sched.trim()) return;
    setErr('');
    try {
      await api.addCheckin({ title: title.trim() || undefined, prompt: prompt.trim(), schedule: { text: sched.trim() } });
      setAdding(false); setTitle(''); setPrompt(''); setSched(''); load(); toast('Cron saved');
    } catch (er: any) { setErr(er.message); }
  };
  const toggle = async (c: Checkin) => {
    setList((s) => (s || []).map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)));
    await api.patchCheckin(c.id, { enabled: !(c.enabled ?? true) }).then(load).catch((e) => { toast(e.message, 'err'); load(); });
  };
  const run = async (c: Checkin) => { const r = await api.runCheckin(c.id).catch((e) => { toast(e.message, 'err'); return null; }); if (r) toast(r.ok ? 'Running — result goes to your inbox' : 'Already running', 'note'); setTimeout(load, 800); };
  const del = async (c: Checkin) => { if (!confirm(`Delete “${c.title}”?`)) return; setList((s) => (s || []).filter((x) => x.id !== c.id)); await api.deleteCheckin(c.id).catch(() => load()); };
  return (
    <Section sub="Pico runs these on a schedule in a fresh chat. Results land in your inbox (the tray on the left rail)."
      right={!adding && <button class="btn sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> New cron</button>}>
      {adding && (
        <form class="card form" onSubmit={save}>
          <label>When <span class="dim small">plain English: “every weekday at 8am”, “every 30m”, “mon and fri at 9:15”</span>
            <input class="input mono" value={sched} placeholder="every weekday at 8am" onInput={(e) => setSched((e.target as HTMLInputElement).value)} autoFocus /></label>
          <label>What should Pico do?<textarea class="input" rows={3} placeholder="e.g. check CI on main and summarize anything red" value={prompt} onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)} /></label>
          <label>Name <span class="dim small">(optional)</span><input class="input" placeholder="CI check" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} /></label>
          {err && <div class="err small">{err}</div>}
          <div class="wiz-actions"><button type="button" class="btn ghost" onClick={() => setAdding(false)}>Cancel</button><button class="btn primary" type="submit" disabled={!prompt.trim() || !sched.trim()}>Save</button></div>
        </form>
      )}
      {list === null ? <Spinner /> : list.length === 0 && !adding ? <div class="card muted">No crons yet. Try <code>/cron every weekday at 8am -- check my PRs</code> in chat.</div> : (
        <div class="pgroup">
          {list.map((c) => {
            const on = c.enabled ?? true;
            return (
              <div class={`cron ${on ? '' : 'paused'}`} key={c.id}>
                <span class={`cron-dot ${c.last_status || ''}`} title={c.last_status || 'never run'} />
                <div class="cron-main">
                  <div class="cron-title">{c.title}</div>
                  <div class="cron-sub mono">{c.schedule_text || JSON.stringify(c.schedule)} · next {on ? when(c.next_run) : 'paused'}{c.last_run ? ` · last ${when(c.last_run)}` : ''}</div>
                </div>
                <button class="icon-btn xs" onClick={() => toggle(c)} title={on ? 'Pause' : 'Resume'}><Icon name={on ? 'pause' : 'play'} size={13} /></button>
                <button class="icon-btn xs" onClick={() => run(c)} title="Run now"><Icon name="send" size={13} /></button>
                <button class="icon-btn xs" onClick={() => del(c)} title="Delete"><Icon name="trash" size={13} /></button>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// ---------- Usage ----------
function UsageTab() {
  const [u, setU] = useState<Usage | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.usage(30).then(setU).catch((e) => setErr(e.message)); }, []);
  if (err) return <div class="card err">{err}</div>;
  if (!u) return <div class="pad"><Spinner /></div>;
  const max = Math.max(1, ...u.days.map((d) => d.input + d.output + d.cached));
  const tot = u.totals;
  return (
    <>
      <div class="set-sec-head"><p class="muted">Last {u.days_requested} days.</p></div>
      <div class="ustats">
        <div class="ustat"><span class="us-k">turns</span><span class="us-v mono">{tot.turns}</span></div>
        <div class="ustat"><span class="us-k">input</span><span class="us-v mono">{fmtTok(tot.input)}</span></div>
        <div class="ustat"><span class="us-k">output</span><span class="us-v mono">{fmtTok(tot.output)}</span></div>
        <div class="ustat"><span class="us-k">cache hit</span><span class="us-v mono">{u.cache_hit_pct == null ? '—' : `${Math.round(u.cache_hit_pct)}%`}</span></div>
        <div class="ustat"><span class="us-k">today</span><span class="us-v mono">{fmtTok(u.today.input + u.today.output)}</span></div>
      </div>
      <Section title="Last 30 days" sub="tokens per day · bright = new input + output, faint = cache reads">
        <div class="ubar-max mono">max {fmtTok(max)}/day</div>
        <div class="ubars" role="img" aria-label="Tokens per day">
          {u.days.map((d) => {
            const fresh = d.input + d.output;
            return (
              <div class="ubar" key={d.date} title={`${d.date}: ${fmtTok(fresh)} new · ${fmtTok(d.cached)} cached · ${d.turns} turns`}>
                <span class="ub-c" style={{ height: `${(d.cached / max) * 100}%` }} />
                <span class="ub-f" style={{ height: `${(fresh / max) * 100}%` }} />
              </div>
            );
          })}
        </div>
        <div class="ubar-axis mono"><span>{u.days[0]?.date.slice(5)}</span><span>{u.days[u.days.length - 1]?.date.slice(5)}</span></div>
      </Section>
      <Section title="By model">
        <div class="pgroup">
          {u.by_model.length === 0 && <div class="prow"><span class="dim">No turns yet.</span></div>}
          {u.by_model.map((m) => (
            <div class="urow" key={m.model}>
              <span class={`mono urow-name ${m.model === 'unknown' ? 'dim' : ''}`}>{m.model === 'unknown' ? 'unattributed (older turns)' : m.model}</span>
              <span class="mono dim">{m.turns} turn{m.turns === 1 ? '' : 's'}</span>
              <span class="mono dim">{fmtTok(m.input)} in · {fmtTok(m.output)} out</span>
              <span class="mono dim">{m.tps ? fmtTps(m.tps) : ''}</span>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

// ---------- Phone ----------
function PhoneTab() {
  const [p, setP] = useState<Pairing | null>(null);
  const [loading, setLoading] = useState(false);
  const pair = async () => {
    setLoading(true);
    try { setP(await api.pair()); } catch (e: any) { toast(e.message, 'err'); } finally { setLoading(false); }
  };
  // The QR SVG comes from our own engine; strip scripts/handlers defensively before injecting.
  const safeSvg = (s: string) => s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '');
  return (
    <Section title="Phone" sub="Use Pico from your phone. Chats still run on this computer.">
      {!p ? (
        <div class="card pair-start">
          <Cat mood="idle" size="sm" />
          <ol class="steps-list">
            <li>Install the Pico app on your phone.</li>
            <li>Tap <b>Pair</b> below and scan the code.</li>
            <li>That's it — your phone talks to this computer.</li>
          </ol>
          <button class="btn primary" onClick={pair} disabled={loading}>{loading ? <Spinner /> : 'Pair a phone'}</button>
        </div>
      ) : (
        <div class="card pair">
          <div class="qr" dangerouslySetInnerHTML={{ __html: safeSvg(p.qr) }} />
          <div class="pair-info">
            <div class="muted small">Or type this code in the app</div>
            <div class="device-code mono">{p.code}</div>
            <div class="muted small mono">{p.url}</div>
            <button class="link-btn" onClick={pair}>New code</button>
          </div>
        </div>
      )}
    </Section>
  );
}

// ---------- Helpers (subagents) ----------
const HELPER_DEFAULTS: SubagentCfg = { enabled: true, max_parallel: 2, model: '', effort: 'low', max_seconds: 300 };
const PARALLEL = [1, 2, 4, 8];
const TIME_STEPS = [60, 120, 180, 300, 600, 900, 1200, 1800];
const fmtLimit = (s: number) => (s < 60 ? `${s}s` : `${Math.round(s / 60)} min`);

function HelperSetting({ title, sub, children, dis }: { title: string; sub: string; children: preact.ComponentChildren; dis?: boolean }) {
  return (
    <div class={`hset ${dis ? 'dis' : ''}`}>
      <div class="hset-txt"><div class="hset-title">{title}</div><div class="muted small">{sub}</div></div>
      <div class="hset-ctl">{children}</div>
    </div>
  );
}

function HelpersTab({ models }: { models: Models | null }) {
  const [cfg, setCfg] = useState<SubagentCfg | null>(null);
  const [list, setList] = useState<ModelInfo[]>(models?.models || []);
  const [saved, setSaved] = useState(0);
  useEffect(() => {
    api.config().then((c) => setCfg({ ...HELPER_DEFAULTS, ...((c.subagents as Partial<SubagentCfg>) || {}) })).catch(() => setCfg(HELPER_DEFAULTS));
    if (!models) api.models().then((m) => setList(m.models)).catch(() => {});
  }, []);
  // Debounced save so slider drags don't spam the engine.
  const timer = useState<{ t?: ReturnType<typeof setTimeout> }>({})[0];
  const update = (patch: Partial<SubagentCfg>) => {
    setCfg((c) => {
      const next = { ...(c || HELPER_DEFAULTS), ...patch };
      clearTimeout(timer.t);
      timer.t = setTimeout(() => {
        api.patchConfig({ subagents: next }).then(() => setSaved(Date.now())).catch((e) => toast(e.message || 'Could not save', 'err'));
      }, 350);
      return next;
    });
  };
  if (!cfg) return <div class="center-fill pad"><Spinner /></div>;
  const off = !cfg.enabled;
  const tIdx = Math.max(0, TIME_STEPS.findIndex((x) => x >= cfg.max_seconds));
  return (
    <Section
      title="Helpers"
      sub="For big jobs, Pico can hand pieces to helpers that work at the same time, then put the results together."
      right={saved ? <span class="saved mono" key={saved}>saved</span> : undefined}
    >
      <div class="card helpers-set">
        <div class="hs-preview" aria-hidden="true">
          {Array.from({ length: Math.min(cfg.enabled ? cfg.max_parallel : 1, 8) }).map((_, i) => <span class="hs-face" key={i}><Face mood={off ? 'asleep' : 'work'} /></span>)}
          <span class="hs-cap mono">{off ? 'helpers off' : `up to ${cfg.max_parallel} at once`}</span>
        </div>
        <HelperSetting title="Use helpers" sub="Let Pico split big jobs into parts that run side by side.">
          <Toggle on={cfg.enabled} onChange={(v) => update({ enabled: v })} label="Use helpers" />
        </HelperSetting>
        <HelperSetting title="How many at once" sub="More is faster, but uses more of your computer." dis={off}>
          <div class="seg sm">
            {PARALLEL.map((n) => <button key={n} disabled={off} class={`seg-btn mono ${cfg.max_parallel === n ? 'sel' : ''}`} onClick={() => update({ max_parallel: n })}>{n}</button>)}
          </div>
        </HelperSetting>
        <HelperSetting title="Model" sub="Which model the helpers think with." dis={off}>
          <select class="input select mono" disabled={off} value={cfg.model || ''} onChange={(e) => update({ model: (e.target as HTMLSelectElement).value })}>
            <option value="">Same as main</option>
            {list.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </HelperSetting>
        <HelperSetting title="Thinking" sub="How hard each helper thinks before acting." dis={off}>
          <div class="effort-pills">
            {HELPER_EFFORTS.map((e: HelperEffort) => (
              <button key={e} disabled={off} class={`epill mono ${cfg.effort === e ? 'sel' : ''}`} style={{ '--effort': EFFORT_COLORS[e] } as any} onClick={() => update({ effort: e })}>
                <span class="e-dot" />{e}
              </button>
            ))}
          </div>
        </HelperSetting>
        <HelperSetting title="Time limit" sub="A helper stops and reports back after this long." dis={off}>
          <div class="slider-wrap">
            <input type="range" class="slider" disabled={off} min={0} max={TIME_STEPS.length - 1} step={1} value={tIdx}
              style={{ '--p': `${(tIdx / (TIME_STEPS.length - 1)) * 100}%` } as any}
              onInput={(e) => update({ max_seconds: TIME_STEPS[Number((e.target as HTMLInputElement).value)] })} aria-label="Time limit" />
            <span class="slider-val mono">{fmtLimit(TIME_STEPS[tIdx])}</span>
          </div>
        </HelperSetting>
      </div>
    </Section>
  );
}

// ---------- Look ----------
function LookTab() {
  const [accent, setAccent] = useState(currentAccent());
  const [motion, setMotion] = useState(motionOn());
  const pick = (id: string) => {
    setAccent(id); applyAccent(id);
    api.patchConfig({ accent: id }).catch(() => {});
  };
  return (
    <>
      <div class="pgroup">
        <Row label="Accent" sub="One color, used sparingly. Medium effort follows it.">
          <div class="swatches">
            {ACCENTS.map((a) => (
              <button key={a.id} class={`swatch ${accent === a.id ? 'sel' : ''}`} style={{ '--sw': a.hex } as any} onClick={() => pick(a.id)} title={a.name} aria-label={a.name}>
                <span class="sw-dot" />
              </button>
            ))}
          </div>
        </Row>
        <Row label="Motion" sub="Shimmer while thinking, streaming caret, the cat's blink. Off keeps everything still.">
          <Toggle on={motion} onChange={(v) => { setMotion(v); applyMotion(v); }} label="Motion" />
        </Row>
      </div>
      <div class="look-preview">
        <Cat mood="happy" size="md" />
        <div>
          <div class="lp-u">fix the off-by-one in calc.py</div>
          <div class="lp-a">Found it — the loop stopped one short. Fixed <code>range(n)</code>.</div>
          <div class="lp-s mono">✓ 3 tools · 1 file <span class="add">+1</span> <span class="del">−1</span> · 4.1s</div>
        </div>
      </div>
    </>
  );
}

// ---------- About ----------
function AboutTab() {
  const [h, setH] = useState<{ version: string; model?: string; provider?: string } | null>(null);
  useEffect(() => { api.health().then(setH).catch(() => {}); }, []);
  return (
    <Section title="About">
      <div class="card about">
        <Cat mood="idle" size="md" />
        <div>
          <div class="mono big-name">pico <span class="muted">{h?.version}</span></div>
          <p class="muted">Your own AI, on your own machine. Chats, memory, and skills live in <code>~/.pico</code> on this computer.</p>
          <p class="muted small">Built on Hermes Agent by Nous Research.</p>
          <button class="link-btn" onClick={() => { clearToken(); location.reload(); }}>Sign out of this browser</button>
        </div>
      </div>
    </Section>
  );
}
