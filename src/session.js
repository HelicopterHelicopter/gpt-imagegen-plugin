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
  if (!port || !wsPath.startsWith('/')) {
    throw new Error('DevToolsActivePort: malformed');
  }
  return { port, path: wsPath };
}

/**
 * GETs http://127.0.0.1:<port>/json/version with a short timeout, resolving
 * true only on a 200 response. Never rejects -- any error or timeout means
 * "not live".
 */
function isPortLive(port, timeoutMs) {
  return new Promise((resolve) => {
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
 * Attaches to a Chrome already running on our profile, else launches one.
 * The launch flags are load-bearing for avoiding bot detection; do not trim
 * them, and never run headless in normal operation -- headless exists only
 * for tests.
 *
 * hideWindow is an explicit choice, never inferred from headless: a window
 * the user has to interact with -- sign-in during `setup`, a Cloudflare
 * challenge -- must stay where the user can see it, so those callers pass
 * hideWindow=false. Only the generate/edit/probe paths, which no human ever
 * looks at, pass true.
 *
 * Returns a handle: { browser, owned, pid }. `owned` is true only when this
 * call launched Chrome itself; close() uses it to make sure an attached
 * browser (belonging to some other process/session) is never torn down.
 */
async function open({ headless, hideWindow }) {
  if (typeof headless !== 'boolean' || typeof hideWindow !== 'boolean') {
    throw new Error('session.open requires explicit boolean { headless, hideWindow }');
  }

  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const endpoint = await endpointFromProfile(dir);
  if (endpoint) {
    try {
      // puppeteer.connect()'s close() sends the CDP `Browser.close` command,
      // which would terminate someone else's Chrome -- close() below must
      // never call it for an attached handle. See close()'s comment.
      const browser = await puppeteer.connect({ browserURL: endpoint.browserURL });
      return { browser, owned: false, pid: null };
    } catch {
      // Endpoint claimed to be live but connect failed anyway; fall through
      // to launching our own, exactly like the Go version's `if err == nil`.
    }
  }

  const bin = chromePath();

  const browser = await puppeteer.launch({
    executablePath: bin,
    userDataDir: dir,
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
  });

  // NOTE: we deliberately never delete or otherwise manage userDataDir
  // ourselves, and we always pass it explicitly above so puppeteer never
  // treats it as a temp dir it owns. Destroying the user's login here was
  // the single worst failure mode in the Go version (launcher.Cleanup()).

  const proc = browser.process();
  const pid = proc ? proc.pid : null;

  // Hide the automation window offscreen so it never steals focus. Only
  // when the caller explicitly asked for it, only on the launch path, only
  // when headful (headless has no window to hide), and only when we have a
  // real pid to target. The error is deliberately ignored: a visible window
  // is acceptable, a failed run is not.
  if (hideWindow && !headless && pid) {
    try {
      hideWindowImpl(pid);
    } catch {
      // non-fatal, see above
    }
  }

  return { browser, owned: true, pid };
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
  chromePath,
  parseDevToolsActivePort,
  endpointFromProfile,
  open,
  close,
  auth,
  parseAuthBody,
  // Exposed only so tests can exercise platform-specific tables and the
  // injectable resolver without needing a real Chrome install or $PATH
  // entry -- mirrors how browser_test.go reaches chromeCandidates and
  // resolveChromePath directly as same-package unexported helpers.
  _internal: { chromeCandidates, resolveChromePath, isPortLive },
};
