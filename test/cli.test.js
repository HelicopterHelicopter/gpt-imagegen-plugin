'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../src/cli');
const { run, safeRun, salvageOutcome } = cli;
const lockMod = require('../src/lock');
const capture = require('../src/capture');
const compose = require('../src/compose');

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

// --- safeRun: idempotent-stdout guard (FIX 1, layer two) -----------------
//
// `fn` may legitimately write its one JSON line and THEN throw -- e.g. a
// cleanup step that raises after emit() already fired. safeRun must not
// compound that into a second stdout line: whatever `fn` already wrote
// stands, the panic detail goes to stderr only, and the exit code is still
// non-zero. This is defence in depth alongside the fix at the cleanup call
// sites themselves (safeCleanup in src/cli.js) -- it is what makes "exactly
// one line" hold even if some future cleanup forgets to route through that
// helper.

test('safeRun: a runner that writes a line and THEN throws still yields exactly one stdout line, detail on stderr, non-zero exit', async () => {
  const stdout = makeStream();
  const stderr = makeStream();
  const SENTINEL = 'GPT_IMAGEGEN_TEST_SENTINEL_POSTWRITE_71ad0c';

  const code = await safeRun(
    () => {
      stdout.write('{"ok":true,"images":[],"conversation_url":"","elapsed_s":0}\n');
      throw new Error(SENTINEL);
    },
    stdout,
    stderr
  );

  const outText = stdout.toString();
  assertSingleJsonLine(outText);
  assert.ok(outText.includes('"ok":true'), 'the line fn already wrote must survive untouched');
  assert.notEqual(code, 0, 'the throw after the write must still be signalled via a non-zero exit code');
  assert.ok(stderr.toString().includes(SENTINEL), 'the thrown value must still be visible on stderr');
});

test('safeRun: a runner that throws BEFORE writing anything still yields exactly one stdout line (no regression)', async () => {
  const stdout = makeStream();
  const stderr = makeStream();
  const SENTINEL = 'GPT_IMAGEGEN_TEST_SENTINEL_PREWRITE_c92f4e';

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
  assert.ok(stderr.toString().includes(SENTINEL));
});

// --- FIX 1: a throwing cleanup must never produce a second stdout line ---
//
// generate()'s outer `finally` blocks call closeSession then releaseLock
// unconditionally. Before the fix, releaseLock rethrowing any non-ENOENT fs
// error escaped generate() -> run() -> safeRun(), which then wrote a SECOND
// json line -- even when emit() had already reported ok:true for images
// genuinely on disk. These tests drive the scenario through run() directly
// (no safeRun wrapper), so a fix that only patches safeRun's own write,
// without stopping the throw at its source (safeCleanup), still fails them:
// an uncaught rejection out of run() itself is exactly the bug.

/**
 * Points the profile lock at a scratch dir so acquireLock/releaseLock never
 * touch the user's real ~/.gpt-imagegen/profile lock.
 *
 * profile.lockPath() is a SIBLING of the profile dir (dirname(profileDir)
 * + "lock"), not something inside it -- so the override must nest the
 * profile dir one level under its own fresh mkdtemp directory. Pointing
 * GPT_IMAGEGEN_PROFILE_DIR directly at a mkdtemp'd dir would make
 * dirname() collapse to the shared os.tmpdir(), so every test using this
 * helper would compute the SAME lockPath ("<tmpdir>/lock") and contend
 * with each other's locks.
 */
function useScratchProfileDir(t) {
  const prev = process.env.GPT_IMAGEGEN_PROFILE_DIR;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-imagegen-fix1-profile-'));
  process.env.GPT_IMAGEGEN_PROFILE_DIR = path.join(scratch, 'profile');
  t.after(() => {
    if (prev === undefined) delete process.env.GPT_IMAGEGEN_PROFILE_DIR;
    else process.env.GPT_IMAGEGEN_PROFILE_DIR = prev;
  });
}

function makeReleaseLockThrow(t) {
  const original = lockMod.releaseLock;
  lockMod.releaseLock = () => {
    throw new Error('EIO: some non-ENOENT filesystem error (simulated)');
  };
  t.after(() => {
    lockMod.releaseLock = original;
  });
}

