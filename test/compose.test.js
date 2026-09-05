'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SelectorMissError,
  WaitTimeoutError,
  attachmentsReady,
  attachTimeoutError,
  joinQuery,
  stateScript,
  KEY_LOADING_STATE,
  KEY_STOP_BUTTON,
  KEY_GENERATED_IMAGE,
} = require('../src/compose');

// --- SelectorMissError ------------------------------------------------

test('SelectorMissError carries the key and is distinguishable from a generic error', () => {
  const err = new SelectorMissError('composer_input');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof SelectorMissError);
  assert.equal(err.selectorKey, 'composer_input');
  assert.equal(err.code, 'SELECTOR_MISS');
  assert.match(err.message, /composer_input/);

  const generic = new Error('boom');
  assert.ok(!(generic instanceof SelectorMissError));
  assert.notEqual(generic.code, 'SELECTOR_MISS');
});

test('SelectorMissError appends detail to the message when given', () => {
  const err = new SelectorMissError('attachment_remove', 'saw 0 of 1 removal controls after 60000ms');
  assert.match(err.message, /no selector matched for attachment_remove/);
  assert.match(err.message, /saw 0 of 1 removal controls/);
  assert.equal(err.detail, 'saw 0 of 1 removal controls after 60000ms');
});

test('SelectorMissError omits the trailing colon when no detail is given', () => {
  const err = new SelectorMissError('stop_button');
  assert.equal(err.message, 'no selector matched for stop_button');
});

// --- attachment upload gating -------------------------------------------

// attachmentsReady is the pure decision behind waitAttachmentsReady's poll
// loop: proceed once at least one removal control exists per attached
// file, never before.
test('attachmentsReady requires at least one removal control per file', () => {
  assert.equal(attachmentsReady(0, 1), false);
  assert.equal(attachmentsReady(1, 1), true);
  assert.equal(attachmentsReady(1, 2), false);
  assert.equal(attachmentsReady(2, 2), true);
  assert.equal(attachmentsReady(3, 2), true, 'more controls than files still counts as ready');
});

// attachTimeoutError is the ONE selector key with no spike provenance --
// it must throw a SelectorMissError (self-healable), never a plain/generic
// timeout error that would be mapped to TIMEOUT and put out of reach of
// the probe and the skill's self-heal.
test('attachTimeoutError is a SelectorMissError for attachment_remove carrying the observed counts', () => {
  const err = attachTimeoutError(0, 2, 60000);
  assert.ok(err instanceof SelectorMissError);
  assert.equal(err.selectorKey, 'attachment_remove');
  assert.equal(err.code, 'SELECTOR_MISS');
  assert.match(err.message, /0 of 2/);
  assert.match(err.message, /60000ms/);
});

// --- WaitTimeoutError -----------------------------------------------------

test('WaitTimeoutError carries the last observed state so timed-out-but-salvageable runs are not discarded', () => {
  const state = { loading: false, streaming: false, imageURLs: ['x'], alts: ['Generated image: X'] };
  const err = new WaitTimeoutError(120000, state);
  assert.equal(err.code, 'TIMEOUT');
  assert.equal(err.state, state);
  assert.match(err.message, /120000ms/);
});

// --- joinQuery / stateScript -----------------------------------------------

function selectorSet(overrides) {
  const base = {
    [KEY_GENERATED_IMAGE]: [{ css: "img[alt^='Generated image: ']" }],
    [KEY_LOADING_STATE]: [{ testid: 'loading-spinner' }],
    [KEY_STOP_BUTTON]: [{ css: "button[data-testid='stop-button']" }],
  };
  return Object.assign(base, overrides);
}

test('joinQuery throws a SelectorMissError for a key with no usable candidate', () => {
  const set = { [KEY_GENERATED_IMAGE]: [] };
  assert.throws(() => joinQuery(set, KEY_GENERATED_IMAGE), SelectorMissError);
  try {
    joinQuery(set, KEY_GENERATED_IMAGE);
    assert.fail('expected joinQuery to throw');
  } catch (err) {
    assert.ok(err instanceof SelectorMissError);
    assert.equal(err.selectorKey, KEY_GENERATED_IMAGE);
  }
});

test('joinQuery joins a key\'s candidates into one JSON-encoded selector list', () => {
  const set = {
    multi: [{ css: '#a' }, { testid: 'b' }],
  };
  const got = joinQuery(set, 'multi');
  // The result must be a JSON string literal (quoted) so it can be spliced
  // straight into a script as a selector-list argument.
  assert.equal(got, JSON.stringify('#a,[data-testid="b"]'));
  assert.equal(JSON.parse(got), '#a,[data-testid="b"]');
});

test('stateScript embeds each key\'s joined candidates and is syntactically valid', () => {
  const set = selectorSet();
  const script = stateScript(set);

  assert.ok(script.includes(joinQuery(set, KEY_GENERATED_IMAGE)));
  assert.ok(script.includes(joinQuery(set, KEY_LOADING_STATE)));
  assert.ok(script.includes(joinQuery(set, KEY_STOP_BUTTON)));

  // The script is a `() => {...}` literal; wrapped as an expression it must
  // parse without throwing.
  assert.doesNotThrow(() => new Function(`return (${script})`));
});

// A selector containing a double quote (a plausible attribute-value
// selector like button[aria-label="Remove"]) must be escaped so it cannot
// break out of the generated script and produce invalid/dangerous JS.
test('stateScript safely escapes a selector containing a double quote', () => {
  const set = selectorSet({
    [KEY_STOP_BUTTON]: [{ css: 'button[aria-label="Stop generating"]' }],
  });
  const script = stateScript(set);

  // Must still be syntactically valid JS.
  assert.doesNotThrow(() => new Function(`return (${script})`), `script was not valid JS:\n${script}`);

  // The selector's double quotes must have been escaped, not left to
  // terminate the JSON string literal early.
  assert.ok(script.includes('\\"Stop generating\\"') || script.includes(JSON.stringify('button[aria-label="Stop generating"]')));
});

test('stateScript throws a SelectorMissError when a required key has no candidates', () => {
  const set = selectorSet({ [KEY_STOP_BUTTON]: [] });
  assert.throws(() => stateScript(set), SelectorMissError);
});
