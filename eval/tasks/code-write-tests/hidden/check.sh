# money.py is restored from the fixture first; tests must pass on the real impl and FAIL (or hang -> killed) on each mutant; 60s cap per run
cd "$SANDBOX"
[ -f test_money.py ] || { echo "no test_money.py"; exit 1; }
python3 - <<'PY'
import glob, os, shutil, subprocess, sys
H = os.environ["HIDDEN"]
def run():
    try:
        return subprocess.run([sys.executable, "-m", "unittest", "-q", "test_money"], capture_output=True, timeout=60,
                              env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}).returncode == 0
    except subprocess.TimeoutExpired:
        return False
shutil.copy(os.environ["TASK_DIR"] + "/fixture/money.py", "money.py")  # never trust the sandbox copy
shutil.rmtree("__pycache__", ignore_errors=True)
if not run():
    sys.exit("tests fail (or hang) on the correct implementation")
orig = open("money.py").read()
survived = []
try:
    for m in sorted(glob.glob(H + "/mutants/*.py")):
        shutil.copy(m, "money.py"); shutil.rmtree("__pycache__", ignore_errors=True)
        if run():
            survived.append(os.path.basename(m))
finally:
    open("money.py", "w").write(orig)
print("survived:", survived or "none")
sys.exit(1 if survived else 0)
PY
