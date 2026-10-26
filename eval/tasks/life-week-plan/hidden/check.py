import json, os
S = json.load(open(os.path.join(os.environ["SANDBOX"], "schedule.json")))
days = ["mon", "tue", "wed", "thu", "fri"]
assert set(S) >= set(days), list(S)
m = lambda t: int(t[:2]) * 60 + int(t[3:5])
tot = {}
for d in days:
    bl = sorted(S[d], key=lambda b: m(b["start"]))
    for b in bl:
        s, e = m(b["start"]), m(b["end"])
        assert 540 <= s < e <= 1020, (d, b)
        assert e <= 720 or s >= 780, ("lunch", d, b)
    for a, b in zip(bl, bl[1:]):
        assert m(a["end"]) <= m(b["start"]), ("overlap", d, a, b)
    names = [(b["what"].lower(), b["start"], b["end"]) for b in bl]
    assert ("team standup", "09:00", "09:30") in names, (d, "standup")
    for b in bl:
        w = b["what"].lower(); dur = m(b["end"]) - m(b["start"])
        tot.setdefault((w, d), 0); tot[(w, d)] += dur
        if w in ("write report", "code review", "deep work", "plan next week"):
            assert dur >= 60, ("block < 1h", d, b)
    assert tot.get(("code review", d), 0) == 60, (d, "code review")
assert ("client call", "14:00", "15:00") in [(b["what"].lower(), b["start"], b["end"]) for b in S["wed"]]
for d in ("tue", "thu"):
    assert ("gym", "16:00", "17:00") in [(b["what"].lower(), b["start"], b["end"]) for b in S[d]]
assert sum(v for (w, d), v in tot.items() if w == "write report") == 360, "report hours"
assert tot.get(("write report", "fri"), 0) == 0
mon_deep = [b for b in S["mon"] if b["what"].lower() == "deep work" and m(b["end"]) <= 720 and m(b["end"]) - m(b["start"]) >= 120]
assert mon_deep, "deep work"
assert any(b["what"].lower() == "plan next week" and m(b["start"]) >= 780 and m(b["end"]) - m(b["start"]) >= 60 for b in S["fri"])
print("ok")
