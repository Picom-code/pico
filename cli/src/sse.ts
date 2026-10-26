// Minimal, spec-compliant-enough SSE parser. Feed it text chunks, get {event, data} out.
// Handles CRLF/CR/LF, multi-line data, comments, chunk boundaries anywhere.

export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}

export class SSEParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  constructor(private onEvent: (e: SSEEvent) => void) {}

  feed(chunk: string): void {
    this.buf += chunk;
    // Normalize line endings, but keep a trailing lone \r (could be first half of \r\n).
    let idx: number;
    for (;;) {
      const n = this.buf.indexOf('\n');
      const r = this.buf.indexOf('\r');
      if (n < 0 && r < 0) break;
      if (r >= 0 && (n < 0 || r < n)) {
        if (r === this.buf.length - 1) break; // wait for possible \n
        idx = r;
        const skip = this.buf[r + 1] === '\n' ? 2 : 1;
        this.line(this.buf.slice(0, idx));
        this.buf = this.buf.slice(idx + skip);
      } else {
        idx = n;
        this.line(this.buf.slice(0, idx));
        this.buf = this.buf.slice(idx + 1);
      }
    }
  }

  /** Flush a final event if the stream ended without a blank line. */
  end(): void {
    if (this.buf) {
      this.line(this.buf.replace(/\r$/, ''));
      this.buf = '';
    }
    this.dispatch();
  }

  private line(l: string): void {
    if (l === '') return this.dispatch();
    if (l.startsWith(':')) return;
    const c = l.indexOf(':');
    const field = c < 0 ? l : l.slice(0, c);
    let value = c < 0 ? '' : l.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
  }

  private dispatch(): void {
    if (!this.data.length && !this.event) return;
    const e: SSEEvent = { event: this.event || 'message', data: this.data.join('\n') };
    if (this.id !== undefined) e.id = this.id;
    this.event = '';
    this.data = [];
    this.onEvent(e);
  }
}

/** Parse SSE data as JSON when possible. */
export function parseData(data: string): any {
  try {
    return JSON.parse(data);
  } catch {
    return { text: data };
  }
}
