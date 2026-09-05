'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const {
  chromePath,
  parseDevToolsActivePort,
  endpointFromProfile,
  launchOptions,
  open,
  close,
  auth,
  parseAuthBody,
  _internal,
} = require('../src/session');

const { chromeCandidates, resolveChromePath } = _internal;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-imagegen-session-test-'));
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

// withEnv's synchronous finally would restore the env var before an async
// fn's body actually finishes running (fn() returns a pending Promise
// immediately). This variant awaits fn() before restoring, which every
// open()-exercising test below needs since open() reads GPT_IMAGEGEN_* env
// vars via profile.js/session.js partway through an async function.
async function withEnvAsync(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

// --- chromePath -------------------------------------------------------

test('chromePath: env override wins', () => {
  const dir = tmpDir();
  const bin = path.join(dir, 'chrome');
  fs.writeFileSync(bin, '');
  try {
    withEnv('GPT_IMAGEGEN_CHROME', bin, () => {
      assert.equal(chromePath(), bin);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chromePath: set-but-nonexistent override errors', () => {
  withEnv('GPT_IMAGEGEN_CHROME', '/definitely/not/here/chrome', () => {
    assert.throws(() => chromePath(), /GPT_IMAGEGEN_CHROME/);
  });
});

test('chromePath: candidate list for this platform is non-empty', () => {
  const candidates = chromeCandidates(process.platform);
  assert.ok(
    candidates.length > 0,
    `chromeCandidates(${process.platform}) is empty; chromePath has no well-known fallback for this OS`
  );
});

test('chromeCandidates: darwin and linux are both non-empty', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.ok(chromeCandidates(platform).length > 0, `chromeCandidates(${platform}) is empty`);
  }
});

test('resolveChromePath: override wins even when $PATH lookup would succeed', () => {
  const dir = tmpDir();
  const bin = path.join(dir, 'chrome');
  fs.writeFileSync(bin, '');
  try {
    withEnv('GPT_IMAGEGEN_CHROME', bin, () => {
      const lookPath = (name) => `/somewhere/on/path/${name}`;
      const got = resolveChromePath('linux', fs.existsSync, lookPath);
      assert.equal(got, bin);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveChromePath: falls back to $PATH lookup when no well-known path exists', () => {
  withEnv('GPT_IMAGEGEN_CHROME', undefined, () => {
    const existsAlwaysFalse = () => false;
    const lookPath = (name) => (name === 'chromium' ? '/fake/path/chromium' : null);
    const got = resolveChromePath('linux', existsAlwaysFalse, lookPath);
    assert.equal(got, '/fake/path/chromium');
  });
});

test('resolveChromePath: errors when nothing found anywhere', () => {
  withEnv('GPT_IMAGEGEN_CHROME', undefined, () => {
    const existsAlwaysFalse = () => false;
    const lookPathAlwaysMissing = () => null;
    assert.throws(() => resolveChromePath('linux', existsAlwaysFalse, lookPathAlwaysMissing));
  });
});

// --- parseDevToolsActivePort -------------------------------------------

test('parseDevToolsActivePort: exact two-line format parses', () => {
  const raw = '62909\n/devtools/browser/e95edb1f-89fb-4db0-b419-2d919a02d5c3\n';
  const { port, path: wsPath } = parseDevToolsActivePort(raw);
  assert.equal(port, '62909');
  assert.equal(wsPath, '/devtools/browser/e95edb1f-89fb-4db0-b419-2d919a02d5c3');
});

test('parseDevToolsActivePort: accepts a Buffer, not just a string', () => {
  const raw = Buffer.from('12345\n/devtools/browser/abc\n');
  const { port, path: wsPath } = parseDevToolsActivePort(raw);
  assert.equal(port, '12345');
  assert.equal(wsPath, '/devtools/browser/abc');
});

test('parseDevToolsActivePort: one line is an error', () => {
  assert.throws(() => parseDevToolsActivePort('62909'));
});

test('parseDevToolsActivePort: empty is an error', () => {
  assert.throws(() => parseDevToolsActivePort(''));
  assert.throws(() => parseDevToolsActivePort(Buffer.alloc(0)));
});

test('parseDevToolsActivePort: malformed (second line not a path) is an error', () => {
  assert.throws(() => parseDevToolsActivePort('62909\nnot-a-path\n'));
  assert.throws(() => parseDevToolsActivePort('\n/devtools/browser/abc\n'));
});

// Fix round 1 / FINDING 1: a garbage port must be rejected as malformed at
// parse time, not handed to Node's http client where an out-of-range value
// throws SYNCHRONOUSLY and used to crash open() instead of degrading to
// "launch fresh". See task-6-report.md's "Fix round 1" section for the
// pre-fix repro showing 99999999 (and others) rejecting the promise.
test('parseDevToolsActivePort: out-of-range or non-integer ports are malformed', () => {
  for (const bad of ['99999999', '-1', '65536', '0', 'abc', '1.5', '']) {
    assert.throws(
      () => parseDevToolsActivePort(`${bad}\n/devtools/browser/abc\n`),
      `port ${JSON.stringify(bad)} must be rejected as malformed`
    );
  }
});

test('parseDevToolsActivePort: in-range integer ports at the boundaries parse', () => {
  assert.equal(parseDevToolsActivePort('1\n/devtools/browser/abc\n').port, '1');
  assert.equal(parseDevToolsActivePort('65535\n/devtools/browser/abc\n').port, '65535');
});

// --- endpointFromProfile -------------------------------------------------

test('endpointFromProfile: missing file yields nothing', async () => {
  const dir = tmpDir();
  try {
    const result = await endpointFromProfile(dir);
    assert.equal(result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('endpointFromProfile: a dead port is never trusted', async () => {
  // Bind a port then close it immediately, so the number is very unlikely
  // to be reused for the tiny window before we probe it, and the file
  // naming it is exactly the "stale DevToolsActivePort" case this guards.
  const server = net.createServer();
  const deadPort = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  await new Promise((resolve) => server.close(resolve));

  const dir = tmpDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'DevToolsActivePort'),
      `${deadPort}\n/devtools/browser/abc\n`
    );
    const result = await endpointFromProfile(dir);
    assert.equal(result, null, 'a stale DevToolsActivePort must not be treated as live');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Fix round 1 / FINDING 1: a garbage port in DevToolsActivePort must
// degrade to "no endpoint", never an unhandled rejection. Each case is
// awaited inside a try/catch so a regression fails loudly rather than
// producing an unhandled-rejection warning node --test would not otherwise
// turn into a failing assertion.
test('endpointFromProfile: a garbage port never rejects, always yields no endpoint', async () => {
  for (const bad of ['99999999', '-1', '65536', '0', 'abc', '1.5', '']) {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${bad}\n/devtools/browser/abc\n`);
      let result;
      try {
        result = await endpointFromProfile(dir);
      } catch (err) {
        assert.fail(
          `endpointFromProfile must never reject for a garbage port ${JSON.stringify(bad)}, but threw: ${err.message}`
        );
      }
      assert.equal(result, null, `garbage port ${JSON.stringify(bad)} must yield no endpoint`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('endpointFromProfile: a live /json/version yields a browserURL', async () => {
  const server = http.createServer((req, res) => {
    if (req.url !== '/json/version') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Chrome/152.0.7977.65' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/abc\n`);
    const result = await endpointFromProfile(dir);
    assert.ok(result, 'a live endpoint must be discovered');
    assert.equal(result.browserURL, `http://127.0.0.1:${port}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- parseAuthBody --------------------------------------------------------

test('parseAuthBody: real logged-out shape means logged out', () => {
  const st = parseAuthBody('{"WARNING_BANNER":"DO NOT SHARE"}');
  assert.equal(st.loggedIn, false);
  assert.equal(st.summary, 'WARNING_BANNER');
});

test('parseAuthBody: realistic logged-in payload means logged in, never leaks values', () => {
  const body =
    '{"WARNING_BANNER":"x","accessToken":"SECRET-ACCESS","sessionToken":"SECRET-SESSION",' +
    '"user":{"email":"a@b.c"},"expires":"2026-10-01"}';
  const st = parseAuthBody(body);
  assert.equal(st.loggedIn, true);
  for (const secret of ['SECRET-ACCESS', 'SECRET-SESSION', 'a@b.c']) {
    assert.ok(!st.summary.includes(secret), `summary leaked a value: ${st.summary}`);
  }
  assert.equal(st.summary, 'WARNING_BANNER,accessToken,expires,sessionToken,user');
});

test('parseAuthBody: null user is logged out', () => {
  assert.equal(parseAuthBody('{"user":null}').loggedIn, false);
});

test('parseAuthBody: user must be a non-empty, non-array object', () => {
  const cases = [
    ['{"user": false}', false],
    ['{"user": ""}', false],
    ['{"user": 0}', false],
    ['{"user": []}', false],
    ['{"user": {}}', false],
    ['{"user": {"id":"x"}}', true],
  ];
  for (const [body, want] of cases) {
    assert.equal(parseAuthBody(body).loggedIn, want, `parseAuthBody(${body})`);
  }
});

test('parseAuthBody: non-JSON throws', () => {
  assert.throws(() => parseAuthBody('<html>login</html>'));
});

test('parseAuthBody: non-object JSON (array/primitive) throws', () => {
  assert.throws(() => parseAuthBody('[1,2,3]'));
  assert.throws(() => parseAuthBody('"just a string"'));
});

// --- leak test: parseAuthBody must never surface values, only key names ---

test('parseAuthBody: leak test -- summary contains no sentinel values, only sorted keys', () => {
  const body = JSON.stringify({
    WARNING_BANNER: 'DO NOT SHARE',
    accessToken: 'SENTINEL-ACCESS-TOKEN-DO-NOT-LEAK',
    sessionToken: 'SENTINEL-SESSION-TOKEN-DO-NOT-LEAK',
    user: {
      id: 'SENTINEL-ACCOUNT-ID-DO-NOT-LEAK',
      email: 'sentinel-do-not-leak@example.com',
    },
    expires: '2026-10-01',
  });

  const st = parseAuthBody(body);

  const sentinels = [
    'SENTINEL-ACCESS-TOKEN-DO-NOT-LEAK',
    'SENTINEL-SESSION-TOKEN-DO-NOT-LEAK',
    'SENTINEL-ACCOUNT-ID-DO-NOT-LEAK',
    'sentinel-do-not-leak@example.com',
  ];
  for (const s of sentinels) {
    assert.ok(!st.summary.includes(s), `summary leaked a sentinel value: ${st.summary}`);
    assert.ok(!JSON.stringify(st.keys).includes(s), 'keys array leaked a sentinel value');
  }

  const wantKeys = ['WARNING_BANNER', 'accessToken', 'expires', 'sessionToken', 'user'];
  assert.deepEqual(st.keys, wantKeys);
  assert.equal(st.summary, wantKeys.join(','));
  assert.equal(st.loggedIn, true);
});

// --- close() must never touch a browser it does not own -------------------

test('close(): a no-op on an attached (unowned) handle -- never calls browser.close()', async () => {
  let closeCalled = false;
  const handle = {
    owned: false,
    browser: {
      close: async () => {
        closeCalled = true;
        throw new Error('close() must never be invoked on an attached browser');
      },
    },
  };
  await close(handle);
  assert.equal(closeCalled, false, 'close() attempted to close a browser it did not launch');
});

test('close(): safe on null/undefined handles', async () => {
  await assert.doesNotReject(() => close(null));
  await assert.doesNotReject(() => close(undefined));
});

test('close(): safe on an owned handle with no browser attached', async () => {
  await assert.doesNotReject(() => close({ owned: true, browser: null }));
});

test('close(): does invoke browser.close() when the handle is owned', async () => {
  let closeCalled = false;
  const handle = {
    owned: true,
    browser: {
      close: async () => {
        closeCalled = true;
      },
    },
  };
  await close(handle);
  assert.equal(closeCalled, true, 'close() must close a browser it launched itself');
});

// --- launchOptions: FINDING 2, point 1 -------------------------------------
// Pure function, no puppeteer call, no filesystem access -- asserted on
// directly so the anti-detection flags and the never-a-temp-dir guarantee
// don't depend on ever actually launching Chrome.

test('launchOptions: always includes the anti-detection flags', () => {
  const opts = launchOptions({
    headless: false,
    userDataDir: '/tmp/some-profile',
    executablePath: '/usr/bin/chrome',
  });
  assert.ok(opts.args.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(opts.args.includes('--no-first-run'));
  assert.ok(opts.args.includes('--no-default-browser-check'));
});

test('launchOptions: ignoreDefaultArgs contains exactly --enable-automation', () => {
  const opts = launchOptions({
    headless: false,
    userDataDir: '/tmp/some-profile',
    executablePath: '/usr/bin/chrome',
  });
  assert.deepEqual(opts.ignoreDefaultArgs, ['--enable-automation']);
});

test('launchOptions: userDataDir is always a non-empty string, for every input', () => {
  const inputs = [
    { headless: true, userDataDir: '/a/b/profile', executablePath: '/usr/bin/chrome' },
    { headless: false, userDataDir: '/tmp/x', executablePath: undefined },
  ];
  for (const input of inputs) {
    const opts = launchOptions(input);
    assert.equal(typeof opts.userDataDir, 'string');
    assert.ok(opts.userDataDir.length > 0, 'userDataDir must never be empty');
    assert.equal(opts.userDataDir, input.userDataDir);
  }
});

test('launchOptions: refuses to build options without a userDataDir', () => {
  // A missing userDataDir is exactly what lets puppeteer invent (and later
  // delete) its own temp profile -- this must be impossible to construct.
  assert.throws(() =>
    launchOptions({ headless: false, userDataDir: '', executablePath: '/usr/bin/chrome' })
  );
  assert.throws(() => launchOptions({ headless: false, executablePath: '/usr/bin/chrome' }));
});

test('launchOptions: headless passes through verbatim', () => {
  assert.equal(
    launchOptions({ headless: true, userDataDir: '/x', executablePath: '/c' }).headless,
    true
  );
  assert.equal(
    launchOptions({ headless: false, userDataDir: '/x', executablePath: '/c' }).headless,
    false
  );
});

// --- open(): FINDING 2, point 2 ---------------------------------------
// puppeteer is injected via a `deps` param so these run with no real Chrome
// anywhere. A live endpoint is still a REAL local HTTP server standing in
// for Chrome's DevTools port -- only the puppeteer.connect/launch calls
// themselves are faked.

function startFakeDevToolsServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'Chrome/152.0.0.0' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('open(): a live endpoint uses connect(), never launch(), and owned is false', async () => {
  const server = await startFakeDevToolsServer();
  const port = server.address().port;
  const profile = tmpDir();
  try {
    fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${port}\n/devtools/browser/abc\n`);

    const connectedBrowser = { marker: 'attached-browser' };
    let connectOpts = null;
    let launchCalled = false;
    const fakePuppeteer = {
      connect: async (opts) => {
        connectOpts = opts;
        return connectedBrowser;
      },
      launch: async () => {
        launchCalled = true;
        throw new Error('launch() must not be called when a live endpoint exists');
      },
    };

    await withEnvAsync('GPT_IMAGEGEN_PROFILE_DIR', profile, async () => {
      const handle = await open(
        { headless: true, hideWindow: false },
        { puppeteer: fakePuppeteer }
      );
      assert.equal(launchCalled, false, 'launch() must not be called when connect() succeeds');
      assert.ok(connectOpts, 'connect() must have been called');
      assert.equal(connectOpts.browserURL, `http://127.0.0.1:${port}`);
      assert.equal(handle.owned, false, 'an attached handle must have owned === false');
      assert.equal(handle.browser, connectedBrowser);
      assert.equal(handle.pid, null);
    });
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test('open(): no live endpoint launches with launchOptions(), and owned is true', async () => {
  const profile = tmpDir(); // no DevToolsActivePort file -> nothing to attach to
  const chromeDir = tmpDir();
  const chromeBin = path.join(chromeDir, 'chrome');
  fs.writeFileSync(chromeBin, '');
  try {
    let connectCalled = false;
    let launchOpts = null;
    const launchedBrowser = { process: () => ({ pid: 13579 }) };
    const fakePuppeteer = {
      connect: async () => {
        connectCalled = true;
        throw new Error('connect() must not be called when there is no live endpoint');
      },
      launch: async (opts) => {
        launchOpts = opts;
        return launchedBrowser;
      },
    };

    await withEnvAsync('GPT_IMAGEGEN_PROFILE_DIR', profile, () =>
      withEnvAsync('GPT_IMAGEGEN_CHROME', chromeBin, async () => {
        const handle = await open(
          { headless: true, hideWindow: false },
          { puppeteer: fakePuppeteer }
        );
        assert.equal(connectCalled, false, 'connect() must not be attempted with no live endpoint');
        assert.ok(launchOpts, 'launch() must have been called');
        assert.equal(launchOpts.userDataDir, profile);
        assert.ok(launchOpts.args.includes('--disable-blink-features=AutomationControlled'));
        assert.deepEqual(launchOpts.ignoreDefaultArgs, ['--enable-automation']);
        assert.equal(handle.owned, true, 'a launched handle must have owned === true');
        assert.equal(handle.browser, launchedBrowser);
        assert.equal(handle.pid, 13579);
      })
    );
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(chromeDir, { recursive: true, force: true });
  }
});

// This is the guard for the historical blocker: hideWindow inferred from
// headless once hid the window the user had to sign into. All four
// combinations are asserted so neither boolean can ever be derived from the
// other again -- the two "must NOT hide" cases matter as much as the one
// "must hide" case.
test('open(): hideWindow and headless are independent -- all four combinations', async () => {
  const chromeDir = tmpDir();
  const chromeBin = path.join(chromeDir, 'chrome');
  fs.writeFileSync(chromeBin, '');

  const cases = [
    { headless: false, hideWindow: true, wantHideCalled: true },
    { headless: false, hideWindow: false, wantHideCalled: false },
    { headless: true, hideWindow: true, wantHideCalled: false }, // headless: no window to hide
    { headless: true, hideWindow: false, wantHideCalled: false },
  ];

  try {
    for (const c of cases) {
      const profile = tmpDir();
      let hideCalledWithPid = null;
      const fakePuppeteer = {
        connect: async () => {
          throw new Error('no live endpoint in this test');
        },
        launch: async () => ({ process: () => ({ pid: 777 }) }),
      };
      const fakeHideWindow = (pid) => {
        hideCalledWithPid = pid;
      };

      try {
        await withEnvAsync('GPT_IMAGEGEN_PROFILE_DIR', profile, () =>
          withEnvAsync('GPT_IMAGEGEN_CHROME', chromeBin, () =>
            open(
              { headless: c.headless, hideWindow: c.hideWindow },
              { puppeteer: fakePuppeteer, hideWindow: fakeHideWindow }
            )
          )
        );
      } finally {
        fs.rmSync(profile, { recursive: true, force: true });
      }

      const label = `headless=${c.headless} hideWindow=${c.hideWindow}`;
      if (c.wantHideCalled) {
        assert.equal(hideCalledWithPid, 777, `${label} must hide the window`);
      } else {
        assert.equal(hideCalledWithPid, null, `${label} must NOT hide the window`);
      }
    }
  } finally {
    fs.rmSync(chromeDir, { recursive: true, force: true });
  }
});

test('open(): a step that throws after a successful launch closes the browser rather than leaking it', async () => {
  const profile = tmpDir();
  const chromeDir = tmpDir();
  const chromeBin = path.join(chromeDir, 'chrome');
  fs.writeFileSync(chromeBin, '');

  let closeCalled = false;
  const fakePuppeteer = {
    connect: async () => {
      throw new Error('no live endpoint in this test');
    },
    launch: async () => ({
      // Simulates some unexpected post-launch failure (e.g. process()
      // throwing on an odd platform/puppeteer combination) -- the point is
      // ANY throw after a successful launch, not this specific one.
      process: () => {
        throw new Error('boom: process() failed after a successful launch');
      },
      close: async () => {
        closeCalled = true;
      },
    }),
  };

  try {
    await withEnvAsync('GPT_IMAGEGEN_PROFILE_DIR', profile, () =>
      withEnvAsync('GPT_IMAGEGEN_CHROME', chromeBin, () =>
        assert.rejects(() =>
          open({ headless: true, hideWindow: false }, { puppeteer: fakePuppeteer })
        )
      )
    );
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(chromeDir, { recursive: true, force: true });
  }

  assert.equal(
    closeCalled,
    true,
    'a browser launched but never returned to the caller must be closed, not leaked'
  );
});

// --- auth(): throwaway page must always close, and never leak the body ----

test('auth(): closes the throwaway page even when navigation throws', async () => {
  let closeCalled = false;
  const fakePage = {
    goto: async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    },
    $eval: async () => {
      throw new Error('$eval should not be reached when goto throws');
    },
    close: async () => {
      closeCalled = true;
    },
  };
  const handle = { browser: { newPage: async () => fakePage } };

  await assert.rejects(() => auth(handle));
  assert.equal(closeCalled, true, 'the throwaway auth page must be closed even when navigation fails');
});

test('auth(): a non-JSON body never leaks into the thrown error, and the page is still closed', async () => {
  let closeCalled = false;
  const secret = 'SENTINEL-AUTH-BODY-DO-NOT-LEAK-93f2';
  const fakePage = {
    goto: async () => {},
    $eval: async () => `<html>not json, contains ${secret}</html>`,
    close: async () => {
      closeCalled = true;
    },
  };
  const handle = { browser: { newPage: async () => fakePage } };

  await assert.rejects(
    () => auth(handle),
    (err) => {
      assert.ok(!err.message.includes(secret), `thrown error leaked the raw body: ${err.message}`);
      return true;
    }
  );
  assert.equal(closeCalled, true, 'the throwaway auth page must be closed even when parsing fails');
});
