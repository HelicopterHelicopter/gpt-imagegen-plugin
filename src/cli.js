'use strict';

const { parseArgs } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const envelope = require('./envelope');
const selectors = require('./selectors');
const pageState = require('./state');
const lockMod = require('./lock');
const profile = require('./profile');
const sessionMod = require('./session');
const capture = require('./capture');
const naming = require('./naming');
const compose = require('./compose');
const probe = require('./probe');
const { fileIdFromUrl } = require('./urls');

// Wires every port module into the CLI. Port of cmd/gpt-imagegen/run.go and
// main.go. stdout carries EXACTLY ONE line of JSON, ever -- the skill parses
// stdout unconditionally, so a stray write there breaks the whole plugin.
// Every other message (progress, warnings, panics) goes to stderr.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- window policy ----------------------------------------------------
//
// Named constants, not bare booleans passed inline, for the same reason as
// the Go original: getting this wrong is invisible in a diff and
// catastrophic in use. `headless` is never true in normal operation -- it
// is the strongest bot-detection signal there is. `hideWindow` is an
// explicit, per-command choice, never inferred from `headless`: setup and
// doctor are sessions a human must look at or touch (sign-in, a Cloudflare
// challenge), so they ask for a VISIBLE window; generate/edit/probe hide
// theirs because no human ever sees them.
const HEADLESS = false;
const VISIBLE_WINDOW = false; // hideWindow=false
const HIDDEN_WINDOW = true; // hideWindow=true

// Stage names for probe dumps and failure envelopes. Literals, never user
// input, so they are safe as file-name components (see probe.sanitizeStage).
const STAGE_COMPOSER = 'composer';
const STAGE_GENERATION = 'generation';

/**
 * The seam every command opens/closes/authenticates its browser through.
 * A plain mutable object, not module-level `let` bindings, so a test can
 * reach in via `require('../src/cli')._internal` and replace one function
 * (e.g. to assert a command never launches Chrome) without needing `run` to
 * accept anything beyond the fixed `(argv, stdout, stderr)` signature.
 * Production code never overrides this; it is the direct port of run.go's
 * package-level `var openBrowser = session.Open` seam, translated to
 * per-object mutation since JS has no package-private test access.
 */
const internal = {
  openSession: sessionMod.open,
  closeSession: sessionMod.close,
  auth: sessionMod.auth,
};

function artifactDir() {
  const d = path.join(os.tmpdir(), 'gpt-imagegen');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function emit(stream, result) {
  envelope.write(result, stream);
  return envelope.exitCode(result);
}

/**
 * Saves a PNG of the page next to the probe dump. Only worth taking on a
 * selector miss, where the question is "what does the page actually look
 * like now" -- so any failure here degrades to an empty path rather than
 * failing the run.
 */
async function writeScreenshot(page, stage, dir) {
  let buf;
  try {
    buf = await page.screenshot({ type: 'png' });
  } catch {
    return '';
  }
  if (!buf || buf.length === 0) return '';
  const dest = path.join(dir, `fail-${stage}.png`);
  try {
    fs.writeFileSync(dest, buf, { mode: 0o600 });
  } catch {
    return '';
  }
  return dest;
}

/**
 * Builds the one failure the skill is allowed to repair: the probe dump it
 * reads candidates from, the key it must patch, and a screenshot of the
 * page as it actually was. `stage` is always a caller-side literal.
 */
async function selectorMissResult(page, miss, stage) {
  const dir = artifactDir();
  let probePath = '';
  try {
    probePath = await probe.capture(page, stage, dir);
  } catch {
    probePath = '';
  }
  const r = envelope.failure(envelope.CODES.SELECTOR_MISS, miss.message);
  r.error.selectorKey = miss.selectorKey || '';
  r.error.stage = stage;
  r.error.probe = probePath;
  r.error.screenshot = await writeScreenshot(page, stage, dir);
  return r;
}

async function cmdSetup(stdout, stderr) {
  let handle;
  try {
    // visibleWindow is load-bearing here: this is the window the user signs
    // in through, and the one a Cloudflare challenge has to be solved in.
    handle = await internal.openSession({ headless: HEADLESS, hideWindow: VISIBLE_WINDOW });
  } catch (err) {
    return emit(stdout, envelope.failure(envelope.CODES.CHROME_MISSING, err.message));
  }
  try {
    let st = null;
    try {
      st = await internal.auth(handle);
    } catch {
      st = null;
    }
    if (st && st.loggedIn) {
      stderr.write(`already signed in; keys=${st.summary}\n`);
      return emit(stdout, envelope.success(null, '', false, 0));
    }

    let page;
    try {
      page = await handle.browser.newPage();
      await page.goto('https://chatgpt.com/', { waitUntil: 'load' });
    } catch (err) {
      return emit(stdout, envelope.failure(envelope.CODES.NOT_LOGGED_IN, err.message));
    }

    stderr.write('Sign in to ChatGPT in the Chrome window. Waiting up to 10 minutes.\n');
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      let s = null;
      try {
        s = await internal.auth(handle);
      } catch {
        s = null;
      }
      if (s && s.loggedIn) {
        stderr.write(`signed in; keys=${s.summary}\n`);
        return emit(stdout, envelope.success(null, '', false, 0));
      }
      await sleep(6000);
    }
    return emit(stdout, envelope.failure(envelope.CODES.NOT_LOGGED_IN, 'timed out waiting for sign-in'));
  } finally {
    await internal.closeSession(handle);
  }
}

