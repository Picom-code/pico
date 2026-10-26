#!/usr/bin/env bun
// pico — terminal app for the Pico engine.
import { bold, C, fg, NO_COLOR, t } from './ansi';
import { Api, baseUrl, ensureEngine, picoHome, type Health, type Persona } from './api';
import { App } from './app';
import { type Effort, normalizeEffort } from './effort';
import { collectMentions } from './files';
import { renderSummary } from './status';
import { applyPrefs, loadPrefs, parseVerbosity, setVerbosity } from './theme';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarizeArgs } from './turn';
import { LiveScreen, Terminal } from './tty';
import { runSetupBox, runWizard } from './wizard';
import { uninstallCmd, updateCmd } from './selfupdate';
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;

/** `pico -h`: the cat, every flag, a few example lines. */
export function usage(): string {
  const a = (x: string) => fg(C.accent)(x);
  const row = (flag: string, what: string) => '  ' + a(flag.padEnd(26)) + t.dim(what);
  const ex = (cmd: string, what: string) => '  ' + fg(C.text)(cmd.padEnd(37)) + t.faint(what);
  return [
    a(' /\\_/\\ '),
    a('( o.o )  ') + bold('pico') + t.dim(` v${VERSION}`) + t.faint('  your own AI, on your own machine'),
    a(' > ^ < '),
    '',
    bold('usage') + t.dim('  pico [flags] · every launch opens a new chat unless you -c / -r'),
    '',
    bold('chat'),
    row('--yolo', 'new chat with /yolo on (runs commands without asking)'),
    row('--model <id>', 'switch model before the first turn'),
    row('--effort low|med|high', 'effort for this launch (default: /model → default effort)'),
    row('--verbose <level>', 'quiet | normal | verbose | full · or reasoning=preview tools=full'),
    row('--cwd <dir>', 'work in another directory'),
    row('--plan "task"', 'start by planning; enter go to run it'),
    row('--goal "text"', 'start with a goal pinned above the input'),
    row('--loop <every> "prompt"', 'start a loop: 5m, 1h, until-done'),
    row('-c, --continue', 'resume the last chat'),
    row('-r, --resume [id]', 'resume a chat (picker without an id)'),
    '',
    bold('scripts'),
    row('-p, --print "prompt"', 'print one answer to stdout and exit (- reads stdin)'),
    row('--json', 'with -p: one JSON event per line'),
    '',
    bold('setup'),
    row('--setup', 'choose a model: ChatGPT login, any API, or local'),
    row('--login', 'sign in with ChatGPT'),
    row('pico doctor', 'health, hardware and model status'),
    row('pico sessions', 'list chats'),
    row('pico update', 'check for a new pico, install it if you say yes'),
    row('pico uninstall', 'remove the app (keeps ~/.pico unless --purge)'),
    row('-v, --version', 'print version'),
    '',
    bold('examples'),
    ex('pico --yolo', 'fresh chat, no approval prompts'),
    ex('pico -c', 'pick up where you left off'),
    ex('pico --model gpt-5.5 --effort high', 'flags combine'),
    ex('pico --plan "add a --json flag"', 'plan first, then go'),
    ex('pico --loop 10m "check CI on main"', 'keep an eye on something'),
    ex('git diff | pico -p "review this"', 'one-shot from a pipe'),
    '',
    t.faint(`env  PICO_URL (${baseUrl()})  PICO_HOME (${picoHome()})  PICO_VERBOSE  NO_COLOR`),
  ].join('\n');
}

