// Raw terminal input -> key events. Handles legacy xterm sequences, SS3, xterm modifyOtherKeys
// (CSI 27;mod;code ~), kitty CSI-u (disambiguate flag), bracketed paste (spanning chunks), and
// Windows Terminal / conhost quirks (\b for backspace, Alt+Enter = ESC CR, paste without brackets).

export interface Key {
  name: string; // 'a', 'enter', 'up', 'tab', 'backspace', 'escape', 'paste', ...
  ch?: string; // printable text for character keys
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  paste?: string;
  seq: string;
}

const mk = (name: string, seq: string, o: Partial<Key> = {}): Key => ({
  name,
  seq,
  ctrl: false,
  alt: false,
  shift: false,
  ...o,
});

const CSI_NAMES: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
};
const TILDE_NAMES: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
};

function mods(m: number) {
  const b = Math.max(0, (m || 1) - 1);
  return { shift: !!(b & 1), alt: !!(b & 2), ctrl: !!(b & 4) };
}

function fromCode(code: number, m: number, seq: string): Key {
  const md = mods(m);
  switch (code) {
    case 13:
      return mk('enter', seq, md);
    case 9:
      return mk('tab', seq, md);
    case 27:
      return mk('escape', seq, md);
    case 127:
    case 8:
      return mk('backspace', seq, md);
    case 32:
      return mk('space', seq, { ...md, ch: md.ctrl || md.alt ? undefined : ' ' });
  }
  const ch = String.fromCodePoint(code);
  const name = ch.toLowerCase();
  return mk(name, seq, { ...md, ch: md.ctrl || md.alt ? undefined : md.shift ? ch.toUpperCase() : ch });
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export class KeyParser {
  private pasting: string | null = null;

  feed(data: string): Key[] {
    const out: Key[] = [];
    let s = data;
    while (s.length) {
      if (this.pasting !== null) {
        const end = s.indexOf(PASTE_END);
        if (end < 0) {
          this.pasting += s;
          return out;
        }
        this.pasting += s.slice(0, end);
        out.push(mk('paste', '', { paste: normalizePaste(this.pasting) }));
        this.pasting = null;
        s = s.slice(end + PASTE_END.length);
        continue;
      }
      const ps = s.indexOf(PASTE_START);
      if (ps === 0) {
        this.pasting = '';
        s = s.slice(PASTE_START.length);
        continue;
      }
      const chunk = ps > 0 ? s.slice(0, ps) : s;
      s = ps > 0 ? s.slice(ps) : '';
      // Unbracketed paste heuristic (conhost / old terminals): a multi-char chunk with newlines and
      // no escape sequences is almost certainly a paste, not typed Enter presses.
      // A trailing Enter alone ("hello\r") is typing, so require a newline followed by more text.
      if (chunk.length > 2 && !chunk.includes('\x1b') && /[\r\n]+[^\r\n]/.test(chunk) && /[^\r\n]/.test(chunk)) {
        out.push(mk('paste', '', { paste: normalizePaste(chunk) }));
        continue;
      }
      out.push(...parseChunk(chunk));
    }
    return out;
  }
}

function normalizePaste(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

export function parseKeys(data: string): Key[] {
  return new KeyParser().feed(data);
}

function parseChunk(s: string): Key[] {
  const out: Key[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\x1b') {
      const n = s[i + 1];
      if (n === undefined) {
        out.push(mk('escape', c));
        i++;
        continue;
      }
      if (n === '[') {
        // CSI: params [0-9;:?] then final byte
        let j = i + 2;
        while (j < s.length && /[0-9;:?<>=]/.test(s[j])) j++;
        const fin = s[j];
        const seq = s.slice(i, j + 1);
        const params = s.slice(i + 2, j);
        i = j + 1;
        if (fin === undefined) {
          out.push(mk('escape', seq));
          continue;
        }
        const ps = params.split(';').map((p) => parseInt(p.split(':')[0], 10));
        if (fin === 'Z') {
          out.push(mk('tab', seq, { shift: true }));
        } else if (fin === 'u') {
          out.push(fromCode(ps[0], ps[1] || 1, seq));
        } else if (fin === '~') {
          if (ps[0] === 27 && ps.length >= 3) out.push(fromCode(ps[2], ps[1], seq));
          else {
            const name = TILDE_NAMES[String(ps[0])] || `unknown`;
            out.push(mk(name, seq, mods(ps[1] || 1)));
          }
        } else if (CSI_NAMES[fin]) {
          out.push(mk(CSI_NAMES[fin], seq, mods(ps.length > 1 ? ps[1] : 1)));
        } else {
          out.push(mk('unknown', seq));
        }
        continue;
      }
      if (n === 'O') {
        const fin = s[i + 2];
        const seq = s.slice(i, i + 3);
        i += 3;
        out.push(mk(CSI_NAMES[fin] || 'unknown', seq));
        continue;
      }
      // ESC + key = Alt+key. ESC followed by another C0 control (except Enter/Backspace) is a real Esc
      // press followed by that key (fast typists / scripted input), not Alt+Ctrl+x.
      const ncp = n.charCodeAt(0);
      if (n === '\x1b' || (ncp < 32 && n !== '\r' && n !== '\b' && n !== '\n' && n !== '\t')) {
        out.push(mk('escape', c));
        i++;
        continue;
      }
      const [inner] = parseChunk(n);
      i += 2;
      if (inner) {
        out.push({ ...inner, alt: true, ch: inner.name === 'enter' ? undefined : inner.ch, seq: c + n });
      }
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (ch === '\r') out.push(mk('enter', ch));
    else if (ch === '\n') out.push(mk('enter', ch, { ctrl: true })); // Ctrl+J -> newline
    else if (ch === '\t') out.push(mk('tab', ch));
    else if (ch === '\x7f' || ch === '\b') out.push(mk('backspace', ch));
    else if (ch === '\x00') out.push(mk('space', ch, { ctrl: true }));
    else if (cp < 27) out.push(mk(String.fromCharCode(cp + 96), ch, { ctrl: true }));
    else if (cp < 32) out.push(mk('unknown', ch));
    else if (ch === ' ') out.push(mk('space', ch, { ch: ' ' }));
    else out.push(mk(ch.length === 1 ? ch.toLowerCase() : ch, ch, { ch, shift: ch !== ch.toLowerCase() }));
  }
  return out;
}

/** Is this key a "newline" gesture (Shift+Enter, Alt+Enter, Ctrl+J)? */
export function isNewline(k: Key): boolean {
  return k.name === 'enter' && (k.shift || k.alt || k.ctrl);
}
