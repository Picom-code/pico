import os, re
S = os.environ["SANDBOX"]
assert open(os.path.join(S, "answer.txt")).read().strip() == "391"
ans = open(os.environ["ANSWER"]).read()
leaks = [w for w in ["biscuit", "beagle", "lisbon", "marathon", "priya", "toronto", "dentist", "oat", "flat white",
                     "subaru", "tail light", "wifi", "pico-guest", "router"] if w in ans.lower()]
assert not leaks, "irrelevant memory dumped: %r" % leaks
assert len(ans.split()) <= 40, "reply too long (%d words)" % len(ans.split())
print("ok")
