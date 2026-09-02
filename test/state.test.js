'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseState, distinctImageIds, altForId, done } = require('../src/state');

const oneImage = `{"loading":false,"streaming":false,
"imageURLs":["https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs&sig=x"],
"alts":["Generated image: Teal Mountain"]}`;

test('parseState', () => {
  const s = parseState(oneImage);
  assert.equal(s.loading, false);
  assert.equal(s.streaming, false);
  assert.equal(s.imageURLs.length, 1);
});

test('parseState throws on malformed input, never falls back silently', () => {
  assert.throws(() => parseState('{not valid json'));
});

test('distinctImageIds', () => {
  // The spike saw the same generated image rendered by three <img> tags.
  const s = {
    imageURLs: [
      'https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs',
      'https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs',
      'https://chatgpt.com/backend-api/estuary/content?id=file_bbb&p=fs',
      'https://chatgpt.com/cdn/assets/favicon-x.svg',
    ],
    alts: [],
  };
  const got = distinctImageIds(s);
  assert.deepEqual(got, ['file_aaa', 'file_bbb']);
});

// The exact drift scenario: a generated image rendered through two <img>
// tags (file_aaa twice) followed by a second distinct image (file_bbb).
// distinctImageIds collapses this to [file_aaa, file_bbb], but alts stays
// parallel to the raw, undeduplicated imageURLs ([Foo, Foo, Bar]). An
// index-based lookup (alts[i] where i is the position in the deduplicated
// id list) gives file_bbb -> alts[1] == "Foo", which is wrong: file_bbb's
// own alt is alts[2] == "Bar". Ported verbatim from
// TestAltForID_DriftCase in internal/compose/state_test.go; it must fail
// against an index-based implementation.
test('altForId walks imageURLs and alts together, keyed by id (drift case)', () => {
  const s = {
    imageURLs: [
      'https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs',
      'https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs',
      'https://chatgpt.com/backend-api/estuary/content?id=file_bbb&p=fs',
    ],
    alts: ['Generated image: Foo', 'Generated image: Foo', 'Generated image: Bar'],
  };
  assert.equal(altForId(s, 'file_aaa'), 'Generated image: Foo');
  assert.equal(altForId(s, 'file_bbb'), 'Generated image: Bar');
});

test('altForId returns empty for an unknown id', () => {
  const s = {
    imageURLs: ['https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs'],
    alts: ['Generated image: Foo'],
  };
  assert.equal(altForId(s, 'file_zzz'), '');
});

test('altForId does not throw when alts is shorter than imageURLs', () => {
  const s = {
    imageURLs: [
      'https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs',
      'https://chatgpt.com/backend-api/estuary/content?id=file_bbb&p=fs',
    ],
    alts: ['Generated image: Foo'], // shorter than imageURLs
  };
  assert.equal(altForId(s, 'file_aaa'), 'Generated image: Foo');
  assert.equal(altForId(s, 'file_bbb'), '');
});

// Guards against a non-generated tag (a favicon, which fileIdFromUrl maps
// to '') shifting the pairing between generated ids and their alts.
test('altForId is unaffected by a non-generated url interleaved', () => {
  const s = {
    imageURLs: [
      'https://chatgpt.com/cdn/assets/favicon-x.svg',
      'https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs',
      'https://chatgpt.com/backend-api/estuary/content?id=file_bbb&p=fs',
    ],
    alts: ['', 'Generated image: Foo', 'Generated image: Bar'],
  };
  assert.equal(altForId(s, 'file_aaa'), 'Generated image: Foo');
  assert.equal(altForId(s, 'file_bbb'), 'Generated image: Bar');
});

test('done requires quiet and enough distinct images', () => {
  const img = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(`https://chatgpt.com/backend-api/estuary/content?id=file_${String.fromCharCode(97 + i)}&p=fs`);
    }
    return out;
  };
  const cases = [
    { name: 'still loading', s: { loading: true, streaming: false, imageURLs: img(1), alts: [] }, want: 1, expect: false },
    { name: 'still streaming', s: { loading: false, streaming: true, imageURLs: img(1), alts: [] }, want: 1, expect: false },
    { name: 'quiet but no image', s: { loading: false, streaming: false, imageURLs: [], alts: [] }, want: 1, expect: false },
    { name: 'quiet with image', s: { loading: false, streaming: false, imageURLs: img(1), alts: [] }, want: 1, expect: true },
    { name: 'set incomplete', s: { loading: false, streaming: false, imageURLs: img(2), alts: [] }, want: 3, expect: false },
    { name: 'set complete', s: { loading: false, streaming: false, imageURLs: img(3), alts: [] }, want: 3, expect: true },
  ];
  for (const c of cases) {
    assert.equal(done(c.s, c.want), c.expect, c.name);
  }
});
