// First-run setup wizard (engine state == 'setup'): boot animation, hardware scan panel, persona,
// model recommendation, provider, features, POST /api/setup, then job progress over SSE.
import { bold, C, fg, fmtBytes, t, width } from './ansi';
import type { Api, Persona, Recipe, Recipes, SystemInfo } from './api';
import { bar, box, confirm, select, skullFrame, textPrompt, toggles, type Item } from './ui';
import { LiveScreen, spinFrame, Terminal } from './tty';
import { apiSetupFlow, chooseSetup, loginFlow, type SetupChoice } from './setup';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PERSONAS: Item<Persona>[] = [
  { label: 'engineer', value: 'engineer', hint: 'code, terminals, repos' },
  { label: 'business', value: 'business', hint: 'email, docs, planning' },
  { label: 'creative', value: 'creative', hint: 'writing, ideas, images' },
  { label: 'marketing', value: 'marketing', hint: 'copy, campaigns, research' },
  { label: 'student', value: 'student', hint: 'learning, notes, explain it' },
  { label: 'general', value: 'general', hint: 'a bit of everything' },
];

export function systemPanel(s: SystemInfo, w: number): string[] {
  const k = (x: string) => t.dim(x.padEnd(8));
  const gpus = s.gpus?.length
    ? s.gpus.map((g) => `${g.name}${g.vram_gb ? t.dim(` · ${g.vram_gb} GB`) : ''}${g.compute ? t.dim(` · ${g.compute}`) : ''}`)
    : [t.dim('none detected')];
  const rt = Object.entries(s.runtimes || {})
    .filter(([, v]) => v)
    .map(([n]) => n);
  const body = [
    k('os') + `${s.os} ${t.dim(s.arch)}`,
    k('cpu') + `${s.cpu?.name ?? '?'} ${t.dim(`· ${s.cpu?.cores ?? '?'} cores`)}`,
    k('memory') + `${s.ram_gb} GB${s.unified_memory ? t.dim(' unified') : ''}`,
    ...gpus.map((g, i) => k(i ? '' : 'gpu') + g),
    k('accel') + (s.accelerators || []).map((a) => t.accent(a)).join(t.dim(' · ')),
    k('disk') + `${s.disk_free_gb} GB free`,
  ];
  if (rt.length) body.push(k('found') + rt.join(t.dim(' · ')));
  return box('hardware', body, Math.min(w, 64));
}

export function recipeItem(r: Recipe, rec = false): Item<Recipe> {
  const size = `${r.params_b}B${r.active_b ? `/${r.active_b}B` : ''} ${r.quant}`;
  return {
    label: (rec ? '★ ' : '  ') + r.model,
    value: r,
    hint: `${size} · ${r.file_gb} GB · ~${r.est_tps} tok/s${r.tps_source === 'est' ? '*' : ''} · ${Math.round(r.ctx / 1024)}k ctx${r.fits ? '' : ' · ⚠ tight fit'}`,
    detail: [r.why, r.strengths?.length ? 'good at: ' + r.strengths.join(', ') : ''].filter(Boolean),
  };
}

export interface WizardOpts {
  quiet?: boolean;
  persona?: Persona;
  yes?: boolean; // accept recommendation without asking
  /** skip the 3-choice box (pico --login -> 'openai_login') */
  choice?: SetupChoice;
}

