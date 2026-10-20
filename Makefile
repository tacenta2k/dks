.PHONY: test typecheck build dist release

test:
	npm run typecheck
	npm test

typecheck:
	npm run typecheck

build:
	npm run build

dist:
	npm run dist

release:
	npm run release
