'use strict';

// Opt-in end-to-end smoke test. Drives a real, signed-in ChatGPT session
// and therefore costs a real ChatGPT turn against the user's account. It
// must NEVER run as part of the ordinary suite -- only when a human
// deliberately sets GPT_IMAGEGEN_LIVE=1. Port of tests/live/live_test.go.
//
// It runs the plugin AS INSTALLED: the launcher shim inside a plugin-only
// copy, which execs the committed bundle. It used to run
// bin/gpt-imagegen.js instead, which loads src/ from this checkout and
// resolves puppeteer-core out of node_modules/ -- so the artifact users
// actually receive had never generated an image even once. Only `doctor`
// had ever exercised the bundle, and doctor never touches the composer,
// the network capture or the image write.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fakeInstall, shimIn } = require('./install-helper');

const LIVE = process.env.GPT_IMAGEGEN_LIVE === '1';
const skipReason = LIVE ? false : 'set GPT_IMAGEGEN_LIVE=1 to run the live smoke';

// The image the generate smoke produces, handed to the edit smoke below.
// Chaining beats a committed fixture here: `.gitignore` excludes *.png, the
// pair mirrors the real workflow (make an image, then change it), and the
// edit smoke cannot silently pass against a stale or hand-made input.
let generated = null;

test('generate produces a real image file on disk', { skip: skipReason }, (t) => {
  const shim = shimIn(fakeInstall(t));
  if (!fs.existsSync(shim)) {
    assert.fail(`launcher shim not found at ${shim}`);
  }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-imagegen-live-'));
  const out = path.join(outDir, 'smoke.png');

  let stdout;
  try {
    stdout = execFileSync(
      shim,
      ['generate', '--prompt', 'a plain solid teal square, no text', '--out', out],
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

  generated = result.images[0].path;
});

test('edit attaches a reference image and returns a changed one', { skip: skipReason }, (t) => {
  // Costs a second real turn, which is why it is opt-in with the rest of the
  // smoke. It earns that: `edit` is the only path that uploads a file, so
  // the attachment selectors and waitAttachmentsReady() -- an entire code
  // path and selector key -- have no other live coverage. `generate` never
  // touches any of it.
  if (!generated || !fs.existsSync(generated)) {
    t.skip('generate smoke did not produce an input image');
    return;
  }

  const shim = shimIn(fakeInstall(t));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-imagegen-live-')), 'edited.png');

  let stdout;
  try {
    stdout = execFileSync(
      shim,
      ['edit', '--image', generated, '--prompt', 'change the square to bright orange', '--out', out],
      { encoding: 'utf8' }
    );
  } catch (err) {
    assert.fail(
      `edit failed: ${err.message}\nstdout=${err.stdout || ''}\nstderr=${err.stderr || ''}`
    );
  }

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, `unexpected result: ${stdout}`);
  assert.equal(result.images && result.images.length, 1, `unexpected result: ${stdout}`);

  const stat = fs.statSync(result.images[0].path);
  assert.ok(stat.size >= 1000, `no real image written: ${result.images[0].path} is only ${stat.size} bytes`);

  // Dimensions come from parsing the file's own header, so a non-zero pair
  // also confirms the bytes on disk are a real, decodable image.
  assert.ok(
    result.images[0].width > 0 && result.images[0].height > 0,
    `edited image has no dimensions: ${stdout}`
  );
});
