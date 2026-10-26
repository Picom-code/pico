import { useEffect, useRef, useState } from 'preact/hooks';
import { api, fmtBytes, fmtCtx, jobEvents, type Persona, type Recipe, type Recipes, type SystemInfo } from '../api';
import { Icon, Skeleton, Spinner, Toggle, Typed, type Mood } from '../components/ui';

type Step = 'hello' | 'scan' | 'persona' | 'model' | 'extras' | 'install' | 'done';
type Provider =
  | { kind: 'local'; recipe_id: string }
  | { kind: 'openai_login' }
  | { kind: 'custom'; base_url: string; api_key: string; model: string };

const PERSONAS: { id: Persona; icon: string; title: string; line: string }[] = [
  { id: 'engineer', icon: '</>', title: 'Engineer', line: 'Code, scripts, debugging, docs' },
  { id: 'business', icon: '$_', title: 'Business owner', line: 'Email, plans, numbers, customers' },
  { id: 'creative', icon: '~*', title: 'Creative', line: 'Writing, ideas, images, stories' },
  { id: 'marketing', icon: '>>', title: 'Marketing', line: 'Copy, campaigns, social posts' },
  { id: 'student', icon: '[?]', title: 'Student', line: 'Studying, essays, explaining things' },
  { id: 'general', icon: '¯\\_', title: 'Just curious', line: 'A bit of everything' },
];

const STEPS: Step[] = ['scan', 'persona', 'model', 'extras', 'install'];
const STEP_LABEL: Record<string, string> = { scan: 'Your computer', persona: 'About you', model: 'Your AI', extras: 'Extras', install: 'Install' };

