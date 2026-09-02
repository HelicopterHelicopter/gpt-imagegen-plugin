'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CODES,
  success,
  failure,
  withConversation,
  write,
  exitCode,
} = require('../src/envelope');

// Minimal stand-in for a writable stream (mirrors Go's bytes.Buffer in the
// original test): captures everything written, nothing more.
class BufferStream {
  constructor() {
    this.data = '';
  }
  write(chunk) {
    this.data += chunk;
    return true;
  }
}

test('success writes exactly one JSON line', () => {
  const r = success(
    [{ path: '/abs/hero.png', bytes: 184203, width: 1536, height: 1024, title: 'Teal Mountain' }],
    'https://chatgpt.com/c/abc',
    true,
    41.2,
  );
  const buf = new BufferStream();
  write(r, buf);
  const out = buf.data;

  const newlineCount = (out.match(/\n/g) || []).length;
  assert.equal(newlineCount, 1, `want exactly one trailing newline, got ${JSON.stringify(out)}`);
  assert.ok(out.endsWith('\n'), `want trailing newline, got ${JSON.stringify(out)}`);

  const back = JSON.parse(out);
  assert.equal(back.ok, true);
  assert.equal(back.images.length, 1);
  assert.equal(back.images[0].bytes, 184203);
  assert.equal(back.error, undefined, 'success must omit error');
  assert.equal(exitCode(r), 0);
});

test('failure omits images and carries the code', () => {
  const r = withConversation(failure(CODES.RATE_LIMITED, 'hit the cap'), 'https://chatgpt.com/c/xyz');
  const buf = new BufferStream();
  write(r, buf);

  assert.ok(!buf.data.includes('"images"'), `failure must omit images, got ${buf.data}`);

  const back = JSON.parse(buf.data);
  assert.equal(back.ok, false, 'failure must have ok=false');
  assert.equal(back.error.code, CODES.RATE_LIMITED);
  assert.equal(back.error.conversation_url, 'https://chatgpt.com/c/xyz');
  assert.equal(exitCode(r), 1);
});

test('withConversation isolates failures derived from one base', () => {
  const base = failure(CODES.TIMEOUT, 'boom');
  const a = withConversation(base, 'https://chatgpt.com/c/url-a');
  const b = withConversation(base, 'https://chatgpt.com/c/url-b');

  assert.equal(a.error.conversationUrl, 'https://chatgpt.com/c/url-a');
  assert.equal(b.error.conversationUrl, 'https://chatgpt.com/c/url-b');
  assert.equal(base.error.conversationUrl, '', 'withConversation must not mutate its input');
});

test('withConversation on a success result sets the top-level field', () => {
  let r = success([], 'https://chatgpt.com/c/conv', false, 1.5);
  r = withConversation(r, 'https://chatgpt.com/c/updated');

  assert.equal(r.conversationUrl, 'https://chatgpt.com/c/updated');
  assert.equal(r.error, null, 'success must not have an error');
});
