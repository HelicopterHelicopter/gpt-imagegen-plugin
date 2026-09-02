'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isGeneratedImageUrl, fileIdFromUrl } = require('../src/urls');

// Real URL captured by the spike from a finished generation.
const GEN_URL =
  'https://chatgpt.com/backend-api/estuary/content?id=file_00000000e7148208927dc5bbece7a546&ts=496736&p=fs&cid=1&sig=88d3f46f4ff9b2c50cfcde0c8e819b36e6bd286c16c28191fd12097ea8afdeab&v=0';

test('isGeneratedImageUrl', async (t) => {
  const cases = [
    ['generated image', GEN_URL, true],
    ['sprite sheet', 'https://chatgpt.com/cdn/assets/sprites-shell-097001e7.svg', false],
    ['sprites core', 'https://chatgpt.com/cdn/assets/sprites-core-9b910f5e.svg', false],
    ['watercolor bg', 'https://chatgpt.com/cdn/assets/watercolor-cxf1rp88.webp', false],
    ['favicon', 'https://chatgpt.com/cdn/assets/favicon-l4nq08hd.svg', false],
    [
      'google avatar',
      'https://lh3.googleusercontent.com/a/ACg8ocLLmCTS11F6i2Dfz40Uj5DGahctKK4ds69P8cDsFAyhLSJ2=s96-c',
      false,
    ],
    ['auth0 avatar', 'https://cdn.auth0.com/avatars/jr.png', false],
    ['ecosystem icon', 'https://chatgpt.com/images/ecosystem/apps/slack/icon.png', false],
    ['empty', '', false],
    ['attacker host', 'https://attacker.example.com/backend-api/estuary/content?id=file_x', false],
    ['suffix confusion', 'https://chatgpt.com.evil.com/backend-api/estuary/content?id=file_x', false],
    ['lookalike host', 'https://evilchatgpt.com/backend-api/estuary/content?id=file_x', false],
    [
      'userinfo bypass',
      'https://chatgpt.com@attacker.example.com/backend-api/estuary/content?id=file_x',
      false,
    ],
    [
      'path not exact',
      'https://chatgpt.com/evil/backend-api/estuary/content?id=file_x',
      false,
    ],
    ['oaiusercontent subdomain', 'https://cdn.oaiusercontent.com/backend-api/estuary/content?id=file_x', true],
    ['non-file prefix', 'https://chatgpt.com/backend-api/estuary/content?id=notaprefix', false],
    ['with port', 'https://chatgpt.com:443/backend-api/estuary/content?id=file_x', true],
  ];
  for (const [name, url, want] of cases) {
    await t.test(name, () => {
      assert.equal(isGeneratedImageUrl(url), want, `isGeneratedImageUrl(${JSON.stringify(url)})`);
    });
  }
});

test('the userinfo bypass URL parses its hostname as the attacker host', () => {
  // Documents WHY the userinfo-bypass case above must be false: the
  // "chatgpt.com" segment is credentials (userinfo), not the host.
  const parsed = new URL('https://chatgpt.com@attacker.example.com/backend-api/estuary/content?id=file_x');
  assert.equal(parsed.hostname, 'attacker.example.com');
  assert.equal(parsed.username, 'chatgpt.com');
});

test('fileIdFromUrl', () => {
  assert.equal(fileIdFromUrl(GEN_URL), 'file_00000000e7148208927dc5bbece7a546');
  assert.equal(fileIdFromUrl('https://chatgpt.com/cdn/assets/x.svg'), '');
});

test('isGeneratedImageUrl and fileIdFromUrl agree on every input', () => {
  const urls = [
    GEN_URL,
    'https://chatgpt.com/backend-api/estuary/content?id=file_x',
    'https://attacker.example.com/backend-api/estuary/content?id=file_x',
    'https://chatgpt.com.evil.com/backend-api/estuary/content?id=file_x',
    'https://evilchatgpt.com/backend-api/estuary/content?id=file_x',
    'https://chatgpt.com@attacker.example.com/backend-api/estuary/content?id=file_x',
    'https://chatgpt.com/evil/backend-api/estuary/content?id=file_x',
    'https://cdn.oaiusercontent.com/backend-api/estuary/content?id=file_x',
    'https://chatgpt.com/backend-api/estuary/content?id=notaprefix',
    'https://chatgpt.com:443/backend-api/estuary/content?id=file_x',
    'https://chat.openai.com/backend-api/estuary/content?id=file_y',
    'https://chatgpt.com/cdn/assets/sprites-shell-097001e7.svg',
    'https://lh3.googleusercontent.com/a/ACg8ocLLmCTS11F6i2Dfz40Uj5DGahctKK4ds69P8cDsFAyhLSJ2=s96-c',
    'https://cdn.auth0.com/avatars/jr.png',
    '',
  ];
  for (const u of urls) {
    const isGen = isGeneratedImageUrl(u);
    const id = fileIdFromUrl(u);
    const hasId = id !== '';
    assert.equal(isGen, hasId, `agreement failed for ${JSON.stringify(u)}: isGeneratedImageUrl=${isGen} fileIdFromUrl=${JSON.stringify(id)}`);
  }
});
