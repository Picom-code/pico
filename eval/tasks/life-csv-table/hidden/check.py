import os
L = [l.strip() for l in open(os.path.join(os.environ["SANDBOX"], "plants.md")).read().strip().splitlines()]
cells = lambda l: [c.strip() for c in l.strip("|").split("|")]
assert cells(L[0]) == ["name", "light", "water_per_week", "price"], L[0]
assert set(L[1].replace("|", "").replace(":", "").replace(" ", "")) == {"-"}, L[1]
rows = [cells(l) for l in L[2:]]
assert len(rows) == 6, rows
assert [r[0] for r in rows] == ["Fiddle leaf fig", "Monstera", "ZZ plant", "Snake plant, tall", "Calathea", "Pothos"], [r[0] for r in rows]
assert [r[3] for r in rows] == ["$39.99", "$24.50", "$21.00", "$18.00", "$17.25", "$9.50"], [r[3] for r in rows]
assert rows[3][1:3] == ["low", "0.5"]
print("ok")
