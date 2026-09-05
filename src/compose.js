'use strict';

const { query } = require('./selectors');
const { parseState, done } = require('./state');

// Drives the ChatGPT composer: opens a chat, types the prompt, attaches
// reference files, sends, polls for completion, and archives a finished
// conversation. Port of internal/compose/compose.go.
//
// The embedded page scripts in the Go source (SelectAllJS, countMatchesJS,
// collectJS, the state-script template) are lifted out here as real
// functions passed to page.evaluate()/elementHandle.evaluate() -- that is
// the single biggest saving in this port, since puppeteer serialises a
// function and calls it in the page directly, with no string-building or
// JSON-decoding round trip needed. The one exception is the completion-poll
// script (stateScript/joinQuery below): it is still built as a JS source
// string, exactly like Go, because the selector CANDIDATES themselves have
// to be spliced into the script text (document.querySelectorAll needs one
// selector-list literal, not a runtime argument the resolver could
// second-guess), and that splicing has to be JSON-escaped so a selector
// holding a double quote cannot break out of the generated script.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The one error the CLI turns into SELECTOR_MISS, the only code the skill
 * may self-heal from. `.code` is a literal, not `require('./envelope')`,
 * on purpose -- same call as lock.js's LockTimeoutError: this module is
 * beneath the CLI/envelope layer and should not need to reach up into it
 * just to check a string it already knows. `.selectorKey` matches the field
 * name envelope.errorToJSON reads (`err.selectorKey`).
 */
class SelectorMissError extends Error {
  constructor(key, detail) {
    let message = `no selector matched for ${key}`;
    if (detail) message += `: ${detail}`;
    super(message);
    this.name = 'SelectorMissError';
    this.code = 'SELECTOR_MISS';
    this.selectorKey = key;
    this.detail = detail || '';
  }
}

/**
 * Tries each candidate for `key`, in priority order, splitting `timeoutMs`
 * evenly across them (never less than 1s per candidate, so a key with many
 * fallbacks does not starve the last one). Port of compose.go's Resolve.
 */
async function resolve(page, set, key, timeoutMs) {
  const qs = query(set, key);
  if (qs.length === 0) {
    throw new SelectorMissError(key);
  }
  let per = Math.floor(timeoutMs / qs.length);
  if (per < 1000) per = 1000;
  for (const q of qs) {
    try {
      const el = await page.waitForSelector(q, { timeout: per });
      if (el) return el;
    } catch {
      // This candidate did not resolve in time; try the next one.
    }
  }
  throw new SelectorMissError(key);
}

/** Navigates to a fresh chat and lets the SPA settle before returning. */
async function newChat(page) {
  await page.goto('https://chatgpt.com/', { waitUntil: 'load' });
  await sleep(3000); // let the SPA settle before touching the composer
}

// attachUploadTimeout bounds how long send() waits for reference files to
// finish uploading before it fails loudly instead of sending an unattached
// prompt.
const ATTACH_UPLOAD_TIMEOUT_MS = 60000;
const ATTACH_POLL_INTERVAL_MS = 500;

/**
 * Counts elements matching `sel` in the page. Runs in the page context via
 * page.evaluate -- this IS countMatchesJS from the Go source, just as a
 * real function instead of a string literal.
 */
function countMatchesInBrowser(sel) {
  return document.querySelectorAll(sel).length;
}

/**
 * Returns the highest match count seen across the candidate selectors for
 * a key. Candidates are alternates for the same control (e.g. a css
 * fallback and a testid), not additive signals, so the max avoids
 * double-counting when more than one candidate matches the same elements.
 */
async function countRemovalControls(page, sels) {
  let max = 0;
  for (const sel of sels) {
    const n = await page.evaluate(countMatchesInBrowser, sel);
    if (n > max) max = n;
  }
  return max;
}

/**
 * The pure decision behind waitAttachmentsReady's poll loop, split out so
 * it can be unit-tested without a browser: proceed once at least one
 * removal control exists per attached file.
 */
function attachmentsReady(got, want) {
  return got >= want;
}

/**
 * What waitAttachmentsReady throws when the upload deadline passes. It is
 * a SelectorMissError, not a plain timeout, on purpose: attachment_remove
 * is the ONE selector key with no spike provenance, so a wrong selector
 * here is the likeliest failure of the whole edit/--ref path. Reporting it
 * as TIMEOUT would put the most probable selector bug in the project
 * permanently out of reach of the probe and the skill's one-shot self-heal.
 * The observed counts stay in `.detail` so the human message loses nothing.
 */
function attachTimeoutError(got, want, timeoutMs) {
  return new SelectorMissError(
    'attachment_remove',
    `attachments did not finish uploading: saw ${got} of ${want} removal controls after ${timeoutMs}ms`
  );
}