export interface Args {
  cmd?: string;
  prompt?: string;
  json: boolean;
  effort?: Effort;
  resume?: string;
  /** -r without an id: show the picker */
  resumePick?: boolean;
  cont: boolean;
  yolo?: boolean;
  model?: string;
  cwd?: string;
  plan?: string;
  goal?: string;
  loop?: string;
  harness?: 'lean' | 'hermes';
  verbose?: string;
  setup?: boolean;
  login?: boolean;
  persona?: Persona;
  yes: boolean;
  quiet: boolean;
  noStart: boolean;
  rest: string[];
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, cont: false, yes: false, quiet: false, noStart: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => {
      const eq = x.indexOf('=');
      if (x.startsWith('--') && eq > 0) return x.slice(eq + 1);
      return argv[++i];
    };
    const key = x.startsWith('--') && x.includes('=') ? x.slice(0, x.indexOf('=')) : x;
    switch (key) {
      case '-p':
      case '--print':
      case '--prompt':
        a.prompt = val() ?? '-';
        break;
      case '--json':
        a.json = true;
        break;
      case '-e':
      case '--effort': {
        const v = normalizeEffort(val());
        if (!v) die(`--effort must be low | med | high`);
        a.effort = v;
        break;
      }
      case '-r':
      case '--resume': {
        // optional id: `-r` alone (or followed by another flag) opens the picker
        const nx = x.includes('=') ? val() : argv[i + 1];
        if (nx && !nx.startsWith('-')) {
          a.resume = x.includes('=') ? nx : argv[++i];
        } else a.resumePick = true;
        break;
      }
      case '--yolo':
        a.yolo = true;
        break;
      case '-m':
      case '--model': {
        const v = val();
        if (!v) die('--model needs a model id (see /model)');
        a.model = v;
        break;
      }
      case '--cwd':
      case '-C': {
        const v = val();
        if (!v) die('--cwd needs a directory');
        a.cwd = v;
        break;
      }
      case '--plan': {
        const v = val();
        if (!v) die('--plan needs a task');
        a.plan = v;
        break;
      }
      case '--goal': {
        const v = val();
        if (!v) die('--goal needs text');
        a.goal = v;
        break;
      }
      case '--loop': {
        const every = val();
        if (!every) die('--loop needs an interval and a prompt, e.g. --loop 10m "check CI"');
        const prompt = every === 'stop' ? '' : argv[++i];
        if (every !== 'stop' && !prompt) die('--loop needs a prompt after the interval');
        a.loop = `${every} ${prompt ?? ''}`.trim();
        break;
      }
      case '--harness': {
        const v = val();
        if (v !== 'lean' && v !== 'hermes') die('--harness must be lean | hermes');
        a.harness = v;
        break;
      }
      case '--verbose': {
        const v = val();
        if (!v || !parseVerbosity(v)) die('--verbose must be quiet | normal | verbose | full (or reasoning=… tools=… summary=on|off)');
        a.verbose = v;
        break;
      }
      case '--setup':
        a.setup = true;
        break;
      case '--login':
        a.login = true;
        break;
      case '-c':
      case '--continue':
        a.cont = true;
        break;
      case '--persona':
        a.persona = val() as Persona;
        break;
      case '-y':
      case '--yes':
        a.yes = true;
        break;
      case '-q':
      case '--quiet':
        a.quiet = true;
        break;
      case '--no-start':
        a.noStart = true;
        break;
      case '-v':
      case '--version':
        a.cmd = 'version';
        break;
      case '-h':
      case '--help':
        a.cmd = 'help';
        break;
      default:
        if (!a.cmd && !x.startsWith('-')) a.cmd = x;
        else a.rest.push(x);
    }
  }
  return a;
}

