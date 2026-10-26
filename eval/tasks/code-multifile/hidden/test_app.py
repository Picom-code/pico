import json, os, subprocess, sys, tempfile
S = os.environ["SANDBOX"]; sys.path.insert(0, S)
from models import Expense
from storage import save, load
assert Expense(1, "x").currency == "USD"
assert Expense(1, "x", "eur").currency == "EUR"
for bad in ["EURO", "E1", ""]:
    try:
        Expense(1, "x", bad); raise SystemExit("no ValueError for " + bad)
    except ValueError:
        pass
d = tempfile.mkdtemp(); db = os.path.join(d, "e.json")
save(db, [Expense(2, "a", "GBP")]); assert load(db)[0].currency == "GBP"
open(db, "w").write(json.dumps([{"amount": 3, "desc": "old"}])); assert load(db)[0].currency == "USD"
os.remove(db)
env = {**os.environ, "EXPENSES_DB": db}
run = lambda *a: subprocess.run([sys.executable, "cli.py", *a], cwd=S, env=env, capture_output=True, text=True, check=True).stdout
run("add", "10", "lunch", "--currency", "eur"); run("add", "2.5", "coffee", "--currency", "EUR")
run("add", "4", "bus"); run("add", "1.25", "gum", "--currency", "GBP")
out = run("total").strip().splitlines()
assert out == ["EUR 12.50", "GBP 1.25", "USD 4.00"], out
print("ok")
