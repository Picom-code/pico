// Terminal session + inline "live region" renderer.
//
// Model: lines that are final are *committed* once into the terminal's normal scrollback (so native
// scrolling, selection and copy keep working). Everything still changing (streaming reply, overlays,
// input box, status bar) is the *live region*, redrawn in place each frame by moving the cursor up and
// clearing. Works on any VT terminal incl. Windows Terminal / modern conhost (VT is on by default in
// Windows 10+; we never use Unix-only APIs).
import { truncate } from './ansi';
import { isShimmer, spinGlyph } from './theme';
import { type Key, KeyParser } from './keys';

const CSI = '\x1b[';
export const SYNC_ON = '\x1b[?2026h';
export const SYNC_OFF = '\x1b[?2026l';

export class Terminal {
  private parser = new KeyParser();
  private keyHandlers: ((k: Key) => void)[] = [];
  private resizeHandlers: (() => void)[] = [];
  private started = false;
  private lastCols = 0;
  private lastRows = 0;
  private poll: ReturnType<typeof setInterval> | null = null;
  private onData = (d: Buffer | string) => {
    const s = typeof d === 'string' ? d : d.toString('utf8');
    for (const k of this.parser.feed(s)) for (const h of [...this.keyHandlers]) h(k); // snapshot: a handler added mid-dispatch (modal) must not see this key
  };
  private onResize = () => {
    const c = this.cols;
    const r = this.rows;
    if (c === this.lastCols && r === this.lastRows) return;
    this.lastCols = c;
    this.lastRows = r;
    for (const h of this.resizeHandlers) h();
  };

  get cols() {
    return Math.max(20, process.stdout.columns || 80);
  }
  get rows() {
    return Math.max(8, process.stdout.rows || 24);
  }

  start() {
    if (this.started) return;
    this.started = true;
    const stdin = process.stdin as any;
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
    stdin.setEncoding?.('utf8');
    stdin.on('data', this.onData);
    stdin.resume();
    // bracketed paste, kitty keyboard "disambiguate" (Shift+Enter, real Esc), xterm modifyOtherKeys=1
    this.write(`${CSI}?2004h${CSI}>1u${CSI}>4;1m`);
    this.lastCols = this.cols;
    this.lastRows = this.rows;
    process.stdout.on('resize', this.onResize);
    // Windows consoles do not always emit SIGWINCH-style resize events: poll cheaply.
    this.poll = setInterval(this.onResize, 300);
    const restore = () => this.stop();
    process.once('exit', restore);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    if (this.poll) clearInterval(this.poll);
    process.stdout.off('resize', this.onResize);
    this.write(`${CSI}?2004l${CSI}<u${CSI}>4m${CSI}?25h${CSI}0m`);
    const stdin = process.stdin as any;
    stdin.off('data', this.onData);
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false);
    stdin.pause();
  }

  onKey(h: (k: Key) => void) {
    this.keyHandlers.push(h);
    return () => (this.keyHandlers = this.keyHandlers.filter((x) => x !== h));
  }
  onResizeEvent(h: () => void) {
    this.resizeHandlers.push(h);
  }
  write(s: string) {
    process.stdout.write(s);
  }
}

export interface Frame {
  lines: string[];
  /** cursor position inside the live region (row index into lines, display column); undefined = hidden */
  cursor?: { row: number; col: number };
}

/**
 * Inline live region with line-level diffing: only rows whose content changed are rewritten, so a
 * ticking spinner costs a few bytes and nothing flickers. Commits (lines that become permanent
 * scrollback), width changes and height changes fall back to a redraw from the first changed row.
 */
export class LiveScreen {
  private cursorRow = 0; // row of the terminal cursor relative to top of the live region
  private pending: string[] = [];
  private prev: string[] = [];
  private prevCols = 0;
  private prevCursor = '';
  /** bytes written by the last render (tests / perf checks) */
  lastBytes = 0;
  constructor(public term: Terminal) {}