function die(msg: string, code = 1): never {
  process.stderr.write(t.err('pico: ') + msg + '\n');
  process.exit(code);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function connect(args: Args, quietStatus = false): Promise<{ api: Api; health: Health }> {
  const api = new Api();
  try {
    const health = await ensureEngine(api, {
      start: !args.noStart,
      onStatus: (s) => !quietStatus && process.stderr.write(t.dim(s + '\n')),
    });
    return { api, health };
  } catch (e: any) {
    die(e.message, 2);
  }
}

// ---------------------------------------------------------------- pico -p
async function printMode(args: Args): Promise<number> {
  let prompt = args.prompt!;
  if (prompt === '-' || (!prompt && !process.stdin.isTTY)) prompt = await readStdin();
  if (!process.stdin.isTTY && prompt !== args.prompt) {
    /* already read */
  } else if (!process.stdin.isTTY && args.rest.length === 0) {
    // allow `cat file | pico -p "summarize"`: append piped input as context
    const piped = await Promise.race([readStdin(), new Promise<string>((r) => setTimeout(() => r(''), 50))]);
    if (piped.trim()) prompt = `${prompt}\n\n${piped}`;
  }
  if (!prompt.trim()) die('empty prompt');
  const { api, health } = await connect(args, args.json);
  if (health.state === 'setup') die('pico is not set up yet — run `pico` once to pick a model', 3);
  let sid = args.resume;
  if (!sid && args.cont) sid = (await api.sessions())[0]?.id;
  if (args.model) {
    try {
      await api.setModel(args.model);
    } catch (e: any) {
      die(`--model ${args.model}: ${e?.message || e}`);
    }
  }
  if (!sid) sid = (await api.newSession(process.cwd())).id;
  const { attachments, skipped } = collectMentions(prompt, process.cwd());
  for (const s of skipped) process.stderr.write(t.warn(`skipped ${s}\n`));
  const out = process.stdout;
  const err = process.stderr;
  const showTools = !args.json && !!process.stderr.isTTY;
  let failed = '';
  let lastChar = '\n';
  let text = '';
  let summaryLine = '';
  const emit = (event: string, data: any) => out.write(JSON.stringify({ event, ...data }) + '\n');
  const ctl = new AbortController();
  let stopping = false;
  process.on('SIGINT', async () => {
    if (stopping) process.exit(130);
    stopping = true;
    try {
      await api.stop(sid!);
    } catch {}
    ctl.abort();
  });
  try {
    await api.send(
      sid,
      { text: prompt, ...(args.effort ? { effort: args.effort } : {}), ...(args.harness ? { harness: args.harness } : {}), ...(attachments.length ? { attachments } : {}) } as any,
      {
        delta: (d) => {
          if (args.json) return emit('delta', d);
          if (!d.text) return;
          text += d.text;
          out.write(d.text);
          lastChar = d.text[d.text.length - 1];
        },
        reasoning: (d) => args.json && emit('reasoning', d),
        tool_start: (d) => {
          if (args.json) return emit('tool_start', d);
          if (showTools) err.write(t.accent('· ') + t.dim(`${d.name} ${summarizeArgs(d.args).slice(0, 80)}\n`));
        },
        tool_end: (d) => {
          if (args.json) return emit('tool_end', d);
          if (showTools) err.write((d.ok === false ? t.err('  ✗ ') : t.ok('  ✓ ')) + t.dim(d.name) + '\n');
        },
        todo: (d) => args.json && emit('todo', d),
        // newer events (tool_progress, notice, compacted, subagent_*): pass through in --json
        '*': (d) => {
          if (!args.json) return;
          const { __event, ...rest } = d;
          emit(__event, rest);
        },
        notice: (d) => {
          if (args.json) return emit('notice', d);
          if (showTools) err.write(t.accentDim(`+ ${d.kind === 'skill' ? 'new skill' : 'remembered'}: `) + t.dim(String(d.text)) + '\n');
        },
        approval: async (d) => {
          if (args.json) emit('approval', d);
          // Non-interactive: never auto-approve. Deny and tell the user.
          err.write(t.warn(`! denied (non-interactive): ${d.command}\n`));
          try {
            await api.approve(sid!, String(d.id), false);
          } catch {}
        },
        done: (d) => {
          if (args.json) return emit('done', { ...d, session_id: sid });
          if (showTools && d?.summary) summaryLine = renderSummary(d.summary);
        },
        error: (d) => {
          failed = d.message || 'error';
          if (args.json) emit('error', d);
        },
      },
      ctl.signal,
    );
  } catch (e: any) {
    if (stopping) {
      if (!args.json && lastChar !== '\n') out.write('\n');
      return 130;
    }
    failed = e.message || String(e);
  }
  if (!args.json && text && lastChar !== '\n') out.write('\n');
  if (summaryLine && !failed) err.write(summaryLine + '\n');
  if (failed) {
    if (!args.json) err.write(t.err('pico: ') + failed + '\n');
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------- subcommands
async function sessionsCmd(args: Args) {
  const { api } = await connect(args, true);
  const list = await api.sessions();
  if (args.json) return console.log(JSON.stringify(list, null, 2));
  if (!list.length) return console.log(t.dim('no sessions yet'));
  const { relTime } = await import('./app');
  for (const s of list) console.log(`${t.faint(s.id.padEnd(14))} ${(s.pinned ? t.accent('★ ') : '  ') + (s.title || '(untitled)').slice(0, 48).padEnd(50)} ${t.dim(relTime(s.updated))}`);
}

async function doctor(args: Args): Promise<number> {
  const api = new Api();
  const report: any = { url: api.base, home: picoHome(), token: !!api.token };
  const line = (ok: boolean | null, k: string, v: string) =>
    console.log(`${ok === null ? t.warn('!') : ok ? t.ok('✓') : t.err('✗')} ${t.muted(k.padEnd(10))} ${v}`);
  let code = 0;
  try {
    report.health = await api.health();
  } catch (e: any) {
    report.health_error = e.message;
  }
  if (report.health) {
    try {
      report.system = await api.system();
    } catch (e: any) {
      report.system_error = e.message;
    }
    try {
      report.models = await api.models();
    } catch (e: any) {
      report.models_error = e.message;
    }
    try {
      report.updates = await api.updates();
    } catch {}
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.health?.ok ? 0 : 1;
  }
  console.log(fg(C.accent)(' /\\_/\\\n( o.o )  ') + bold('pico doctor') + t.dim(` v${VERSION}`) + fg(C.accent)('\n > ^ <\n'));
  line(!!report.token, 'token', report.token ? `${picoHome()}/token` : `missing (${picoHome()}/token) — engine creates it on first start`);
  if (!report.health) {
    line(false, 'engine', `${api.base} unreachable (${report.health_error})`);
    console.log(t.dim('  start it with `pico` (auto-starts pico-engine) or set PICO_ENGINE_CMD'));
    return 2;
  }
  const h: Health = report.health;
  line(h.ok && h.state !== 'error', 'engine', `${api.base} · v${h.version} · ${h.state}`);
  if (h.state === 'setup') line(null, 'setup', 'not set up yet — run `pico`');
  if (report.system) {
    const s = report.system;
    line(true, 'system', `${s.os} ${s.arch} · ${s.cpu?.name} (${s.cpu?.cores} cores) · ${s.ram_gb} GB${s.unified_memory ? ' unified' : ''}`);
    for (const g of s.gpus || []) line(true, 'gpu', `${g.name} · ${g.vram_gb} GB${g.driver ? ' · driver ' + g.driver : ''}`);
    line(true, 'accel', (s.accelerators || []).join(', ') + t.dim(` · disk ${s.disk_free_gb} GB free`));
  } else {
    line(false, 'system', report.system_error);
    code = 1;
  }
  if (report.models) {
    const act = report.models.models.find((m: any) => m.id === report.models.active);
    line(!!act, 'model', act ? `${act.name || act.id} · ${act.local ? 'local' : act.provider}${act.ctx ? ` · ${Math.round(act.ctx / 1024)}k ctx` : ''}${act.tps ? ` · ${Math.round(act.tps)} tok/s` : ''}` : 'no active model');
  } else if (report.models_error) {
    line(false, 'model', report.models_error);
    code = 1;
  }
  const n = report.updates?.available?.length || 0;
  if (n) line(null, 'updates', `${n} available — run /update in pico`);
  return h.state === 'error' ? 1 : code;
}

// ---------------------------------------------------------------- interactive
async function interactive(args: Args, forceSetup = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) die('interactive mode needs a terminal — use `pico -p "…"` for scripts');
  const term0 = new Terminal();
  const screen0 = new LiveScreen(term0);
  let { api, health } = await connect(args);
  if ((args.setup || args.login) && health.state !== 'setup' && !forceSetup) {
    term0.start();
    let res: string | null = null;
    try {
      res = await runSetupBox(api, term0, screen0, args.login ? 'openai_login' : undefined);
    } catch (e: any) {
      screen0.clearLive();
      term0.stop();
      if (e?.message === 'cancelled') process.exit(130);
      die(e?.message || String(e));
    }
    screen0.clearLive();
    term0.stop();
    if (res) process.stdout.write(t.ok('✓ ') + t.muted(res) + '\n');
    try {
      health = await api.health();
    } catch {}
  } else if (health.state === 'setup' || forceSetup) {
    term0.start();
    let ok = false;
    try {
      ok = await runWizard(api, term0, screen0, { quiet: args.quiet, persona: args.persona, yes: args.yes, choice: args.login ? 'openai_login' : undefined });
    } catch (e: any) {
      screen0.clearLive();
      term0.stop();
      if (e?.message === 'cancelled') process.exit(130);
      die(e?.message || String(e));
    }
    screen0.clearLive();
    term0.stop();
    if (!ok) process.exit(1);
    try {
      health = await api.health();
    } catch {}
  }
  let resume = args.resume;
  if (!resume && args.cont) {
    try {
      resume = (await api.sessions())[0]?.id;
    } catch {}
  }
  const app = new App(api, {
    version: VERSION,
    effort: args.effort,
    resume,
    resumePick: args.resumePick && !resume,
    yolo: args.yolo,
    model: args.model,
    harness: args.harness,
    plan: args.plan,
    goal: args.goal,
    loop: args.loop,
  });
  await app.run(health);
  process.exit(0);
}

export async function main(argv = process.argv.slice(2)) {
  applyPrefs(loadPrefs());
  const args = parseArgs(argv);
  if (args.verbose) setVerbosity(parseVerbosity(args.verbose)!);
  if (args.cwd) {
    const d = resolve(args.cwd.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
    if (!existsSync(d) || !statSync(d).isDirectory()) die(`--cwd: not a directory: ${args.cwd}`);
    process.chdir(d);
  }
  if (process.platform === 'win32' && !NO_COLOR) {
    // Enable UTF-8 output on legacy code pages; VT processing is on by default in Windows Terminal.
    try {
      process.stdout.setDefaultEncoding?.('utf8');
    } catch {}
  }
  if (args.cmd === 'version') return console.log(`pico ${VERSION}`);
  if (args.cmd === 'help') return console.log(usage());
  if (args.prompt !== undefined) process.exit(await printMode(args));
  switch (args.cmd) {
    case undefined:
      return interactive(args);
    case 'sessions':
      return sessionsCmd(args);
    case 'doctor':
      process.exit(await doctor(args));
    case 'setup':
      return interactive(args, true);
    case 'chat':
      return interactive(args);
    case 'update':
      process.exit(await updateCmd({ yes: args.yes, check: args.rest.includes('--check'), json: args.json }));
    case 'uninstall':
      process.exit(await uninstallCmd({ yes: args.yes, purge: args.rest.includes('--purge') }));
    default:
      // `pico "some question"` => print mode
      args.prompt = [args.cmd, ...args.rest].join(' ');
      process.exit(await printMode(args));
  }
}

if (import.meta.main) {
  main().catch((e) => die(e?.stack || String(e)));
}