export async function runWizard(api: Api, term: Terminal, screen: LiveScreen, opts: WizardOpts = {}): Promise<boolean> {
  const cols = term.cols;
  const title = [bold(fg(C.text)('pico')) + t.dim('  first-time setup')];

  // 1. boot animation, scanning hardware in parallel
  const sysP = api.system().catch((e) => e as Error);
  if (!opts.quiet) {
    const msgs = ['waking up', 'stretching bones', 'scanning your hardware', 'counting gigabytes'];
    for (let i = 0; i < 10; i++) {
      const sk = skullFrame(Math.min(5, i));
      const pad = ' '.repeat(Math.min(i, 6) * 2);
      screen.render({ lines: [...title, '', ...sk.map((l) => pad + t.accent(l)), '', t.muted(`${spinFrame()} ${msgs[Math.floor(i / 3) % msgs.length]}…`)] });
      await sleep(110);
    }
  }
  const sys = await sysP;
  const hw = sys instanceof Error ? [t.err(`hardware scan failed: ${sys.message}`)] : systemPanel(sys, cols);
  const skel = skullFrame(4).map((l) => t.accent(l));
  const head = () => [...title, '', ...sideBySide(skel, hw), ''];
  screen.commit(head());
  screen.render({ lines: [] });
  const H = () => [] as string[];

  // 2. persona
  const persona = opts.persona ?? (await select(term, screen, 'What will you mostly use Pico for?', PERSONAS, { header: H }));
  screen.commit([t.ok('✓ ') + t.muted('persona ') + persona]);

  // 3. provider: one small box, 3 choices. ChatGPT + Any API finish (and save) in their own flows.
  const prov: SetupChoice | null = opts.yes ? 'local' : opts.choice ?? (await chooseSetup(term, screen, H));
  if (!prov) {
    screen.commit([t.dim('setup cancelled — run `pico --setup` any time')]);
    screen.render({ lines: [] });
    return false;
  }
  if (prov === 'openai_login' || prov === 'custom') {
    const res = prov === 'custom' ? await apiSetupFlow(api, term, screen) : await loginFlow(api, term, screen);
    if (!res) {
      screen.commit([t.dim('setup cancelled — run `pico --setup` any time')]);
      screen.render({ lines: [] });
      return false;
    }
    try {
      await api.patchConfig({ persona } as any);
    } catch {}
    screen.commit([t.ok('✓ ') + t.muted(prov === 'custom' ? 'model ' : 'ChatGPT · ') + res, '', ...skullFrame(4).map((l) => t.accent(l)), bold('  ready.') + t.dim(' say hi.'), '']);
    screen.render({ lines: [] });
    return true;
  }

  let provider: any;
  if (prov === 'local') {
    screen.commit([t.ok('✓ ') + t.muted('provider ') + 'this machine']);
    let recipes: Recipes;
    const stopSpin = spinner(screen, 'picking models for this machine');
    try {
      recipes = await api.recipes(persona);
    } finally {
      stopSpin();
    }
    const items = [recipeItem(recipes.recommended, true), ...recipes.alternatives.map((r) => recipeItem(r))];
    const chosen = opts.yes
      ? recipes.recommended
      : await select(term, screen, 'Pick a model', items, { footer: `↑↓ move · enter select · * estimated · catalog ${recipes.catalog_version}` });
    screen.commit([t.ok('✓ ') + t.muted('model ') + chosen.model + t.dim(`  ${chosen.file_gb} GB · ~${chosen.est_tps} tok/s`)]);
    provider = { kind: 'local', recipe_id: chosen.id };
  } else if (prov === 'openai_login') {
    provider = { kind: 'openai_login' };
    try {
      const st = await api.post<{ url: string; code: string }>('/api/auth/openai/start');
      screen.commit([t.ok('✓ ') + t.muted('provider ') + 'ChatGPT', '  open ' + fg(C.accent)(st.url) + '  and enter code ' + bold(st.code)]);
      await waitLogin(api, screen);
    } catch (e: any) {
      screen.commit([t.warn('! ') + `login start failed: ${e.message} — continuing; you can /connect later`]);
    }
  } else {
    const base_url = await textPrompt(term, screen, 'Base URL', { initial: 'https://' });
    const api_key = await textPrompt(term, screen, 'API key', { secret: true });
    const model = await textPrompt(term, screen, 'Model name');
    provider = { kind: 'custom', base_url, api_key, model };
    screen.commit([t.ok('✓ ') + t.muted('provider ') + base_url + t.dim(` · ${model}`)]);
  }

  // 4. features
  const features = opts.yes
    ? { voice: false, image: false, video: false }
    : await toggles(term, screen, 'Extras (you can change these later)', [
        { key: 'voice', label: 'voice', on: false, hint: 'talk & listen' },
        { key: 'image', label: 'images', on: false, hint: 'generate pictures' },
        { key: 'video', label: 'video', on: false, hint: 'heavy · big download' },
      ]);
  const on = Object.entries(features).filter(([, v]) => v).map(([k]) => k);
  screen.commit([t.ok('✓ ') + t.muted('extras ') + (on.length ? on.join(', ') : t.dim('none'))]);

  if (!opts.yes && !(await confirm(term, screen, 'Install now?'))) {
    screen.commit([t.dim('setup skipped — run `pico` again any time')]);
    screen.render({ lines: [] });
    return false;
  }

  // 5. setup + job progress
  const { job_id } = await api.post<{ job_id: string }>('/api/setup', { persona, provider, features });
  return await jobProgress(api, screen, job_id, opts.quiet);
}

