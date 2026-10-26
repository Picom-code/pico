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
    sub.add_parser("total")
    args = ap.parse_args(argv)
    items = load(DB)
    if args.cmd == "add":
        items.append(Expense(args.amount, args.desc))
        save(DB, items)
    else:
        print("%.2f" % sum(e.amount for e in items))


if __name__ == "__main__":
    main()
