'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keeps ChatGPT DOM selectors as data rather than code, so a repair after a
// UI change needs no rebuild. A user-level file overrides the embedded
// defaults per key, which is where self-heal writes. Port of
// internal/selectors/selectors.go.

// Static require path, on purpose: esbuild's JSON loader inlines a require
// of a literal ".json" path at bundle time, producing an object literal in
// the bundle rather than a runtime file read. A computed path (e.g. built
// from __dirname + a variable, or a runtime fs.readFileSync) would defeat
// that and force a file lookup relative to wherever the bundle ends up on
// disk. Do not change this to a dynamic path.
const embedded = require('./selectors.json');

/**
 * Deep-clones a parsed selectors object. Every call to load() must return an
 * independent copy of the embedded defaults: `embedded` above is the SAME
 * object every time (require() caches modules), so without cloning,
 * mutating one loaded Set (e.g. via patch()) would silently mutate every
 * other Set ever loaded from embedded -- including the "defaults" snapshot
 * save() reads to compute its delta. Go's json.Unmarshal into a fresh map
 * gets this for free each call; JSON parse/stringify is the JS equivalent.
 */
function cloneSet(set) {
  return JSON.parse(JSON.stringify(set));
}

/**
 * Where self-heal writes. Kept separate from the embedded copy so a plugin
 * upgrade never clobbers a local repair, and deleting it restores shipped
 * defaults. Throws if the home directory cannot be determined -- never
 * silently returns an empty path, which would make self-heal write (or a
 * later load read) some unintended location.
 */
function userPath() {
  const home = os.homedir();
  if (!home) {
    throw new Error('cannot determine home directory');
  }
  return path.join(home, '.gpt-imagegen', 'selectors.json');
}

/**
 * Merges a user override over the embedded defaults, per key. An empty
 * userPath, or a missing file, yields the defaults alone.
 *
 * The merge is per key and WHOLESALE: a key present in the user file
 * replaces that key's entire candidate list, it does not prepend to it.
 * That is deliberate -- it is the only way a repair can retire a shipped
 * candidate that now matches the wrong element -- but it means a patch of
 * {"composer_input":[{"css":"#new"}]} deletes every shipped fallback for
 * composer_input. Anything writing this file (today, the skill, by hand)
 * must therefore write the new candidate FOLLOWED BY the key's existing
 * candidates. SKILL.md carries that instruction with a worked example;
 * the "replaces the whole key" test in test/selectors.test.js pins the
 * behaviour.
 *
 * A malformed user file throws -- it never falls back to defaults, which
 * would hide a broken self-heal behind selectors that merely look fine.
 */
function load(userPath) {
  const base = cloneSet(embedded);
  if (!userPath) return base;

  let raw;
  try {
    raw = fs.readFileSync(userPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return base;
    throw err;
  }

  let over;
  try {
    over = JSON.parse(raw);
  } catch (err) {
    throw new Error(`user selectors invalid: ${err.message}`);
  }

  for (const key of Object.keys(over)) {
    base[key] = over[key];
  }
  return base;
}

/**
 * Returns CSS selector strings in priority order (the order candidates
 * appear in the key's list). Text-only candidates are skipped; the caller
 * resolves those separately.
 */
function query(set, key) {
  const out = [];
  const candidates = set[key] || [];
  for (const c of candidates) {
    if (c.testid) {
      out.push(`[data-testid="${c.testid}"]`);
    } else if (c.css) {
      out.push(c.css);
    }
  }
  return out;
}

/**
 * Puts a candidate at the front of a key's list, mutating `set` in place.
 *
 * NOTE: nothing in the CLI calls patch or save. Self-heal is performed by
 * the skill, which reads the probe dump and writes
 * ~/.gpt-imagegen/selectors.json itself; these two are a library surface
 * kept for callers that want to build a delta file programmatically. Do not
 * document them as the mechanism that writes that file -- the README says
 * what actually happens.
 */
function patch(set, key, candidate) {
  set[key] = [candidate, ...(set[key] || [])];
}

/**
 * Compares two candidate-list values for equality (same shape as the Go
 * Candidate struct comparison: testid, css and text fields, in order).
 */
function candidateSlicesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i].testid || '') !== (b[i].testid || '')) return false;
    if ((a[i].css || '') !== (b[i].css || '')) return false;
    if ((a[i].text || '') !== (b[i].text || '')) return false;
  }
  return true;
}

/**
 * Persists only the delta from embedded defaults to the given path.
 *
 * Like patch, save has no production caller today (see the note on patch).
 * This ensures that a plugin upgrade can improve a selector that was not
 * patched, and deleting the file restores all shipped defaults. Keys absent
 * from embedded are always written. Directory mode 0o700, file mode 0o600.
 *
 * Writing the whole set here was a real bug: after one self-heal repair,
 * all keys froze in the user file and permanently shadowed future
 * upgrades. Only the keys that actually differ from embedded may be
 * written.
 */
function save(set, filePath) {
  const defaults = cloneSet(embedded);

  const delta = {};
  for (const key of Object.keys(set)) {
    const exists = Object.prototype.hasOwnProperty.call(defaults, key);
    if (!exists || !candidateSlicesEqual(set[key], defaults[key])) {
      delta[key] = set[key];
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(delta, null, 2) + '\n';
  fs.writeFileSync(filePath, body, { mode: 0o600 });
}

/**
 * The candidate lists this plugin ships, independent of any user overrides.
 *
 * Self-heal needs these: a key in the user file REPLACES that key's list
 * wholesale, so a patch must repeat the shipped candidates behind its new
 * one or it deletes every fallback. SKILL.md used to send the agent to
 * `src/selectors.json` for them, which is not shipped -- `/plugin install`
 * copies only the plugin directory. Serving them from here instead means
 * the answer comes from the same inlined JSON the resolver itself uses, so
 * there is no second copy to drift out of sync.
 *
 * Returns a fresh clone for the same reason load() does: `embedded` is one
 * cached object, and handing out a reference would let a caller mutate the
 * defaults for every later load in the process.
 */
function shipped() {
  return cloneSet(embedded);
}

module.exports = { load, query, patch, save, userPath, shipped };
