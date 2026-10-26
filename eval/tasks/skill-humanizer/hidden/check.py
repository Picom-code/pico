# deterministic: facts kept, AI-isms gone, skill actually loaded (any tool call touching "humanizer")
import json, os, re
S = os.environ["SANDBOX"]
t = open(os.path.join(S, "blurb.txt")).read()
low = t.lower()
for fact in [r"saturday", r"9 may|may 9", r"10\s*(am|a\.m\.|:00)", r"elm street", r"gloves", r"seedling"]:
    assert re.search(fact, low), "missing fact: " + fact
isms = ["testament", "vibrant", "pivotal", "delve", "tapestry", "fast-paced", "foster", "enhance", "crucial",
        "showcase", "additionally", "thrilled", "unique opportunity", "not only", "enduring", "\u2014", "\u2728", "\U0001f331"]
hit = [w for w in isms if w in low]
assert not hit, "AI-isms left: %r" % hit
assert len(t.split()) <= 140, "too long"
tools = json.load(open(os.environ["TOOLS_JSON"]))
assert any("humanizer" in (e.get("args") or "").lower() or "humanizer" in (e.get("name") or "").lower() for e in tools), \
    "humanizer skill was never loaded"
print("ok")
