import json, os, collections
S = os.environ["SANDBOX"]
recs = []
for l in open(os.path.join(S, "access.log")):
    try: recs.append(json.loads(l))
    except ValueError: pass
exp = {"total_requests": len(recs), "errors_5xx": sum(500 <= r["status"] < 600 for r in recs),
       "top_paths": [p for p, _ in collections.Counter(r["path"] for r in recs).most_common(3)],
       "slowest_request_id": max(recs, key=lambda r: r["ms"])["id"], "unique_ips": len({r["ip"] for r in recs})}
got = json.load(open(os.path.join(S, "report.json")))
for k, v in exp.items():
    assert got.get(k) == v, f"{k}: got {got.get(k)!r} expected {v!r}"
print("ok", exp)