async function cmdDoctor(stdout, stderr) {
  try {
    sessionMod.chromePath();
  } catch (err) {
    return emit(stdout, envelope.failure(envelope.CODES.CHROME_MISSING, err.message));
  }
  let handle;
  try {
    // doctor is a diagnostic a human runs and watches, so it stays visible.
    handle = await internal.openSession({ headless: HEADLESS, hideWindow: VISIBLE_WINDOW });
  } catch (err) {
    return emit(stdout, envelope.failure(envelope.CODES.CHROME_MISSING, err.message));
  }
  try {
    let st = null;
    try {
      st = await internal.auth(handle);
    } catch {
      st = null;
    }
    if (!st || !st.loggedIn) {
      return emit(stdout, envelope.failure(envelope.CODES.NOT_LOGGED_IN, 'run: gpt-imagegen setup'));
    }
    stderr.write(`chrome ok, profile ok, auth ok; keys=${st.summary}\n`);
    return emit(stdout, envelope.success(null, '', false, 0));
  } finally {
    await internal.closeSession(handle);
  }
}

/** Parses "--count" into a positive-or-not integer, exactly like Go's flag.Int would. */
function parseCount(raw) {
  if (!/^-?\d+$/.test(raw)) return null;
  return parseInt(raw, 10);
}

function cmdGenerate(args, stdout, stderr) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        prompt: { type: 'string' },
        out: { type: 'string' },
        count: { type: 'string' },
        ref: { type: 'string', multiple: true },
      },
    });
  } catch (err) {
    return emit(stdout, envelope.failure(envelope.CODES.REFUSED, err.message));
  }
  const prompt = parsed.values.prompt || '';
  const out = parsed.values.out || '';
  const refs = parsed.values.ref || [];
  if (!prompt || !out) {
    return emit(stdout, envelope.failure(envelope.CODES.REFUSED, '--prompt and --out are required'));
  }
  let count = 1;
  if (parsed.values.count !== undefined) {
    count = parseCount(parsed.values.count);
    if (count === null) {
      return emit(stdout, envelope.failure(envelope.CODES.REFUSED, `invalid --count: ${parsed.values.count}`));
    }
  }
  return generate(prompt, out, count, refs, stdout, stderr);
}

function cmdEdit(args, stdout, stderr) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        image: { type: 'string' },
        prompt: { type: 'string' },
        out: { type: 'string' },
      },
    });
  } catch (err) {
    return emit(stdout, envelope.failure(envelope.CODES.REFUSED, err.message));
  }
  const image = parsed.values.image || '';
  const prompt = parsed.values.prompt || '';
  const out = parsed.values.out || '';
  if (!image || !prompt || !out) {
    return emit(stdout, envelope.failure(envelope.CODES.REFUSED, '--image, --prompt and --out are required'));
  }
  // Fail fast, before any browser is launched: a missing --image is a user
  // error, not something worth spending a Chrome launch (or the profile
  // lock) to discover.
  try {
    fs.statSync(image);
  } catch {
    return emit(stdout, envelope.failure(envelope.CODES.REFUSED, `no such image: ${image}`));
  }
  return generate(prompt, out, 1, [image], stdout, stderr);
}

