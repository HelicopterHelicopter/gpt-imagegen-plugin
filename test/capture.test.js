'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRecorder,
  recordFinished,
  fetchInPage,
  decode,
  dimensions,
} = require('../src/capture');
const { extFor } = require('../src/naming');

// A 1x1 PNG, used to prove the decode and dimension paths without a browser.
// Same fixture as the Go port's capture_test.go.
const ONE_PX_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const GEN_URL = (id) => `https://chatgpt.com/backend-api/estuary/content?id=${id}&p=fs&sig=x`;

// --- decode ---------------------------------------------------------------

test('decode', async (t) => {
  await t.test('valid base64', () => {
    const got = decode(ONE_PX_PNG_B64, true);
    const want = Buffer.from(ONE_PX_PNG_B64, 'base64');
    assert.ok(got.equals(want));
  });

  await t.test('raw (non-base64) body', () => {
    const got = decode('plain', false);
    assert.equal(got.toString('binary'), 'plain');
  });

  await t.test('raw Buffer body passes through untouched', () => {
    const buf = Buffer.from([1, 2, 3]);
    assert.strictEqual(decode(buf, false), buf);
  });

  await t.test('invalid base64 throws rather than silently corrupting', () => {
    assert.throws(() => decode('!!!not base64!!!', true));
  });
});

// --- dimensions -------------------------------------------------------------

test('dimensions', async (t) => {
  await t.test('PNG', () => {
    const png = Buffer.from(ONE_PX_PNG_B64, 'base64');
    const { width, height } = dimensions(png);
    assert.equal(width, 1);
    assert.equal(height, 1);
  });

  await t.test('JPEG', () => {
    // Minimal baseline JPEG: SOI, SOF0 (8-bit, 16 tall x 32 wide, 1
    // component), EOI. Enough for a header-only parse; not a decodable
    // image, which is fine since dimensions() never decodes pixel data.
    const jpeg = Buffer.from([
      0xff, 0xd8, // SOI
      0xff, 0xc0, // SOF0
      0x00, 0x0b, // segment length = 11
      0x08, // precision
      0x00, 0x10, // height = 16
      0x00, 0x20, // width = 32
      0x01, // 1 component
      0x01, 0x11, 0x00, // component id, sampling, quant table
      0xff, 0xd9, // EOI
    ]);
    const { width, height } = dimensions(jpeg);
    assert.equal(width, 32);
    assert.equal(height, 16);
  });

  await t.test('WebP (lossy VP8)', () => {
    // RIFF/WEBP container with a single VP8 chunk: 3-byte frame tag, the
    // VP8 start code (0x9d 0x01 0x2a), then 64x48 packed as little-endian
    // 14-bit width/height.
    const chunkData = Buffer.from([
      0x00, 0x00, 0x00, // frame tag
      0x9d, 0x01, 0x2a, // start code
      0x40, 0x00, // width = 64
      0x30, 0x00, // height = 48
    ]);
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      u32le(4 + 8 + chunkData.length), // 'WEBP' + chunk header + chunk data
      Buffer.from('WEBP', 'ascii'),
      Buffer.from('VP8 ', 'ascii'),
      u32le(chunkData.length),
      chunkData,
    ]);
    const { width, height } = dimensions(webp);
    assert.equal(width, 64);
    assert.equal(height, 48);
  });

  await t.test('WebP (lossless VP8L)', () => {
    // width-1=79 (0x4F), height-1=59 (0x3B) packed into 14+14 bits LE.
    const width = 80;
    const height = 60;
    const bits = (width - 1) | ((height - 1) << 14);
    const chunkData = Buffer.concat([Buffer.from([0x2f]), u32le(bits)]);
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      u32le(4 + 8 + chunkData.length),
      Buffer.from('WEBP', 'ascii'),
      Buffer.from('VP8L', 'ascii'),
      u32le(chunkData.length),
      chunkData,
    ]);
    const got = dimensions(webp);
    assert.equal(got.width, 80);
    assert.equal(got.height, 60);
  });

  await t.test('non-image throws', () => {
    assert.throws(() => dimensions(Buffer.from('not an image')));
  });
});

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

// --- extFor (src/naming.js; sanity check that capture-adjacent code agrees) -

test('extFor', () => {
  assert.equal(extFor('image/png'), '.png');
  assert.equal(extFor('image/webp'), '.webp');
  assert.equal(extFor('image/jpeg'), '.jpg');
  assert.equal(extFor('image/gif'), '.png'); // unknown types fall back to png
});

// --- recordFinished: the actual response-handler logic ---------------------
//
// These drive recordFinished directly with a stub fetchBody, exercising the
// exact logic that had the eviction bug, without a browser.

test('recordFinished: fetch failure keeps url+mime but not bytes (eviction case)', async () => {
  const rec = createRecorder(null);
  const url = GEN_URL('file_abc');

  await recordFinished(rec, { url, mime: 'image/webp' }, async () => {
    throw new Error('buffer evicted');
  });

  assert.equal(rec.mime('file_abc'), 'image/webp', 'mime must be the real one, not the png default');
  assert.equal(rec.url('file_abc'), url);
  assert.deepEqual(rec.ids(), ['file_abc']);
  assert.deepEqual(rec.files(), {}, 'no bytes were ever obtained');
});

