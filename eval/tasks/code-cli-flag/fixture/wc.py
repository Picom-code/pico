import argparse
import re
import sys


def main(argv=None):
    ap = argparse.ArgumentParser(description="count words")
    ap.add_argument("file")
    ap.add_argument("-l", "--lines", action="store_true", help="print line count only")
    a = ap.parse_args(argv)
    text = open(a.file, encoding="utf-8").read()
    if a.lines:
        print(len(text.splitlines()))
        return 0
    words = [w for w in re.split(r"[^A-Za-z]+", text) if w]
    print(len(words))
    return 0


if __name__ == "__main__":
    sys.exit(main())
