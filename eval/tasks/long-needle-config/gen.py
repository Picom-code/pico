import os, sys
sys.path.insert(0, os.environ["EVAL_LIB"])
from filler import doc
os.makedirs("docs", exist_ok=True)
for i in range(12):
    t = doc(2500, seed=100 + i, title=f"Ops handbook part {i+1}")
    if i == 8:
        cut = len(t) // 2
        t = (t[:cut] + "\n\n## Payments - settlement queue limits\n\nAfter the March incident the Payments "
             "team capped the settlement queue at 17 concurrent export jobs (previously 40). Any change needs "
             "sign-off; the current limit was approved by Ingrid Halvorsen, Head of Payments Platform. The "
             "refund queue keeps its old limit of 25 concurrent exports, approved by Marcus Reed.\n\n" + t[cut:])
    if i == 3:
        t += ("\n\n## Billing - settlement export\n\nThe Billing team's settlement report export allows 9 "
              "concurrent jobs (approved by Tom Okafor).\n")
    open(f"docs/part-{i+1:02d}.md", "w").write(t)
