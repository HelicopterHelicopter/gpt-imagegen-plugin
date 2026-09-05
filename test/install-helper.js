'use strict';

// Builds the plugin exactly as `/plugin install` puts it on disk: the
// directory marketplace.json names, copied alone, with no repo checkout
// around it. Shared so the offline layout tests (test/install.test.js) and
// the live smoke (test/live.test.js) exercise the SAME artifact a user gets
// -- the live smoke used to run bin/gpt-imagegen.js against src/ and
// node_modules/, which meant the committed bundle's generate path had never
// actually been executed against ChatGPT.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const pluginSrc = path.join(repoRoot, 'plugins', 'gpt-imagegen');

/**
 * Copies the plugin directory into a fresh temp dir and returns its root.
 * The temp dir is deliberately far from this repo: if the bundle is not
 * inside the plugin, nothing up-tree can accidentally satisfy the require.
 * Pass a node:test context to have the copy cleaned up after the test.
 */
function fakeInstall(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-imagegen-install-'));
  if (t && typeof t.after === 'function') {
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  }
  const dest = path.join(dir, 'gpt-imagegen');
  fs.cpSync(pluginSrc, dest, { recursive: true });
  return dest;
}

/** The launcher a user actually invokes, inside an installed copy. */
function shimIn(installed) {
  return path.join(installed, 'scripts', 'gpt-imagegen');
}

module.exports = { repoRoot, pluginSrc, fakeInstall, shimIn };
