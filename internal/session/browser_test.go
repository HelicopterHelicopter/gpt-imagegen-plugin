package session

import (
	"os"
	"os/exec"
	"runtime"
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

// TestChromeCandidatesForCurrentGOOSAreNonEmpty pins the requirement that
// ChromePath has a well-known fallback list for the platform it actually
// runs on. This only asserts about runtime.GOOS, which in this project's CI
// is always darwin or linux.
func TestChromeCandidatesForCurrentGOOSAreNonEmpty(t *testing.T) {
	c := chromeCandidates(runtime.GOOS)
	if len(c) == 0 {
		t.Fatalf("chromeCandidates(%q) is empty; ChromePath has no well-known fallback for this OS", runtime.GOOS)
	}
}

func TestChromeCandidatesDarwinAndLinuxAreDistinctAndNonEmpty(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		c := chromeCandidates(goos)
		if len(c) == 0 {
			t.Fatalf("chromeCandidates(%q) is empty", goos)
		}
	}
}

// statAlwaysMissing and a lookPath stub let resolveChromePath's fallback
// logic be tested deterministically without requiring a real Chrome
// installation anywhere -- neither at a well-known path nor on $PATH.
func statAlwaysMissing(string) (os.FileInfo, error) { return nil, os.ErrNotExist }

func TestResolveChromePathOverrideWinsEvenWhenPathLookupWouldSucceed(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "chrome")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	t.Setenv("GPT_IMAGEGEN_CHROME", f.Name())

	lookPath := func(name string) (string, error) { return "/somewhere/on/path/" + name, nil }
	got, err := resolveChromePath("linux", os.Stat, lookPath)
	if err != nil {
		t.Fatalf("resolveChromePath: %v", err)
	}
	if got != f.Name() {
		t.Fatalf("resolveChromePath = %q, want override %q to win", got, f.Name())
	}
}

func TestResolveChromePathSetButNonexistentOverrideErrors(t *testing.T) {
	t.Setenv("GPT_IMAGEGEN_CHROME", "/definitely/not/here")
	lookPath := func(name string) (string, error) { return "/somewhere/on/path/" + name, nil }
	if _, err := resolveChromePath("linux", os.Stat, lookPath); err == nil {
		t.Fatal("a set-but-nonexistent override must error even though $PATH lookup would otherwise succeed")
	}
}

func TestResolveChromePathFallsBackToPathLookup(t *testing.T) {
	t.Setenv("GPT_IMAGEGEN_CHROME", "")
	lookPath := func(name string) (string, error) {
		if name == "chromium" {
			return "/fake/path/chromium", nil
		}
		return "", exec.ErrNotFound
	}
	got, err := resolveChromePath("linux", statAlwaysMissing, lookPath)
	if err != nil {
		t.Fatalf("resolveChromePath: %v", err)
	}
	if got != "/fake/path/chromium" {
		t.Fatalf("resolveChromePath = %q, want /fake/path/chromium", got)
	}
}

func TestResolveChromePathErrorsWhenNothingFoundAnywhere(t *testing.T) {
	t.Setenv("GPT_IMAGEGEN_CHROME", "")
	lookPathAlwaysMissing := func(string) (string, error) { return "", exec.ErrNotFound }
	_, err := resolveChromePath("linux", statAlwaysMissing, lookPathAlwaysMissing)
	if err == nil {
		t.Fatal("want an error when no absolute candidate and no $PATH entry exists")
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
