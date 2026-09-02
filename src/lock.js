'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Cross-process lock serialising the send moment so two Claude sessions
// never type into the same ChatGPT composer at once. A lock that admits two
// winners fails its only purpose.
//
// The Go version used syscall.Flock: kernel-enforced, released automatically
// when the holding process dies, immune to staleness. Node has no flock
// (fs.flock is undefined) and a native addon would break the single-file
// bundling this port exists for. So this is a PID-file lock -- the scheme
// Go itself started with, before review found three bugs in it. This is
// that scheme written correctly the second time around:
//
//   1. EPERM from process.kill(pid, 0) means the pid is a LIVE process
//      owned by someone else, not a dead one. Only ESRCH means gone.
//      Getting this backwards steals a live lock out from under its owner.
//   2. Releasing must verify ownership: re-read the file and only remove it
//      if it still names our own pid + nonce. An unconditional remove can
//      delete a different run's live lock.
//   3. Reclaiming a stale lock must not be blind-remove-then-retry. Two
//      processes can both decide "stale" from the same read, and if a
//      reclaim removes the file unconditionally, the second one to act can
//      delete the FIRST one's freshly-written live lock instead of the
//      stale entry it actually inspected. The fix: remember the exact
//      bytes read, and immediately before removing, re-read and compare;
//      only remove if the file still holds exactly what was inspected.
//
// A fourth hole is structural to this scheme rather than a Go-review bug:
// Go's flock made file creation and lock acquisition the SAME atomic
// kernel operation, so a crash could never leave an existing-but-unlocked
// file behind. This PID-file scheme has a real (if narrow) window where
// that happens: a process can die between `fs.openSync(path, 'wx')` and
// writing its pid+nonce payload, leaving an empty or truncated file with
// no pid to check liveness against. Left alone, such a record is neither
// "alive" nor "stale" by the pid check -- it is undecidable forever, and
// every future acquireLock() times out with PROFILE_LOCKED permanently.
// That is an availability hole, not a correctness one (it still fails
// CLOSED -- it never grants two winners -- it just never grants any),
// but it violates the same "a crashed run must not wedge the tool
// forever" guarantee the pid-liveness check exists to provide. The fix:
// an unparseable record is reclaimed once it has been unparseable for
// longer than UNPARSEABLE_LOCK_MAX_AGE_MS -- long enough that no live
// acquirer could still be mid-write, since a live holder writes its
// record microseconds after creating the file -- using the exact same
// read-immediately-before-unlink-and-compare-exactly discipline as bug
// #3's stale reclaim (content AND mtime must both still match what was
// inspected). This heuristic applies ONLY to records that fail to parse;
// a well-formed record is decided purely by pid liveness regardless of
// its age, no matter how old its mtime is.
//
// Port of internal/session/profile.go's AcquireLock/Release, deliberately
// reimplemented rather than literally translated since Go's flock has no
// Node equivalent.

const POLL_INTERVAL_MS = 100;
const LOCK_FILE_MODE = 0o644;

// How long a lock file may remain unparseable (empty, truncated, or plain
// garbage) before it is treated as a crash artifact rather than a live
// acquire that just hasn't finished its single write() yet. See the
// fourth-hole note above for why this is needed and why it is safe: a
// live holder's write happens microseconds after its open(), so anything
// still unparseable a full 10 seconds later cannot belong to one.
const UNPARSEABLE_LOCK_MAX_AGE_MS = 10_000;

/**
 * Thrown by acquireLock() on timeout. `.code` is the discriminant a caller
 * (the future CLI entry point) maps to envelope.CODES.PROFILE_LOCKED --
 * checked by string on purpose so lock.js need not require envelope.js.
 */
