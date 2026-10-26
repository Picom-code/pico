// `pico update` / `pico uninstall` for installs made by installer/install.sh|ps1.
// The installer leaves $PICO_PREFIX/install.json and the launcher exports PICO_PREFIX. Nothing here runs on
// its own: update only shows what is new and asks; the user decides. (The engine's /api/updates is about
// models and config, not the app — separate thing.)
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bold, C, fg, t } from './ansi';

export interface InstallInfo {
  version: string;
  commit: string;
  source: 'git' | 'tarball' | 'local';
  repo: string;
  ref: string;
  src_path?: string;
  hermes_ref?: string;
  prefix: string;
  home: string;
  bin_dir: string;
  linked?: boolean;
  modify_path?: boolean;
  web?: boolean;
  no_web?: boolean;
  os?: string;
  arch?: string;
  installed_at?: string;
}

const WIN = process.platform === 'win32';
export const INSTALL_SH = 'https://raw.githubusercontent.com/Picom-code/pico/main/installer/install.sh';
export const INSTALL_PS1 = 'https://raw.githubusercontent.com/Picom-code/pico/main/installer/install.ps1';

export function defaultPrefix(): string {
  if (WIN) return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Pico');
  return join(homedir(), '.pico-app');
}

export function readInstall(prefix = process.env.PICO_PREFIX || defaultPrefix()): InstallInfo | null {
  try {
    return JSON.parse(readFileSync(join(prefix, 'install.json'), 'utf8'));
  } catch {
    return null;
  }
}

const short = (s: string) => (s || '').slice(0, 7);
const ok = (s: string) => console.log(t.ok('✓ ') + s);
const note = (s: string) => console.log(t.dim(s));

function git(args: string[], cwd?: string): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

function ghSlug(repo: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/.]+?)(\.git)?\/?$/.exec(repo);
  return m ? m[1] : null;
}

async function ghJson(path: string): Promise<any> {
  const r = await fetch(`https://api.github.com/${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pico-cli' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}

export interface Latest {
  commit: string;
  label: string;
  /** one line per change, newest first */
  log: string[];
  /** ref to install (a release tag when following releases) */
  ref: string;
}

/** What is newer than the installed commit, without touching the install. */
export async function checkLatest(info: InstallInfo): Promise<Latest> {
  if (info.source === 'local' && info.src_path) {
    const head = git(['rev-parse', 'HEAD'], info.src_path);
    if (!head.ok) throw new Error(`can't read ${info.src_path}`);
    const log = git(['log', '--format=%h %s', '-n', '8', `${info.commit}..HEAD`], info.src_path);
    return { commit: head.out, label: `local ${short(head.out)}`, log: log.ok && log.out ? log.out.split('\n') : [], ref: info.ref };
  }
  const followsRelease = /^v\d/.test(info.ref);
  const slug = ghSlug(info.repo);
  if (followsRelease && slug) {
    const rel = await ghJson(`repos/${slug}/releases/latest`);
    const tag = rel.tag_name as string;
    const c = await ghJson(`repos/${slug}/commits/${encodeURIComponent(tag)}`);
    const body = String(rel.body || '')
      .split('\n')
      .map((l) => l.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 8);
    return { commit: c.sha, label: tag, log: body, ref: tag };
  }
  if (slug) {
    const cmp = await ghJson(`repos/${slug}/compare/${info.commit}...${encodeURIComponent(info.ref)}`).catch(() => null);
    if (cmp) {
      const commits = (cmp.commits || []) as any[];
      const head = commits.length ? commits[commits.length - 1].sha : info.commit;
      const log = commits
        .slice(-8)
        .reverse()
        .map((c) => `${short(c.sha)} ${String(c.commit?.message || '').split('\n')[0]}`);
      return { commit: cmp.status === 'identical' || cmp.status === 'behind' ? info.commit : head, label: `${info.ref} ${short(head)}`, log, ref: info.ref };
    }
  }
  // any git host: ls-remote for the head commit (no changelog without a clone)
  const r = git(['ls-remote', info.repo, info.ref]);
  const sha = r.ok ? r.out.split(/\s+/)[0] : '';
  if (!sha) throw new Error(`can't reach ${info.repo}`);
  return { commit: sha, label: `${info.ref} ${short(sha)}`, log: [], ref: info.ref };
}

