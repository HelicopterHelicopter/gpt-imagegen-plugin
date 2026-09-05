'use strict';

const { launchTestBrowser } = require('./browser-helper.js');

// Fixture regression tests: the ONLY test in this project that can warn a
// maintainer that ChatGPT changed its DOM (or that our selectors drifted
// from it). Everything else in this repo is unit-level and never touches a
// real DOM shape. Runs against saved fixture HTML over file:// -- no
// network, no ChatGPT account. Port of tests/fixture_test.go.
//
// Skips cleanly (never fails) when no Chrome-family browser is available,
// mirroring fixturePage's t.Skipf in the Go source.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const { chromePath } = require('../src/session');
const selectors = require('../src/selectors');
const compose = require('../src/compose');
const { distinctImageIds, altForId, done } = require('../src/state');

// The single generated file in fixtures/conversation.html, rendered through
// two <img> tags the way ChatGPT actually renders a generation. Keep these
// in sync with the fixture HTML by hand -- the same duplication tests/
// fixture_test.go carries, and for the same reason: a golden-file test's
// expectations live next to its input.
const IMG_A_ID = 'file_00000000e7148208927dc5bbece7a546';
const IMG_A_ALT = 'Generated image: Geometric Teal Mountain Emblem';

// The second, different generated file added in
// fixtures/conversation_multi_image.html -- what makes the AltForID check
// meaningful rather than trivial (a page with only one image would pass
// even with the id/alt pairing broken).
const IMG_B_ID = 'file_9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const IMG_B_ALT = 'Generated image: Sunset Origami Crane';

// A real ChatGPT UI asset URL placed in conversation.html next to the
// generated image. It must never show up in ReadState's imageURLs or
// contribute an id to distinctImageIds.
const NON_GENERATED_SRC = 'https://chatgpt.com/cdn/assets/sprites-core-9b910f5e.svg';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function fixtureUrl(name) {
  return 'file://' + path.join(FIXTURES_DIR, name);
}

// Resolved once at module load. chromePath() throws when no Chrome-family
// browser exists anywhere the resolver knows to look (well-known install
// paths, $PATH, $GPT_IMAGEGEN_CHROME); every test below skips cleanly in
// that case rather than failing.
let chromeBin;
try {
  chromeBin = chromePath();
} catch {
  chromeBin = null;
}
const skipReason = chromeBin ? false : 'no Chrome-family browser available for the fixture tests';

/**
 * Launches a throwaway headless browser, loads `fixture` over file://, and
 * runs `fn(page)`, returning its result.
 *
 * Deliberately does NOT set a userDataDir: a throwaway browser is correct
 * for a fixture test, and pointing it at the real ~/.gpt-imagegen profile
 * would risk the user's actual ChatGPT login. The browser is always closed
 * in a finally, so a failing assertion inside fn can never leak a Chrome
 * process.
 */
