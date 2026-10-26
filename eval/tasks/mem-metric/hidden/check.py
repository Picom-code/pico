import os, re
S = os.environ["SANDBOX"]
t = open(os.path.join(S, "facts.txt")).read()
ans = open(os.environ["ANSWER"]).read()
assert re.search(r"8[,.\s]?8\d\d(\.\d+)?\s*(m\b|metre|meter)|8[.,]8\d*\s*(km|kilomet)", t), "Everest metric missing: " + t
assert re.search(r"42(\.\d+)?\s*(km|kilomet)", t), "marathon km missing: " + t
for txt in (t, ans):
    assert not re.search(r"\b(feet|foot|ft|miles?|mi|yards?|inch(es)?|pounds?|lbs?|fahrenheit)\b", txt, re.I), "imperial unit present: " + txt
print("ok")