async function ask(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(q + t.dim(' [y/N] '));
  const ans: string = await new Promise((res) => {
    const onData = (d: Buffer) => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      res(d.toString('utf8').trim());
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
  return /^y(es)?$/i.test(ans);
}

function header(title: string) {
  console.log(fg(C.accent)(' /\\_/\\\n( o.o )  ') + bold(title) + fg(C.accent)('\n > ^ <\n'));
}

function notInstalled(cmd: string): number {
  console.error(t.err('pico: ') + `${cmd} works for installs made by the Pico installer (no install.json in ${process.env.PICO_PREFIX || defaultPrefix()}).`);
  console.error(t.dim(WIN ? `  install: irm ${INSTALL_PS1} | iex` : `  install: curl -fsSL ${INSTALL_SH} | sh`));
  return 1;
}

/** Run the installer for this prefix (the copy inside the install for local sources, else the published one). */
function runInstaller(info: InstallInfo, ref: string): number {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PICO_PREFIX: info.prefix,
    PICO_HOME: info.home,
    PICO_BIN_DIR: info.bin_dir,
    PICO_REPO: info.repo,
    PICO_REF: ref,
  };
  if (info.modify_path === false) env.PICO_NO_MODIFY_PATH = '1';
  if (info.no_web) env.PICO_NO_WEB = '1';
  if (info.source === 'local' && info.src_path) env.PICO_SRC = info.src_path;
  else delete env.PICO_SRC;
  if (info.hermes_ref && !process.env.PICO_HERMES_REF) delete env.PICO_HERMES_REF; // the new source's pin wins
  const fresh = info.source === 'local' && info.src_path ? info.src_path : null;
  if (WIN) {
    const local = fresh ? join(fresh, 'installer', 'install.ps1') : '';
    const cmd = local && existsSync(local) ? `& '${local.replace(/'/g, "''")}' -Yes` : `& ([scriptblock]::Create((irm '${INSTALL_PS1}'))) -Yes`;
    return spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { stdio: 'inherit', env }).status ?? 1;
  }
  const local = fresh ? join(fresh, 'installer', 'install.sh') : '';
  const sh = local && existsSync(local) ? `sh '${local.replace(/'/g, `'\\''`)}' --yes` : `curl -fsSL '${INSTALL_SH.replace(/main/, encodeURIComponent(ref))}' | sh -s -- --yes`;
  return spawnSync('sh', ['-c', sh], { stdio: 'inherit', env }).status ?? 1;
}

export async function updateCmd(opts: { yes: boolean; check: boolean; json: boolean }): Promise<number> {
  const info = readInstall();
  if (!info) return notInstalled('pico update');
  let latest: Latest;
  try {
    latest = await checkLatest(info);
  } catch (e: any) {
    console.error(t.err('pico: ') + `couldn't check for updates: ${e?.message || e}`);
    return 1;
  }
  const behind = latest.commit !== info.commit;
  if (opts.json) {
    console.log(JSON.stringify({ current: { version: info.version, commit: info.commit, ref: info.ref }, latest, update_available: behind }, null, 2));
    return 0;
  }
  header('pico update');
  console.log(`${t.muted('current'.padEnd(9))} ${info.version} · ${short(info.commit)} ${t.dim(`(${info.source === 'local' ? 'local ' + info.src_path : info.ref})`)}`);
  console.log(`${t.muted('latest'.padEnd(9))} ${latest.label}`);
  if (!behind) {
    console.log('');
    ok('up to date');
    return 0;
  }
  if (latest.log.length) {
    console.log('');
    for (const l of latest.log) console.log(t.accent('· ') + t.dim(l.slice(0, 96)));
  }
  console.log('');
  if (opts.check) {
    note('update available — run `pico update` to install it');
    return 0;
  }
  if (!opts.yes && !(await ask('install it?'))) {
    note(process.stdin.isTTY ? 'not updated' : 'not updated (no terminal to confirm — use `pico update --yes`)');
    return 0;
  }
  return runInstaller(info, latest.ref);
}

function stopEngine(prefix: string) {
  if (WIN) {
    const py = join(prefix, 'venv', 'Scripts', 'python.exe').replace(/'/g, "''");
    spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | ? { $_.ExecutablePath -eq '${py}' } | % { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' });
  } else spawnSync('pkill', ['-f', join(prefix, 'venv', 'bin', 'python')], { stdio: 'ignore' });
}

export async function uninstallCmd(opts: { yes: boolean; purge: boolean }): Promise<number> {
  const info = readInstall();
  if (!info) return notInstalled('pico uninstall');
  header('pico uninstall');
  const link = join(info.bin_dir, WIN ? 'pico.cmd' : 'pico');
  console.log(`${t.muted('remove'.padEnd(8))} ${info.prefix}`);
  console.log(`${t.muted(''.padEnd(8))} ${link}`);
  if (opts.purge) console.log(`${t.muted(''.padEnd(8))} ${info.home} ${t.err('(your chats, settings and keys)')}`);
  else console.log(`${t.muted('keep'.padEnd(8))} ${info.home} ${t.dim('(chats + settings · --purge removes it too)')}`);
  console.log('');
  if (!opts.yes && !(await ask('uninstall pico?'))) {
    note('nothing removed');
    return 0;
  }
  stopEngine(info.prefix);
  try {
    const st = lstatSync(link);
    const mine = st.isSymbolicLink() ? readlinkSync(link).startsWith(info.prefix) : WIN && readFileSync(link, 'utf8').includes(info.prefix);
    if (mine) unlinkSync(link);
  } catch {}
  if (WIN) {
    // a running exe can't delete its own folder: hand the delete to a detached shell that waits for us to exit
    const p = info.prefix.replace(/'/g, "''");
    const h = opts.purge ? info.home.replace(/'/g, "''") : '';
    const script = `Start-Sleep 2; Remove-Item -Recurse -Force '${p}' -ErrorAction SilentlyContinue${h ? `; Remove-Item -Recurse -Force '${h}' -ErrorAction SilentlyContinue` : ''}`;
    spawnSync('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',"${script.replace(/"/g, '`"')}"`], { stdio: 'ignore' });
    const bin = join(info.prefix, 'bin');
    const user = spawnSync('powershell', ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('Path','User')`], { encoding: 'utf8' }).stdout?.trim() || '';
    const kept = user.split(';').filter((x) => x && x.toLowerCase() !== bin.toLowerCase() && x.toLowerCase() !== info.bin_dir.toLowerCase());
    if (kept.length !== user.split(';').filter(Boolean).length)
      spawnSync('powershell', ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable('Path','${kept.join(';').replace(/'/g, "''")}','User')`], { stdio: 'ignore' });
  } else {
    rmSync(info.prefix, { recursive: true, force: true });
    if (opts.purge) rmSync(info.home, { recursive: true, force: true });
  }
  ok('pico removed' + (opts.purge ? ' · data purged' : t.dim(` · your data is still in ${info.home}`)));
  if (!WIN) note('a PATH line the installer added to your shell rc (marked "added by the pico installer") is harmless; delete it if you like');
  return 0;
}
