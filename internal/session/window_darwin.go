//go:build darwin

package session

import (
	"fmt"
	"os/exec"
)

// HideWindow moves the automation window offscreen so it never steals focus.
// Headless would be cleaner but is the strongest bot-detection signal, so we
// stay headful and hide instead. Failure is non-fatal: visible is acceptable.
func HideWindow(pid int) error {
	script := fmt.Sprintf(`tell application "System Events"
	set procs to (every process whose unix id is %d)
	repeat with p in procs
		try
			set position of front window of p to {-9000, -9000}
		end try
	end repeat
end tell`, pid)
	return exec.Command("osascript", "-e", script).Run()
}
