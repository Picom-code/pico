import { bold, C, fg, G, t, truncate, width } from './ansi';

export interface Command {
  name: string; // without slash
  desc: string;
  args?: string;
  local: boolean; // handled in the CLI (true) or sent to the engine as plain text (false)
  skill?: boolean;
  alias?: boolean; // hidden from the palette, still runnable
}

export const BUILTINS: Command[] = [
  { name: 'model', desc: 'switch model · default effort', args: '[id]', local: true },
  { name: 'setup', desc: 'set up a model: ChatGPT, any API, local', local: true },
  { name: 'login', desc: 'sign in with ChatGPT', local: true, alias: true },
  { name: 'new', desc: 'start a fresh session', local: true },
  { name: 'sessions', desc: 'list recent sessions', local: true },
  { name: 'resume', desc: 'reopen a past session', args: '[id]', local: true },
  { name: 'goal', desc: 'goal the agent works toward · bare: checklist', args: '[goal|clear]', local: false },
  { name: 'plan', desc: 'plan first, wait for go', args: '<task>', local: false },
  { name: 'plan!', desc: 'plan, then do it right away', args: '<task>', local: false, alias: true },
  { name: 'loop', desc: 'repeat a prompt on an interval', args: '<5m|until-done|stop> …', local: false },
  { name: 'cron', desc: 'scheduled jobs · bare: manage', args: '[add|rm|pause|resume|run]', local: false },
  { name: 'inbox', desc: 'results from scheduled jobs', local: true },
  { name: 'usage', desc: 'tokens, time & speed · last 30 days', local: false },
  { name: 'compact', desc: 'summarize context to free tokens', args: '[focus]', local: false },
  { name: 'lean', desc: 'slim your profile & show the speedup', local: false },
  { name: 'yolo', desc: 'run commands without asking (toggle)', args: '[on|off]', local: false },
  { name: 'undo', desc: 'undo the last turn (restores changed files)', local: true },
  { name: 'agents', desc: 'subagent settings', local: true },
  { name: 'subagents', desc: 'subagent settings', local: true, alias: true },
  { name: 'settings', desc: 'status · config · usage · look & feel', local: true },
  { name: 'status', desc: 'settings: engine, model, session, standing prompt', local: true, alias: true },
  { name: 'config', desc: 'settings: effort, approvals, compaction', local: true, alias: true },
  { name: 'theme', desc: 'look & feel: accent, spinner, reply style, verbosity', local: true },
  { name: 'verbose', desc: 'how much reasoning & tool detail shows', args: '[quiet|normal|verbose|full]', local: true },
  { name: 'memory', desc: 'what pico remembers about you', local: true },
  { name: 'skills', desc: 'list skills', local: true },
  { name: 'search', desc: 'search past chats', args: '<query>', local: true },
  { name: 'checkin', desc: 'scheduled background replies', local: true, alias: true },
  { name: 'connect', desc: 'apps & connectors', local: true },
  { name: 'update', desc: 'check for faster models/config', local: true },
  { name: 'effort', desc: 'set reasoning effort', args: 'low|med|high', local: true },
  { name: 'copy', desc: 'copy the last reply to the clipboard', local: true },
  { name: 'clear', desc: 'clear the screen', local: true },
  { name: 'redraw', desc: 'repaint the screen (after resize / garbled output)', local: true },
  { name: 'help', desc: 'keys & commands', local: true },
  { name: 'quit', desc: 'exit pico', local: true },
];

/** Keys reference: [key, what]. */
export const KEYS: [string, string][] = [
  ['enter', 'send · while working: steer the reply'],
  ['alt+enter', 'while working: stop + send as new  (or start with !)'],
  ['tab', 'complete commands, args, @paths · again to cycle'],
  ['shift+enter', 'newline  (also ctrl+j, \\+enter)'],
  ['shift+tab', 'cycle effort  low → med → high'],
  ['esc', 'stop the turn · close a menu'],
  ['ctrl+c', 'stop / clear · twice to quit'],
  ['ctrl+o', 'expand diffs, thinking, subagents · goal checklist'],
  ['ctrl+p', 'next model'],
  ['ctrl+l', 'redraw the screen'],
  ['↑ ↓', 'history'],
  ['@path', 'attach a file'],
  ['/', 'commands (fuzzy)'],
  ['enter / e', 'plan waiting: go · edit'],
  ['y n a', 'approve: allow · deny · always'],
];
/** Plain text form (kept for print mode / docs). */
export const HELP = ['keys', ...KEYS.map(([k, v]) => '  ' + k.padEnd(14) + v)];

/**
 * /help and ?: two aligned sections. Keys in accent, descriptions dim; commands in one column,
 * skills listed after (names truncated so the description column stays aligned).
 */
export function helpLines(cols: number, cmds: Command[]): string[] {
  const g = G();
  const out: string[] = ['  ' + bold(fg(C.text)('keys'))];
  const keyW = Math.max(...KEYS.map(([k]) => k.length)) + 2;
  for (const [k, v] of KEYS) out.push(truncate('  ' + t.accent(k.padEnd(keyW)) + t.dim(v), cols));
  if (!cmds.length) return out;
  const builtins = cmds.filter((c) => !c.skill);
  const skills = cmds.filter((c) => c.skill);
  const nameW = Math.min(26, Math.max(...cmds.map((c) => c.name.length + 1)) + 2);
  const row = (c: Command) => {
    const name = truncate('/' + c.name, nameW - 1);
    return truncate('  ' + t.accent(name) + ' '.repeat(Math.max(1, nameW - width(name))) + t.dim(c.desc), cols);
  };
  out.push('', '  ' + bold(fg(C.text)('commands')));
  for (const c of builtins) out.push(row(c));
  if (skills.length) {
    out.push('', '  ' + bold(fg(C.text)('skills')) + t.faint(` ${g.sep} ${skills.length}`));
    for (const c of skills) out.push(row(c));
  }
  return out;
}
