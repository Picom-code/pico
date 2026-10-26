import os, re
L = [l for l in open(os.path.join(os.environ["SANDBOX"], "summary.md")).read().splitlines() if l.strip()]
assert len(L) == 5, "%d lines" % len(L)
assert all(l.startswith("- ") for l in L), L
assert all(len(l[2:].split()) <= 25 for l in L), [len(l.split()) for l in L]
t = " ".join(L).lower()
assert re.search(r"48,?000|48k|1\.23", t), "budget missing"
assert re.search(r"2 feb|february 2|feb(ruary)? 2\b", t), "deadline missing"
print("ok")
