'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { profileDir, lockPath } = require('../src/profile');
const { acquireLock, releaseLock, LockTimeoutError } = require('../src/lock');

const LOCK_MODULE = path.join(__dirname, '..', 'src', 'lock.js');

// Safety net: if a test throws before its own try/finally cleanup runs (in
// principle should never happen, since every spawn below is wrapped), make
// sure nothing spawned by this file survives the process exiting.
const liveChildren = new Set();
process.on('exit', () => {
  for (const child of liveChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-imagegen-lock-test-'));
}

// --- profile.js -------------------------------------------------------

test('profileDir honours GPT_IMAGEGEN_PROFILE_DIR override', () => {
  const prev = process.env.GPT_IMAGEGEN_PROFILE_DIR;
  try {
    process.env.GPT_IMAGEGEN_PROFILE_DIR = '/tmp/custom-profile';
    assert.equal(profileDir(), '/tmp/custom-profile');
  } finally {
    if (prev === undefined) delete process.env.GPT_IMAGEGEN_PROFILE_DIR;
    else process.env.GPT_IMAGEGEN_PROFILE_DIR = prev;
  }
});

test('profileDir defaults to ~/.gpt-imagegen/profile', () => {
  const prev = process.env.GPT_IMAGEGEN_PROFILE_DIR;
  try {
    delete process.env.GPT_IMAGEGEN_PROFILE_DIR;
    const want = path.join(os.homedir(), '.gpt-imagegen', 'profile');
    assert.equal(profileDir(), want);
  } finally {
    if (prev === undefined) delete process.env.GPT_IMAGEGEN_PROFILE_DIR;
    else process.env.GPT_IMAGEGEN_PROFILE_DIR = prev;
  }
});

test('lockPath is "lock" alongside the profile directory', () => {
  const prev = process.env.GPT_IMAGEGEN_PROFILE_DIR;
  try {
    process.env.GPT_IMAGEGEN_PROFILE_DIR = '/tmp/custom-profile';
    assert.equal(lockPath(), path.join('/tmp', 'lock'));
  } finally {
    if (prev === undefined) delete process.env.GPT_IMAGEGEN_PROFILE_DIR;
    else process.env.GPT_IMAGEGEN_PROFILE_DIR = prev;
  }
});

// --- lock.js: basic exclusivity, timeout shape, release semantics -----

test('a second acquire is refused with a PROFILE_LOCKED-shaped error, after roughly its timeout', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'lock');
    const first = acquireLock(p, 2000);
    try {
      const start = Date.now();
      assert.throws(
        () => acquireLock(p, 300),
        (err) => err instanceof LockTimeoutError && err.code === 'PROFILE_LOCKED'
      );
      const elapsed = Date.now() - start;
      // Must have genuinely polled for roughly the timeout, not failed
      // instantly and not run drastically over it.
      assert.ok(elapsed >= 250, `acquire returned too early: ${elapsed}ms (want ~300ms)`);
      assert.ok(elapsed <= 900, `acquire took too long: ${elapsed}ms (want ~300ms)`);
    } finally {
      releaseLock(first);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release then re-acquire succeeds', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'lock');
    const first = acquireLock(p, 2000);
    releaseLock(first);
    const second = acquireLock(p, 2000);
    releaseLock(second);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release is idempotent, and safe on null/undefined handles', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'lock');
    const l = acquireLock(p, 2000);
    releaseLock(l);
    releaseLock(l); // second release: no-op, must not throw
    releaseLock(null);
    releaseLock(undefined);
    // Confirms the file is actually gone (first release worked), not just
    // that the second release silently did nothing to a file left behind.
    assert.equal(fs.existsSync(p), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release only removes the file if it still names this handle\'s own pid + nonce', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'lock');
    const l = acquireLock(p, 2000);
    // Simulate another run having reclaimed this path after our handle was
    // issued (e.g. our on-disk file vanished and someone else's fresh
    // acquire landed at the same path) by overwriting it with a different
    // identity before we release.
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, nonce: 'someone-elses-nonce' }));
    releaseLock(l);
    // The impostor entry must survive: release must not have deleted it.
    assert.equal(fs.existsSync(p), true);
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(onDisk.nonce, 'someone-elses-nonce');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- lock.js: EPERM must not be mistaken for dead ----------------------

test('a lock naming a live process owned by another user is not stolen', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'lock');
    // pid 1 is root-owned and, on any machine this test runs on, alive.
    // process.kill(1, 0) throws EPERM here -- exactly the case bug #1 got
    // backwards (treating EPERM as "dead" and stealing the lock).
    fs.writeFileSync(p, JSON.stringify({ pid: 1, nonce: 'root-owned' }));
    const start = Date.now();
    assert.throws(
      () => acquireLock(p, 300),
      (err) => err instanceof LockTimeoutError && err.code === 'PROFILE_LOCKED'
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 250, `acquire returned too early: ${elapsed}ms (want ~300ms)`);
    // The lock file must be untouched -- not stolen, not deleted.
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(onDisk.pid, 1);
    assert.equal(onDisk.nonce, 'root-owned');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- lock.js: the death test -------------------------------------------
//
// A lock file naming a pid that is genuinely dead must become acquirable.
// Proven for real: a child process actually acquires the lock (signalled
// over stdout, not assumed via a sleep), the parent is shown to be
// genuinely blocked while the child lives, then the child is SIGKILLed
// (so it never gets a chance to release cleanly) and the parent must then
// acquire.

const CHILD_SCRIPT = `
const { acquireLock } = require(process.env.LOCK_MODULE);
try {
  acquireLock(process.env.LOCK_PATH, 30000);
} catch (err) {
  console.log('LOCK_ERR ' + (err && err.message));
  process.exit(1);
}
console.log('LOCK_HELD');
setInterval(() => {}, 1000);
`;

function spawnLockHolder(lockFilePath) {
  const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
    env: { ...process.env, LOCK_MODULE, LOCK_PATH: lockFilePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.add(child);
  return child;
}

function waitForLockHeld(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let stderrBuf = '';
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`timed out waiting for LOCK_HELD; stderr: ${stderrBuf}`)));
    }, timeoutMs);

    function finish(action) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      action();
    }

    function onStdout(chunk) {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line === 'LOCK_HELD') {
          finish(() => resolve());
          return;
        }
        if (line.startsWith('LOCK_ERR')) {
          finish(() => reject(new Error(`child failed to acquire lock: ${line}`)));
          return;
        }
      }
    }
    function onStderr(chunk) {
      stderrBuf += chunk.toString('utf8');
    }

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
  });
}

async function killAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    liveChildren.delete(child);
    return;
  }
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  liveChildren.delete(child);
}

test('a lock held by a process that dies becomes acquirable (real child process)', async () => {
  const dir = tmpDir();
  const p = path.join(dir, 'lock');
  const child = spawnLockHolder(p);
  try {
    await waitForLockHeld(child, 10_000);

    // Parent must be genuinely blocked while the child (still alive) holds
    // the lock.
    assert.throws(
      () => acquireLock(p, 500),
      (err) => err instanceof LockTimeoutError && err.code === 'PROFILE_LOCKED'
    );

    // Kill the child without giving it a chance to release, then wait for
    // it to actually be reaped so its pid is truly gone (not a zombie
    // still answering kill(pid, 0)).
    await killAndWait(child);

    const lock = acquireLock(p, 5000);
    releaseLock(lock);
  } finally {
    await killAndWait(child); // no-op if already reaped above
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
