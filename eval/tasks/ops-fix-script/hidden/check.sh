set -e
cd "$SANDBOX"
rm -rf backup
out=$(bash backup.sh)
D=backup/$(date +%Y-%m-%d)
[ "$out" = "backed up 3 files" ] || { echo "out: $out"; exit 1; }
[ -f "$D/meeting notes.txt" ] && [ -f "$D/todo.txt" ] && [ -f "$D/ideas.txt" ] && [ ! -e "$D/skip.md" ]
# second run must also work (dest exists)
out2=$(bash backup.sh); [ "$out2" = "backed up 3 files" ]
# not hardcoded: add a file
echo hi > notes/new.txt; rm -rf backup; [ "$(bash backup.sh)" = "backed up 4 files" ]
echo ok
