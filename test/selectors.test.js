'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { load, query, patch, save, userPath, shipped } = require('../src/selectors');

// productionKeys is every key the production code actually resolves or
// queries. It is exhaustive in BOTH directions on purpose: a key the code
// needs but the data lacks is a guaranteed runtime failure, and a key the
// data declares but no code reads is a selector that looks maintained, gets
// self-healed, and changes nothing.
const productionKeys = [
  'composer_input', // compose.Send
  'upload_input', // compose.Send, --ref/edit
  'attachment_remove', // compose.waitAttachmentsReady
  'loading_state', // compose.ReadState
  'stop_button', // compose.ReadState
  'generated_image', // compose.ReadState
  'conversation_options', // compose.Archive
];

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selectors-test-'));
  return path.join(dir, 'selectors.json');
}

test('load(embedded) has every known production key', () => {
  const s = load('');
  for (const k of productionKeys) {
    assert.ok((s[k] || []).length > 0, `embedded set missing key ${JSON.stringify(k)}`);
  }
});

// The other half: every embedded key must have a production reader. A
// declared-but-unused key is worse than a missing one, because self-heal
// will happily write a repair into it and the re-run will fail identically.
test('embedded set has no unused keys', () => {
  const s = load('');
  const used = new Set(productionKeys);
  for (const k of Object.keys(s)) {
    assert.ok(used.has(k), `embedded set declares key ${JSON.stringify(k)} that no production code reads; use it or delete it`);
  }
});

test('embedded set has the attachment_remove key, css form first', () => {
  const s = load('');
  assert.ok((s['attachment_remove'] || []).length > 0);
  const got = query(s, 'attachment_remove');
  assert.ok(got.length > 0, 'query returned no candidates');
  assert.equal(got[0], "button[aria-label*='Remove' i]");
});

// Pins the merge semantic the skill's self-heal instructions have to be
// written against. A key in the user file REPLACES that key's candidate
// list; it does not prepend to it. So the natural-looking patch -- one new
// candidate under one key -- silently deletes every shipped fallback for
// that key, and the next UI wobble that the fallback would have absorbed
// becomes a hard failure instead.
//
// The behaviour is intentional (a repair must be able to retire a shipped
// candidate that now matches the wrong element), so the fix is
// instructional, not behavioural: whoever writes the file must repeat the
// existing candidates after the new one. This test exists so that
// instruction can never quietly stop being true.
test('user override replaces the whole key, wholesale', () => {
  const p = tmpFile();

  const embedded = load('');
  assert.ok(
    (embedded['composer_input'] || []).length >= 2,
    `this test needs a key with fallbacks; composer_input has ${(embedded['composer_input'] || []).length}`
  );

  // The naive patch: one candidate, one key.
  fs.writeFileSync(p, '{"composer_input":[{"css":"#new"}]}');
  const naive = load(p);
  const naiveGot = query(naive, 'composer_input');
  assert.deepEqual(naiveGot, ['#new'], 'the user file must replace a key wholesale');

  // The correct patch: the new candidate FOLLOWED BY the shipped ones.
  fs.writeFileSync(
    p,
    '{"composer_input":[{"css":"#new"},{"css":"#prompt-textarea"},{"testid":"prompt-textarea"},{"css":"div[contenteditable=\'true\']"}]}'
  );
  const merged = load(p);
  const got = query(merged, 'composer_input');
  assert.equal(got.length, query(embedded, 'composer_input').length + 1);
  assert.equal(got[0], '#new');
  assert.equal(got[1], '#prompt-textarea');
});

test('query orders testid before css', () => {
  const s = { k: [{ testid: 'the-testid' }, { css: '#fallback' }] };
  const got = query(s, 'k');
  assert.deepEqual(got, ['[data-testid="the-testid"]', '#fallback']);
});