  /** true when the last line written to scrollback is blank (so callers can keep one-row gaps) */
  lastBlank = true;
  /** Queue lines to be written permanently above the live region on the next render. */
  commit(lines: string[]) {
    if (!lines.length) return;
    this.pending.push(...lines);
    this.lastBlank = lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, '').trim() === '';
  }

  /** Forget the live region (e.g. after clearing the screen). */
  reset() {
    this.cursorRow = 0;
    this.prev = [];
    this.prevCursor = '';
  }

  /** Clear the visible screen + scrollback and home the cursor (used for full reprints). */
  clearAll() {
    this.term.write(`${CSI}2J${CSI}3J${CSI}H`);
    this.pending = [];
    this.lastBlank = true;
    this.reset();
  }

  private move(from: number, to: number): string {
    if (to < from) return `${CSI}${from - to}A`;
    if (to > from) return `${CSI}${to - from}B`;
    return '';
  }

  render(frame: Frame) {
    const cols = this.term.cols;
    const rows = this.term.rows;
    // Live region must fit on screen, otherwise cursor-up can't reach its top. Keep the bottom.
    let lines = frame.lines.map((l) => truncate(l, cols));
    let cur = frame.cursor;
    if (lines.length > rows - 1) {
      const cut = lines.length - (rows - 1);
      lines = lines.slice(cut);
      if (cur) cur = cur.row - cut >= 0 ? { row: cur.row - cut, col: cur.col } : undefined;
    }
    const curKey = cur ? `${cur.row}:${cur.col}` : '';
    const full = this.pending.length > 0 || cols !== this.prevCols || this.prev.length === 0;
    let body = '';
    let at = this.cursorRow;
    if (full) {
      body += this.move(at, 0) + `\r${CSI}J`;
      for (const l of this.pending) body += truncate(l, cols) + `${CSI}0m\r\n`;
      this.pending = [];
      body += lines.map((l) => l + `${CSI}0m`).join('\r\n');
      at = Math.max(0, lines.length - 1);
    } else if (lines.length === this.prev.length) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === this.prev[i]) continue;
        body += this.move(at, i) + `\r${CSI}2K` + lines[i] + `${CSI}0m`;
        at = i;
      }
    } else {
      let first = 0;
      while (first < lines.length && first < this.prev.length && lines[first] === this.prev[first]) first++;
      // never move below the last existing row with CSI B (it would not scroll); rewrite from there
      first = Math.min(first, Math.max(0, this.prev.length - 1));
      body += this.move(at, first) + `\r${CSI}J` + lines.slice(first).map((l) => l + `${CSI}0m`).join('\r\n');
      at = Math.max(0, lines.length - 1);
    }
    if (!body && curKey === this.prevCursor) {
      this.lastBytes = 0;
      return;
    }
    let out = SYNC_ON + `${CSI}?25l` + body;
    if (cur) {
      out += this.move(at, cur.row) + `\r` + (cur.col > 0 ? `${CSI}${cur.col}C` : '') + `${CSI}?25h`;
      this.cursorRow = cur.row;
    } else this.cursorRow = at;
    out += SYNC_OFF;
    this.prev = lines;
    this.prevCols = cols;
    this.prevCursor = curKey;
    this.lastBytes = out.length;
    this.term.write(out);
  }

  /** Erase the live region and leave the cursor at its top (before exiting / handing off stdout). */
  clearLive() {
    let out = '';
    for (const l of this.pending) out += l + `${CSI}0m\r\n`;
    if (this.cursorRow > 0) out = `${CSI}${this.cursorRow}A` + `\r${CSI}J` + out;
    else out = `\r${CSI}J` + out;
    this.pending = [];
    this.reset();
    this.term.write(out + `${CSI}?25h`);
  }
}

/** Braille spinner (kept for reference); the live spinner comes from the /theme prefs. */
export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Current spinner glyph. 'shimmer' has no glyph, so generic callers get braille. */
export const spinFrame = (now = Date.now()) => (isShimmer() ? spinGlyph(now, 'braille') : spinGlyph(now));
