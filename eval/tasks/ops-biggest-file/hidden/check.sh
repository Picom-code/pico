cd "$SANDBOX"
[ "$(tr -d '[:space:]' < answer.txt | sed 's#^\./##')" = "data/.hidden/old/core.dump" ] || { echo "answer: $(cat answer.txt)"; exit 1; }
[ -f data/.hidden/old/core.dump ] && [ -f data/logs/app.log ]
