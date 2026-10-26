// Small, safe markdown → HTML renderer. Everything is HTML-escaped first; only
// whitelisted constructs produce tags. Links are restricted to http(s)/mailto.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function safeUrl(u: string): string | null {
  const t = u.trim();
  if (/^(https?:|mailto:)/i.test(t) || t.startsWith('/') || t.startsWith('#')) return t;
  return null;
}

/** Inline formatting on an already-raw string. Escapes, then applies inline rules. */
function inline(src: string): string {
  // Protect inline code spans first.
  const codes: string[] = [];
  let s = src.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
    const raw = url.replace(/&amp;/g, '&');
    const ok = safeUrl(raw);
    return ok ? `<a href="${esc(ok)}" target="_blank" rel="noopener noreferrer">${text}</a>` : m;
  });
  // bare URLs
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre: string, url: string) =>
    `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
  return s;
}

const splitRow = (line: string) => {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map((c) => c.trim());
};

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code (unterminated fence = still streaming; render what we have)
    const fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flushPara();
      const lang = fence[2] || '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) { buf.push(lines[i]); i++; }
      i++;
      out.push(
        `<div class="code"><div class="code-head"><span>${esc(lang || 'code')}</span><button class="copy" data-copy>copy</button></div>` +
        `<pre><code>${esc(buf.join('\n'))}</code></pre></div>`,
      );
      continue;
    }

    if (!line.trim()) { flushPara(); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); const n = Math.min(h[1].length + 1, 6); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }

    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }

    if (/^\s*>/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // table: header row + separator row
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flushPara();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      const al = (k: number) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');
      out.push(
        `<div class="table"><table><thead><tr>${head.map((c, k) => `<th${al(k)}>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${head.map((_, k) => `<td${al(k)}>${inline(r[k] ?? '')}</td>`).join('')}</tr>`).join('') +
        `</tbody></table></div>`,
      );
      continue;
    }

    // lists (one level of nesting by indent)
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[2]);
      const items: { text: string; sub: string[] }[] = [];
      const baseIndent = li[1].length;
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m && m[1].length <= baseIndent + 1) { items.push({ text: m[3], sub: [] }); i++; continue; }
        if (m && items.length) { items[items.length - 1].sub.push(lines[i].slice(baseIndent + 2)); i++; continue; }
        if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1].text += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => {
        const task = it.text.match(/^\[([ xX])\]\s+(.*)$/);
        const body = task ? `<span class="task ${task[1] !== ' ' ? 'done' : ''}">${task[1] !== ' ' ? '✓' : '○'}</span> ${inline(task[2])}` : inline(it.text);
        return `<li>${body}${it.sub.length ? renderMarkdown(it.sub.join('\n')) : ''}</li>`;
      }).join('')}</${tag}>`);
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join('');
}
