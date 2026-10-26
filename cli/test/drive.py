#!/usr/bin/env python3
"""Drive the interactive pico TUI in a pseudo-terminal and capture frames.

  uv run --with pyte test/drive.py <scenario> [--bin dist/pico] [--url http://127.0.0.1:7979]

Each step sends keystrokes, waits, then dumps the emulated screen (pyte) as plain text. Raw ANSI
output is also saved so color changes (e.g. Shift+Tab effort) can be inspected.
"""
import os, pty, select, sys, time, json, argparse, re

import pyte

ap = argparse.ArgumentParser()
ap.add_argument('scenario')
ap.add_argument('--bin', default='dist/pico')
ap.add_argument('--url', default='http://127.0.0.1:7979')
ap.add_argument('--cols', type=int, default=90)
ap.add_argument('--rows', type=int, default=30)
ap.add_argument('--out', default='test/frames')
ap.add_argument('--split', action='store_true', help='also write one .txt + .ansi file per frame')
ap.add_argument('--name', default=None, help='output name (default: scenario)')
ap.add_argument('--ascii', action='store_true', help='PICO_ASCII=1')
ap.add_argument('--cwd', default=None, help='working directory for the pico process')
ap.add_argument('--args', default='', help='extra CLI args (| separated)')
a = ap.parse_args()

SHIFT_TAB = '\x1b[Z'
ENTER = '\r'
ESC = '\x1b'
CTRL_C = '\x03'
CTRL_O = '\x0f'
DOWN = '\x1b[B'
SHIFT_ENTER = '\x1b[13;2u'
RIGHT = '\x1b[C'
LEFT = '\x1b[D'

