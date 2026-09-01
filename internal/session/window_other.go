//go:build !darwin

package session

// HideWindow is macOS-only; elsewhere the window stays visible.
func HideWindow(pid int) error { return nil }