async function cmdProbe(args, stdout, stderr) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { stage: { type: 'string' } } });
  } catch (err) {
    return emit(stdout, envelope.failure(envelope.CODES.REFUSED, err.message));
  }
  const stage = parsed.values.stage || 'composer';

  let handle;
  try {
    // Nobody watches a probe run; it only dumps the DOM.
    handle = await internal.openSession({ headless: HEADLESS, hideWindow: HIDDEN_WINDOW });
  } catch (err) {
    return emit(stdout, envelope.failure(envelope.CODES.CHROME_MISSING, err.message));
  }
  try {
    let page;
    try {
      page = await handle.browser.newPage();
      await page.goto('https://chatgpt.com/', { waitUntil: 'load' });
    } catch (err) {
      return emit(stdout, envelope.failure(envelope.CODES.TIMEOUT, err.message));
    }
    await sleep(3000);

    let probePath;
    try {
      probePath = await probe.capture(page, stage, artifactDir());
    } catch (err) {
      return emit(stdout, envelope.failure(envelope.CODES.SELECTOR_MISS, err.message));
    }
    const r = envelope.failure(envelope.CODES.SELECTOR_MISS, 'probe written');
    r.error.probe = probePath;
    r.error.stage = stage;
    r.error.screenshot = await writeScreenshot(page, 'probe', artifactDir());
    return emit(stdout, r);
  } finally {
    await internal.closeSession(handle);
  }
}

/**
 * Writes every generated image it can actually retrieve and returns the
 * envelope entries for them. Shared by the success path and the
 * timeout-salvage path so the two can never drift. The only error it lets
 * propagate is a genuine filesystem failure; an image whose bytes cannot be
 * retrieved is skipped, leaving a shorter list rather than failing the run.
 *
 * Fallback order for image bytes: rec.url(id) first, then a scan of
 * state.imageURLs -- never the reverse.
 */
async function saveImages(page, rec, state, ids, out, stderr) {
  const files = rec.files();
  const images = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    let data = files[id];
    if (!data || data.length === 0) {
      let srcUrl = rec.url(id);
      if (!srcUrl) {
        for (const u of state.imageURLs) {
          if (fileIdFromUrl(u) === id) {
            srcUrl = u;
            break;
          }
        }
      }
      if (srcUrl) {
        try {
          data = await capture.fetchInPage(page, srcUrl);
        } catch {
          data = null;
        }
      }
    }
    if (!data || data.length === 0) continue;

    // Titles come from altForId, which walks the same per-tag imageURLs/alts
    // arrays state.js does -- never by indexing alts with `i`, the position
    // in this deduplicated id list.
    const title = naming.titleFromAlt(pageState.altForId(state, id));
    const ext = naming.extFor(rec.mime(id));
    const dst = naming.outputPath(out, i, title, ext);
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o755 });
    fs.writeFileSync(dst, data, { mode: 0o644 });
    let dims = { width: 0, height: 0 };
    try {
      dims = capture.dimensions(data);
    } catch {
      // Unrecognised format: 0x0, matching Go's discarded-error behaviour.
    }
    images.push({ path: dst, bytes: data.length, width: dims.width, height: dims.height, title });
    stderr.write(`saved ${dst} (${data.length} bytes)\n`);
  }
  return images;
}

/**
 * The shared path for both `generate` and `edit`. Port of run.go's
 * `generate`. Acquires the profile lock before touching the browser and
 * releases it (finally) no matter how the run ends; never retries a
 * generation; archives only after every image is on disk, and never on a
 * failure or salvaged-timeout path.
 */
