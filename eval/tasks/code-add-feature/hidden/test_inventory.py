import os, sys
sys.path.insert(0, os.environ["SANDBOX"])
from inventory import Inventory
inv = Inventory(); inv.add("apple", 5); inv.add("pear", 2)
inv.remove("apple", 3); assert inv.count("apple") == 2
inv.remove("pear", 2); assert inv.items() == ["apple"], inv.items()
for bad in [("apple", 3), ("kiwi", 1), ("apple", 0), ("apple", -1), ("apple", 1.5)]:
    try:
        inv.remove(*bad); raise SystemExit("expected ValueError for %r" % (bad,))
    except ValueError:
        pass
assert inv.count("apple") == 2
inv.add("apple", 1); assert inv.count("apple") == 3
print("ok")