test('FIX1 failure case: releaseLock throwing after openSession fails still yields exactly one ok:false line', async (t) => {
  useScratchProfileDir(t);
  makeReleaseLockThrow(t);

  const originalOpen = cli._internal.openSession;
  cli._internal.openSession = async () => {
    throw new Error('no chrome');
  };
  t.after(() => {
    cli._internal.openSession = originalOpen;
  });

  const stdout = makeStream();
  const stderr = makeStream();

  // Calling run() directly (no safeRun) is deliberate: before the fix,
  // releaseLock's throw escapes generate() -> run() as an unhandled
  // rejection from THIS await -- the test fails right here, not on a
  // later assertion, which is the clearest possible signal the bug is
  // real and not merely a stdout-formatting nitpick.
  const code = await run(
    ['generate', '--prompt', 'x', '--out', path.join(os.tmpdir(), 'fix1-out.png')],
    stdout,
    stderr
  );

  const parsed = assertSingleJsonLine(stdout.toString());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'CHROME_MISSING');
  assert.notEqual(code, 0);
  assert.ok(stderr.toString().includes('cleanup failed'), 'the swallowed cleanup error must still reach stderr');
});

test('FIX1 success case: releaseLock (and closeSession) throwing after a successful generate leaves the ok:true line unchanged', async (t) => {
  useScratchProfileDir(t);
  makeReleaseLockThrow(t);

  const originalOpen = cli._internal.openSession;
  const originalAuth = cli._internal.auth;
  const originalClose = cli._internal.closeSession;
  const originalCreateRecorder = capture.createRecorder;
  const originalNewChat = compose.newChat;
  const originalSend = compose.send;
  const originalWaitDone = compose.waitDone;
  const originalArchive = compose.archive;

  const fakePage = { url: () => 'https://chatgpt.com/c/fix1-success-test' };
  const fileId = 'file_fix1success0000000000000000';

  cli._internal.openSession = async () => ({ browser: { newPage: async () => fakePage } });
  cli._internal.auth = async () => ({ loggedIn: true, summary: 'k' });
  // closeSession ALSO throws here: both cleanup steps in generate()'s
  // nested finally blocks must be independently swallowed.
  cli._internal.closeSession = async () => {
    throw new Error('EIO: close failed (simulated)');
  };
  capture.createRecorder = () => ({
    start() {},
    files() {
      return { [fileId]: Buffer.from('not really png bytes, just needs length > 0') };
    },
    url() {
      return '';
    },
    mime() {
      return 'image/png';
    },
    ids() {
      return [fileId];
    },
  });
  compose.newChat = async () => {};
  compose.send = async () => {};
  compose.waitDone = async () => ({
    loading: false,
    streaming: false,
    imageURLs: [`https://chatgpt.com/backend-api/estuary/content?id=${fileId}`],
    alts: ['Generated image: Fix1 Success Test'],
  });
  compose.archive = async () => {};

  t.after(() => {
    cli._internal.openSession = originalOpen;
    cli._internal.auth = originalAuth;
    cli._internal.closeSession = originalClose;
    capture.createRecorder = originalCreateRecorder;
    compose.newChat = originalNewChat;
    compose.send = originalSend;
    compose.waitDone = originalWaitDone;
    compose.archive = originalArchive;
  });

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-imagegen-fix1-out-'));
  const stdout = makeStream();
  const stderr = makeStream();

  // As above: run() directly, so a regression surfaces as an unhandled
  // rejection right here rather than a downstream assertion.
  const code = await run(['generate', '--prompt', 'a cat wearing a hat', '--out', outDir], stdout, stderr);

  const outText = stdout.toString();
  const parsed = assertSingleJsonLine(outText);
  assert.equal(parsed.ok, true, `expected ok:true to survive the throwing cleanups, got ${outText}`);
  assert.equal(parsed.images.length, 1);
  assert.equal(code, 0);
  assert.ok(stderr.toString().includes('cleanup failed (closeSession)'), 'closeSession failure must reach stderr');
  assert.ok(stderr.toString().includes('cleanup failed (releaseLock)'), 'releaseLock failure must reach stderr');
});

