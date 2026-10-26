import os, random, sys
sys.path.insert(0, os.environ["EVAL_LIB"])
from filler import paragraph
r = random.Random(99)
os.makedirs("transcripts", exist_ok=True)
names = ["Alma Ruiz", "Kenji Sato", "Fatima Noor", "Oskar Berg", "Lena Fischer", "Diego Paz", "Grace Liu",
         "Tomas Novak", "Aisha Bello", "Sven Olsen", "Mira Patel", "Jonah Weiss"]
codes = ["E-4417", "E-4470", "E-1471", "E-4471X", "W-4471", "E-0001", "E-7744"]
hits = {3: "Kenji Sato", 11: "Fatima Noor", 19: "Diego Paz", 26: "Grace Liu"}
for day in range(1, 31):
    calls = []
    for c in range(3):
        cust = r.choice(names)
        code = r.choice(codes)
        calls.append(f"### Call {c+1}\nCustomer: {cust}\nAgent: support-{r.randint(1,9)}\n\n"
                     f"Customer says the app shows {code} after login. {paragraph(r, 4)}\nResolution: {paragraph(r, 2)}\n")
    if day in hits:
        calls.insert(r.randint(0, 3), f"### Call X\nCustomer: {hits[day]}\nAgent: support-{r.randint(1,9)}\n\n"
                     f"{paragraph(r, 3)} The customer read out the error: E-4471. {paragraph(r, 2)}\nResolution: escalated to tier 2.\n")
    open(f"transcripts/2026-09-{day:02d}.md", "w").write(f"# Support calls 2026-09-{day:02d}\n\n" + "\n".join(calls))
