// Multiline text buffer with a cursor, soft-wrap layout and history. Pure logic, unit-tested.
import { cpWidth } from './ansi';

const chars = (s: string) => Array.from(s);

export class Editor {
  lines: string[][] = [[]];
  row = 0;
  col = 0;
  history: string[] = [];
  private hIdx = -1; // -1 = editing fresh input
  private draft = '';

  get value(): string {
    return this.lines.map((l) => l.join('')).join('\n');
  }
  set value(v: string) {
    this.lines = v.split('\n').map(chars);
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
  }
  get empty() {
    return this.lines.length === 1 && this.lines[0].length === 0;
  }
  clear() {
    this.value = '';
    this.hIdx = -1;
  }

  insert(text: string) {
    const parts = text.replace(/\r\n?/g, '\n').split('\n');
    const line = this.lines[this.row];
    const tail = line.slice(this.col);
    const first = chars(parts[0]);
    line.splice(this.col, line.length - this.col, ...first);
    this.col += first.length;
    if (parts.length > 1) {
      const newLines = parts.slice(1).map(chars);
      const lastLen = newLines[newLines.length - 1].length;
      newLines[newLines.length - 1].push(...tail);
      this.lines.splice(this.row + 1, 0, ...newLines);
      this.row += newLines.length;
      this.col = lastLen;
    } else {
      line.push(...tail);
    }
  }
  newline() {
    this.insert('\n');
  }
  backspace() {
    if (this.col > 0) {
      this.lines[this.row].splice(this.col - 1, 1);
      this.col--;
    } else if (this.row > 0) {
      const cur = this.lines.splice(this.row, 1)[0];
      this.row--;
      this.col = this.lines[this.row].length;
      this.lines[this.row].push(...cur);
    }
  }
  del() {
    const line = this.lines[this.row];
    if (this.col < line.length) line.splice(this.col, 1);
    else if (this.row < this.lines.length - 1) {
      line.push(...this.lines.splice(this.row + 1, 1)[0]);
    }
  }
  left() {
    if (this.col > 0) this.col--;
    else if (this.row > 0) {
      this.row--;
      this.col = this.lines[this.row].length;
    }
  }
  right() {
    if (this.col < this.lines[this.row].length) this.col++;
    else if (this.row < this.lines.length - 1) {
      this.row++;
      this.col = 0;
    }
  }
  /** Returns false when already on the first line (caller may use history). */
  up(): boolean {
    if (this.row === 0) return false;
    this.row--;
    this.col = Math.min(this.col, this.lines[this.row].length);
    return true;
  }
  down(): boolean {
    if (this.row >= this.lines.length - 1) return false;
    this.row++;
    this.col = Math.min(this.col, this.lines[this.row].length);
    return true;
  }
  home() {
    this.col = 0;
  }
  end() {
    this.col = this.lines[this.row].length;
  }
  killToStart() {
    this.lines[this.row].splice(0, this.col);
    this.col = 0;
  }
  killToEnd() {
    this.lines[this.row].splice(this.col);
  }
  private isWord(c: string | undefined) {
    return !!c && /[\p{L}\p{N}_]/u.test(c);
  }
  wordLeft() {
    const l = this.lines[this.row];
    if (this.col === 0) return this.left();
    let c = this.col;
    while (c > 0 && !this.isWord(l[c - 1])) c--;
    while (c > 0 && this.isWord(l[c - 1])) c--;
    this.col = c;
  }
  wordRight() {
    const l = this.lines[this.row];
    if (this.col >= l.length) return this.right();
    let c = this.col;
    while (c < l.length && !this.isWord(l[c])) c++;
    while (c < l.length && this.isWord(l[c])) c++;
    this.col = c;
  }
  deleteWord() {
    const end = this.col;
    this.wordLeft();
    if (this.row === this.row) this.lines[this.row].splice(this.col, Math.max(0, end - this.col));
  }

  /** The token (no whitespace) immediately before the cursor, e.g. "@src/ma". */
  tokenBeforeCursor(): string {
    const l = this.lines[this.row];
    let c = this.col;
    while (c > 0 && !/\s/.test(l[c - 1])) c--;
    return l.slice(c, this.col).join('');
  }
  replaceTokenBeforeCursor(text: string) {
    const tok = chars(this.tokenBeforeCursor());
    this.lines[this.row].splice(this.col - tok.length, tok.length);
    this.col -= tok.length;
    this.insert(text);
  }

  // ---- history ----
  pushHistory(v: string) {
    if (!v.trim()) return;
    if (this.history[this.history.length - 1] !== v) this.history.push(v);
    if (this.history.length > 500) this.history.shift();
    this.hIdx = -1;
  }
  historyPrev(): boolean {
    if (!this.history.length) return false;
    if (this.hIdx === -1) {
      this.draft = this.value;
      this.hIdx = this.history.length - 1;
    } else if (this.hIdx > 0) this.hIdx--;
    else return false;
    this.value = this.history[this.hIdx];
    this.row = 0;
    this.col = this.lines[0].length;
    return true;
  }
  historyNext(): boolean {
    if (this.hIdx === -1) return false;
    if (this.hIdx < this.history.length - 1) {
      this.hIdx++;
      this.value = this.history[this.hIdx];
    } else {
      this.hIdx = -1;
      this.value = this.draft;
    }
    return true;
  }

  /** Soft-wrap to `width` columns. Returns visual lines and the cursor's visual position. */
  layout(width: number): { lines: string[]; row: number; col: number } {
    const out: string[] = [];
    let cRow = 0;
    let cCol = 0;
    const w = Math.max(4, width);
    this.lines.forEach((line, r) => {
      let cur = '';
      let cw = 0;
      let startVisual = out.length;
      const segStarts: number[] = [0];
      line.forEach((ch, i) => {
        const chw = cpWidth(ch.codePointAt(0)!) || 1;
        if (cw + chw > w) {
          out.push(cur);
          cur = '';
          cw = 0;
          segStarts.push(i);
        }
        if (r === this.row && i === this.col) {
          cRow = out.length;
          cCol = cw;
        }
        cur += ch;
        cw += chw;
      });
      if (r === this.row && this.col >= line.length) {
        if (cw >= w) {
          out.push(cur);
          cur = '';
          cw = 0;
        }
        cRow = out.length;
        cCol = cw;
      }
      out.push(cur);
      void startVisual;
    });
    return { lines: out, row: cRow, col: cCol };
  }
}
