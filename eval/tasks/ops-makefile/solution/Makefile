VERSION := 1.4.2

.PHONY: clean test dist

test:
	python3 -m unittest -q

dist: test
	mkdir -p dist
	tar czf dist/calc-$(VERSION).tar.gz calc.py README.md

clean:
	rm -rf __pycache__ dist
