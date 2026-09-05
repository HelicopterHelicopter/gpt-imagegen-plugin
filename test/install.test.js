'use strict';

// Guards the ONE layout that actually matters at run time: the plugin as
// Claude Code installs it.
//
// `/plugin install` copies the plugin directory named by marketplace.json
// (`./plugins/gpt-imagegen`) and nothing else -- not the repo root, not
// node_modules, not any sibling of the plugin directory. Every other test in
// this suite runs from a full repo checkout, where the repo root is always
// present and always one or three levels up. That difference hid a fatal
// bug: the bundle lived at the REPO root (`dist/index.cjs`) and the shim
// reached it with `$here/../../../dist/index.cjs`, which resolves correctly
// from `plugins/gpt-imagegen/scripts/` in a checkout and resolves to garbage
// -- above the plugin root, outside anything that gets installed -- once
// installed. Result: `Cannot find module .../dist/index.cjs`, and the
// published plugin could not run a single command.
//
// So this test refuses to look at the checkout. It copies the plugin
// directory alone into a temp dir far away from this repo and runs the shim
// there. If the bundle is not inside the plugin directory, or the shim's
// relative path climbs out of it, there is nothing up-tree to accidentally
// satisfy the require and the test fails the way the real install did.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const pluginSrc = path.join(repoRoot, 'plugins', 'gpt-imagegen');

/**
 * Copies the plugin directory -- and only the plugin directory -- into a
 * fresh temp dir, mimicking what `/plugin install` puts on disk.
 * Returns the path to the installed plugin root.
 */
function fakeInstall(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-imagegen-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dest = path.join(dir, 'gpt-imagegen');
  fs.cpSync(pluginSrc, dest, { recursive: true });
  return dest;
}

test('the shim runs from an installed plugin with no repo checkout around it', (t) => {
  const installed = fakeInstall(t);
  const shim = path.join(installed, 'scripts', 'gpt-imagegen');

  // An unknown command is the cheapest thing that proves the bundle both
  // resolved and executed: src/cli.js emits a REFUSED envelope for it
  // without launching Chrome or touching the user's profile.
  //
  // spawnSync, not execFileSync: a REFUSED envelope is a legitimate non-zero
  // exit, so throwing on exit status would conflate "the CLI ran and said no"
  // with "the CLI could not be loaded at all". The two are told apart by what
  // reaches stdout -- a failed require prints a loader stack to stderr and
  // leaves stdout empty.
  const res = spawnSync(shim, ['definitely-not-a-command'], { encoding: 'utf8' });
  assert.ok(
    res.stdout.trim(),
    `shim produced no stdout from an installed plugin layout; stderr was:\n${res.stderr}`
  );

  const parsed = JSON.parse(res.stdout.trim());
  assert.strictEqual(parsed.ok, false);
  assert.strictEqual(parsed.error.code, 'REFUSED');
});

test('the bundle the shim needs is inside the installed plugin directory', (t) => {
  const installed = fakeInstall(t);
  assert.ok(
    fs.existsSync(path.join(installed, 'dist', 'index.cjs')),
    'dist/index.cjs must ship INSIDE plugins/gpt-imagegen/ -- anything outside ' +
      'that directory is not copied by `/plugin install`'
  );
});

test('the shim never resolves the bundle above the plugin root', () => {
  const shim = fs.readFileSync(path.join(pluginSrc, 'scripts', 'gpt-imagegen'), 'utf8');
  const m = shim.match(/^bundle="([^"]+)"$/m);
  assert.ok(m, 'expected the shim to assign the bundle path to `bundle="..."`');

  // Resolve the literal the shim uses, with $here standing in for the real
  // scripts/ directory, and assert it stays within the plugin root.
  const scriptsDir = path.join(pluginSrc, 'scripts');
  const resolved = path.resolve(m[1].replace('$here', scriptsDir));
  assert.ok(
    resolved.startsWith(pluginSrc + path.sep),
    `shim resolves the bundle to ${resolved}, which is outside the plugin root ` +
      `${pluginSrc}; only files under the plugin root are installed`
  );
});

test('no shipped file points outside the plugin root', () => {
  // The bundle-path bug in its general form: a shipped file naming a path
  // that only exists in a repo checkout. `${CLAUDE_PLUGIN_ROOT}/../../src/...`
  // reads fine here and is a dangling reference for every installed user,
  // because `/plugin install` copies nothing above the plugin root.
  //
  // This caught a second instance after the shim: SKILL.md sent the
  // self-heal step to `${CLAUDE_PLUGIN_ROOT}/../../src/selectors.json` for
  // the shipped candidate lists. Missing that file does not fail loudly --
  // it pushes the agent into writing the single-candidate patch SKILL.md
  // itself labels WRONG, silently deleting every shipped fallback.
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'dist') continue; // the built bundle, not authored text
        walk(full);
        continue;
      }
      const text = fs.readFileSync(full, 'utf8');
      for (const line of text.split('\n')) {
        // A shipped file may say "../" inside prose; what must never appear
        // is a PATH rooted at the plugin that then climbs out of it.
        if (/\$\{?CLAUDE_PLUGIN_ROOT\}?\/(\.\.\/)/.test(line)) {
          offenders.push(`${path.relative(pluginSrc, full)}: ${line.trim()}`);
        }
      }
    }
  };
  walk(pluginSrc);
  assert.deepStrictEqual(
    offenders,
    [],
    'these shipped files reference a path above the plugin root, which is ' +
      'not installed:\n' + offenders.join('\n')
  );
});
