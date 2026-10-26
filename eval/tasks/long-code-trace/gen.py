import os, random
r = random.Random(5)
os.makedirs("src", exist_ok=True)
open("src/__init__.py", "w").write("")
open("SPEC.md", "w").write("# Fees\n\nBase fee = 2% of amount. Tier discounts on the base fee: silver 5%, gold 15%, platinum 25%.\n")
words = ["ledger", "cache", "queue", "invoice", "shipment", "profile", "report", "session", "bucket", "token"]


def filler_module(i):
    lines = [f'"""Module {i}: helpers for the {r.choice(words)} subsystem."""', ""]
    for j in range(32):
        a, b = r.choice(words), r.choice(words)
        lines += [f"def {a}_{b}_{i}_{j}(x, y=0):",
                  f'    """Return the {a} {b} adjustment for x (unrelated to fees)."""',
                  f"    total = x * {r.randint(2, 9)} + y",
                  f"    if total > {r.randint(100, 900)}:",
                  f"        total -= {r.randint(1, 50)}",
                  "    return total", ""]
    return "\n".join(lines)


for i in range(22):
    open(f"src/mod_{i:02d}.py", "w").write(filler_module(i))
open("src/rates.py", "w").write(filler_module(90) + """

BASE_RATE = 0.02
TIER_DISCOUNTS = {
    "silver": 0.05,
    "gold": 0.015,
    "platinum": 0.25,
}
LEGACY_GOLD = 0.15  # unused: old pricing table
""")
open("src/tiers.py", "w").write(filler_module(91) + """

from src.rates import TIER_DISCOUNTS


def discount_for(tier):
    return TIER_DISCOUNTS.get(tier, 0.0)
""")
open("src/fees.py", "w").write(filler_module(92) + """

from src.rates import BASE_RATE
from src.tiers import discount_for


def base_fee(amount):
    return amount * BASE_RATE


def tiered_fee(amount, tier):
    return round(base_fee(amount) * (1 - discount_for(tier)), 4)
""")
open("src/api.py", "w").write(filler_module(93) + """

from src.fees import tiered_fee


def compute_fee(amount, tier="standard"):
    return tiered_fee(amount, tier)
""")
