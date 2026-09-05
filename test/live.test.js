'use strict';

// Opt-in end-to-end smoke test. Drives the real CLI entry point against a
// real, signed-in ChatGPT session and therefore costs a real ChatGPT turn
// against the user's account. It must NEVER run as part of the ordinary
// suite -- only when a human deliberately sets GPT_IMAGEGEN_LIVE=1. Port of
// tests/live/live_test.go.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LIVE = process.env.GPT_IMAGEGEN_LIVE === '1';
const skipReason = LIVE ? false : 'set GPT_IMAGEGEN_LIVE=1 to run the live smoke';

test('generate produces a real image file on disk', { skip: skipReason }, () => {
  const bin = path.join(__dirname, '..', 'bin', 'gpt-imagegen.js');
  if (!fs.existsSync(bin)) {
    assert.fail(`entry point not found at ${bin}`);
  }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-imagegen-live-'));
  const out = path.join(outDir, 'smoke.png');

  let stdout;
  try {
    stdout = execFileSync(
      process.execPath,
      [bin, 'generate', '--prompt', 'a plain solid teal square, no text', '--out', out],
      { encoding: 'utf8' }
    );
  } catch (err) {
    assert.fail(
      `run failed: ${err.message}\nstdout=${err.stdout || ''}\nstderr=${err.stderr || ''}`
    );
  }

  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    assert.fail(`stdout not JSON: ${stdout}`);
  }

  assert.equal(result.ok, true, `unexpected result: ${stdout}`);
  assert.equal(result.images && result.images.length, 1, `unexpected result: ${stdout}`);

  // Assert a genuine image landed on disk with a plausible size -- not
  // merely that the process exited 0 and printed the right shape of JSON.
  const stat = fs.statSync(result.images[0].path);
  assert.ok(stat.size >= 1000, `no real image written: ${result.images[0].path} is only ${stat.size} bytes`);
});
