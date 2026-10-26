set -e
cd "$SANDBOX"
python3 -m unittest discover -q -s tests -t . 2>&1
! grep -rnw --include='*.py' --include='*.md' 'get_usr' . || { echo "get_usr still present"; exit 1; }
grep -q 'def get_user(' app/users.py
grep -q 'def get_usrs_page(' app/users.py || { echo "get_usrs_page was renamed"; exit 1; }
grep -q 'get_usrs_page' README.md
grep -q 'get_user(uid)' README.md
python3 -c "from app.users import get_user; assert get_user(1)=='ada'"
grep -q 'get_user' tests/test_users.py
echo ok