export async function jobProgress(api: Api, screen: LiveScreen, jobId: string, quiet = false): Promise<boolean> {
  let label = 'starting';
  let pct = 0;
  let bytes = 0;
  let total = 0;
  let step = '';
  let ok = false;
  let err = '';
  const started = Date.now();
  const draw = () => {
    const w = Math.min(40, screen.term.cols - 30);
    const rate = bytes && (Date.now() - started) / 1000 > 0.5 ? fmtBytes(bytes / ((Date.now() - started) / 1000)) + '/s' : '';
    screen.render({
      lines: [
        t.accent(spinFrame()) + ' ' + bold(label) + (step ? t.dim(`  ${step}`) : ''),
        '  ' + bar(pct / 100, w) + ' ' + t.muted(`${Math.round(pct)}%`.padStart(4)) + (total ? t.dim(`  ${fmtBytes(bytes)} / ${fmtBytes(total)}`) : '') + (rate ? t.dim(`  ${rate}`) : ''),
      ],
    });
  };
  const timer = quiet ? null : setInterval(draw, 100);
  let lastStep = '';
  try {
    await api.stream('GET', `/api/jobs/${encodeURIComponent(jobId)}/events`, undefined, {
      progress: (d) => {
        if (lastStep && d.step !== lastStep) screen.commit([t.ok('✓ ') + t.muted(label)]);
        lastStep = d.step;
        step = d.step ?? '';
        label = d.label ?? label;
        pct = typeof d.pct === 'number' ? d.pct : pct;
        bytes = d.bytes ?? 0;
        total = d.total ?? 0;
        if (quiet) process.stderr.write(`${label} ${Math.round(pct)}%\n`);
      },
      done: (d) => {
        ok = d.ok !== false;
      },
      error: (d) => {
        err = d.message || 'setup failed';
      },
    });
  } finally {
    if (timer) clearInterval(timer);
  }
  if (lastStep && ok) screen.commit([t.ok('✓ ') + t.muted(label)]);
  if (err || !ok) {
    screen.commit([t.err('✗ ') + (err || 'setup did not finish')]);
    screen.render({ lines: [] });
    return false;
  }
  screen.commit(['', ...skullFrame(4).map((l) => t.accent(l)), bold('  ready.') + t.dim(' say hi.'), '']);
  screen.render({ lines: [] });
  return true;
}

async function waitLogin(api: Api, screen: LiveScreen) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    screen.render({ lines: [t.accent(spinFrame()) + t.muted(' waiting for login in your browser…')] });
    try {
      const s = await api.get<{ state: string }>('/api/auth/openai/status');
      if (s.state === 'ok' || s.state === 'done' || s.state === 'connected') return;
      if (s.state === 'error' || s.state === 'expired') throw new Error(s.state);
    } catch (e) {
      if ((e as Error).message === 'error' || (e as Error).message === 'expired') throw e;
    }
    await sleep(1500);
  }
}

function spinner(screen: LiveScreen, msg: string) {
  const id = setInterval(() => screen.render({ lines: [t.accent(spinFrame()) + ' ' + t.muted(msg + '…')] }), 80);
  return () => clearInterval(id);
}

export function sideBySide(a: string[], b: string[], gap = 3): string[] {
  const aw = Math.max(...a.map(width));
  const n = Math.max(a.length, b.length);
  const offA = Math.max(0, Math.floor((b.length - a.length) / 2));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const la = a[i - offA] ?? '';
    out.push(la + ' '.repeat(aw - width(la) + gap) + (b[i] ?? ''));
  }
  return out;
}

/**
 * /setup, `pico --setup`, `pico --login`: just the 3-choice box (no persona/extras unless the user
 * picks a local model, which needs the hardware wizard). Returns a one-line result or null.
 */
export async function runSetupBox(api: Api, term: Terminal, screen: LiveScreen, choice?: SetupChoice): Promise<string | null> {
  const pick = choice ?? (await chooseSetup(term, screen));
  if (!pick) return null;
  if (pick === 'custom') return apiSetupFlow(api, term, screen);
  if (pick === 'openai_login') {
    const m = await loginFlow(api, term, screen);
    return m ? `ChatGPT · ${m}` : null;
  }
  const ok = await runWizard(api, term, screen, { choice: 'local', quiet: true });
  return ok ? 'local model' : null;
}