class LockTimeoutError extends Error {
  constructor(lockPath, timeoutMs) {
    super(
      `another gpt-imagegen run holds the browser lock at ${lockPath} (waited ${timeoutMs}ms)`
    );
    this.name = 'LockTimeoutError';
    this.code = 'PROFILE_LOCKED';
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Returns whether `pid` names a currently-running process, distinguishing
 * "gone" from "alive but not ours to touch". process.kill(pid, 0) sends no
 * signal; it only probes existence/permission.
 *
 * - No throw: the process exists and we're allowed to signal it (ours, or
 *   another process running as us).
 * - ESRCH: no such process. Genuinely dead. Safe to treat as stale.
 * - EPERM: the process exists but is owned by someone else (e.g. pid 1,
 *   root-owned). ALIVE, not dead -- this is bug #1 from the Go review, and
 *   is exactly what the "lock owned by another user" test pins.
 * - Anything else is unexpected and is rethrown rather than guessed at.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    if (err.code === 'EPERM') return true;
    throw err;
  }
}

/**
 * Parses lock file contents into {pid, nonce}, or null if the content is
 * not a well-formed lock record. Returning null (rather than throwing) lets
 * the caller treat a not-yet-fully-written file (the brief instant between
 * another process's `wx` create and its write of the payload) the same way
 * as garbage: neither "alive" nor "stale", just "not yet decidable" --
 * worth a short wait and another look, never a reason to steal or corrupt
 * someone else's in-progress acquire.
 */
function parseLockFile(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    obj &&
    typeof obj.pid === 'number' &&
    Number.isInteger(obj.pid) &&
    obj.pid > 0 &&
    typeof obj.nonce === 'string' &&
    obj.nonce.length > 0
  ) {
    return { pid: obj.pid, nonce: obj.nonce };
  }
  return null;
}

/** Blocking sleep. Node has no synchronous sleep primitive; Atomics.wait on
 * a throwaway SharedArrayBuffer is the standard way to get one without
 * spinning the CPU. Blocking the whole process here is deliberate and
 * matches Go's blocking AcquireLock: this call happens at CLI startup,
 * before anything else the process would need to be responsive for.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquires the cross-process lock at `lockPath`, blocking (polling roughly
 * every 100ms) until it succeeds or `timeoutMs` elapses.
 *
 * Returns a lock handle -- an opaque object; pass it to releaseLock().
 * Never mutate or introspect its fields, they are private to this module.
 *
 * On timeout, throws LockTimeoutError (`.code === 'PROFILE_LOCKED'`). This
 * is the ONLY failure-signalling contract: every other error (e.g. a
 * permissions failure making the lock directory) propagates as whatever
 * error Node's fs layer raised, unwrapped.
 *
 * The deadline is checked at the top of EVERY loop iteration, including
 * the one right after a stale-lock reclaim, not only immediately before
 * sleeping -- Go's version skipped the check on one path and could overrun
 * its timeout by a full poll interval.
 */
