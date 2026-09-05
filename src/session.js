'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('puppeteer-core');

const { profileDir } = require('./profile');
const { hideWindow: hideWindowImpl } = require('./window');

// Port of internal/session/browser.go, devtools.go and auth.go. Owns the
// whole browser lifecycle. Everything here exists so a real, signed-in
// Chrome profile survives every run and every crash -- see the module-level
// comment in profile.go: "Everything here is about not corrupting the
// user's login."
//
// The single most important rule in this file: NEVER let puppeteer manage
// (and therefore delete) the profile directory. puppeteer only marks a
// userDataDir "temp" -- and cleans it up with an rm on close -- when the
// caller does NOT pass a userDataDir option itself (see
// node_modules/puppeteer-core/lib/puppeteer/node/ChromeLauncher.js:
// isTempUserDataDir stays false whenever a `--user-data-dir` argument is
// already present, which it always is here because `open()` always passes
// `userDataDir: profileDir()` explicitly to puppeteer.launch()). Never
// launch without that option.

// --- chromePath ---------------------------------------------------------

// chromeLookPathNames are executable names searched on $PATH, in priority
// order, when no well-known absolute path exists for the current OS. Exact
// port of browser.go's chromeLookPathNames.
const CHROME_LOOKPATH_NAMES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
];

/**
 * The well-known absolute paths to a Chrome-family browser for `platform`
 * (a node process.platform value), in priority order. Port of browser.go's
 * chromeCandidates -- takes platform as a parameter rather than reading
 * process.platform itself so every platform's list is testable from any
 * host.
 */
function chromeCandidates(platform) {
  switch (platform) {
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ];
    case 'linux':
      return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
      ];
    default:
      return [];
  }
}

function defaultExists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Node has no exec.LookPath equivalent, so this walks $PATH itself, checking
 * each directory for an executable file named `name`. Returns the resolved
 * path, or null if not found anywhere on $PATH.
 */
function defaultLookPath(name) {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const st = fs.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // not found / not executable here; keep looking
    }
  }
  return null;
}

/**
 * Implements chromePath()'s resolution order against injectable
 * exists/lookPath functions so the logic is testable without a real Chrome
 * installation anywhere on the test machine. Port of browser.go's
 * resolveChromePath.
 */
function resolveChromePath(platform, exists, lookPath) {
  const override = process.env.GPT_IMAGEGEN_CHROME;
  if (override) {
    if (!exists(override)) {
      throw new Error(
        `GPT_IMAGEGEN_CHROME is set to "${override}" but no file exists there`
      );
    }
    return override;
  }
  const candidates = chromeCandidates(platform);
  for (const p of candidates) {
    if (exists(p)) return p;
  }
  for (const name of CHROME_LOOKPATH_NAMES) {
    const p = lookPath(name);
    if (p) return p;
  }
  throw new Error(
    `no Chrome-family browser found for ${platform} (checked $GPT_IMAGEGEN_CHROME, ` +
      `${candidates.length} well-known install path(s), and $PATH for ` +
      `${CHROME_LOOKPATH_NAMES.join(', ')}); set $GPT_IMAGEGEN_CHROME or install Chrome`
  );
}

/**
 * Locates a Chrome-family browser binary. Resolution order:
 *   1. $GPT_IMAGEGEN_CHROME, if set -- always wins, even when the path turns
 *      out not to exist, so a broken override is reported as a clear error
 *      rather than silently falling through to something else.
 *   2. A well-known absolute path for the current OS.
 *   3. $PATH, searched for common Chrome-family executable names.
 */
function chromePath() {
  return resolveChromePath(process.platform, defaultExists, defaultLookPath);
}

// --- DevToolsActivePort / attach-or-launch endpoint discovery -----------

/**
 * True only for a string that is exactly an unsigned decimal integer in the
 * usable TCP port range 1..65535 -- no sign, no decimal point, no
 * leading/trailing junk. Rejects 0 (not a connectable port), out-of-range
 * values like 65536 or 99999999, and non-numeric junk like "abc" or "1.5".
 *
 * This exists because Node's http client validates its own `port` option
 * and throws SYNCHRONOUSLY for an out-of-range value -- so an unvalidated
 * garbage port read from disk was reaching http.get() and crashing the
 * caller instead of degrading to "not live". Rejecting it here, at parse
 * time, means a corrupted or stale DevToolsActivePort file is treated
 * exactly like any other malformed file: not trusted, never fatal.
 */
function isValidPortString(s) {
  if (!/^[0-9]+$/.test(s)) return false;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Parses the two-line file Chrome writes into its user-data-dir:
 * port on line 1, browser websocket path on line 2. Port of devtools.go's
 * ParseDevToolsActivePort. Accepts a string or Buffer.
 */
function parseDevToolsActivePort(raw) {
  const text = (Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '')).trim();
  const lines = text.split('\n');
  if (lines.length < 2) {
    throw new Error('DevToolsActivePort: want 2 lines');
  }
  const port = lines[0].trim();
  const wsPath = lines[1].trim();
  if (!port || !wsPath.startsWith('/') || !isValidPortString(port)) {
    throw new Error('DevToolsActivePort: malformed');
  }
  return { port, path: wsPath };
}

