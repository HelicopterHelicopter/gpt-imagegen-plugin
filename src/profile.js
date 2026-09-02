'use strict';

const os = require('node:os');
const path = require('node:path');

// Locates the browser profile and its lock file. Port of
// internal/session/profile.go's ProfileDir/LockPath.

/**
 * Directory holding the persistent Chrome profile (cookies, login state).
 * Overridable via GPT_IMAGEGEN_PROFILE_DIR for tests and for anyone who
 * wants the profile somewhere other than the default. Falls back to a
 * relative path if the home directory cannot be determined, matching Go's
 * behaviour of returning ".gpt-imagegen/profile" rather than throwing.
 */
function profileDir() {
  const v = process.env.GPT_IMAGEGEN_PROFILE_DIR;
  if (v) return v;
  let home;
  try {
    home = os.homedir();
  } catch {
    home = '';
  }
  if (!home) return path.join('.gpt-imagegen', 'profile');
  return path.join(home, '.gpt-imagegen', 'profile');
}

/**
 * Path to the lock file that serialises access to the profile. Lives
 * alongside the profile directory (a sibling, not inside it) so clearing
 * the profile directory never touches the lock.
 */
function lockPath() {
  return path.join(path.dirname(profileDir()), 'lock');
}

module.exports = { profileDir, lockPath };