async function withFixturePage(fixture, fn) {
  const browser = await launchTestBrowser(chromeBin);
  try {
    const page = await browser.newPage();
    await page.goto(fixtureUrl(fixture), { waitUntil: 'load' });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

function loadSelectors() {
  return selectors.load('');
}

/** Resolves `key` against `page` and fails with the real error, if any. */
async function assertResolves(page, set, key) {
  try {
    await compose.resolve(page, set, key, 5000);
  } catch (err) {
    assert.fail(`selector ${JSON.stringify(key)} no longer resolves: ${err.message}`);
  }
}

test(
  'every selector key production depends on (on a finished conversation) resolves against the fixture',
  { skip: skipReason },
  async () => {
    await withFixturePage('conversation.html', async (page) => {
      const set = loadSelectors();
      // The two completion-only keys (loading_state, stop_button) cannot be
      // asserted here: their whole meaning is "a generation is still
      // running", so they are covered by the next test against the
      // generating fixture. Between the two tests every key in
      // selectors.json is covered -- the property that makes this a drift
      // detector rather than a spot check.
      const keys = [
        'composer_input',
        'upload_input',
        'generated_image',
        'conversation_options',
        'attachment_remove',
      ];
      for (const key of keys) {
        await assertResolves(page, set, key);
      }
    });
  }
);

test(
  'the completion selectors (loading_state, stop_button) resolve against a generating conversation',
  { skip: skipReason },
  async () => {
    await withFixturePage('conversation_generating.html', async (page) => {
      const set = loadSelectors();
      await assertResolves(page, set, 'loading_state');
      await assertResolves(page, set, 'stop_button');
    });
  }
);

test(
  'a generating conversation reads as NOT done: loading and streaming are both true and nothing has arrived',
  { skip: skipReason },
  async () => {
    await withFixturePage('conversation_generating.html', async (page) => {
      const set = loadSelectors();
      const st = await compose.readState(page, set);

      assert.equal(st.loading, true, 'loading_state must be reported while an image generation is in flight');
      assert.equal(st.streaming, true, 'stop_button must be reported while the turn is still streaming');
      assert.deepEqual(st.imageURLs, [], 'no image has arrived yet');
      assert.equal(done(st, 1), false, 'done must be false while the page is still generating');
    });
  }
);

test(
  'a finished single-image conversation reads quiet and collapses its two <img> tags to one distinct id',
  { skip: skipReason },
  async () => {
    await withFixturePage('conversation.html', async (page) => {
      const set = loadSelectors();
      const st = await compose.readState(page, set);

      assert.equal(st.loading, false, 'finished conversation must be quiet (loading)');
      assert.equal(st.streaming, false, 'finished conversation must be quiet (streaming)');

      // The fixture's assistant-avatar <img> is NOT a generated image (its
      // alt does not start with "Generated image: "). It must contribute
      // nothing: not to the raw tag list ReadState extracts here, and (a
      // few lines down) not to distinctImageIds.
      assert.ok(
        !st.imageURLs.includes(NON_GENERATED_SRC),
        `non-generated image leaked into imageURLs: ${JSON.stringify(st.imageURLs)}`
      );

      // Two <img> tags point at the same underlying generated file: this is
      // the property that stops the tool saving the same image twice.
      assert.equal(
        st.imageURLs.length,
        2,
        `expected exactly the 2 tags for the one generated file, got: ${JSON.stringify(st.imageURLs)}`
      );

      const ids = distinctImageIds(st);
      assert.deepEqual(ids, [IMG_A_ID], `distinctImageIds = ${JSON.stringify(ids)}, want exactly [${IMG_A_ID}]`);

      assert.equal(done(st, 1), true, 'done must be true for a finished single-image conversation');
      assert.equal(done(st, 2), false, 'done must be false when a set of 2 was requested but only 1 arrived');

      // altForId must return the shared alt text for the id, regardless of
      // which of the two <img> tags it is read from.
      assert.equal(altForId(st, IMG_A_ID), IMG_A_ALT);
    });
  }
);

test(
  'altForId distinguishes two different generated images on the multi-image fixture',
  { skip: skipReason },
  async () => {
    await withFixturePage('conversation_multi_image.html', async (page) => {
      const set = loadSelectors();
      const st = await compose.readState(page, set);

      assert.equal(st.loading, false, 'finished conversation must be quiet (loading)');
      assert.equal(st.streaming, false, 'finished conversation must be quiet (streaming)');

      const ids = distinctImageIds(st);
      assert.deepEqual(
        ids,
        [IMG_A_ID, IMG_B_ID],
        `distinctImageIds = ${JSON.stringify(ids)}, want exactly [${IMG_A_ID}, ${IMG_B_ID}]`
      );

      assert.equal(done(st, 2), true, 'done must be true once both requested images have arrived');
      assert.equal(done(st, 3), false, 'done must be false when a set of 3 was requested but only 2 arrived');

      // This is what makes the check meaningful rather than trivial: on a
      // page with only one image, returning "the only alt on the page"
      // would pass even with the id/alt pairing broken.
      assert.equal(altForId(st, IMG_A_ID), IMG_A_ALT);
      assert.equal(altForId(st, IMG_B_ID), IMG_B_ALT);
    });
  }
);

test(
  'selectAllInBrowser runs on the real contenteditable composer and returns true',
  { skip: skipReason },
  async () => {
    await withFixturePage('conversation.html', async (page) => {
      const set = loadSelectors();
      const el = await compose.resolve(page, set, 'composer_input', 5000);

      // This is the single most important assertion in this file. The
      // equivalent Go bug -- a select-all helper that called the DOM
      // `.select()` method, which a contenteditable <div> does not have --
      // threw `this.select is not a function` against the composer on
      // EVERY real run, and was caught only by the live smoke, after unit
      // tests, fixture tests and two reviews had all already passed. The
      // fixture's composer (#prompt-textarea, contenteditable="true") is
      // the same shape as the real one, so evaluating the exact function
      // production calls (compose.selectAllInBrowser) against it here is
      // what would have caught that bug offline.
      const ok = await el.evaluate(compose.selectAllInBrowser);
      assert.equal(ok, true, "selectAllInBrowser must select a contenteditable composer's contents and return true");
    });
  }
);
