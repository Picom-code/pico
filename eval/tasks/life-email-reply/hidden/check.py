import os, re
t = open(os.path.join(os.environ["SANDBOX"], "reply.txt")).read()
low = t.lower()
assert len(t.split()) < 120, "%d words" % len(t.split())
assert "thursday" in low and re.search(r"3\s*(pm|p\.m\.|:00)|15:00", low), "slot"
assert "tuesday" not in low or re.search(r"thursday", low), "slot"
assert "nda" in low and re.search(r"sign", low), "nda"
assert "parking" in low and "?" in t, "parking question"
assert re.search(r"\bsam\s*$", low.strip()), "sign-off"
assert not low.startswith("subject"), "subject line"
print("ok")
