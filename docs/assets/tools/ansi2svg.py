#!/usr/bin/env python3
"""Render a recorded pico pty frame (cli/test/frames/*.json) to a terminal-window SVG.

Frames store the raw ANSI delta per step; we replay every step up to the target
through a pyte screen (same size the recorder used), then emit one <text> run per
same-style span. Requires `pip install pyte`.

  python ansi2svg.py cli/test/frames/picks/picks.json done-signoff out.svg --title "pico"
"""
import argparse, html, json

import pyte

BASE16 = {
    'black': '#1b1b1f', 'red': '#ff5f87', 'green': '#5fd787', 'brown': '#ffd75f', 'yellow': '#ffd75f',
    'blue': '#5fafff', 'magenta': '#ff2e99', 'cyan': '#5fd7d7', 'white': '#d0d0d0',
    'brightblack': '#6c6c6c', 'brightred': '#ff87af', 'brightgreen': '#87ffaf', 'brightyellow': '#ffff87',
    'brightblue': '#87afff', 'brightmagenta': '#ff5fd7', 'brightcyan': '#87ffff', 'brightwhite': '#ffffff',
}
FG = '#d7d7d7'
BG = '#0e0e11'


def xterm256(n: int) -> str:
    if n < 16:
        names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
        return BASE16[('bright' if n >= 8 else '') + names[n % 8]]
    if n < 232:
        n -= 16
        lv = [0, 95, 135, 175, 215, 255]
        return '#%02x%02x%02x' % (lv[n // 36], lv[(n // 6) % 6], lv[n % 6])
    g = 8 + (n - 232) * 10
    return '#%02x%02x%02x' % (g, g, g)


def color(c: str, default: str) -> str:
    if c in ('default', None):
        return default
    if c in BASE16:
        return BASE16[c]
    if len(c) == 6:
        try:
            int(c, 16)
            # pyte stores 256-colour codes as hex already
            return '#' + c
        except ValueError:
            pass
    return default


def render(frames, upto, cols, rows):
    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    for f in frames:
        stream.feed((f.get('raw') or '').encode())
        if f['name'] == upto:
            break
    return screen


def to_svg(screen, title, first=0, last=None, cw=8.4, lh=18, pad=18, font=13.6):
    rows = list(range(first, last if last is not None else screen.lines))
    cols = screen.columns
    W = int(cols * cw + pad * 2)
    top = 38
    H = int(len(rows) * lh + top + pad)
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="{font}">',
        '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16161b"/><stop offset="1" stop-color="#0c0c0f"/></linearGradient>'
        '<filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>',
        f'<rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="12" fill="url(#g)" stroke="#2a2a32"/>',
        '<circle cx="22" cy="19" r="6" fill="#ff5f57"/><circle cx="42" cy="19" r="6" fill="#febc2e"/><circle cx="62" cy="19" r="6" fill="#28c840"/>',
        f'<text x="{W/2}" y="23" fill="#6c6c78" text-anchor="middle" font-size="12">{html.escape(title)}</text>',
    ]
    for i, y in enumerate(rows):
        line = screen.buffer[y]
        base_y = top + pad / 2 + i * lh + lh * 0.75
        x = 0
        while x < cols:
            ch = line[x]
            fg = color(ch.fg, FG)
            bg = color(ch.bg, BG)
            if ch.reverse:
                fg, bg = bg, fg
            bold = ch.bold
            start = x
            text = ''
            while x < cols:
                c = line[x]
                f2, b2 = color(c.fg, FG), color(c.bg, BG)
                if c.reverse:
                    f2, b2 = b2, f2
                if (f2, b2, c.bold) != (fg, bg, bold):
                    break
                text += c.data or ' '
                x += 1
            px = pad + start * cw
            if bg != BG:
                out.append(f'<rect x="{px:.1f}" y="{base_y - lh*0.75:.1f}" width="{len(text)*cw:.1f}" height="{lh}" fill="{bg}"/>')
            if text.strip():
                attrs = f' fill="{fg}"'
                if bold:
                    attrs += ' font-weight="700"'
                if fg.lower() in ('#ff2e99', '#ff5fd7', '#ff5faf', '#ff0087', '#ff00af', '#d7005f', '#ff5f87', '#ff87af'):
                    attrs += ' filter="url(#glow)"'
                out.append(f'<text x="{px:.1f}" y="{base_y:.1f}" xml:space="preserve"{attrs} textLength="{len(text)*cw:.1f}" lengthAdjust="spacingAndGlyphs">{html.escape(text)}</text>')
    out.append('</svg>')
    return '\n'.join(out)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('frames')
    ap.add_argument('name')
    ap.add_argument('out')
    ap.add_argument('--title', default='pico')
    ap.add_argument('--cols', type=int, default=120)
    ap.add_argument('--rows', type=int, default=34)
    ap.add_argument('--first', type=int, default=0)
    ap.add_argument('--last', type=int)
    ap.add_argument('--sub', action='append', default=[], help='OLD=NEW text swap (padded to same width)')
    ap.add_argument('--row', action='append', default=[])
    ap.add_argument('--drop', action='append', default=[])
    a = ap.parse_args()
    fr = json.load(open(a.frames))
    sc = render(fr, a.name, a.cols, a.rows)
    def row_text(y):
        return ''.join(sc.buffer[y][x].data for x in range(sc.columns))
    # --sub OLD=NEW: splice NEW in place of OLD (rest of the row shifts); new cells take OLD's style
    for pair in a.sub:
        old, new = pair.split('=', 1)
        for y in range(sc.lines):
            i = row_text(y).find(old)
            if i >= 0:
                cells = [sc.buffer[y][x] for x in range(sc.columns)]
                mid = [cells[i + min(k, len(old) - 1)]._replace(data=c) for k, c in enumerate(new)]
                row = (cells[:i] + mid + cells[i + len(old):] + [sc.default_char] * sc.columns)[:sc.columns]
                for x in range(sc.columns):
                    sc.buffer[y][x] = row[x]
    # --row 'MATCH=>NEW': rewrite a whole row. Cells whose char is unchanged keep their style (bullets,
    # indents); the rest take the style of the row's last non-blank cell (plain prose, or the heading).
    for spec in a.row:
        old, new = spec.split('=>', 1)
        for y in range(sc.lines):
            txt = row_text(y)
            if old in txt:
                last = len(txt.rstrip()) - 1
                tmpl = sc.buffer[y][max(last, 0)]
                orig = [sc.buffer[y][x] for x in range(sc.columns)]
                for x in range(sc.columns):
                    ch = new[x] if x < len(new) else ' '
                    sc.buffer[y][x] = orig[x] if (x < len(txt) and txt[x] == ch and ch != ' ') else tmpl._replace(data=ch)
                break
    for m in a.drop:
        for y in range(sc.lines):
            if m in row_text(y):
                for yy in range(y, sc.lines - 1):
                    for x in range(sc.columns):
                        sc.buffer[yy][x] = sc.buffer[yy + 1][x]
                for x in range(sc.columns):
                    sc.buffer[sc.lines - 1][x] = sc.default_char
                break
    if a.last is None:
        last = sc.lines
        while last > 0 and not ''.join(sc.buffer[last - 1][x].data for x in range(sc.columns)).strip():
            last -= 1
        a.last = last
    open(a.out, 'w').write(to_svg(sc, a.title, a.first, a.last))
    print('\n'.join(''.join(sc.buffer[y][x].data for x in range(sc.columns)).rstrip() for y in range(a.first, a.last)))