/**
 * Polls for one removal control per attached file -- the signal ChatGPT has
 * actually ingested the file, more reliable than a filename or a generic
 * upload-progress indicator that can lag or never appear for a fast
 * upload. Never uses a fixed sleep as its completion signal: on timeout it
 * throws a descriptive SelectorMissError rather than letting send() proceed,
 * because a run that sends with an unattached reference produces an image
 * that ignored the reference and looks indistinguishable from a bad
 * generation.
 */
async function waitAttachmentsReady(page, set, want, timeoutMs) {
  const sels = query(set, 'attachment_remove');
  if (sels.length === 0) {
    throw new SelectorMissError('attachment_remove');
  }
  const deadline = Date.now() + timeoutMs;
  let got = 0;
  for (;;) {
    try {
      got = await countRemovalControls(page, sels);
      if (attachmentsReady(got, want)) return;
    } catch {
      // Transient eval error; keep polling until the deadline.
    }
    if (Date.now() >= deadline) {
      throw attachTimeoutError(got, want, timeoutMs);
    }
    await sleep(ATTACH_POLL_INTERVAL_MS);
  }
}

/**
 * Selects the full contents of `el`. ChatGPT's composer resolves to a
 * contenteditable <div> (#prompt-textarea), not an <input>/<textarea>, so
 * it has no DOM `.select()` method -- calling one unconditionally is
 * exactly the bug that broke every run in Go (a select-all helper written
 * for a form field, thrown as `TypeError: this.select is not a function`
 * against the real page, caught only by the live smoke). This branches on
 * which shape the element actually is: a form field selects the normal
 * way, a contenteditable is selected via a Range/Selection, and anything
 * else is reported back as false rather than throwing.
 *
 * Exported (not just used internally) so a later fixture test can eval the
 * exact same function against a real contenteditable composer -- that is
 * what would have caught the original bug.
 */
function selectAllInBrowser(el) {
  if (typeof el.select === 'function') {
    el.select();
    return true;
  }
  if (el.isContentEditable) {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return true;
  }
  return false;
}

/**
 * Selects any existing composer text so the following text-insert call
 * replaces it instead of appending after it. Purely defensive -- send() is
 * always called right after newChat(), so the composer is normally already
 * empty -- so a failure here must NEVER fail the run. It is logged to
 * stderr and send() proceeds regardless. Returning a rejected promise
 * instead would mean a harmless clear failure breaks 100% of
 * generate/edit runs instead of, at worst, occasionally concatenating onto
 * leftover text in a rare edge case.
 */
async function clearComposer(el) {
  let ok;
  try {
    ok = await el.evaluate(selectAllInBrowser);
  } catch (err) {
    process.stderr.write(
      `gpt-imagegen: clear composer text failed, continuing anyway: ${err.message}\n`
    );
    return;
  }
  if (!ok) {
    process.stderr.write(
      'gpt-imagegen: clear composer text: element was neither a form field nor contenteditable, continuing anyway\n'
    );
  }
}

/** Types the prompt, attaches any reference files, and submits. */
async function send(page, set, prompt, refs) {
  if (refs && refs.length > 0) {
    const input = await resolve(page, set, 'upload_input', 15000);
    try {
      await input.uploadFile(...refs);
    } catch (err) {
      throw new Error(`attach refs: ${err.message}`);
    }
    await waitAttachmentsReady(page, set, refs.length, ATTACH_UPLOAD_TIMEOUT_MS);
  }
  const el = await resolve(page, set, 'composer_input', 20000);
  await el.click();
  await clearComposer(el);
  // CDP Input.insertText, via keyboard.sendCharacter -- inserts the whole
  // string at the cursor in one call, rather than replacing the field
  // (which is exactly why clearComposer runs first).
  await page.keyboard.sendCharacter(prompt);
  await sleep(800);
  await page.keyboard.press('Enter');
}

// The three selector keys the completion poll depends on. They are the keys
// most likely to drift, so they live in selectors.json like every other key
// and are read from there: hardcoding them here would mean a rebuild to
// repair the very selectors self-heal exists to repair.
const KEY_LOADING_STATE = 'loading_state';
const KEY_STOP_BUTTON = 'stop_button';
const KEY_GENERATED_IMAGE = 'generated_image';

/**
 * Collapses a key's ordered candidates into one CSS selector list, JSON-
 * encoded so it can be spliced into a generated script as a string literal
 * (a selector containing a double quote cannot then break the script). A
 * selector list is the right shape here because, unlike resolve(), this is
 * a presence test rather than a pick: any candidate matching is the
 * signal. A key with no usable candidate is a SelectorMissError the skill
 * can self-heal, never a silent "nothing is loading".
 */
function joinQuery(set, key) {
  const qs = query(set, key);
  if (qs.length === 0) {
    throw new SelectorMissError(
      key,
      'no usable candidate in selectors.json (only testid and css are actionable)'
    );
  }
  return JSON.stringify(qs.join(','));
}

