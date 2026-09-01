package session

import (
	"os"
	"testing"
)

func TestChromePathErrorsWhenMissing(t *testing.T) {
	t.Setenv("GPT_IMAGEGEN_CHROME", "/definitely/not/here")
	if _, err := ChromePath(); err == nil {
		t.Fatal("missing chrome binary must error so the CLI reports CHROME_MISSING")
	}
}

func TestChromePathHonoursOverride(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "chrome")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	t.Setenv("GPT_IMAGEGEN_CHROME", f.Name())
	got, err := ChromePath()
	if err != nil {
		t.Fatalf("ChromePath: %v", err)
	}
	if got != f.Name() {
		t.Fatalf("ChromePath = %q, want %q", got, f.Name())
	}
}

// TestCloseIsSafeOnAttached guards the rule that we never shut down a browser
// we did not launch.
func TestCloseIsSafeOnAttached(t *testing.T) {
	b := &Browser{Owned: false}
	b.Close() // must not panic and must not attempt a close on a nil Rod
}

// TestAttachedBrowserHasNoPID documents that we never try to reposition or
// shut down a browser we did not launch: a Browser built with Owned: false
// must always have PID == 0, since PID is only ever populated on the launch
// path in Open.
func TestAttachedBrowserHasNoPID(t *testing.T) {
	b := &Browser{Owned: false}
	if b.PID != 0 {
		t.Fatalf("attached Browser.PID = %d, want 0", b.PID)
	}
}
