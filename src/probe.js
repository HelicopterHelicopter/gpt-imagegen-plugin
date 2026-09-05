'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Dumps candidate elements when a selector stops matching, so the skill can
// repair selectors.json without a live browser attach. Port of
// internal/probe/probe.go.

/**
 * Reports whether a candidate can actually become a working selector. The
 * resolver in selectors.js only understands `testid` and `css` -- a
 * candidate described only by role/name/text is a description of an
 * element, not a way to find it.
 */
function actionable(candidate) {
  return !!(candidate && (candidate.testid || candidate.css));
}

/**
 * Travels inside every dump so the instructions cannot be separated from
 * the data the agent is reading.
 */
const DUMP_NOTE =
  'Only the "testid" and "css" fields are actionable: they are the only two the selector resolver understands. "role", "name" and "text" are informational and are ignored by the resolver, so a patch built from them silently matches nothing. When patching ~/.gpt-imagegen/selectors.json, write the new candidate FIRST and then repeat the key\'s existing candidates: the user file replaces a key wholesale, so a single-candidate list discards every shipped fallback.';

/**
 * Reduces `stage` to a safe, single-component file-name fragment:
 * path.basename drops any leading directories, and any residual path
 * separator or ".." sequence is replaced so the result cannot be used to
 * traverse out of the directory writeDump joins it into. An empty or
 * still-unsafe result falls back to "unknown".
 *
 * writeDump is called with caller-controlled strings, so without this a
 * stage like "../../etc/foo" could escape `dir` (path.join normalises the
 * joined path, so the traversal is NOT caught by join alone -- it happily
 * resolves "../../etc/foo" relative to dir and walks right out of it).
 */
function sanitizeStage(stage) {
  let s = path.basename(stage || '');
  s = s.split(path.sep).join('_');
  s = s.split('..').join('_');
  if (s === '' || s === '.' || s === path.sep) {
    return 'unknown';
  }
  return s;
}

/** Keeps only the fields Dump.candidates is meant to carry, in JSON form. */
function candidateToJSON(c) {
  const out = {};
  if (c.testid) out.testid = c.testid;
  if (c.css) out.css = c.css;
  if (c.role) out.role = c.role;
  if (c.name) out.name = c.name;
  if (c.text) out.text = c.text;
  return out;
}

/**
 * Writes a probe dump for `stage` into `dir` as JSON and returns the path
 * written. `stage` is sanitised before it is used in the path or recorded
 * in the dump (see sanitizeStage).
 */
function writeDump(dir, stage, url, cands) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safeStage = sanitizeStage(stage);
  const dump = {
    stage: safeStage,
    url: url || '',
    captured_at: new Date().toISOString(),
    note: DUMP_NOTE,
    candidates: (cands || []).map(candidateToJSON),
  };
  const body = JSON.stringify(dump, null, 2) + '\n';
  const p = path.join(dir, `probe-${safeStage}.json`);
  fs.writeFileSync(p, body, { mode: 0o600 });
  return p;
}

/**
 * Enumerates interactive and image elements with everything needed to
 * write a new selector. Runs in the page context via page.evaluate.
 *
 * `css` is emitted ONLY when it is genuinely selective: an #id or a
 * [data-testid=...]. It deliberately never falls back to the bare tag
 * name. A candidate of "button" or "div" looks like a repair and behaves
 * like a landmine: patched to the front of a key, resolve() returns the
 * FIRST button or div on the page, so the tool would type the prompt into
 * an arbitrary control and report success. An empty css is strictly
 * better -- a missing candidate is visible and safe, a wrong one is
 * neither. An id is emitted only when it is a plain CSS identifier, since
 * an id needing escaping would produce an invalid selector.
 *
 * The zero-rect filter below exists to keep those landmine button/div
 * candidates out, and it is otherwise correct. But it has one structural
 * blind spot: ChatGPT's upload control is a hidden `input[type=file]` --
 * that is exactly why compose.send drives it with uploadFile() rather than
 * a click -- so it always has a zero-size box and the filter would drop it
 * every time. Dropping it is worse than useless for that one key: a
 * SELECTOR_MISS on upload_input then produces a dump with no candidate at
 * all, and the self-heal loop this dump exists to feed correctly gives up
 * rather than guessing. `input[type=file]` is therefore exempted from the
 * rect check specifically -- and ONLY that -- everything else (buttons,
 * divs, textareas, images) still has to pass it.
 */
function collectCandidatesInBrowser() {
  const out = [];
  const sel = 'button,[role=button],textarea,input,div[contenteditable=true],img,[data-testid]';
  const idOK = /^[A-Za-z_-][A-Za-z0-9_-]*$/;
  document.querySelectorAll(sel).forEach((e) => {
    const isFileInput = e.tagName === 'INPUT' && (e.getAttribute('type') || '').toLowerCase() === 'file';
    if (!isFileInput) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
    }
    const testid = e.getAttribute('data-testid') || '';
    let css = '';
    if (e.id && idOK.test(e.id)) {
      css = '#' + e.id;
    } else if (testid) {
      css = `[data-testid="${testid}"]`;
    }
    out.push({
      testid: testid,
      css: css,
      role: e.getAttribute('role') || e.tagName.toLowerCase(),
      name: (e.getAttribute('aria-label') || e.getAttribute('alt') || '').slice(0, 120),
      text: (e.textContent || '').trim().slice(0, 80),
    });
  });
  return out.slice(0, 400);
}

/** Collects candidates from a live page. */
async function collect(page) {
  return page.evaluate(collectCandidatesInBrowser);
}

/** Collects candidates from a live page and writes the dump file. */
async function capture(page, stage, dir) {
  const cands = await collect(page);
  let url = '';
  try {
    url = page.url() || '';
  } catch {
    url = '';
  }
  return writeDump(dir, stage, url, cands);
}

module.exports = {
  DUMP_NOTE,
  actionable,
  sanitizeStage,
  writeDump,
  collectCandidatesInBrowser,
  collect,
  capture,
};
