set -e
cd "$SANDBOX"
export PYTHONDONTWRITEBYTECODE=1
rm -rf __pycache__
make -s test >/dev/null
make -s dist >/dev/null
tar tzf dist/calc-1.4.2.tar.gz | sed 's#^\./##; s#^calc-1.4.2/##' | sort | grep -qx calc.py
tar tzf dist/calc-1.4.2.tar.gz | sed 's#^\./##; s#^calc-1.4.2/##' | grep -qx README.md
make -s clean >/dev/null; [ ! -e dist ]
# break the code -> test and dist must fail
cp calc.py /tmp/pico_calc_$$; echo 'def add(a, b):
    return a - b' > calc.py; printf 'def add(a, b):\n    return a - b\n' > calc.py
if make -s test >/dev/null 2>&1; then cp /tmp/pico_calc_$$ calc.py; echo "make test passed on broken code"; exit 1; fi
if make -s dist >/dev/null 2>&1; then cp /tmp/pico_calc_$$ calc.py; echo "make dist passed on broken code"; exit 1; fi
cp /tmp/pico_calc_$$ calc.py; rm -f /tmp/pico_calc_$$
# version must come from the variable
sed -i '' 's/^VERSION := 1.4.2/VERSION := 9.9.9/' Makefile; make -s dist >/dev/null; [ -f dist/calc-9.9.9.tar.gz ]
echo ok
