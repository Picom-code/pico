import argparse
import os
from models import Expense
from storage import load, save

DB = os.environ.get("EXPENSES_DB", "expenses.json")


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("amount", type=float)
    a.add_argument("desc")
    a.add_argument("--currency", default="USD")
    sub.add_parser("total")
    args = ap.parse_args(argv)
    items = load(DB)
    if args.cmd == "add":
        items.append(Expense(args.amount, args.desc, args.currency))
        save(DB, items)
    else:
        tot = {}
        for e in items:
            tot[e.currency] = tot.get(e.currency, 0) + e.amount
        for c in sorted(tot):
            print("%s %.2f" % (c, tot[c]))


if __name__ == "__main__":
    main()