SCENARIOS = {
    'chat': [
        ('boot', '', 1.5),
        ('effort-off', SHIFT_TAB + SHIFT_TAB + SHIFT_TAB, 0.4),   # medium -> high -> off -> low ... see below
        ('typing', 'explain this repo', 0.4),
        ('multiline', SHIFT_ENTER + 'second line', 0.4),
        ('streaming', ENTER, 1.6),
        ('done', '', 3.5),
        ('palette', '/se', 0.5),
        ('tools-midstream', ESC + '\x15' + 'use a tool and todo please' + ENTER, 2.6),
        ('tools-done', '', 5.0),
        ('approval', 'approve cleanup' + ENTER, 4.5),
        ('approved', 'y', 4.0),
        ('thinking-expand', CTRL_O, 0.6),
        ('files', '@src/ma', 0.6),
        ('model-picker', ESC + '\x15' + '/model' + ENTER, 0.8),
        ('model-picked', DOWN + ENTER, 0.8),
        ('help', '/help' + ENTER, 0.6),
        ('update', '/update' + ENTER, 0.8),
        ('update-no', 'n', 0.5),
        ('quit', CTRL_C + CTRL_C, 0.6),
    ],
    'stop': [
        ('boot', '', 1.5),
        ('long', 'give me a long answer' + ENTER, 1.5),
        ('stopped', ESC, 1.5),
        ('history', '\x1b[A', 0.4),
        ('resume', '\x15/resume' + ENTER, 0.8),
        ('resume-pick', '', 0.1),
        ('resumed', ENTER, 1.0),
        ('quit', CTRL_C + CTRL_C, 0.5),
    ],
    # polish features: context bar levels, live tools + tail, diff, summary, notice, subagents, undo
    'polish': [
        ('boot', '', 1.5),
        ('tool-running-tail', 'run the tool please' + ENTER, 1.3),
        ('tools-done-diff-summary', '', 3.0),
        ('ctrl-o-expanded', CTRL_O, 0.6),
        ('ctrl-o-collapsed', CTRL_O, 0.6),
        ('ctx-half', 'say hi half' + ENTER, 2.5),
        ('ctx-fill', 'say hi fill' + ENTER, 2.5),
        ('notice', 'remember my dog say hi' + ENTER, 2.6),
        ('compacted', 'compact say hi' + ENTER, 1.3),
        ('compacted-settled', '', 3.0),
        ('agents-running', 'agents slow say hi' + ENTER, 1.4),
        ('agents-done', '', 4.0),
        ('agents-expanded', CTRL_O, 0.6),
        ('undo', '/undo' + ENTER, 1.0),
        ('palette-undo', '/un', 0.5),
        ('quit', ESC + '\x15' + CTRL_C + CTRL_C, 0.5),
    ],
    # multi-turn conversation blocks, then resize 120 -> 70 -> 100 and /redraw
    'blocks': [
        ('boot', '', 1.5),
        ('turn1', 'say hi' + ENTER, 2.0),
        ('turn2', 'use a tool and write a new file' + ENTER, 5.5),
        ('turn3', 'explain the code' + ENTER, 4.5),
        ('resize-70', {'resize': (70, 34)}, 1.2),
        ('resize-100', {'resize': (100, 34)}, 1.2),
        ('redraw', '/redraw' + ENTER, 1.0),
        ('narrow-50', {'resize': (50, 34)}, 1.2),
        ('quit', CTRL_C + CTRL_C, 0.5),
    ],
    'agents-settings': [
        ('boot', '', 1.5),
        ('open', '/agents' + ENTER, 0.8),
        ('down-parallel', DOWN, 0.3),
        ('parallel-5', RIGHT + RIGHT, 0.3),
        ('model', DOWN + RIGHT, 0.3),
        ('effort', DOWN + RIGHT, 0.3),
        ('budget', DOWN + LEFT, 0.3),
        ('saved', ENTER, 0.8),
        ('quit', CTRL_C + CTRL_C, 0.5),
    ],
    'effort': [
        ('boot', '', 1.5),
        ('e1', SHIFT_TAB, 0.3),
        ('e2', SHIFT_TAB, 0.3),
        ('e3', SHIFT_TAB, 0.3),
        ('e4', SHIFT_TAB, 0.3),
        ('quit', CTRL_C + CTRL_C, 0.5),
    ],
    # lookbook picks: welcome quip, thinking shimmer, tool tree + live tail, summary-only diff, cat sign-off,
    # perched cat on the effort rule, ctrl+o expand, effort recolor, 120 -> 60 col bottom region
    'picks': [
        ('boot', '', 1.5),
        ('typing', 'use a tool and fix calc', 0.3),
        ('thinking', ENTER, 0.3),
        ('working-tree-tail', '', 1.2),
        ('done-signoff', '', 3.0),
        ('ctrl-o-expanded', CTRL_O, 0.6),
        ('ctrl-o-collapsed', CTRL_O, 0.6),
        ('effort-high', SHIFT_TAB, 0.3),
        ('notice', 'remember my dog say hi' + ENTER, 3.0),
        ('compaction-flash', 'compact say hi' + ENTER, 1.4),
        ('error', 'error' + ENTER, 1.5),
        ('undo', '/undo' + ENTER, 1.0),
        ('resize-60', {'resize': (60, 34)}, 1.2),
        ('resize-50', {'resize': (50, 34)}, 1.2),
        ('resize-100', {'resize': (100, 34)}, 1.2),
        ('redraw', '/redraw' + ENTER, 1.0),
        ('quit', CTRL_C + CTRL_C, 0.5),
    ],
    'theme': [
        ('boot', '', 1.5),
        ('open', '/theme' + ENTER, 0.8),
        ('accent-cyan', RIGHT + RIGHT, 0.4),
        ('spinner-row', DOWN, 0.3),
        ('spinner-moon', RIGHT + RIGHT, 0.4),
        ('spinner-eq', RIGHT, 0.4),
        ('saved', ENTER, 0.8),
        ('working-with-theme', 'use a tool please' + ENTER, 1.6),
        ('done-with-theme', '', 3.5),
        ('quit', CTRL_C + CTRL_C, 0.5),
    ],
    'bottom60': [
        ('boot', '', 1.5),
        ('working', 'use a tool please' + ENTER, 1.5),
        ('done', '', 3.5),
        ('quit', CTRL_C + CTRL_C, 0.5),
    ],
    'live': [
        ('boot', '', 2.0),
        ('ask', 'say ok' + ENTER, 12.0),
        ('quit', CTRL_C + CTRL_C, 0.5),
    ],
    'wizard': [
        ('boot', '', 2.2),
        ('persona', DOWN * 0, 0.2),
        ('persona-picked', ENTER, 0.5),       # engineer
        ('provider-picked', ENTER, 0.8),      # local -> recipes
        ('model-list', DOWN, 0.4),
        ('model-picked', '\x1b[A' + ENTER, 0.5),
        ('features', ' ', 0.3),
        ('features-done', ENTER, 0.3),
        ('confirm', 'y', 1.2),
        ('progress', '', 1.0),
        ('finished', '', 3.5),
        ('quit', CTRL_C + CTRL_C, 0.6),
    ],
}