/**
 * GETs http://127.0.0.1:<port>/json/version with a short timeout, resolving
 * true only on a 200 response. Never rejects -- any error, timeout, OR
 * synchronous throw (e.g. an out-of-range port slipping past validation
 * some other way) means "not live". The try/catch around the whole body is
 * deliberate belt-and-braces on top of isValidPortString: this is exactly
 * the class of bug where something unanticipated throws where a boolean
 * was assumed, so the seam that talks to a runtime we don't control (Node's
 * http client) is the one wrapped defensively.
 */
function isPortLive(port, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const req = http.get(
        { host: '127.0.0.1', port: Number(port), path: '/json/version', timeout: timeoutMs },
        (res) => {
          res.resume(); // drain so the socket can close
          resolve(res.statusCode === 200);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Returns a browser endpoint for a Chrome already running on this profile
 * directory, verifying liveness first so a stale DevToolsActivePort file is
 * never trusted. Returns null when the file is missing, malformed, or names
 * a port nothing is listening on. Port of devtools.go's EndpointFromProfile,
 * made async because Node has no synchronous HTTP client.
 *
 * On success returns { port, wsPath, browserURL } where browserURL is the
 * `http://127.0.0.1:<port>` form puppeteer.connect({ browserURL }) expects.
 */
async function endpointFromProfile(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'DevToolsActivePort'));
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = parseDevToolsActivePort(raw);
  } catch {
    return null;
  }
  const alive = await isPortLive(parsed.port, 2000);
  if (!alive) return null;
  return {
    port: parsed.port,
    wsPath: parsed.path,
    browserURL: `http://127.0.0.1:${parsed.port}`,
  };
}

// --- open / close ---------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds the exact options object passed to puppeteer.launch(). Pure and
 * side-effect free -- no puppeteer call, no filesystem access -- precisely
 * so the launch flags can be asserted on directly without ever launching a
 * browser. `userDataDir` is REQUIRED and validated non-empty: a missing one
 * is exactly what lets puppeteer invent (and mark as temp, and later
 * delete) its own profile directory -- see the module comment at the top of
 * this file. Never call puppeteer.launch() with an options object built any
 * other way.
 */
/**
 * The cap puppeteer puts on every single CDP command (Connection.js applies
 * `timeout ?? 180_000`). Set explicitly rather than inherited so the cap is
 * visible at the call site: it is not a budget for a whole generation --
 * every wait in this codebase is a Node-side polling loop of short calls --
 * but it is what a single stalled call costs before it fails, and the text
 * puppeteer raises when it does is rewritten before a user ever sees it
 * (see describeCdpError in cli.js).
 */
const PROTOCOL_TIMEOUT_MS = 180000;

function launchOptions({ headless, userDataDir, executablePath }) {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) {
    throw new Error('launchOptions requires a non-empty userDataDir');
  }
  return {
    executablePath,
    userDataDir,
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    // puppeteer adds --enable-automation by default; that flag is exactly
    // what tips ChatGPT off, so it is stripped here rather than trusting
    // any inferred default.
    ignoreDefaultArgs: ['--enable-automation'],
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
  };
}

/**
 * Attaches to a Chrome already running on our profile, else launches one.
 * The launch flags (see launchOptions) are load-bearing for avoiding bot
 * detection; do not trim them, and never run headless in normal operation
 * -- headless exists only for tests.
 *
 * hideWindow is an explicit choice, never inferred from headless: a window
 * the user has to interact with -- sign-in during `setup`, a Cloudflare
 * challenge -- must stay where the user can see it, so those callers pass
 * hideWindow=false. Only the generate/edit/probe paths, which no human ever
 * looks at, pass true. headless and hideWindow are independent booleans;
 * neither is ever derived from the other -- inferring hideWindow from
 * headless is exactly the bug that once hid the window the user had to sign
 * in through.
 *
 * `deps` is test-only dependency injection: `deps.puppeteer` overrides the
 * real puppeteer-core module (so tests can assert connect() vs launch()
 * without a real Chrome), and `deps.hideWindow` overrides the window-hiding
 * implementation (so tests can spy on whether it was invoked). Both default
 * to the real thing; production code never passes `deps`.
 *
 * Returns a handle: { browser, owned, pid }. `owned` is true only when this
 * call launched Chrome itself; close() uses it to make sure an attached
 * browser (belonging to some other process/session) is never torn down.
 */