export function Wizard({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [step, setStep] = useState<Step>('hello');
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [recipes, setRecipes] = useState<Recipes | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [features, setFeatures] = useState({ voice: false, image: false, video: false });

  const idx = STEPS.indexOf(step);
  useEffect(() => {
    if (!onCancel) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && step !== 'install') onCancel(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel, step]);
  const mood: Mood = step === 'scan' ? 'scan' : step === 'install' ? 'work' : step === 'done' ? 'happy' : step === 'model' ? 'think' : 'idle';

  return (
    <div class="wizard">
      <header class="wiz-top">
        <div class="brand mono"><span class="accent">pico</span> setup</div>
        {onCancel && step !== 'install' && (
          <button class="btn ghost wiz-close" onClick={onCancel} title="Back to chat (Esc)">✕ close</button>
        )}
        {idx >= 0 && (
          <ol class="wiz-steps" aria-label="Setup progress">
            {STEPS.map((s, i) => (
              <li key={s} class={i < idx ? 'done' : i === idx ? 'cur' : ''}>
                <span class="dot" /> <span class="lbl">{STEP_LABEL[s]}</span>
              </li>
            ))}
          </ol>
        )}
      </header>

      <main class="wiz-main">
        {step !== 'hello' && step !== 'install' && step !== 'done' && (
          <div class="wiz-mascot"><Skeleton mood={mood} size="sm" /></div>
        )}
        <div class="wiz-card-wrap" key={step}>
          {step === 'hello' && <Hello onNext={() => setStep('scan')} />}
          {step === 'scan' && <Scan sys={sys} setSys={setSys} onNext={() => setStep('persona')} />}
          {step === 'persona' && (
            <PersonaStep value={persona} onPick={(p) => { setPersona(p); setRecipes(null); setStep('model'); }} onBack={() => setStep('scan')} />
          )}
          {step === 'model' && persona && (
            <ModelStep
              persona={persona} recipes={recipes} setRecipes={setRecipes}
              onBack={() => setStep('persona')}
              onPick={(p, r) => { setProvider(p); setRecipe(r); setStep('extras'); }}
            />
          )}
          {step === 'extras' && (
            <Extras sys={sys} recipe={recipe} provider={provider} features={features} setFeatures={setFeatures}
              onBack={() => setStep('model')} onNext={() => setStep('install')} />
          )}
          {step === 'install' && provider && persona && (
            <Install body={{ persona, provider, features }} recipe={recipe} onDone={() => setStep('done')} onBack={() => setStep('extras')} />
          )}
          {step === 'done' && <Done onGo={onDone} />}
        </div>
      </main>
    </div>
  );
}

function Hello({ onNext }: { onNext: () => void }) {
  const [line, setLine] = useState(0);
  return (
    <div class="hello">
      <div class="boot"><Skeleton mood={line >= 2 ? 'happy' : 'idle'} size="lg" /></div>
      <h1 class="mono hello-h">
        <Typed text="hey. i'm pico." speed={55} onDone={() => setTimeout(() => setLine(1), 250)} />
      </h1>
      {line >= 1 && (
        <p class="hello-p">
          <Typed text="Your own AI, running on your own computer. Let's set it up — takes about two minutes." speed={18} onDone={() => setLine(2)} />
        </p>
      )}
      <button class={`btn primary big fade ${line >= 2 ? 'in' : ''}`} onClick={onNext} disabled={line < 2}>
        Let's go <span class="mono">→</span>
      </button>
    </div>
  );
}

function Scan({ sys, setSys, onNext }: { sys: SystemInfo | null; setSys: (s: SystemInfo) => void; onNext: () => void }) {
  const [err, setErr] = useState('');
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (sys) { setShown(5); return; }
    const t0 = Date.now();
    api.system().then((s) => {
      // let the scan animation breathe for a moment even on fast machines
      setTimeout(() => setSys(s), Math.max(0, 1400 - (Date.now() - t0)));
    }).catch((e) => setErr(e.message || 'Scan failed'));
  }, []);
  useEffect(() => {
    if (!sys || shown >= 5) return;
    const t = setTimeout(() => setShown((n) => n + 1), 180);
    return () => clearTimeout(t);
  }, [sys, shown]);

  const gpu = sys?.gpus?.[0];
  const rows: [string, string][] = sys ? [
    ['Graphics', gpu ? gpu.name : sys.unified_memory ? 'Built-in (shared memory)' : 'None found'],
    ['Graphics memory', gpu?.vram_gb ? `${gpu.vram_gb} GB` : sys.unified_memory ? `shares ${sys.ram_gb} GB` : '—'],
    ['Memory', `${sys.ram_gb} GB`],
    ['System', `${prettyOS(sys.os)} · ${sys.arch}`],
    ['Free space', `${Math.round(sys.disk_free_gb)} GB`],
  ] : [];

  return (
    <section class="card wiz-card">
      <div class="eyebrow mono">step 1 · your computer</div>
      <h2>{sys ? 'Here’s what you’ve got' : 'Taking a look at your computer…'}</h2>
      <p class="muted">{sys ? verdict(sys) : 'Checking your graphics card and memory so Pico can pick an AI that runs fast here.'}</p>
      <div class={`scan-box ${sys ? 'scanned' : 'scanning'}`}>
        <div class="scanline" />
        {!sys && !err && (
          <div class="scan-ghost mono">
            {['graphics', 'memory', 'system', 'storage'].map((x) => <div key={x}><span>{x}</span><span class="ghost-bar" /></div>)}
          </div>
        )}
        {sys && (
          <dl class="hw">
            {rows.slice(0, shown).map(([k, v]) => (
              <div class="hw-row" key={k}><dt>{k}</dt><dd class="mono">{v}</dd></div>
            ))}
          </dl>
        )}
        {err && <p class="err">{err}</p>}
      </div>
      <div class="wiz-actions">
        <span />
        <button class="btn primary" disabled={!sys} onClick={onNext}>Continue</button>
      </div>
    </section>
  );
}

function prettyOS(os: string) {
  const o = os.toLowerCase();
  if (o.includes('darwin') || o.includes('mac')) return 'macOS';
  if (o.includes('win')) return 'Windows';
  if (o.includes('linux')) return 'Linux';
  return os;
}

function verdict(s: SystemInfo) {
  const vram = Math.max(0, ...s.gpus.map((g) => g.vram_gb || 0));
  const mem = s.unified_memory ? s.ram_gb * 0.7 : vram;
  if (mem >= 20) return 'Nice — this machine can run a seriously capable AI, fast.';
  if (mem >= 10) return 'Good news — this machine can run a strong AI comfortably.';
  if (mem >= 6) return 'This machine can run a solid, quick AI.';
  return 'This machine can run a small AI. You can also connect a cloud one later.';
}

function PersonaStep({ value, onPick, onBack }: { value: Persona | null; onPick: (p: Persona) => void; onBack: () => void }) {
  return (
    <section class="card wiz-card">
      <div class="eyebrow mono">step 2 · about you</div>
      <h2>What do you do?</h2>
      <p class="muted">Pico picks a model that's good at what you need. You can change this anytime.</p>
      <div class="persona-grid">
        {PERSONAS.map((p) => (
          <button key={p.id} class={`persona ${value === p.id ? 'sel' : ''}`} onClick={() => onPick(p.id)}>
            <span class="p-icon mono">{p.icon}</span>
            <span class="p-title">{p.title}</span>
            <span class="p-line">{p.line}</span>
          </button>
        ))}
      </div>
      <div class="wiz-actions"><button class="btn ghost" onClick={onBack}>Back</button><span /></div>
    </section>
  );
}