async function generate(prompt, out, count, refs, stdout, stderr) {
  const start = Date.now();

  // Any AcquireLock failure -- not only a timeout -- is reported as
  // PROFILE_LOCKED, matching run.go's unconditional mapping.
  let lock;
  try {
    lock = lockMod.acquireLock(profile.lockPath(), 3 * 60 * 1000);
  } catch (err) {
    return emit(stdout, envelope.failure(envelope.CODES.PROFILE_LOCKED, err.message));
  }

  try {
    // selectors.userPath() can fail to resolve (e.g. no home dir). A silent
    // fallback to embedded defaults would disable self-heal without anyone
    // noticing, so surface it as a refusal instead.
    let userPath;
    try {
      userPath = selectors.userPath();
    } catch (err) {
      return emit(stdout, envelope.failure(envelope.CODES.REFUSED, `resolve selectors path: ${err.message}`));
    }
    let sel;
    try {
      sel = selectors.load(userPath);
    } catch (err) {
      return emit(stdout, envelope.failure(envelope.CODES.REFUSED, err.message));
    }

    let handle;
    try {
      // The generation session is the ONLY one that hides its window: no
      // human ever looks at it, and it must not steal focus mid-task.
      handle = await internal.openSession({ headless: HEADLESS, hideWindow: HIDDEN_WINDOW });
    } catch (err) {
      return emit(stdout, envelope.failure(envelope.CODES.CHROME_MISSING, err.message));
    }

    try {
      let st = null;
      try {
        st = await internal.auth(handle);
      } catch {
        st = null;
      }
      if (!st || !st.loggedIn) {
        return emit(stdout, envelope.failure(envelope.CODES.NOT_LOGGED_IN, 'run: gpt-imagegen setup'));
      }

      let page;
      try {
        page = await handle.browser.newPage();
      } catch (err) {
        return emit(stdout, envelope.failure(envelope.CODES.TIMEOUT, err.message));
      }

      const rec = capture.createRecorder(page);
      rec.start();

      try {
        await compose.newChat(page);
      } catch (err) {
        return emit(stdout, envelope.failure(envelope.CODES.TIMEOUT, err.message));
      }
      stderr.write('composer ready; sending prompt\n');

      try {
        await compose.send(page, sel, prompt, refs);
      } catch (err) {
        // A SelectorMissError (including the attachment_remove timeout) is
        // the one repairable failure; anything else is a timeout from the
        // caller's perspective -- nothing was sent, so there is nothing to
        // recover.
        if (err instanceof compose.SelectorMissError) {
          return emit(stdout, await selectorMissResult(page, err, STAGE_COMPOSER));
        }
        return emit(stdout, envelope.failure(envelope.CODES.TIMEOUT, err.message));
      }

      let convUrl = '';
      try {
        convUrl = page.url() || '';
      } catch {
        convUrl = '';
      }

      // waitDone's WaitTimeoutError carries the LAST observed state
      // (err.state) precisely so the salvage path below can still read it:
      // a run that produced images but tripped the deadline has already
      // spent the ChatGPT turn, and under a no-retry discipline throwing
      // those images away is the worst outcome available.
      let waitErr = null;
      let st2 = null;
      try {
        st2 = await compose.waitDone(page, sel, count, 6 * 60 * 1000);
      } catch (err) {
        waitErr = err;
        st2 = err.state || { loading: false, streaming: false, imageURLs: [], alts: [] };
      }
      try {
        convUrl = page.url() || convUrl;
      } catch {
        // keep whatever convUrl already held
      }

      let timedOut = false;
      if (waitErr) {
        if (waitErr instanceof compose.SelectorMissError) {
          // A completion selector with no usable candidate: repairable, so
          // report it as SELECTOR_MISS with a probe rather than burying it
          // in a TIMEOUT.
          const r = await selectorMissResult(page, waitErr, STAGE_GENERATION);
          return emit(stdout, envelope.withConversation(r, convUrl));
        }
        timedOut = true;
        stderr.write(`generation did not signal completion (${waitErr.message}); salvaging whatever arrived\n`);
      }

      const ids = pageState.distinctImageIds(st2);
      if (ids.length === 0) {
        if (timedOut) {
          return emit(
            stdout,
            envelope.withConversation(envelope.failure(envelope.CODES.TIMEOUT, waitErr.message), convUrl)
          );
        }
        return emit(
          stdout,
          envelope.withConversation(
            envelope.failure(envelope.CODES.NO_IMAGE_RETURNED, 'no generated image in the response'),
            convUrl
          )
        );
      }

      let images;
      try {
        images = await saveImages(page, rec, st2, ids, out, stderr);
      } catch (err) {
        return emit(stdout, envelope.withConversation(envelope.failure(envelope.CODES.REFUSED, err.message), convUrl));
      }

      if (images.length === 0) {
        if (timedOut) {
          return emit(
            stdout,
            envelope.withConversation(envelope.failure(envelope.CODES.TIMEOUT, waitErr.message), convUrl)
          );
        }
        return emit(
          stdout,
          envelope.withConversation(
            envelope.failure(envelope.CODES.NO_IMAGE_RETURNED, 'image bytes could not be retrieved'),
            convUrl
          )
        );
      }

      const elapsedS = (Date.now() - start) / 1000;

      if (timedOut) {
        // Salvaged run: real images on disk, so ok:true with exactly the
        // images that exist. Deliberately NOT archived -- the conversation
        // is the recovery path for the images that never arrived.
        stderr.write(
          `warning: run timed out (${waitErr.message}) and saved ${images.length} of ${count} requested images; ` +
            `the conversation is left unarchived at ${convUrl} for recovery\n`
        );
        return emit(stdout, envelope.success(images, convUrl, false, elapsedS));
      }

      // A partial save is still ok:true (the schema is unchanged; the
      // caller can compare images.length to count), but silently shipping
      // fewer images than requested deserves a visible warning.
      if (images.length < count) {
        stderr.write(`warning: saved ${images.length} of ${count} requested images\n`);
      }

      // Archive only now that every file is on disk. A failed run is never
      // archived, because its conversation URL is the recovery path. A
      // failure to archive is cosmetic and must not fail the run.
      let archived = false;
      try {
        await compose.archive(page, sel);
        archived = true;
      } catch (err) {
        stderr.write(`archive skipped: ${err.message}\n`);
      }

      return emit(stdout, envelope.success(images, convUrl, archived, elapsedS));
    } finally {
      await internal.closeSession(handle);
    }
  } finally {
    lockMod.releaseLock(lock);
  }
}

