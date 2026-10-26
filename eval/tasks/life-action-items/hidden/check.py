import json, os
A = json.load(open(os.path.join(os.environ["SANDBOX"], "actions.json")))
assert isinstance(A, list) and all(isinstance(a, dict) and set(a) == {"owner", "task", "due"} for a in A), A
exp = {("tom", "2026-11-04"), ("lucia", "2026-11-06"), ("maya", "2026-11-13"), ("ben", None), ("lucia", "2026-11-30")}
got = {(str(a["owner"]).strip().lower(), a["due"]) for a in A}
assert got == exp, "got %r" % sorted(got, key=str)
assert len(A) == 5
t = json.dumps(A).lower()
assert "pricing" in t and "churn" in t and "venue" in t and "licen" in t and "dark mode" not in t and "onboarding" not in t
print("ok")
