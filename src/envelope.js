'use strict';

// Defines the single JSON object the CLI writes to stdout.
// The skill branches on error.code, never on prose, so codes are a stable
// API. Port of internal/envelope/envelope.go.

/**
 * The exact error code strings. Verbatim, stable API -- do not rename.
 *
 * BINARY_MISSING is intentionally absent: in the Go version it existed only
 * because a compiled binary could be missing from disk. That cannot happen
 * once this bundle is committed alongside the plugin, so there is no code
 * path that would ever produce it here.
 */
const CODES = Object.freeze({
  NOT_LOGGED_IN: 'NOT_LOGGED_IN',
  SELECTOR_MISS: 'SELECTOR_MISS',
  TIMEOUT: 'TIMEOUT',
  CHALLENGE: 'CHALLENGE',
  RATE_LIMITED: 'RATE_LIMITED',
  PROFILE_LOCKED: 'PROFILE_LOCKED',
  NO_IMAGE_RETURNED: 'NO_IMAGE_RETURNED',
  CHROME_MISSING: 'CHROME_MISSING',
  REFUSED: 'REFUSED',
});

/**
 * Builds a successful result.
 *
 * @param {Array<{path:string, bytes:number, width:number, height:number, title?:string}>} images
 * @param {string} conversationUrl
 * @param {boolean} archived
 * @param {number} elapsedS
 */
function success(images, conversationUrl, archived, elapsedS) {
  return {
    ok: true,
    images: images || [],
    conversationUrl: conversationUrl || '',
    archived: !!archived,
    elapsedS: elapsedS || 0,
    error: null,
  };
}

/**
 * Builds a failed result. Use withConversation() afterwards to attach the
 * recovery URL, if one is known.
 *
 * @param {string} code one of CODES
 * @param {string} message
 */
function failure(code, message) {
  return {
    ok: false,
    images: [],
    conversationUrl: '',
    archived: false,
    elapsedS: 0,
    error: {
      code,
      stage: '',
      selectorKey: '',
      probe: '',
      screenshot: '',
      conversationUrl: '',
      message: message || '',
    },
  };
}

/**
 * Attaches the conversation URL, which on failure is the recovery path a
 * caller can revisit.
 *
 * Returns a NEW result; never mutates `result`. In the Go original this was
 * a method with a value receiver that mutated the pointer its Error field
 * aliased, so two results derived from one base result ended up sharing
 * (and corrupting) the same error. JS objects are always references, so the
 * same bug is trivial to reintroduce here by mutating in place -- this
 * function must clone instead.
 */
function withConversation(result, url) {
  if (result.error) {
    return {
      ...result,
      error: { ...result.error, conversationUrl: url },
    };
  }
  return { ...result, conversationUrl: url };
}

function imageToJSON(img) {
  const out = {
    path: img.path,
    bytes: img.bytes,
    width: img.width,
    height: img.height,
  };
  if (img.title) out.title = img.title;
  return out;
}

function errorToJSON(err) {
  const out = { code: err.code };
  if (err.stage) out.stage = err.stage;
  if (err.selectorKey) out.selector_key = err.selectorKey;
  if (err.probe) out.probe = err.probe;
  if (err.screenshot) out.screenshot = err.screenshot;
  if (err.conversationUrl) out.conversation_url = err.conversationUrl;
  if (err.message) out.message = err.message;
  return out;
}

/**
 * Renders a result to the plain object that gets JSON-serialised, omitting
 * empty fields the same way Go's `,omitempty` struct tags did, so the
 * output shape matches the Go binary's byte for byte.
 */
function toJSON(result) {
  const out = { ok: result.ok };
  if (result.images && result.images.length > 0) {
    out.images = result.images.map(imageToJSON);
  }
  if (result.conversationUrl) out.conversation_url = result.conversationUrl;
  if (result.archived) out.archived = result.archived;
  if (result.elapsedS) out.elapsed_s = result.elapsedS;
  if (result.error) out.error = errorToJSON(result.error);
  return out;
}

/**
 * Writes the result as exactly one line of JSON: one JSON object followed
 * by exactly one trailing newline, nothing else. This is the sole guarantee
 * that stdout is one parseable line for the skill to read.
 */
function write(result, stream) {
  stream.write(JSON.stringify(toJSON(result)) + '\n');
}

function exitCode(result) {
  return result.ok ? 0 : 1;
}

module.exports = {
  CODES,
  success,
  failure,
  withConversation,
  write,
  exitCode,
  toJSON,
};