function acquireLock(lockPath, timeoutMs) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  const pid = process.pid;
  const nonce = crypto.randomUUID();
  const payload = Buffer.from(JSON.stringify({ pid, nonce }));

  for (;;) {
    if (Date.now() >= deadline) {
      throw new LockTimeoutError(lockPath, timeoutMs);
    }

    // Atomic create: succeeds only if the file did not already exist.
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx', LOCK_FILE_MODE);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      fd = null;
    }

    if (fd !== null) {
      try {
        fs.writeSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      return { path: lockPath, pid, nonce };
    }

    // Lock file already exists. Inspect it to decide whether it is a live
    // hold (wait) or a stale one left by a dead process (reclaim).
    let raw;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue; // vanished between create and read; retry now
      throw err;
    }

    const info = parseLockFile(raw);
    if (info === null) {
      // Not yet a complete record (another process is mid-write) or plain
      // garbage left by a crash in that same window (the fourth hole,
      // see header comment). Which of the two it is turns entirely on
      // age: a live holder finishes its write microseconds after
      // creating the file, so only a record that has stayed unparseable
      // past UNPARSEABLE_LOCK_MAX_AGE_MS can safely be called a crash
      // artifact.
      let st;
      try {
        st = fs.statSync(lockPath);
      } catch (err) {
        if (err.code === 'ENOENT') continue; // vanished; retry from the top
        throw err;
      }
      const ageMs = Date.now() - st.mtimeMs;
      if (ageMs < UNPARSEABLE_LOCK_MAX_AGE_MS) {
        // Still within the window a live in-progress write could explain
        // it. Not evidence of anything yet -- wait and re-look, never
        // assume a crash from a merely-young unreadable record.
        if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, timeoutMs);
        sleepSync(POLL_INTERVAL_MS);
        continue;
      }

      // Old enough that this can only be a crash artifact. Reclaim it
      // with the same safe sequence as a stale pid-bearing lock (bug
      // #3): re-read AND re-stat immediately before removing, and only
      // unlink if both the bytes and the mtime are still exactly what
      // was just inspected. Any mismatch means someone else already
      // touched this file since our read -- do not delete what we no
      // longer know to be the same artifact.
      let raw2, st2;
      try {
        raw2 = fs.readFileSync(lockPath, 'utf8');
        st2 = fs.statSync(lockPath);
      } catch (err) {
        if (err.code === 'ENOENT') continue; // someone else already reclaimed it
        throw err;
      }
      if (raw2 !== raw || st2.mtimeMs !== st.mtimeMs) {
        continue; // changed under us; do not touch, re-evaluate from the top
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        if (err.code === 'ENOENT') continue; // a racing reclaimer beat us to it
        throw err;
      }
      // Removed the crash artifact. Loop back and attempt the atomic
      // create again immediately.
      continue;
    }

    if (isProcessAlive(info.pid)) {
      // Held by a live process (ours or, per bug #1, someone else's -- an
      // EPERM-live pid is exactly as untouchable as one we could signal).
      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, timeoutMs);
      sleepSync(POLL_INTERVAL_MS);
      continue;
    }

    // The pid is dead: this looks stale. Bug #3's fix: re-read immediately
    // before removing and only remove if the bytes are IDENTICAL to what
    // was just inspected. If they differ, some other process already
    // reclaimed (or the original holder somehow rewrote) this file since
    // our read -- what's there now is not the stale entry we decided about,
    // so leave it alone and loop back to look again, rather than deleting
    // whatever a concurrent acquirer just wrote.
    let raw2;
    try {
      raw2 = fs.readFileSync(lockPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue; // someone else already reclaimed it
      throw err;
    }
    if (raw2 !== raw) {
      continue; // changed under us; do not touch, re-evaluate from the top
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (err.code === 'ENOENT') continue; // a racing reclaimer beat us to it
      throw err;
    }
    // Removed exactly the stale entry we inspected. Loop back and attempt
    // the atomic create again immediately.
  }
}

/**
 * Releases a lock handle returned by acquireLock().
 *
 * Idempotent and nil/undefined-safe: releaseLock(null) and releasing the
 * same handle twice are both no-ops. Verifies ownership before removing
 * the file (bug #2) -- re-reads the current contents and only unlinks if
 * they still name this handle's own pid + nonce, so releasing never
 * deletes a different run's live lock (one that reclaimed this path after
 * this handle's own file was, for whatever reason, already gone).
 */
function releaseLock(handle) {
  if (!handle || handle.released) return;
  handle.released = true;

  let raw;
  try {
    raw = fs.readFileSync(handle.path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return; // already gone; nothing to do
    throw err;
  }

  const info = parseLockFile(raw);
  if (!info || info.pid !== handle.pid || info.nonce !== handle.nonce) {
    return; // no longer ours; do not touch it
  }

  try {
    fs.unlinkSync(handle.path);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  LockTimeoutError,
  isProcessAlive,
  UNPARSEABLE_LOCK_MAX_AGE_MS,
};