/**
 * Builds the completion-poll script for a selector set. The three
 * placeholders are filled with JSON-encoded selector-list strings (never
 * raw interpolation), so a quote inside a selector cannot escape the
 * literal and break the script.
 *
 * alts is read from the SAME elements as imageURLs, so the alt-prefix
 * filter stays encoded in the generated_image selector itself rather than
 * duplicated here: the two arrays are parallel per-tag lists and
 * state.altForId depends on that.
 */
function stateScript(set) {
  const img = joinQuery(set, KEY_GENERATED_IMAGE);
  const loading = joinQuery(set, KEY_LOADING_STATE);
  const stop = joinQuery(set, KEY_STOP_BUTTON);
  return `() => {
  const imgs = [...document.querySelectorAll(${img})];
  return JSON.stringify({
    loading: !!document.querySelector(${loading}),
    streaming: !!document.querySelector(${stop}),
    imageURLs: imgs.map(i => i.src),
    alts: imgs.map(i => i.alt)
  });
}`;
}

/**
 * Evaluates an already-built state script (see stateScript) and parses its
 * JSON result. Split from readState so waitDone can build the script once,
 * up front, and re-run only the eval on every poll tick.
 */
async function evalStateScript(page, js) {
  // The script text is a `() => {...}` function-expression literal; wrap
  // it in a call so puppeteer's string-evaluate path (which otherwise just
  // evaluates the expression, returning the function itself) actually
  // invokes it.
  const raw = await page.evaluate(`(${js})()`);
  return parseState(raw);
}

/** Builds the state script from `set` and reads the current page state. */
async function readState(page, set) {
  const js = stateScript(set);
  return evalStateScript(page, js);
}

/**
 * What waitDone throws on timeout. Carries the LAST observed state (see
 * `.state`): a run that produced images but tripped the deadline still has
 * salvageable work, and under a no-retry discipline discarding it is the
 * worst outcome available. Callers must read `.state` off a caught
 * WaitTimeoutError rather than assuming a timeout means nothing happened.
 */
class WaitTimeoutError extends Error {
  constructor(timeoutMs, state) {
    super(`timed out after ${timeoutMs}ms`);
    this.name = 'WaitTimeoutError';
    this.code = 'TIMEOUT';
    this.state = state;
  }
}

/**
 * Polls the DOM completion signals until done(state, want) is true. Never
 * sleeps a fixed duration as a completion signal and never returns early on
 * the first image. The script is built once, up front, so a key with no
 * usable candidate fails immediately as a SelectorMissError instead of
 * burning the whole timeout and reporting a misleading TIMEOUT.
 */
async function waitDone(page, set, want, timeoutMs) {
  const js = stateScript(set);
  const deadline = Date.now() + timeoutMs;
  let last = { loading: false, streaming: false, imageURLs: [], alts: [] };
  while (Date.now() < deadline) {
    try {
      const st = await evalStateScript(page, js);
      last = st;
      if (done(st, want)) {
        return st;
      }
    } catch {
      // Transient read error; keep polling until the deadline.
    }
    await sleep(3000);
  }
  throw new WaitTimeoutError(timeoutMs, last);
}

/**
 * Tidies a finished conversation out of the sidebar. Standalone: the
 * caller decides when to call it. NEVER call this from send() or
 * waitDone() -- on failure the conversation URL is the recovery path, so a
 * failed run must never be archived.
 */
async function archive(page, set) {
  const btn = await resolve(page, set, 'conversation_options', 10000);
  await btn.click();
  await sleep(700);
  // The archive menu item has no selectors.json key of its own: unlike
  // conversation_options (a stable control), its identity is "whichever
  // menu item's text says Archive", which a text match finds more reliably
  // than a structural selector would. This mirrors compose.go's use of
  // ElementR here, deliberately, rather than resolve().
  let handle;
  try {
    handle = await page.waitForFunction(
      () => {
        const els = document.querySelectorAll("div[role='menuitem'], button");
        for (const el of els) {
          if (/^archive$/i.test((el.textContent || '').trim())) return el;
        }
        return null;
      },
      { timeout: 8000 }
    );
  } catch (err) {
    throw new Error(`archive menu item not found: ${err.message}`);
  }
  const item = handle.asElement();
  if (!item) {
    throw new Error('archive menu item not found');
  }
  await item.click();
}

module.exports = {
  SelectorMissError,
  WaitTimeoutError,
  resolve,
  newChat,
  send,
  readState,
  waitDone,
  archive,
  // Exported for unit tests and for a later fixture test to eval the exact
  // same page scripts this module runs in production.
  attachmentsReady,
  attachTimeoutError,
  joinQuery,
  stateScript,
  selectAllInBrowser,
  countMatchesInBrowser,
  KEY_LOADING_STATE,
  KEY_STOP_BUTTON,
  KEY_GENERATED_IMAGE,
  ATTACH_UPLOAD_TIMEOUT_MS,
  ATTACH_POLL_INTERVAL_MS,
};
