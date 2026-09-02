'use strict';

const { fileIdFromUrl } = require('./urls');

// Pure decision logic for whether the ChatGPT composer has settled on a
// finished image set. Kept separate from anything that touches the page so
// completion rules are unit-tested, never discovered live. Port of
// internal/compose/state.go.

/**
 * Parses the raw JSON captured from the page (a string or Buffer) into a
 * state object: { loading, streaming, imageURLs, alts }. Throws on
 * malformed input via JSON.parse -- exactly like Go's json.Unmarshal
 * returning an error -- never falls back to a default shape silently.
 */
function parseState(raw) {
  const s = JSON.parse(raw);
  return {
    loading: !!s.loading,
    streaming: !!s.streaming,
    imageURLs: Array.isArray(s.imageURLs) ? s.imageURLs : [],
    alts: Array.isArray(s.alts) ? s.alts : [],
  };
}

/**
 * Returns generated file ids in first-seen order. ChatGPT renders one
 * generated image through several <img> tags, so counting tags -- or
 * dropping ids into a Set/Map and reading its key order -- would overcount
 * or depend on incidental iteration order; distinctness and ordering both
 * come from a single left-to-right walk of imageURLs.
 */
function distinctImageIds(state) {
  const seen = new Set();
  const out = [];
  for (const u of state.imageURLs) {
    const id = fileIdFromUrl(u);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Returns the alt text of the first <img> whose src maps to id, or '' if
 * none. imageURLs and alts are PARALLEL PER-TAG arrays (one entry per <img>
 * tag, not per distinct image), so pairing must walk them together by
 * index. Indexing alts with a position taken from the deduplicated id list
 * (distinctImageIds) is wrong as soon as one generated image is rendered
 * through more than one <img> tag, which is the common case: with ids
 * [A,A,B], an index-based lookup would hand B the alt that belongs to A.
 */
function altForId(state, id) {
  if (!id) return '';
  const { imageURLs, alts } = state;
  for (let i = 0; i < imageURLs.length; i++) {
    if (fileIdFromUrl(imageURLs[i]) !== id) continue;
    return i < alts.length ? alts[i] : '';
  }
  return '';
}

/**
 * Requires the UI to be quiet AND to hold enough distinct images. An early
 * prototype returned as soon as any image byte arrived and saved ChatGPT's
 * own UI sprites while the real image was still generating.
 */
function done(state, want) {
  if (state.loading || state.streaming) return false;
  const need = want < 1 ? 1 : want;
  return distinctImageIds(state).length >= need;
}

module.exports = { parseState, distinctImageIds, altForId, done };
