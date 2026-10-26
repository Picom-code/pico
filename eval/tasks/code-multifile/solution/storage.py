import json
from pathlib import Path
from models import Expense


def save(path, expenses):
    Path(path).write_text(json.dumps([{"amount": e.amount, "desc": e.desc, "currency": e.currency} for e in expenses]))


def load(path):
    p = Path(path)
    if not p.exists():
        return []
    return [Expense(d["amount"], d["desc"], d.get("currency", "USD")) for d in json.loads(p.read_text())]
