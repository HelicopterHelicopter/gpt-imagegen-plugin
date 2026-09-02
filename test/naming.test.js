'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { titleFromAlt, slugify, outputPath, extFor } = require('../src/naming');

test('titleFromAlt', () => {
  // Real alt text captured by the spike.
  assert.equal(
    titleFromAlt('Generated image: Geometric Teal Mountain Emblem'),
    'Geometric Teal Mountain Emblem',
  );
  assert.equal(titleFromAlt(''), '');
  assert.equal(titleFromAlt('some other alt'), '', 'non-generated alt must yield empty');
});

test('slugify', () => {
  const cases = {
    'Geometric Teal Mountain Emblem': 'geometric-teal-mountain-emblem',
    '  Spaced   Out  ': 'spaced-out',
    'Punctuation!! & Symbols': 'punctuation-symbols',
    '': '',
  };
  for (const [input, want] of Object.entries(cases)) {
    assert.equal(slugify(input), want, `slugify(${JSON.stringify(input)})`);
  }
});

test('outputPath numbers siblings', () => {
  assert.equal(outputPath('/a/hero.png', 0, 'T', '.png'), '/a/hero.png', 'index 0 must be verbatim');
  assert.equal(outputPath('/a/hero.png', 1, 'T', '.png'), '/a/hero-2.png');
  assert.equal(outputPath('/a/hero.png', 2, 'T', '.png'), '/a/hero-3.png');
});

test('outputPath into a directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-imagegen-test-'));
  try {
    let got = outputPath(dir, 0, 'Geometric Teal Mountain Emblem', '.png');
    assert.equal(got, path.join(dir, 'geometric-teal-mountain-emblem.png'));

    got = outputPath(dir, 0, '', '.png');
    assert.equal(got, path.join(dir, 'image.png'), 'empty title fallback');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extFor', () => {
  const cases = {
    'image/png': '.png',
    'image/webp': '.webp',
    'image/jpeg': '.jpg',
    'image/gif': '.png', // unknown types fall back to png
  };
  for (const [mime, want] of Object.entries(cases)) {
    assert.equal(extFor(mime), want, `extFor(${JSON.stringify(mime)})`);
  }
});
