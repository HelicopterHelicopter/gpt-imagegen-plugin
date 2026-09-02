'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Turns a captured image into a filename. Port of
// internal/capture/naming.go (titleFromAlt, slugify, outputPath) plus
// extFor from internal/capture/capture.go.

// How ChatGPT labels generated images. Verified by spike.
const ALT_PREFIX = 'Generated image: ';

/** Extracts the model's own title, which makes a good filename. */
function titleFromAlt(alt) {
  if (!alt || !alt.startsWith(ALT_PREFIX)) return '';
  return alt.slice(ALT_PREFIX.length).trim();
}

// Unicode letter (category L) / decimal digit (category Nd), matching Go's
// unicode.IsLetter / unicode.IsDigit rather than an ASCII-only check.
const IS_LETTER = /\p{L}/u;
const IS_DIGIT = /\p{Nd}/u;

function slugify(s) {
  let out = '';
  let lastDash = true; // leading dashes suppressed
  for (const ch of s.toLowerCase()) {
    if (IS_LETTER.test(ch) || IS_DIGIT.test(ch)) {
      out += ch;
      lastDash = false;
    } else if (!lastDash) {
      out += '-';
      lastDash = true;
    }
  }
  return out.replace(/^-+|-+$/g, '');
}

function isDir(p) {
  if (p.endsWith(path.sep)) return true;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Resolves where image number `index` should be written. */
function outputPath(out, index, title, ext) {
  if (isDir(out)) {
    let name = slugify(title);
    if (!name) name = 'image';
    if (index > 0) name = `${name}-${index + 1}`;
    return path.join(out, name + ext);
  }
  if (index === 0) return out;
  const e = path.extname(out);
  const stem = out.slice(0, out.length - e.length);
  return `${stem}-${index + 1}${e}`;
}

/** Maps a MIME type to a file extension, falling back to .png. */
function extFor(mime) {
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  return '.png';
}

module.exports = { titleFromAlt, slugify, outputPath, extFor };
