set -e
cd "$SANDBOX"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "not on main"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "dirty tree"; git status --short; exit 1; }
[ "$(git rev-list --count main)" = "4" ] || { echo "main should have 4 commits"; git log --oneline main; exit 1; }
git log -1 --format=%s main | grep -qi revert
git show main:config.py | grep -q 'RETRIES = 3'
git show main:config.py | grep -q 'TIMEOUT = 60'
git rev-parse -q --verify feature/greeting >/dev/null
[ "$(git log -1 --format=%s feature/greeting)" = "feat: friendlier greeting" ]
git merge-base --is-ancestor main feature/greeting
git show feature/greeting:greet.py > /tmp/pico_greet_$$.py
python3 -c "import importlib.util as u;s=u.spec_from_file_location('g','/tmp/pico_greet_$$.py');m=u.module_from_spec(s);s.loader.exec_module(m);assert m.greet('Ada')=='Hello, Ada!'"
rm -f /tmp/pico_greet_$$.py
git show main:greet.py | grep -q '"Hi "'
echo ok
