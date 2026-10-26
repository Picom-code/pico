import argparse
import re
import sys
from collections import Counter


def main(argv=None):
    ap = argparse.ArgumentParser(description="count words")
    ap.add_argument("file")
    ap.add_argument("-l", "--lines", action="store_true", help="print line count only")
    ap.add_argument("--top", type=int)
    a = ap.parse_args(argv)
    text = open(a.file, encoding="utf-8").read()
    if a.lines:
        print(len(text.splitlines()))
        return 0
    words = [w for w in re.split(r"[^A-Za-z]+", text) if w]
    if a.top:
        c = Counter(w.lower() for w in words)
        for w, n in sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))[:a.top]:
            print(w, n)
        return 0
    print(len(words))
    return 0


if __name__ == "__main__":
    sys.exit(main())
