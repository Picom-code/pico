import json, os
got = json.load(open(os.path.join(os.environ["SANDBOX"], "e4471.json")))
exp = [{"date": "2026-09-03", "customer": "Kenji Sato"}, {"date": "2026-09-11", "customer": "Fatima Noor"},
       {"date": "2026-09-19", "customer": "Diego Paz"}, {"date": "2026-09-26", "customer": "Grace Liu"}]
assert [{"date": g["date"], "customer": g["customer"].strip()} for g in got] == exp, got
print("ok")
