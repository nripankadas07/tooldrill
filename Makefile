.PHONY: install build test demo check

install:
	npm ci

build:
	npm run build

test:
	npm test

demo:
	npm run demo

check:
	npm run check
