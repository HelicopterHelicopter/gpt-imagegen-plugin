'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../src/cli');
const { run, safeRun } = cli;

// Port of run_test.go / main_test.go, adapted to Node. No Chrome, no login:
// every test here either short-circuits before a browser would be opened,
// or replaces cli._internal.openSession with a stub that fails the test if
// it is ever called.

/** A minimal Writable-like stream that just remembers what was written. */
function makeStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    toString() {
      return chunks.join('');
    },
  };
}

/**
 * Asserts stdout is EXACTLY one line of JSON: exactly one newline character
 * anywhere in the buffer, at the very end. Counts newlines rather than
 * merely parsing, per the brief -- a stray extra write before or after the
 * JSON line would still `JSON.parse` successfully if only the last line
 * were checked, so the newline count is the thing actually asserted.
 */
function assertSingleJsonLine(out) {
  const newlineCount = (out.match(/\n/g) || []).length;
  assert.equal(newlineCount, 1, `expected exactly one newline in stdout, got ${newlineCount}: ${JSON.stringify(out)}`);
  assert.ok(out.endsWith('\n'), `expected stdout to end with a newline: ${JSON.stringify(out)}`);
  return JSON.parse(out.slice(0, -1));
}

// --- unknown command ----------------------------------------------------

test('unknown command: exactly one JSON line, ok:false, non-zero exit', async () => {
  const stdout = makeStream();
  const stderr = makeStream();
  const code = await run(['wat'], stdout, stderr);
  const parsed = assertSingleJsonLine(stdout.toString());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'REFUSED');
  assert.notEqual(code, 0);
});

test('no arguments: exactly one JSON line, ok:false, non-zero exit', async () => {
  const stdout = makeStream();
  const stderr = makeStream();
  const code = await run([], stdout, stderr);
  const parsed = assertSingleJsonLine(stdout.toString());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'REFUSED');
  assert.notEqual(code, 0);
});

// --- generate: missing required flags -----------------------------------

test('generate with no --prompt: exactly one JSON line, ok:false, REFUSED', async () => {
  const stdout = makeStream();
  const stderr = makeStream();
  const code = await run(['generate', '--out', path.join(os.tmpdir(), 'out.png')], stdout, stderr);
  const parsed = assertSingleJsonLine(stdout.toString());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'REFUSED');
  assert.notEqual(code, 0);
});

test('generate with --prompt but no --out: exactly one JSON line, ok:false, REFUSED', async () => {
  const stdout = makeStream();
  const stderr = makeStream();
  const code = await run(['generate', '--prompt', 'a cat wearing a hat'], stdout, stderr);
  const parsed = assertSingleJsonLine(stdout.toString());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'REFUSED');
  assert.notEqual(code, 0);
});

// --- edit: missing --image must fail fast, without touching a browser ---

test('edit with a nonexistent --image fails fast and never opens a browser', async (t) => {
  const originalOpen = cli._internal.openSession;
  let openCalled = false;
  cli._internal.openSession = async () => {
    openCalled = true;
    throw new Error('openSession must not be called when --image does not exist');
  };
  t.after(() => {
    cli._internal.openSession = originalOpen;
  });

  const missingImage = path.join(os.tmpdir(), `gpt-imagegen-test-missing-${process.pid}-${Date.now()}.png`);
  assert.ok(!fs.existsSync(missingImage), 'test fixture path must not exist');

  const stdout = makeStream();
  const stderr = makeStream();
  const code = await run(
    ['edit', '--image', missingImage, '--prompt', 'make it blue', '--out', path.join(os.tmpdir(), 'edited.png')],
    stdout,
    stderr
  );

  const parsed = assertSingleJsonLine(stdout.toString());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'REFUSED');
  assert.match(parsed.error.message, /no such image/);
  assert.notEqual(code, 0);
  assert.equal(openCalled, false, 'a missing --image must never launch Chrome');
});

test('edit with missing required flags: exactly one JSON line, ok:false, REFUSED', async () => {
  const stdout = makeStream();
  const stderr = makeStream();
  const code = await run(['edit', '--prompt', 'x'], stdout, stderr);
  const parsed = assertSingleJsonLine(stdout.toString());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'REFUSED');
  assert.notEqual(code, 0);
});

// --- probe: unknown flag still yields exactly one line -------------------

test('an unparseable flag set (unknown option) still yields exactly one JSON line', async () => {
  const stdout = makeStream();
  const stderr = makeStream();
  const code = await run(['generate', '--not-a-real-flag', 'x'], stdout, stderr);
  const parsed = assertSingleJsonLine(stdout.toString());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'REFUSED');
  assert.notEqual(code, 0);
});

// --- safeRun: an uncaught throw must still produce one JSON line ---------

test('safeRun: a synchronously-throwing runner yields one JSON line on stdout, generic message, sentinel only on stderr', async () => {
  const stdout = makeStream();
  const stderr = makeStream();
  const SENTINEL = 'GPT_IMAGEGEN_TEST_SENTINEL_SYNC_8f3c1a9b';

  const code = await safeRun(
    () => {
      throw new Error(SENTINEL);
    },
    stdout,
    stderr
  );

  const outText = stdout.toString();
  const parsed = assertSingleJsonLine(outText);
  assert.equal(parsed.ok, false);
  assert.notEqual(code, 0);
  assert.ok(stderr.toString().includes(SENTINEL), 'the thrown value must be visible on stderr');
  assert.ok(!outText.includes(SENTINEL), 'the thrown value must NEVER appear on stdout');
});

test('safeRun: an async runner that rejects behaves the same as a synchronous throw', async () => {
  const stdout = makeStream();
  const stderr = makeStream();
  const SENTINEL = 'GPT_IMAGEGEN_TEST_SENTINEL_ASYNC_2b91cd';

  const code = await safeRun(
    async () => {
      throw new Error(SENTINEL);
    },
    stdout,
    stderr
  );

  const outText = stdout.toString();
  const parsed = assertSingleJsonLine(outText);
  assert.equal(parsed.ok, false);
  assert.notEqual(code, 0);
  assert.ok(stderr.toString().includes(SENTINEL), 'the thrown value must be visible on stderr');
  assert.ok(!outText.includes(SENTINEL), 'the thrown value must NEVER appear on stdout');
});

test('safeRun: a non-throwing runner passes its result straight through', async () => {
  const stdout = makeStream();
  const stderr = makeStream();
  const code = await safeRun(() => 0, stdout, stderr);
  assert.equal(code, 0);
  assert.equal(stdout.toString(), '');
  assert.equal(stderr.toString(), '');
});