// --- salvageOutcome: the timeout-salvage decision, pinned directly -------
//
// This is the exact decision the Go final review found BROKEN: an earlier
// draft returned failure on waitDone's timeout before ever checking whether
// images had actually been produced, discarding real, already-paid-for
// images. It is extracted as a pure function (no browser, no stubs, no poll
// loop) precisely so this table can pin it directly, the same seam trick
// that already worked for capture.js's recordFinished and for safeRun.

function makeImages(n) {
  return Array.from({ length: n }, (_, i) => ({ path: `/tmp/img-${i}.png`, bytes: 1, width: 1, height: 1 }));
}

const CONV_URL = 'https://chatgpt.com/c/pinned-test-conversation';
const NO_IMAGE_MESSAGE = 'no generated image in the response';

const SALVAGE_CASES = [
  {
    name: 'not timed out, images present -> success, archiving allowed',
    timedOut: false,
    imageCount: 2,
    count: 2,
    wantKind: 'success',
    wantArchived: true,
  },
  {
    name: 'not timed out, no images -> NO_IMAGE_RETURNED',
    timedOut: false,
    imageCount: 0,
    count: 2,
    wantKind: 'failure',
    wantCode: 'NO_IMAGE_RETURNED',
  },
  {
    name: 'timed out, images present -> success, archiving never allowed',
    timedOut: true,
    imageCount: 2,
    count: 2,
    wantKind: 'success',
    wantArchived: false,
  },
  {
    name: 'timed out, no images -> TIMEOUT',
    timedOut: true,
    imageCount: 0,
    count: 2,
    wantKind: 'failure',
    wantCode: 'TIMEOUT',
  },
];

for (const c of SALVAGE_CASES) {
  test(`salvageOutcome: ${c.name}`, () => {
    const outcome = salvageOutcome({
      timedOut: c.timedOut,
      images: makeImages(c.imageCount),
      count: c.count,
      conversationUrl: CONV_URL,
      waitError: c.timedOut ? new Error('timed out after 360000ms') : null,
      noImageMessage: NO_IMAGE_MESSAGE,
    });
    assert.equal(outcome.kind, c.wantKind);
    if (c.wantKind === 'success') {
      assert.equal(outcome.archived, c.wantArchived);
    } else {
      assert.equal(outcome.code, c.wantCode);
      assert.equal(outcome.conversationUrl, CONV_URL);
    }
  });
}

test('salvageOutcome: timed out with 2 of 3 images -> success, archived false, warning names both counts', () => {
  const outcome = salvageOutcome({
    timedOut: true,
    images: makeImages(2),
    count: 3,
    conversationUrl: CONV_URL,
    waitError: new Error('timed out after 360000ms'),
    noImageMessage: NO_IMAGE_MESSAGE,
  });
  assert.equal(outcome.kind, 'success');
  assert.equal(outcome.archived, false);
  assert.match(outcome.warn, /\b2\b/);
  assert.match(outcome.warn, /\b3\b/);
});

test('salvageOutcome: timed out with 3 of 3 images -> still archived false (page never signalled completion)', () => {
  const outcome = salvageOutcome({
    timedOut: true,
    images: makeImages(3),
    count: 3,
    conversationUrl: CONV_URL,
    waitError: new Error('timed out after 360000ms'),
    noImageMessage: NO_IMAGE_MESSAGE,
  });
  assert.equal(outcome.kind, 'success');
  assert.equal(outcome.archived, false, 'a timed-out run must never be archived, even when it is fully complete');
});

test('salvageOutcome: not timed out with 2 of 3 images -> archiving allowed, shortfall warning still present', () => {
  const outcome = salvageOutcome({
    timedOut: false,
    images: makeImages(2),
    count: 3,
    conversationUrl: CONV_URL,
    waitError: null,
    noImageMessage: NO_IMAGE_MESSAGE,
  });
  assert.equal(outcome.kind, 'success');
  assert.equal(outcome.archived, true);
  assert.ok(outcome.warn, 'a shortfall warning must be present');
  assert.match(outcome.warn, /\b2\b/);
  assert.match(outcome.warn, /\b3\b/);
});

