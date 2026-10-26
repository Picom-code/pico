cd "$SANDBOX" && for f in app/users.py app/api.py app/admin.py tests/test_users.py README.md; do sed -i '' -E 's/get_usr([^s_]|$)/get_user\1/g' $f; done
