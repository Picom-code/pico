import os, subprocess, sys
S = os.environ["SANDBOX"]
src = open(os.path.join(S, "fizzbuzz.py")).read()
ind = [l for l in src.splitlines() if l[:1] in (" ", "\t") and l.strip()]
assert ind, "no indented lines"
bad = [l for l in ind if l.startswith(" ")]
assert not bad, "space-indented lines: %r" % bad[:3]
out = subprocess.run([sys.executable, "fizzbuzz.py"], cwd=S, capture_output=True, text=True).stdout.split()
assert out[:15] == ["1","2","Fizz","4","Buzz","Fizz","7","8","Fizz","Buzz","11","Fizz","13","14","FizzBuzz"], out
print("ok")
