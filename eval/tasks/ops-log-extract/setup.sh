python3 - <<'EOF'
import json, random
r = random.Random(7)
paths = ["/", "/login", "/api/items", "/api/items/42", "/static/app.js", "/health"]
w = [5, 2, 9, 3, 6, 1]
lines = []
for i in range(400):
    p = r.choices(paths, w)[0]
    st = r.choices([200, 304, 404, 500, 503], [80, 5, 6, 5, 4])[0]
    lines.append(json.dumps({"id": f"req-{i:04d}", "ip": f"10.0.{r.randint(0,3)}.{r.randint(1,30)}", "path": p,
                             "status": st, "ms": r.randint(3, 900)}))
lines.insert(100, '{"id": "req-broken", "ip": "1.1.1.1", "path": "/", "status": 500, "ms": 99999')
lines.insert(250, 'GARBAGE LINE ' + "x" * 30)
lines.insert(300, json.dumps({"id": "req-slow", "ip": "10.9.9.9", "path": "/api/items", "status": 200, "ms": 4321}))
open("access.log", "w").write("\n".join(lines) + "\n")
EOF