test('salvageOutcome: both failure kinds carry conversationUrl', () => {
  const timeoutFailure = salvageOutcome({
    timedOut: true,
    images: [],
    count: 1,
    conversationUrl: 'https://chatgpt.com/c/conv-1',
    waitError: new Error('timed out after 360000ms'),
    noImageMessage: NO_IMAGE_MESSAGE,
  });
  assert.equal(timeoutFailure.kind, 'failure');
  assert.equal(timeoutFailure.code, 'TIMEOUT');
  assert.equal(timeoutFailure.conversationUrl, 'https://chatgpt.com/c/conv-1');

  const noImageFailure = salvageOutcome({
    timedOut: false,
    images: [],
    count: 1,
    conversationUrl: 'https://chatgpt.com/c/conv-2',
    waitError: null,
    noImageMessage: NO_IMAGE_MESSAGE,
  });
  assert.equal(noImageFailure.kind, 'failure');
  assert.equal(noImageFailure.code, 'NO_IMAGE_RETURNED');
  assert.equal(noImageFailure.conversationUrl, 'https://chatgpt.com/c/conv-2');
});

test('salvageOutcome: images:[] with timedOut:false is NO_IMAGE_RETURNED, never TIMEOUT', () => {
  const outcome = salvageOutcome({
    timedOut: false,
    images: [],
    count: 1,
    conversationUrl: '',
    waitError: null,
    noImageMessage: NO_IMAGE_MESSAGE,
  });
  assert.equal(outcome.kind, 'failure');
  assert.equal(outcome.code, 'NO_IMAGE_RETURNED');
  assert.notEqual(outcome.code, 'TIMEOUT');
});

// --- selectors ----------------------------------------------------------

test('selectors: one JSON line carrying the shipped candidate lists', async () => {
  const stdout = makeStream();
  const stderr = makeStream();
  const code = await run(['selectors'], stdout, stderr);
  const parsed = assertSingleJsonLine(stdout.toString());
  assert.equal(parsed.ok, true);
  assert.equal(code, 0);

  // The field has to survive envelope.toJSON(), which is an allowlist: a
  // field it does not name is dropped, so the command would print a bare
  // {"ok":true} and the self-heal step would have nothing to read.
  assert.ok(parsed.selectors, 'selectors field was dropped from the JSON line');
  assert.ok(
    parsed.selectors.composer_input.length > 1,
    'shipped fallbacks must reach the caller intact'
  );
});

test('selectors: launches no browser', async () => {
  // Self-heal runs this mid-repair, when the page is already in a bad
  // state; it must not open Chrome or touch the user's profile.
  const stdout = makeStream();
  const stderr = makeStream();
  const original = cli._internal.openSession;
  cli._internal.openSession = () => {
    throw new Error('selectors must not open a session');
  };
  try {
    await run(['selectors'], stdout, stderr);
  } finally {
    cli._internal.openSession = original;
  }
  assert.equal(assertSingleJsonLine(stdout.toString()).ok, true);
});

test('every other command is still rejected the same way', async () => {
  const stdout = makeStream();
  const stderr = makeStream();
  await run(['selector'], stdout, stderr); // near-miss, not the real command
  assert.equal(assertSingleJsonLine(stdout.toString()).error.code, 'REFUSED');
});

// --- CDP protocol-timeout message ---------------------------------------

test('a puppeteer protocol timeout becomes something a user can act on', () => {
  // Observed live: a single CDP call stalled inside compose.send() and
  // puppeteer's own text reached the envelope verbatim, telling the user to
  // "Increase the 'protocolTimeout' setting in launch/connect calls" -- a
  // setting no user of this plugin can reach. The stall itself is a
  // transient in Chrome/ChatGPT and is not something this code can prevent;
  // reporting it honestly is.
  const raw =
    "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' " +
    'setting in launch/connect calls for a higher timeout if needed.';
  const msg = cli.describeCdpError(raw);
  assert.ok(!/protocolTimeout/.test(msg), `leaked puppeteer internals: ${msg}`);
  assert.ok(!/launch\/connect/.test(msg), `leaked puppeteer internals: ${msg}`);
  assert.match(msg, /stopped responding/i);
  // No-retry discipline: tell the user to re-run, never retry for them.
  assert.match(msg, /run .*again|re-?run/i);
});

test('an unrelated error message is passed through untouched', () => {
  assert.equal(cli.describeCdpError('attach refs: no such file'), 'attach refs: no such file');
  assert.equal(cli.describeCdpError(''), '');
  assert.equal(cli.describeCdpError(undefined), '');
});