SCENARIOS['live-code'] = [
    ('boot', '', 2.0),
    ('ask', 'calc.py has a bug and test_calc.py fails. fix it and run the tests with python3 test_calc.py' + ENTER, 8.0),
    ('mid', '', 20.0),
    ('done', '', 30.0),
    ('md', 'reply with a short markdown demo: an h2 heading, a 3-row table, a bulleted list, inline `code`, a link, and a short python code block. no tools.' + ENTER, 25.0),
    ('help', '/help' + ENTER, 0.8),
    ('palette', '/th', 0.5),
    ('ctrlc1', '\x15' + CTRL_C, 0.4),
    ('quit', CTRL_C, 0.8),
]
SCENARIOS['feel'] = [
    ('boot', '', 1.5),
    ('typing-cat', 'hello', 0.3),
    ('palette-fuzzy', '\x15/thm', 0.4),
    ('palette-all', '\x15/', 0.4),
    ('help', '\x15/help' + ENTER, 0.6),
    ('approval-box', 'approve cleanup' + ENTER, 4.5),
    ('approved', 'a', 3.5),
    ('yolo-on', '/yolo' + ENTER, 0.25),
    ('yolo-done', '', 1.0),
    ('yolo-approve', 'approve cleanup' + ENTER, 4.5),
    ('copy', '/copy' + ENTER, 0.4),
    ('yolo-off', '/yolo off' + ENTER, 1.0),
    ('error', 'error' + ENTER, 1.5),
    ('stop-ctrlc', 'give me a long answer' + ENTER + '', 1.2),
    ('stopped', CTRL_C, 1.5),
    ('narrow-60', {'resize': (60, 34)}, 1.2),
    ('wide-120', {'resize': (120, 34)}, 1.2),
    ('bye', CTRL_C, 0.5),
    ('quit', CTRL_C, 0.6),
]
SCENARIOS['live-yolo'] = [
    ('boot', '', 2.0),
    ('yolo-on', '/yolo' + ENTER, 2.5),
    ('ask', 'run rm -rf ./build_tmp_dir && echo cleaned in the terminal' + ENTER, 25.0),
    ('quit', CTRL_C + CTRL_C, 0.8),
]
TAB = '\t'
CTRL_U = '\x15'
ALT_ENTER = '\x1b\r'
UP = '\x1b[A'
SCENARIOS['steer'] = [
    ('boot', '', 1.5),
    ('busy', 'answer slowly please' + ENTER, 1.4),
    ('steer-typed', 'focus on the tests', 0.3),
    ('steer-sent', ENTER, 0.15),
    ('steer-applied', '', 1.0),
    ('done', '', 5.0),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['tab'] = [
    ('boot', '', 1.5),
    ('ghost-cmd', '/mo', 0.3),
    ('accepted', TAB, 0.3),
    ('model-arg-ghost', 'gpt', 0.4),
    ('model-arg-cycle', TAB, 0.3),
    ('model-arg-cycle2', TAB, 0.3),
    ('loop-args', CTRL_U + '/loop ', 0.4),
    ('effort-args', CTRL_U + '/effort h', 0.3),
    ('path-candidates', CTRL_U + 'look at @src/', 0.4),
    ('path-narrow', 'st', 0.3),
    ('path-accept', TAB, 0.3),
    ('quit', CTRL_U + CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['model'] = [
    ('boot', '', 1.5),
    ('picker', '/model' + ENTER, 0.8),
    ('down', DOWN + DOWN, 0.3),
    ('effort-row', DOWN + DOWN + RIGHT, 0.3),
    ('back-up', UP, 0.3),
    ('saved', ENTER, 0.8),
    ('direct', '/model qwen' + ENTER, 0.8),
    ('ctrl-p', '\x10', 0.6),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['cron'] = [
    ('boot', '', 1.5),
    ('list', '/cron' + ENTER, 0.8),
    ('down', DOWN, 0.3),
    ('paused', ' ', 0.5),
    ('new-when', 'n', 0.3),
    ('when-typed', 'every weekday at 9am', 0.3),
    ('new-what', ENTER, 0.3),
    ('what-typed', 'triage new github issues', 0.3),
    ('added', ENTER, 0.6),
    ('run-now', UP + UP + UP + ENTER, 0.5),
    ('closed', ESC, 0.5),
    ('inbox-arrives', '', 1.6),
    ('inbox-list', '/inbox' + ENTER, 0.8),
    ('inbox-closed', ESC, 0.5),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['loop'] = [
    ('boot', '', 1.5),
    ('start', '/loop 5s check the build' + ENTER, 0.8),
    ('countdown', '', 0.6),
    ('loop-turn', '', 1.6),
    ('loop-done-wait', '', 2.6),
    ('countdown2', '', 1.0),
    ('stop', '/loop stop' + ENTER, 1.0),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['usage'] = [
    ('boot', '', 1.5),
    ('card', '/usage' + ENTER, 1.0),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['goal'] = [
    ('boot', '', 1.5),
    ('set', '/goal ship the installer' + ENTER, 1.2),
    ('expanded', '\x0f', 0.4),
    ('collapsed', '\x0f', 0.4),
    ('step', 'goal step say hi' + ENTER, 2.5),
    ('reached', 'goal step say hi' + ENTER, 2.2),
    ('fading', '', 2.0),
    ('gone', '', 2.5),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['plan'] = [
    ('boot', '', 1.5),
    ('planning', '/plan add a --json flag' + ENTER, 0.6),
    ('waiting', '', 1.6),
    ('go', ENTER, 1.4),
    ('active', '', 0.8),
    ('done', '', 3.5),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['setup-api'] = [
    ('boot', '', 1.5),
    ('choices', '/setup' + ENTER, 0.6),
    ('any-api', DOWN, 0.3),
    ('url', ENTER, 0.4),
    ('preset-row', RIGHT, 0.3),
    ('typed-name', CTRL_U + 'groq', 0.3),
    ('key', ENTER, 0.3),
    ('key-masked', 'gsk_live_abc123secret', 0.3),
    ('models', ENTER, 0.9),
    ('filter', '4.1', 0.3),
    ('connected', ENTER, 1.2),
    ('back-in-chat', ENTER, 1.0),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['setup-errors'] = [
    ('boot', '', 1.5),
    ('choices', '/setup' + ENTER, 0.6),
    ('url', DOWN + ENTER, 0.5),
    ('wrong-url-typed', CTRL_U + 'https://api.example.com/nope' + ENTER, 0.4),
    ('wrong-url', ENTER, 1.0),
    ('bad-key-typed', CTRL_U + 'openai' + ENTER, 0.4),
    ('bad-key', 'bad' + ENTER, 1.0),
    ('cancel', ESC + ESC + ESC, 0.6),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['setup-login'] = [
    ('boot', '', 1.5),
    ('choices', '/setup' + ENTER, 0.6),
    ('waiting', ENTER, 1.5),
    ('signed-in', '', 5.0),
    ('saved', ENTER, 1.0),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
def verb(level):
    return [
        ('boot', '', 1.5),
        ('set', '/verbose ' + level + ENTER, 0.6),
        ('thinking', 'ponder, then use a tool and fix calc' + ENTER, 0.55),
        ('thinking-late', '', 0.45),
        ('tools-live', '', 1.4),
        ('done', '', 3.5),
        ('quit', CTRL_C + CTRL_C, 0.5),
    ]
for lv in ['quiet', 'normal', 'verbose', 'full']:
    SCENARIOS['verbosity-' + lv] = verb(lv)
SCENARIOS['verbosity-nosummary'] = verb('summary=off')
SCENARIOS['verbosity-picker'] = [
    ('boot', '', 1.5),
    ('open', '/theme' + ENTER, 0.6),
    ('reasoning-row', DOWN + DOWN, 0.4),
    ('reasoning-preview', RIGHT, 0.4),
    ('reasoning-full', RIGHT, 0.4),
    ('tools-row', DOWN, 0.4),
    ('tools-quiet', LEFT, 0.4),
    ('summary-off', DOWN + RIGHT, 0.4),
    ('cancel', ESC, 0.6),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['settings'] = [
    ('boot', '', 3.0),
    ('usage-line', 'say hi' + ENTER, 3.0),
    ('status-tab', '/settings' + ENTER, 1.0),
    ('config-tab', RIGHT, 0.5),
    ('approvals-row', DOWN, 0.3),
    ('approvals-yolo', ENTER, 0.8),
    ('approvals-ask', ENTER, 0.8),
    ('usage-tab', RIGHT, 0.5),
    ('look-tab', RIGHT, 0.5),
    ('closed', ESC, 0.8),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['compaction'] = [
    ('boot', '', 3.0),
    ('config', '/config' + ENTER, 0.8),
    ('compact-at', DOWN * 6, 0.3),
    ('compact-at-85', ENTER, 0.8),
    ('keep-recent', DOWN, 0.3),
    ('keep-7', '+', 0.8),
    ('mode-trim', DOWN + ENTER, 0.8),
    ('closed', ESC, 0.6),
    ('ticked', 'half fill please' + ENTER, 3.0),
    ('auto', 'autocompact now' + ENTER, 3.0),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
def reply(style):
    pre = [] if style == 'band' else [('pick', '/theme' + ENTER + DOWN + DOWN + ENTER * {'label': 1, 'bar': 2, 'plain': 3}[style] + ESC, 1.0)]
    return [('boot', '', 3.0)] + pre + [
        ('exchange', 'yo testing123' + ENTER, 3.0),
        ('two', 'say hi and wrap this deliberately long message so the band has to continue onto a second line of the terminal' + ENTER, 3.0),
        ('quit', CTRL_C + CTRL_C, 0.5),
    ]
for st in ['band', 'label', 'bar', 'plain']:
    SCENARIOS['reply-' + st] = reply(st)
SCENARIOS['reply-picker'] = [
    ('boot', '', 3.0),
    ('open', '/theme' + ENTER, 0.8),
    ('reply-row', DOWN + DOWN, 0.4),
    ('label', ENTER, 0.4),
    ('bar', ENTER, 0.4),
    ('plain', ENTER, 0.4),
    ('band', ENTER, 0.4),
    ('closed', ESC, 0.6),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['usage-real'] = [
    ('boot', '', 2.5),
    ('reply', 'say ok' + ENTER, 25.0),
    ('settings-status', '/status' + ENTER, 2.5),
    ('closed', ESC, 0.8),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
SCENARIOS['launch-flags'] = [
    ('boot', '', 2.5),
    ('quit', CTRL_C + CTRL_C, 0.5),
]
steps = SCENARIOS[a.scenario]
a.bin = os.path.abspath(a.bin)
if (a.scenario in ('blocks', 'picks', 'theme', 'live-code', 'live-yolo', 'feel', 'steer', 'tab', 'model', 'cron', 'loop', 'usage', 'goal', 'plan', 'launch-flags') or a.scenario.startswith(('setup', 'verbosity', 'settings', 'compaction', 'reply'))) and a.cols == 90:
    a.cols, a.rows = 120, 34
env = dict(os.environ, PICO_URL=a.url, TERM='xterm-256color', COLUMNS=str(a.cols), LINES=str(a.rows))
env.pop('COLORTERM', None)
if a.ascii:
    env['PICO_ASCII'] = '1'
if not a.scenario.startswith('live') and not a.scenario.endswith('-real'):
    env.setdefault('PICO_TOKEN', 'test-token')
    # mock runs must never touch the real ~/.pico (e.g. /theme saving tui.json)
    import tempfile
    env['PICO_HOME'] = tempfile.mkdtemp(prefix='pico-drive-')  # live: the CLI finds the real token itself
env.pop('NO_COLOR', None)
env['PICO_NO_BROWSER'] = '1'

pid, fd = pty.fork()
if pid == 0:
    import fcntl, termios, struct
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', a.rows, a.cols, 0, 0))
    if a.cwd:
        os.chdir(a.cwd)
    os.execvpe(a.bin, [a.bin] + [x for x in a.args.split('|') if x], env)

import fcntl, termios, struct
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', a.rows, a.cols, 0, 0))
screen = pyte.HistoryScreen(a.cols, a.rows, history=2000)
stream = pyte.ByteStream(screen)
raw_all = b''

def pump(t):
    global raw_all
    end = time.time() + t
    chunk = b''
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                break
            if not d:
                break
            chunk += d
            stream.feed(d)
    # Finish on a frame boundary (end of a synchronized update) so snapshots are never half-drawn.
    deadline = time.time() + 1.0
    while chunk and not chunk.endswith(b'\x1b[?2026l') and time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                break
            if not d:
                break
            chunk += d
            stream.feed(d)
    raw_all += chunk
    return chunk

def dump():
    lines = [l.rstrip() for l in screen.display]
    while lines and not lines[-1]:
        lines.pop()
    return '\n'.join(lines)

os.makedirs(a.out, exist_ok=True)
frames = []
for name, keys, wait in steps:
    if isinstance(keys, dict) and 'resize' in keys:
        c, r = keys['resize']
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
        screen.resize(r, c)
        os.kill(pid, 28)  # SIGWINCH
    elif keys:
        os.write(fd, keys.encode())
    raw = pump(wait)
    frames.append((name, dump(), raw))
    if a.split:
        d = f'{a.out}/{a.name or a.scenario}'
        os.makedirs(d, exist_ok=True)
        i = len(frames)
        with open(f'{d}/{i:02d}-{name}.txt', 'w') as f:
            f.write(frames[-1][1] + '\n')
        with open(f'{d}/{i:02d}-{name}.ansi', 'wb') as f:
            f.write(raw)

pump(0.5)
try:
    os.kill(pid, 9)
except Exception:
    pass

with open(f'{a.out}/{a.name or a.scenario}.txt', 'w') as f:
    for name, txt, _ in frames:
        f.write(f'===== {name} =====\n{txt}\n\n')
with open(f'{a.out}/{a.name or a.scenario}.raw', 'wb') as f:
    f.write(raw_all)
with open(f'{a.out}/{a.name or a.scenario}.json', 'w') as f:
    json.dump([{'name': n, 'screen': t, 'raw': r.decode('utf8', 'replace')} for n, t, r in frames], f)
print(open(f'{a.out}/{a.name or a.scenario}.txt').read())