/**
 * `run` is a plain function taking streams, so tests drive it with buffers
 * rather than spawning processes. Returns the process exit code.
 */
async function run(argv, stdout, stderr) {
  const args = argv || [];
  if (args.length === 0) {
    return emit(
      stdout,
      envelope.failure(envelope.CODES.REFUSED, 'usage: gpt-imagegen <setup|doctor|generate|edit|probe>')
    );
  }
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'setup':
      return cmdSetup(stdout, stderr);
    case 'doctor':
      return cmdDoctor(stdout, stderr);
    case 'generate':
      return cmdGenerate(rest, stdout, stderr);
    case 'edit':
      return cmdEdit(rest, stdout, stderr);
    case 'probe':
      return cmdProbe(rest, stdout, stderr);
    default:
      return emit(stdout, envelope.failure(envelope.CODES.REFUSED, `unknown command ${cmd}`));
  }
}

/**
 * Runs `fn`, converting any throw -- synchronous, or an async function's
 * rejection -- into a single JSON failure line on stdout, so the "exactly
 * one line of JSON" contract holds even when the process is failing:
 * without this, an uncaught throw would either crash the process before
 * anything reached stdout, or (worse) let the thrown value's raw text leak
 * onto the one channel the skill parses. `fn` is injectable so this guard
 * is testable with a function that throws, without a self-exec or a hidden
 * CLI command.
 *
 * The thrown value's detail is logged to stderr only; stdout always carries
 * a fixed, generic message, because the thrown value could be arbitrary
 * (a raw string, an object, anything) and is not safe to echo onto stdout.
 */
async function safeRun(fn, stdout, stderr) {
  try {
    return await fn();
  } catch (err) {
    const detail = err && err.stack ? err.stack : String(err);
    stderr.write(`gpt-imagegen: internal error: ${detail}\n`);
    const r = envelope.failure(envelope.CODES.REFUSED, 'internal error; see stderr for details');
    envelope.write(r, stdout);
    return envelope.exitCode(r);
  }
}

module.exports = {
  run,
  safeRun,
  // Test-only seam -- see the `internal` doc comment above. Production code
  // never reads or writes this from outside this module.
  _internal: internal,
};