const STRENGTH: Record<string, string> = { coding: 'coding', speed: 'fast', writing: 'writing', creative: 'creative', vision: 'sees images' };

function speedWords(tps: number) {
  if (tps >= 60) return 'Very fast';
  if (tps >= 30) return 'Fast';
  if (tps >= 15) return 'Comfortable';
  return 'Slower';
}

function ModelStep({ persona, recipes, setRecipes, onPick, onBack }: {
  persona: Persona; recipes: Recipes | null; setRecipes: (r: Recipes) => void;
  onPick: (p: Provider, r: Recipe | null) => void; onBack: () => void;
}) {
  const [err, setErr] = useState('');
  const [chosen, setChosen] = useState<Recipe | null>(null);
  const [showOther, setShowOther] = useState(false);
  const [alt, setAlt] = useState<'none' | 'openai' | 'custom'>('none');

  useEffect(() => {
    if (recipes) { setChosen(recipes.recommended); return; }
    api.recipes(persona).then((r) => { setRecipes(r); setChosen(r.recommended); }).catch((e) => setErr(e.message));
  }, [persona]);

  if (err) return <section class="card wiz-card"><p class="err">{err}</p><button class="btn ghost" onClick={onBack}>Back</button></section>;
  if (!recipes || !chosen) return <section class="card wiz-card center"><Spinner /><p class="muted">Finding the best fit…</p></section>;

  if (alt === 'openai') return <OpenAILogin onBack={() => setAlt('none')} onOk={() => onPick({ kind: 'openai_login' }, null)} />;
  if (alt === 'custom') return <CustomServer onBack={() => setAlt('none')} onOk={(p) => onPick(p, null)} />;

  const isRec = chosen.id === recipes.recommended.id;
  const others = [recipes.recommended, ...recipes.alternatives].filter((r) => r.id !== chosen.id);

  return (
    <section class="card wiz-card">
      <div class="eyebrow mono">step 3 · your AI</div>
      <h2>{isRec ? 'We recommend' : 'You picked'}</h2>
      <div class="rec">
        <div class="rec-head">
          <div>
            <div class="rec-name mono">{chosen.model}</div>
            <div class="rec-sub">{chosen.family} · {chosen.params_b}B{chosen.active_b ? ` (${chosen.active_b}B active)` : ''} · {chosen.quant}</div>
          </div>
          {isRec && <span class="badge accent-badge mono">best fit</span>}
        </div>
        <p class="rec-why">{chosen.why}</p>
        <div class="rec-stats">
          <div><span class="k">Speed</span><span class="v">{speedWords(chosen.est_tps)}</span><span class="s mono">~{chosen.est_tps} tok/s{chosen.tps_source === 'est' ? ' (est.)' : ''}</span></div>
          <div><span class="k">Download</span><span class="v">{chosen.file_gb} GB</span><span class="s mono">one time</span></div>
          <div><span class="k">Keeps in mind</span><span class="v">~{Math.max(1, Math.round((chosen.ctx * 0.75) / 500))} pages</span><span class="s mono">{fmtCtx(chosen.ctx)} context</span></div>
        </div>
        <div class="chips">{chosen.strengths.map((s) => <span class="chip" key={s}>{STRENGTH[s] ?? s}</span>)}</div>
      </div>

      <button class="link-btn" onClick={() => setShowOther(!showOther)}>
        {showOther ? 'Hide' : 'See'} other options <span class={`chev ${showOther ? 'up' : ''}`}><Icon name="chev" size={14} /></span>
      </button>
      {showOther && (
        <div class="others">
          {others.map((r) => (
            <button key={r.id} class={`other ${!r.fits ? 'nofit' : ''}`} disabled={!r.fits} onClick={() => { setChosen(r); setShowOther(false); }}>
              <span class="mono o-name">{r.model}</span>
              <span class="o-meta">{r.file_gb} GB · {speedWords(r.est_tps).toLowerCase()} · {fmtCtx(r.ctx)} ctx{!r.fits ? ' · too big for this PC' : ''}</span>
              <span class="o-why">{r.why}</span>
            </button>
          ))}
          <div class="other-split mono">or skip the download</div>
          <button class="other" onClick={() => setAlt('openai')}>
            <span class="o-name">Sign in with ChatGPT</span>
            <span class="o-why">Use your ChatGPT account instead of a local model. Needs internet.</span>
          </button>
          <button class="other" onClick={() => setAlt('custom')}>
            <span class="o-name">Use my own server</span>
            <span class="o-why">Already run Ollama, LM Studio, or an API? Point Pico at it.</span>
          </button>
        </div>
      )}

      <div class="wiz-actions">
        <button class="btn ghost" onClick={onBack}>Back</button>
        <button class="btn primary" onClick={() => onPick({ kind: 'local', recipe_id: chosen.id }, chosen)}>Use this</button>
      </div>
    </section>
  );
}

