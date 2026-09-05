'use strict';

const { isGeneratedImageUrl, fileIdFromUrl } = require('./urls');

// Port of internal/capture/capture.go. This module extracts the generated
// image BYTES from the page. It is deliberately DOM-free -- no element
// queries -- so it survives ChatGPT UI redesigns; it only watches network
// responses and, as a fallback, re-fetches from page context by URL.
//
// Two review findings shaped this port, both preserved deliberately:
//
//  1. recordFinished records url+mime BEFORE attempting the body fetch, and
//     keeps them even when the fetch fails. A fetch failure is exactly the
//     CDP/response-buffer eviction case fetchInPage exists to recover from
//     (it happens on long generations); dropping the metadata on that path
//     meant a webp recovered later via fetchInPage got written to disk as a
//     ".png" holding non-PNG bytes, because mime() fell back to its
//     unknown-id default instead of reporting the real mime it had already
//     seen. recordFinished is exported as a free function taking the
//     recorder as its first argument specifically so a test can drive this
//     path with a stub fetchBody and no browser at all.
//  2. fetchInPage runs `fetch(url, {credentials: 'include'})` inside the
//     page, carrying the user's ChatGPT session cookie, and the URL it is
//     given comes from page DOM (reachable by prompt injection). It refuses
//     any URL isGeneratedImageUrl rejects BEFORE touching the page --
//     otherwise it is an arbitrary-fetch-to-file-write primitive.

const DEFAULT_MIME = 'image/png';

/**
 * Creates a fresh recorder bound to `page`. All mutable state lives as
 * plain (null-prototype) maps on the returned object; recordFinished below
 * is the only thing that writes to them, whether driven by the real
 * response listener from start() or directly by a test.
 */
function createRecorder(page) {
  return {
    page,
    _urls: Object.create(null),
    _mimes: Object.create(null),
    _files: Object.create(null),

    /**
     * Enables the primary capture path: watches every response, and for
     * ones the URL allowlist accepts, records metadata immediately and
     * tries to pull the body out of puppeteer's response buffer. Keyed by
     * file_ id (via recordFinished), so the same generated image arriving
     * through several <img> tags is stored once.
     */
    start() {
      attachResponseListener(this);
    },

    /** Returns a COPY of the captured bytes, keyed by file_ id. */
    files() {
      return { ...this._files };
    },

    /**
     * Returns the mime recorded for `id`. "image/png" is a last-resort
     * default only for an id the recorder never saw at all -- an id whose
     * body fetch failed still has its real mime recorded here, taken from
     * the response before the fetch was attempted.
     */
    mime(id) {
      return id in this._mimes ? this._mimes[id] : DEFAULT_MIME;
    },

    /**
     * Returns the source URL recorded for `id`, or '' if unknown. Populated
     * even when the body could not be read, so a caller can re-fetch an
     * evicted image via fetchInPage.
     */
    url(id) {
      return id in this._urls ? this._urls[id] : '';
    },

    /** Returns the ids the recorder has seen, including evicted ones. */
    ids() {
      return Object.keys(this._urls);
    },
  };
}

/**
 * The real response handler, wired by start(): a thin adapter from
 * puppeteer's `response` event onto recordFinished, so all the actual
 * recording logic lives in one place that tests can reach without a page.
 */
function attachResponseListener(rec) {
  rec.page.on('response', (response) => {
    const url = response.url();
    if (!isGeneratedImageUrl(url)) return;
    const headers = response.headers() || {};
    const mime = (headers['content-type'] || '').split(';')[0].trim();
    // response.buffer() replaces Go's hand-wired
    // NetworkResponseReceived/NetworkLoadingFinished CDP pair; it already
    // hands back raw decoded bytes, so isBase64 is always false here.
    recordFinished(rec, { url, mime }, async () => ({
      body: await response.buffer(),
      isBase64: false,
    }));
  });
}

/**
 * Records metadata for `entry` and, if `fetchBody` succeeds and decodes,
 * its bytes. Metadata (url + mime) is written before fetchBody is even
 * called, and is kept regardless of whether fetchBody or decode fails --
 * see the module comment for why that matters. This is the seam that makes
 * the response handler's logic testable without a browser: start() wires
 * fetchBody to a real puppeteer call, tests wire it to a stub.
 *
 * `fetchBody` is `() => Promise<{body, isBase64}>` (or a value throwing/
 * rejecting to simulate a failed fetch, e.g. a buffer-eviction).
 */
async function recordFinished(rec, entry, fetchBody) {
  const id = fileIdFromUrl(entry.url);
  if (!id) return; // not a generated-image URL; nothing to record, no fetch attempted

  rec._urls[id] = entry.url;
  rec._mimes[id] = entry.mime;

  let result;
  try {
    result = await fetchBody();
  } catch {
    return; // buffer evicted (or otherwise unreachable); fetchInPage is the fallback
  }

  let data;
  try {
    data = decode(result.body, result.isBase64);
  } catch {
    return; // unparseable body; do not write corrupt bytes
  }

  rec._files[id] = data;
}

