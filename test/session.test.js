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
  close,
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