function OpenAILogin({ onBack, onOk }: { onBack: () => void; onOk: () => void }) {
  const [info, setInfo] = useState<{ url: string; code: string } | null>(null);
  const [state, setState] = useState('starting');
  const [err, setErr] = useState('');
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    api.openaiStart().then((i) => {
      setInfo(i);
      setState('pending');
      const poll = async () => {
        if (stop) return;
        try {
          const s = await api.openaiStatus();
          setState(s.state);
          if (s.state === 'ok' || s.state === 'done' || s.state === 'success' || s.state === 'authorized') { onOk(); return; }
          if (s.state === 'error' || s.state === 'expired') return;
        } catch { /* keep polling */ }
        timer = setTimeout(poll, 2000);
      };
      timer = setTimeout(poll, 2000);
    }).catch((e) => setErr(e.message));
    return () => { stop = true; clearTimeout(timer); };
  }, []);
  return (
    <section class="card wiz-card">
      <div class="eyebrow mono">sign in with chatgpt</div>
      <h2>Approve Pico in your browser</h2>
      {err && <p class="err">{err}</p>}
      {!info && !err && <Spinner />}
      {info && (
        <>
          <p class="muted">Open this page, sign in, and type the code below.</p>
          <a class="btn primary" href={info.url} target="_blank" rel="noopener noreferrer">Open sign-in page ↗</a>
          <div class="device-code mono" onClick={() => navigator.clipboard?.writeText(info.code)} title="Click to copy">{info.code}</div>
          <p class="muted small waiting">{state === 'expired' ? 'Code expired — go back and try again.' : state === 'error' ? 'Sign-in failed.' : <><Spinner /> Waiting for you to approve…</>}</p>
        </>
      )}
      <div class="wiz-actions"><button class="btn ghost" onClick={onBack}>Back</button><span /></div>
    </section>
  );
}

function CustomServer({ onBack, onOk }: { onBack: () => void; onOk: (p: Provider) => void }) {
  const [base_url, setUrl] = useState('http://localhost:11434/v1');
  const [api_key, setKey] = useState('');
  const [model, setModel] = useState('');
  const ok = /^https?:\/\//.test(base_url) && model.trim();
  return (
    <section class="card wiz-card">
      <div class="eyebrow mono">use my own server</div>
      <h2>Connect your server</h2>
      <p class="muted">Any OpenAI-compatible server works — Ollama, LM Studio, vLLM, or a cloud API.</p>
      <form class="form" onSubmit={(e) => { e.preventDefault(); if (ok) onOk({ kind: 'custom', base_url, api_key, model }); }}>
        <label>Server address<input class="input mono" value={base_url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} /></label>
        <label>Key <span class="muted small">(leave blank if none)</span><input class="input mono" type="password" value={api_key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} /></label>
        <label>Model name<input class="input mono" placeholder="e.g. qwen3:14b" value={model} onInput={(e) => setModel((e.target as HTMLInputElement).value)} /></label>
        <div class="wiz-actions">
          <button type="button" class="btn ghost" onClick={onBack}>Back</button>
          <button type="submit" class="btn primary" disabled={!ok}>Continue</button>
        </div>
      </form>
    </section>
  );
}