/**
 * The fallback for when puppeteer's response buffer has been evicted,
 * which happens on long generations. The URL is same-origin and
 * cookie-authed, so fetching from page context just works -- but the URL
 * comes from page DOM, so it is validated against the same allowlist
 * isGeneratedImageUrl enforces everywhere else, BEFORE the page is touched
 * at all. Without that guard this function is an arbitrary
 * fetch-with-credentials-to-file-write primitive.
 */
async function fetchInPage(page, url) {
  if (!isGeneratedImageUrl(url)) {
    throw new Error('fetchInPage: refusing to fetch a non-generated-image URL');
  }
  const base64 = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: 'include' });
    const buf = await res.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    // eslint-disable-next-line no-undef -- runs in page context, where btoa exists
    return btoa(binary);
  }, url);
  return decode(base64, true);
}

// Strict (RFC 4648) base64: length a multiple of 4, standard alphabet,
// correct padding. Node's Buffer.from(str, 'base64') is lenient -- it
// silently drops invalid characters instead of erroring -- which would
// turn a corrupt body into a "successfully decoded" (but wrong) file, so
// invalid input is rejected here before ever reaching Buffer.from.
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes a captured body. `body` is raw bytes (a Buffer, or a string
 * interpreted byte-for-byte, matching Go's `[]byte(body)`) when isBase64 is
 * false, or a base64 string when it is true. Throws on malformed base64
 * rather than silently producing truncated/wrong bytes.
 */
function decode(body, isBase64) {
  if (!isBase64) {
    return Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'binary');
  }
  if (typeof body !== 'string' || !STRICT_BASE64.test(body)) {
    throw new Error('decode: invalid base64 data');
  }
  return Buffer.from(body, 'base64');
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngDimensions(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// SOF markers that carry frame dimensions. Excludes 0xC4 (DHT), 0xC8 (JPG,
// reserved), 0xCC (DAC), which fall in the 0xC0-0xCF range but are not SOF.
function isSOFMarker(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegDimensions(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1; // resync
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte between markers
      continue;
    }
    // Standalone markers with no length/payload: TEM, RSTn, SOI, EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) break;
    const segLen = buf.readUInt16BE(offset + 2);
    if (isSOFMarker(marker)) {
      if (offset + 9 > buf.length) break;
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    if (marker === 0xda) break; // start of scan: entropy-coded data follows, no more segments
    offset += 2 + segLen;
  }
  return null;
}

function webpDimensions(buf) {
  if (buf.length < 20) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourCC = buf.toString('ascii', 12, 16);
  const dataOffset = 20; // 'RIFF'+size+'WEBP' (12) + chunk FourCC+size (8)

  if (fourCC === 'VP8 ') {
    // Lossy: 3-byte frame tag, 3-byte start code (0x9d 0x01 0x2a), then
    // 14-bit width and 14-bit height, each in 2 little-endian bytes.
    if (buf.length < dataOffset + 10) return null;
    if (buf[dataOffset + 3] !== 0x9d || buf[dataOffset + 4] !== 0x01 || buf[dataOffset + 5] !== 0x2a) {
      return null;
    }
    const width = buf.readUInt16LE(dataOffset + 6) & 0x3fff;
    const height = buf.readUInt16LE(dataOffset + 8) & 0x3fff;
    return { width, height };
  }

  if (fourCC === 'VP8L') {
    // Lossless: 1-byte signature (0x2f), then a little-endian bitstream
    // packing 14-bit (width-1) and 14-bit (height-1).
    if (buf.length < dataOffset + 5) return null;
    if (buf[dataOffset] !== 0x2f) return null;
    const bits = buf.readUInt32LE(dataOffset + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }

  if (fourCC === 'VP8X') {
    // Extended: 1-byte flags, 3 reserved, then 24-bit little-endian
    // (canvas width-1) and (canvas height-1).
    if (buf.length < dataOffset + 10) return null;
    const width = (buf[dataOffset + 4] | (buf[dataOffset + 5] << 8) | (buf[dataOffset + 6] << 16)) + 1;
    const height = (buf[dataOffset + 7] | (buf[dataOffset + 8] << 8) | (buf[dataOffset + 9] << 16)) + 1;
    return { width, height };
  }

  return null;
}

/**
 * Returns {width, height} for a PNG, JPEG or WebP buffer by reading its
 * header directly -- no image-processing dependency for two integers.
 * Go's ported original used image.DecodeConfig with only png/jpeg/gif
 * registered, so it silently returned 0x0 for WebP even though ChatGPT can
 * serve it; this parses all three formats WebP included, and throws
 * (rather than returning zeroes) for anything unrecognised.
 */
function dimensions(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  return pngDimensions(buf) || jpegDimensions(buf) || webpDimensions(buf) || throwUnrecognised();
}

function throwUnrecognised() {
  throw new Error('dimensions: unrecognised image format');
}

module.exports = {
  createRecorder,
  recordFinished,
  fetchInPage,
  decode,
  dimensions,
};
