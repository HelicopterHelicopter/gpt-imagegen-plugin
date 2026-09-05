.PHONY: bundle bundle-check test smoke

# Rebuilds the committed artifact at dist/index.cjs from src/cli.js (via
# bin/gpt-imagegen.js). See esbuild.config.mjs for why it's unminified and
# why nothing is marked external. dist/index.cjs is committed to git -- run
# this and commit the result whenever src/ changes.
bundle:
	node esbuild.config.mjs

# Rebuilds the bundle and fails if that changes anything already committed
# at dist/. This is what keeps the committed artifact from silently
# drifting out of sync with src/ -- run by CI on every push/PR.
bundle-check: bundle
	git diff --exit-code dist/

test:
	node --test "test/**/*.test.js"

# Live smoke costs a real ChatGPT turn; opt in explicitly.
smoke:
	GPT_IMAGEGEN_LIVE=1 node --test test/live.test.js