test('user override wins and patch round-trips through save/load', () => {
  const p = tmpFile();
  fs.writeFileSync(p, '{"composer_input":[{"css":"#patched"}]}');

  const s = load(p);
  const got = query(s, 'composer_input');
  assert.ok(got.length > 0 && got[0] === '#patched', `user override ignored: ${JSON.stringify(got)}`);

  // Keys absent from the override still come from the embedded defaults.
  assert.ok((s['stop_button'] || []).length > 0, 'override must merge over defaults, not replace the whole set');
  const embedded = load('');
  assert.equal(s['stop_button'].length, embedded['stop_button'].length);

  // A patch persists and reloads.
  patch(s, 'stop_button', { css: '#stopped' });
  save(s, p);
  const again = load(p);
  assert.equal(query(again, 'stop_button')[0], '#stopped');
});

test('save writes only the delta from embedded defaults', () => {
  const p = tmpFile();
  const s = load('');
  patch(s, 'stop_button', { css: '#stopped' });
  save(s, p);

  const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(Object.keys(saved).length, 1, `save wrote ${Object.keys(saved).length} keys, want 1; keys: ${Object.keys(saved)}`);
  assert.ok((saved['stop_button'] || []).length > 0, 'saved file missing patched key');
});

test('a non-patched key stays embedded after save/reload', () => {
  const p = tmpFile();
  const s = load('');
  patch(s, 'stop_button', { css: '#stopped' });
  save(s, p);

  const reloaded = load(p);
  const embedded = load('');
  assert.equal(
    reloaded['composer_input'].length,
    embedded['composer_input'].length,
    'non-patched key shadowed'
  );
});

test('an upgraded default stays visible through a user file that patches a different key', () => {
  const p = tmpFile();
  fs.writeFileSync(p, '{"stop_button":[{"css":"#custom"}]}');

  const s = load(p);
  const embedded = load('');
  assert.ok((s['composer_input'] || []).length > 0, 'key absent from user file should come from embedded');
  assert.equal(s['composer_input'].length, embedded['composer_input'].length);
});

test('save includes keys not present in embedded', () => {
  const p = tmpFile();
  const s = { new_custom_key: [{ css: '#custom' }] };
  save(s, p);

  const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok((saved['new_custom_key'] || []).length > 0, 'save should include keys not in embedded defaults');
});

test('a malformed user file throws, never falls back to defaults silently', () => {
  const p = tmpFile();
  fs.writeFileSync(p, '{not valid json');
  assert.throws(() => load(p));
});

test('userPath returns a non-empty path', () => {
  const p = userPath();
  assert.ok(p, 'userPath should return a non-empty path');
});

// esbuild's JSON loader only inlines a require() of a literal ".json" path
// at bundle time; a computed path or a runtime fs.readFileSync would force
// a file lookup instead. Task 10 wires the actual esbuild bundle and can
// exercise loading the real bundled artifact; until then, this pins the two
// preconditions that make that inlining possible so a later change to this
// file cannot regress it silently.
test('selectors.json is required via a static path, not a runtime file read (bundle-inlinable)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'selectors.js'), 'utf8');
  assert.match(
    src,
    /require\(['"]\.\/selectors\.json['"]\)/,
    'expected a static require of ./selectors.json so esbuild can inline it'
  );
  assert.doesNotMatch(
    src,
    /readFileSync\([^)]*selectors\.json/,
    'the embedded defaults must not be loaded via a runtime file read -- that defeats esbuild inlining'
  );
});

test('shipped() returns the embedded defaults', () => {
  const set = shipped();
  assert.ok(Object.keys(set).length > 0, 'expected at least one shipped key');
  assert.ok(
    set.composer_input.length > 1,
    'composer_input must ship more than one candidate -- the layered fallback ' +
      'is the whole reason self-heal has to carry shipped candidates through'
  );
});

test('shipped() hands out an independent copy each call', () => {
  // Same hazard cloneSet() exists for: `embedded` is one cached object, so
  // returning a reference would let a caller mutate the defaults for every
  // later load in the process.
  const first = shipped();
  first.composer_input.length = 0;
  first.injected_key = [{ css: '.nope' }];
  const second = shipped();
  assert.ok(second.composer_input.length > 1, 'defaults were mutated by a caller');
  assert.strictEqual(second.injected_key, undefined);
});