async function open({ headless, hideWindow }, deps = {}) {
  if (typeof headless !== 'boolean' || typeof hideWindow !== 'boolean') {
    throw new Error('session.open requires explicit boolean { headless, hideWindow }');
  }
  const puppeteerImpl = deps.puppeteer || puppeteer;
  const hideWindowFn = deps.hideWindow || hideWindowImpl;

  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const endpoint = await endpointFromProfile(dir);
  if (endpoint) {
    let browser;
    try {
      // puppeteer.connect()'s close() sends the CDP `Browser.close` command,
      // which would terminate someone else's Chrome -- close() below must
      // never call it for an attached handle. See close()'s comment.
      browser = await puppeteerImpl.connect({
        browserURL: endpoint.browserURL,
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
      });
    } catch {
      browser = undefined;
      // Endpoint claimed to be live but connect failed anyway; fall through
      // to launching our own, exactly like the Go version's `if err == nil`.
    }
    if (browser) {
      try {
        return { browser, owned: false, pid: null };
      } catch (err) {
        // Defensive: if a future step here ever throws, detach rather than
        // leak the connection. Never .close() an attached browser -- that
        // would kill the real, shared Chrome instead of merely letting go.
        await Promise.resolve(browser.disconnect?.()).catch(() => {});
        throw err;
      }
    }
  }

  const bin = chromePath();
  const options = launchOptions({ headless, userDataDir: dir, executablePath: bin });
  const browser = await puppeteerImpl.launch(options);

  // NOTE: we deliberately never delete or otherwise manage userDataDir
  // ourselves, and launchOptions always sets it explicitly so puppeteer
  // never treats it as a temp dir it owns. Destroying the user's login here
  // was the single worst failure mode in the Go version (launcher.Cleanup()).

  try {
    const proc = browser.process();
    const pid = proc ? proc.pid : null;

    // Hide the automation window offscreen so it never steals focus. Only
    // when the caller explicitly asked for it, only on the launch path,
    // only when headful (headless has no window to hide), and only when we
    // have a real pid to target. The error is deliberately ignored: a
    // visible window is acceptable, a failed run is not.
    if (hideWindow && !headless && pid) {
      try {
        hideWindowFn(pid);
      } catch {
        // non-fatal, see above
      }
    }

    return { browser, owned: true, pid };
  } catch (err) {
    // A browser we just launched but never got to return: close it rather
    // than leak a live, orphaned Chrome process nothing will ever close.
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Shuts Chrome down gracefully so cookies are flushed, but only if this
 * process launched it (`handle.owned`). An attached browser belongs to
 * someone else -- calling .close() on a puppeteer-core browser obtained via
 * connect() actually sends the CDP `Browser.close` command and terminates
 * the real remote Chrome (it is not a mere disconnect), so this check is
 * the only thing standing between us and killing someone else's session.
 * Safe to call with a null/undefined handle.
 */
async function close(handle) {
  if (!handle || !handle.owned || !handle.browser) return;
  try {
    await handle.browser.close();
  } catch {
    // Matches Go's Close(), which discards the error from Rod's Close():
    // a failed graceful close is not worth failing the whole run over.
  }
  // Give Chrome a moment to flush cookies to disk after close resolves,
  // exactly like the Go version's 1500ms sleep -- a hard kill can drop
  // recent cookies and silently sign the user out.
  await sleep(1500);
}

// --- auth -----------------------------------------------------------------

/**
 * Parses the safe-to-log view of /api/auth/session. The raw payload can
 * carry accessToken and sessionToken, so only key names are ever retained;
 * `summary` is the sorted, comma-joined key list and must never be built
 * from anything but those keys. Port of auth.go's ParseAuthBody.
 *
 * `user` counts as logged in only when it is a non-empty, non-array object
 * -- {"user": false}, {"user": ""}, {"user": 0}, {"user": []} and
 * {"user": {}} must all be logged OUT.
 */
function parseAuthBody(body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('auth endpoint did not return JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('auth endpoint did not return JSON');
  }

  const keys = Object.keys(parsed).sort();
  const user = parsed.user;
  const loggedIn =
    !!user &&
    typeof user === 'object' &&
    !Array.isArray(user) &&
    Object.keys(user).length > 0;

  return { loggedIn, keys, summary: keys.join(',') };
}

/**
 * Probes the session endpoint in its own throwaway page/tab, closed on
 * every path (including errors) so a page that may be mid-login is never
 * navigated away from. Port of browser.go's Browser.Auth.
 */
async function auth(handle) {
  const page = await handle.browser.newPage();
  try {
    await page.goto('https://chatgpt.com/api/auth/session', {
      timeout: 25000,
      waitUntil: 'load',
    });
    // page.$eval runs the callback inside the browser tab via CDP, the
    // standard puppeteer DOM-read primitive -- not JS eval() of untrusted
    // input; the function body is this file's own literal source.
    const text = await page.$eval('body', (el) => el.textContent || '');
    return parseAuthBody(text.trim());
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = {
  PROTOCOL_TIMEOUT_MS,
  chromePath,
  parseDevToolsActivePort,
  endpointFromProfile,
  launchOptions,
  open,
  close,
  auth,
  parseAuthBody,
  // Exposed only so tests can exercise platform-specific tables and the
  // injectable resolver without needing a real Chrome install or $PATH
  // entry -- mirrors how browser_test.go reaches chromeCandidates and
  // resolveChromePath directly as same-package unexported helpers.
  _internal: { chromeCandidates, resolveChromePath, isPortLive, isValidPortString },
};
