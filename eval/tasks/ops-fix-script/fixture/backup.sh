#!/bin/bash
set -e
DEST=backup/$(date +%Y-%m-%d)
mkdir $DEST
count = 0
for f in $(ls notes/*.txt); do
  cp $f $DEST/
  count=$count+1
done
echo "backed up $count file"
