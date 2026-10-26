set -e
git init -q -b main .
git config user.email eval@pico.local; git config user.name "Pico Eval"
printf 'RETRIES = 3\nTIMEOUT = 30\n' > config.py
printf 'def greet(name):\n    return "Hi " + name\n' > greet.py
git add -A; git commit -qm "initial"
printf 'RETRIES = 3\nTIMEOUT = 60\n' > config.py; git commit -qam "bump timeout"
printf 'RETRIES = 0\nTIMEOUT = 60\n' > config.py; git commit -qam "tweak: set retries to 0"
