'use strict';

const { execFileSync } = require('node:child_process');

// Port of internal/session/window_darwin.go's HideWindow and
// window_other.go's no-op stub, collapsed into one function that branches on
// process.platform since Node has no build-tag equivalent.
//
// Moves the automation window offscreen so it never steals focus. Headless
// would be cleaner but is the strongest bot-detection signal, so the browser
// stays headful and this hides it instead. Failure here is expected to be
// non-fatal to the caller: a visible window is an acceptable outcome, a
// failed run is not -- so this function is written to just do the thing and
// let a thrown error be the caller's to catch and ignore, exactly like Go's
// HideWindow returning an error that Open() discards with `_ = HideWindow(...)`.

/**
 * Moves every window of the process named by `pid` to off-screen coordinates
 * via AppleScript/System Events. No-op on any platform other than darwin.
 */
function hideWindow(pid) {
  if (process.platform !== 'darwin') return;
  const script = `tell application "System Events"
	set procs to (every process whose unix id is ${pid})
	repeat with p in procs
		try
			set position of front window of p to {-9000, -9000}
		end try
	end repeat
end tell`;
  execFileSync('osascript', ['-e', script]);
}

module.exports = { hideWindow };
