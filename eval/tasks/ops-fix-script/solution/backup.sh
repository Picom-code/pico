#!/bin/bash
set -e
DEST="backup/$(date +%Y-%m-%d)"
mkdir -p "$DEST"
count=0
for f in notes/*.txt; do
  [ -e "$f" ] || continue
  cp "$f" "$DEST/"
  count=$((count+1))
done
echo "backed up $count files"
