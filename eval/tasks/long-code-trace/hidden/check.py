import os, sys
S = os.environ["SANDBOX"]; sys.path.insert(0, S)
from src.api import compute_fee
assert compute_fee(1000, "gold") == 17.0, compute_fee(1000, "gold")
assert compute_fee(1000, "silver") == 19.0 and compute_fee(1000, "platinum") == 15.0 and compute_fee(1000) == 20.0
src = open(os.path.join(S, "src/fees.py")).read()
assert "amount * BASE_RATE" in src and "1 - discount_for(tier)" in src, "fees.py rewritten"
print("ok")
