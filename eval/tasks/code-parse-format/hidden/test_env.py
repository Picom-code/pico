import os, sys
sys.path.insert(0, os.environ["SANDBOX"])
from envparse import parse_env
src = """
# comment
export HOST = example.com
PORT=8080   # trailing
NAME="Pico  Agent # not a comment"
RAW='a\\nb ${HOST}'
URL=http://${HOST}:${PORT}/x
MSG="line1\\nline2 \\"q\\" ${NAME}"
EMPTY=
MISSING=${NOPE}end
"""
d = parse_env(src)
assert d["HOST"] == "example.com", d
assert d["PORT"] == "8080", d
assert d["NAME"] == "Pico  Agent # not a comment", d
assert d["RAW"] == "a\\nb ${HOST}", repr(d["RAW"])
assert d["URL"] == "http://example.com:8080/x", d
assert d["MSG"] == 'line1\nline2 "q" Pico  Agent # not a comment', repr(d["MSG"])
assert d["EMPTY"] == ""
assert d["MISSING"] == "end"
assert len(d) == 8
try:
    parse_env("A=1\n\nbroken line\n"); raise SystemExit("no error")
except ValueError as e:
    assert "3" in str(e), e
print("ok")