test('recordFinished: fetch success stores bytes, mime and url', async () => {
  const rec = createRecorder(null);
  const url = GEN_URL('file_ok');

  await recordFinished(rec, { url, mime: 'image/png' }, async () => ({
    body: ONE_PX_PNG_B64,
    isBase64: true,
  }));

  const want = Buffer.from(ONE_PX_PNG_B64, 'base64');
  assert.ok(rec.files()['file_ok'].equals(want));
  assert.equal(rec.mime('file_ok'), 'image/png');
  assert.equal(rec.url('file_ok'), url);
});

test('recordFinished: valid base64 decodes into files()', async () => {
  const rec = createRecorder(null);
  await recordFinished(rec, { url: GEN_URL('file_b64'), mime: 'image/png' }, async () => ({
    body: ONE_PX_PNG_B64,
    isBase64: true,
  }));
  assert.ok('file_b64' in rec.files());
});

test('recordFinished: invalid base64 keeps metadata but not bytes', async () => {
  const rec = createRecorder(null);
  const url = GEN_URL('file_bad');

  await recordFinished(rec, { url, mime: 'image/jpeg' }, async () => ({
    body: '!!!not base64!!!',
    isBase64: true,
  }));

  assert.deepEqual(rec.files(), {}, 'no corrupt bytes should be stored');
  assert.equal(rec.mime('file_bad'), 'image/jpeg');
  assert.equal(rec.url('file_bad'), url);
});

test('recordFinished: non-generated-image URL records nothing and does not throw', async () => {
  const rec = createRecorder(null);
  let fetchCalled = false;

  await recordFinished(
    rec,
    { url: 'https://chatgpt.com/cdn/assets/sprite-shell.svg', mime: 'image/svg+xml' },
    async () => {
      fetchCalled = true;
      return { body: '', isBase64: false };
    },
  );

  assert.equal(fetchCalled, false, 'must not attempt a body fetch for a non-generated-image URL');
  assert.deepEqual(rec.ids(), []);
  assert.deepEqual(rec.files(), {});
});

test('recordFinished: many ids do not clobber each other (same-image-several-<img>-tags shape)', async () => {
  const rec = createRecorder(null);
  const ids = ['file_1', 'file_2', 'file_3'];
  await Promise.all(
    ids.map((id) =>
      recordFinished(rec, { url: GEN_URL(id), mime: 'image/png' }, async () => ({
        body: ONE_PX_PNG_B64,
        isBase64: true,
      })),
    ),
  );
  assert.deepEqual(rec.ids().sort(), ids);
  assert.equal(Object.keys(rec.files()).length, 3);
});

// --- accessor contracts ------------------------------------------------

test('files() returns a copy: mutating it does not affect the recorder', async () => {
  const rec = createRecorder(null);
  await recordFinished(rec, { url: GEN_URL('file_abc'), mime: 'image/webp' }, async () => ({
    body: ONE_PX_PNG_B64,
    isBase64: true,
  }));

  const got = rec.files();
  got['file_abc'] = Buffer.from('mutated');
  delete got['file_abc'];
  got['file_xyz'] = Buffer.from('injected');

  const again = rec.files();
  assert.ok(again['file_abc'].equals(Buffer.from(ONE_PX_PNG_B64, 'base64')), 'live map must be unaffected');
  assert.equal('file_xyz' in again, false, 'injected key must not leak into a later call');
});

test('mime() defaults to image/png only for a truly unknown id', () => {
  const rec = createRecorder(null);
  assert.equal(rec.mime('file_unknown'), 'image/png');
});

test('url() returns empty string for an unknown id', () => {
  const rec = createRecorder(null);
  assert.equal(rec.url('file_unknown'), '');
});

// --- fetchInPage: must refuse before touching the page ----------------------

function throwingPage() {
  return {
    evaluate() {
      throw new Error('page.evaluate must not be called for a rejected URL');
    },
  };
}

test('fetchInPage refuses before touching the page', async (t) => {
  const cases = [
    ['foreign host', 'https://attacker.example.com/backend-api/estuary/content?id=file_x'],
    ['suffix confusion host', 'https://chatgpt.com.evil.com/backend-api/estuary/content?id=file_x'],
    ['UI asset path', 'https://chatgpt.com/cdn/assets/sprite-shell-097001e7.svg'],
    ['non-file_ id', 'https://chatgpt.com/backend-api/estuary/content?id=notaprefix'],
  ];
  for (const [name, url] of cases) {
    await t.test(name, async () => {
      await assert.rejects(fetchInPage(throwingPage(), url));
    });
  }
});

test('fetchInPage decodes a successful in-page fetch', async () => {
  const page = {
    async evaluate(fn, url) {
      // Simulate what the real page-context fn would return: base64 of
      // the fetched bytes. Prove the url argument was forwarded.
      assert.equal(url, GEN_URL('file_ok'));
      return ONE_PX_PNG_B64;
    },
  };
  const got = await fetchInPage(page, GEN_URL('file_ok'));
  assert.ok(got.equals(Buffer.from(ONE_PX_PNG_B64, 'base64')));
});