function Extras({ sys, recipe, provider, features, setFeatures, onBack, onNext }: {
  sys: SystemInfo | null; recipe: Recipe | null; provider: Provider | null;
  features: { voice: boolean; image: boolean; video: boolean };
  setFeatures: (f: { voice: boolean; image: boolean; video: boolean }) => void;
  onBack: () => void; onNext: () => void;
}) {
  const vram = sys ? Math.max(0, ...sys.gpus.map((g) => g.vram_gb || 0), sys.unified_memory ? sys.ram_gb * 0.6 : 0) : 0;
  const local = provider?.kind === 'local';
  const canImage = recipe?.features?.image ?? (local ? vram >= 8 : true);
  const canVideo = recipe?.features?.video ?? (local ? vram >= 16 : false);
  const items: { id: 'voice' | 'image' | 'video'; title: string; line: string; can: boolean; extra: string }[] = [
    { id: 'voice', title: 'Voice', line: 'Talk to Pico and hear it answer out loud.', can: recipe?.features?.voice ?? true, extra: '~200 MB' },
    { id: 'image', title: 'Make images', line: 'Ask for a picture and Pico draws it, right on your computer.', can: canImage, extra: '~4 GB' },
    { id: 'video', title: 'Make short videos', line: 'Turn a sentence into a few seconds of video. Slow, but fun.', can: canVideo, extra: '~10 GB' },
  ];
  return (
    <section class="card wiz-card">
      <div class="eyebrow mono">step 4 · extras</div>
      <h2>Want any extras?</h2>
      <p class="muted">All optional. You can turn these on later in Settings.</p>
      <div class="extras">
        {items.map((it) => (
          <div class={`extra ${!it.can ? 'dis' : ''}`} key={it.id}>
            <div>
              <div class="x-title">{it.title} <span class="muted small mono">{it.can ? it.extra : 'not available on this computer'}</span></div>
              <div class="x-line">{it.line}</div>
            </div>
            <Toggle label={it.title} on={features[it.id] && it.can} disabled={!it.can} onChange={(v) => setFeatures({ ...features, [it.id]: v })} />
          </div>
        ))}
      </div>
      <div class="wiz-actions">
        <button class="btn ghost" onClick={onBack}>Back</button>
        <button class="btn primary" onClick={onNext}>Install</button>
      </div>
    </section>
  );
}

function Install({ body, recipe, onDone, onBack }: { body: unknown; recipe: Recipe | null; onDone: () => void; onBack: () => void }) {
  const [pct, setPct] = useState(0);
  const [label, setLabel] = useState('Getting ready…');
  const [bytes, setBytes] = useState<[number, number] | null>(null);
  const [err, setErr] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const started = useRef(false);

  const run = async () => {
    setErr('');
    const ac = new AbortController();
    try {
      const { job_id } = await api.setup(body);
      let finished = false;
      await jobEvents(job_id, (e) => {
        if (e.event === 'progress') {
          const d = e.data;
          if (typeof d.pct === 'number') setPct(Math.max(0, Math.min(100, d.pct)));
          if (d.label) {
            setLabel(d.label);
            setLog((l) => (l[l.length - 1] === d.label ? l : [...l.slice(-4), d.label]));
          }
          if (d.total) setBytes([d.bytes || 0, d.total]); else setBytes(null);
        } else if (e.event === 'done') {
          finished = true;
          if (e.data?.ok === false) setErr(e.data.message || 'Setup did not finish.');
          else { setPct(100); setTimeout(onDone, 700); }
        } else if (e.event === 'error') {
          finished = true;
          setErr(e.data?.message || 'Something went wrong.');
        }
      }, ac.signal);
      if (!finished) setErr('Lost connection to the installer. Try again.');
    } catch (e: any) {
      setErr(e?.message || 'Setup failed');
    }
  };

  useEffect(() => { if (!started.current) { started.current = true; run(); } }, []);

  return (
    <section class="install">
      <Skeleton mood={err ? 'think' : pct >= 100 ? 'happy' : 'work'} size="lg" />
      <h2 class="mono">{err ? 'hmm, that didn’t work' : pct >= 100 ? 'all done' : 'setting things up'}</h2>
      <p class="muted">{recipe ? <>Installing <span class="mono">{recipe.model}</span>. </> : null}{err ? '' : 'You can grab a coffee — this only happens once.'}</p>
      <div class="bigbar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div class="bigbar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div class="bar-meta mono">
        <span>{err ? '' : label}</span>
        <span>{bytes ? `${fmtBytes(bytes[0])} / ${fmtBytes(bytes[1])}` : ''} <b class="accent">{Math.round(pct)}%</b></span>
      </div>
      {log.length > 1 && !err && (
        <ul class="install-log mono">{log.slice(0, -1).map((l, i) => <li key={i}><Icon name="check" size={12} /> {l}</li>)}</ul>
      )}
      {err && (
        <div class="install-err">
          <p class="err">{err}</p>
          <div class="wiz-actions"><button class="btn ghost" onClick={onBack}>Back</button><button class="btn primary" onClick={run}>Try again</button></div>
        </div>
      )}
    </section>
  );
}

function Done({ onGo }: { onGo: () => void }) {
  return (
    <section class="install done">
      <Skeleton mood="happy" size="lg" />
      <h1 class="mono"><Typed text="you're set." speed={60} /></h1>
      <p class="muted">Pico is running on your computer. Your chats stay here.</p>
      <button class="btn primary big" onClick={onGo}>Start chatting <span class="mono">→</span></button>
    </section>
  );
}
