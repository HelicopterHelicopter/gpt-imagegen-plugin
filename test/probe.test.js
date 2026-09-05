'use strict';

const { launchTestBrowser } = require('./browser-helper.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const { actionable, sanitizeStage, writeDump, collect, DUMP_NOTE } = require('../src/probe');
const { chromePath } = require('../src/session');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
}

test('writeDump round-trips valid JSON into the given dir', () => {
  const dir = tmpDir();
  const cands = [
    { testid: 'stop-button', role: 'button', name: 'Stop', css: "button[data-testid='stop-button']" },
    { css: '#prompt-textarea', text: '' },
  ];
  const p = writeDump(dir, 'composer', 'https://chatgpt.com/c/abc', cands);

  assert.equal(path.dirname(p), dir, `dump written outside dir: ${p}`);

  const raw = fs.readFileSync(p, 'utf8');
  const back = JSON.parse(raw);

  assert.equal(back.stage, 'composer');
  assert.equal(back.url, 'https://chatgpt.com/c/abc');
  assert.equal(back.candidates.length, 2);
  assert.equal(back.candidates[0].testid, 'stop-button');
  assert.equal(back.candidates[0].css, "button[data-testid='stop-button']");
  assert.equal(back.candidates[1].css, '#prompt-textarea');

  // The dump has to carry its own instructions: the agent reading it is one
  // step removed from this codebase, and the trap it must avoid (copying
  // role/name into selectors.json, or replacing a key with a single
  // candidate) is invisible from the data alone.
  assert.ok(back.note, 'dump must carry the note explaining which fields are actionable');
  for (const want of ['testid', 'css', 'role', 'actionable']) {
    assert.ok(
      back.note.toLowerCase().includes(want),
      `note does not mention ${JSON.stringify(want)}: ${back.note}`
    );
  }
});

test('DUMP_NOTE mentions the actionable fields', () => {
  for (const want of ['testid', 'css', 'role', 'actionable']) {
    assert.ok(DUMP_NOTE.toLowerCase().includes(want));
  }
});

// The resolver understands testid and css and nothing else, so a candidate
// described only by role/name/text is a dead end. Copying one into
// selectors.json produces a key with no query -- written without error,
// failing identically on re-run -- which is exactly the silent no-op
// self-heal must avoid.
test('actionable marks only copyable candidates', () => {
  const cases = [
    { name: 'testid', c: { testid: 'stop-button' }, want: true },
    { name: 'css', c: { css: '#prompt-textarea' }, want: true },
    { name: 'role and name only', c: { role: 'button', name: 'Send prompt' }, want: false },
    { name: 'text only', c: { text: 'Send' }, want: false },
    { name: 'empty', c: {}, want: false },
  ];
  for (const c of cases) {
    assert.equal(actionable(c.c), c.want, `actionable(${JSON.stringify(c.c)}) for case ${c.name}`);
  }
});

// Pins the field names the probe emits to the ones selectors.js
// understands. If these drift, a candidate copied verbatim out of a dump
// stops being a working patch and self-heal silently no-ops.
test('candidate JSON matches the selectors.js candidate shape', () => {
  const dir = tmpDir();
  const p = writeDump(dir, 'composer', 'https://example.com', [
    { testid: 't', css: '#c', role: 'button', name: 'n', text: 'x' },
  ]);
  const back = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cand = back.candidates[0];
  assert.equal(cand.testid, 't');
  assert.equal(cand.css, '#c');
});

// Guards against a stage value escaping dir via path traversal. writeDump
// is called with caller-controlled strings, so a stage like
// "../../etc/passwd" must not be able to write outside the given dir.
test('writeDump sanitises stage against path traversal', () => {
  const cases = [
    { name: 'plain', stage: 'composer' },
    { name: 'traversal', stage: '../../etc/passwd' },
    { name: 'nested_separator', stage: 'a/b' },
    { name: 'dotdot_alone', stage: '..' },
    { name: 'empty', stage: '' },
  ];
  for (const c of cases) {
    const dir = tmpDir();
    const p = writeDump(dir, c.stage, 'https://example.com', []);
    assert.equal(
      path.dirname(p),
      dir,
      `stage ${JSON.stringify(c.stage)} escaped dir: got path ${JSON.stringify(p)}, want it inside ${JSON.stringify(dir)}`
    );
    assert.ok(fs.existsSync(p), `dump file not created at ${p}`);
  }
});

test('sanitizeStage never returns a value containing a path separator or ".."', () => {
  const inputs = ['composer', '../../etc/passwd', 'a/b', '..', '', '.', '/etc/passwd', '../../../x'];
  for (const stage of inputs) {
    const got = sanitizeStage(stage);
    assert.ok(got.length > 0, `sanitizeStage(${JSON.stringify(stage)}) returned empty`);
    assert.ok(!got.includes('/'), `sanitizeStage(${JSON.stringify(stage)}) => ${JSON.stringify(got)} still has a separator`);
    assert.ok(!got.includes('..'), `sanitizeStage(${JSON.stringify(stage)}) => ${JSON.stringify(got)} still has ".."`);
  }
});

// --- FIX 3: a hidden input[type=file] must survive the zero-rect filter --
//
// ChatGPT's upload control is a hidden input[type=file] (compose.send
// drives it via uploadFile(), never a click, precisely because it is never
// visible). getBoundingClientRect() on a hidden element is {0,0}, so the
// rect filter that otherwise correctly keeps landmine button/div
// candidates out would also drop the ONE element the --ref/edit path's
// upload_input key needs. A SELECTOR_MISS on that key would then produce a
// probe dump with no candidate at all, leaving the documented self-heal
// loop nothing to repair it with -- structurally unrepairable. Runs
// against a real headless browser (skips cleanly, same as fixture.test.js,
// when no Chrome-family browser is available) because getBoundingClientRect
// is a real layout computation jsdom does not reliably reproduce.

let chromeBin;
try {
  chromeBin = chromePath();
} catch {
  chromeBin = null;
}
const skipReason = chromeBin ? false : 'no Chrome-family browser available for this test';

test(
  'collect() still reports a hidden input[type=file] as an actionable candidate',
  { skip: skipReason },
  async () => {
    const browser = await launchTestBrowser(chromeBin);
    try {
      const page = await browser.newPage();
      // display:none, exactly like a real hidden file input: width and
      // height both compute to 0, which is what the rect filter looks at.
      await page.setContent(
        '<!doctype html><html><body>' +
          '<input type="file" data-testid="upload-photos-input" style="display:none">' +
          '</body></html>'
      );

      const cands = await collect(page);
      const hit = cands.find((c) => c.testid === 'upload-photos-input');

      assert.ok(hit, `expected a candidate for the hidden file input, got: ${JSON.stringify(cands)}`);
      assert.ok(
        actionable(hit),
        `candidate for the hidden file input must be actionable (testid or css): ${JSON.stringify(hit)}`
      );
    } finally {
      await browser.close();
    }
  }
);
