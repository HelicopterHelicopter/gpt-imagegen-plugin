package session

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
)

// chromeLookPathNames are executable names searched on $PATH, in priority
// order, when no well-known absolute path exists for the current OS.
var chromeLookPathNames = []string{
	"google-chrome",
	"google-chrome-stable",
	"chromium",
	"chromium-browser",
}

// chromeCandidates returns the well-known absolute paths to a Chrome-family
// browser for goos, in priority order. It takes goos as a parameter rather
// than reading runtime.GOOS itself so every platform's list is unit
// testable from any host.
func chromeCandidates(goos string) []string {
	switch goos {
	case "darwin":
		return []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		}
	case "linux":
		return []string{
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
		}
	default:
		return nil
	}
}

// ChromePath locates a Chrome-family browser binary. Resolution order:
//
//  1. $GPT_IMAGEGEN_CHROME, if set. This always wins, even when the path
//     turns out not to exist, so a broken override is reported as a clear
//     error rather than silently falling through to something else.
//  2. A well-known absolute path for the current OS (see chromeCandidates).
//  3. $PATH, searched for common Chrome-family executable names.
func ChromePath() (string, error) {
	return resolveChromePath(runtime.GOOS, os.Stat, exec.LookPath)
}

// resolveChromePath implements ChromePath's resolution order against
// injectable stat/lookPath functions so the logic is testable without a
// real Chrome installation anywhere on the test machine.
func resolveChromePath(goos string, stat func(string) (os.FileInfo, error), lookPath func(string) (string, error)) (string, error) {
	if p := os.Getenv("GPT_IMAGEGEN_CHROME"); p != "" {
		if _, err := stat(p); err != nil {
			return "", fmt.Errorf("GPT_IMAGEGEN_CHROME is set to %q but no file exists there", p)
		}
		return p, nil
	}
	candidates := chromeCandidates(goos)
	for _, p := range candidates {
		if _, err := stat(p); err == nil {
			return p, nil
		}
	}
	for _, name := range chromeLookPathNames {
		if p, err := lookPath(name); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf(
		"no Chrome-family browser found for %s (checked $GPT_IMAGEGEN_CHROME, %d well-known install path(s), and $PATH for %s); set $GPT_IMAGEGEN_CHROME or install Chrome",
		goos, len(candidates), strings.Join(chromeLookPathNames, ", "),
	)
}

// Browser wraps a rod connection. PID is only ever non-zero for a browser we
// launched ourselves (Owned == true); when attaching to an already-running
// Chrome we do not own that process, so PID stays zero and we never try to
// reposition or shut it down by pid.
type Browser struct {
	Rod   *rod.Browser
	Owned bool
	PID   int
}

// Open attaches to a Chrome already running on our profile, else launches one.
// The launch flags are load-bearing for avoiding bot detection; do not trim
// them, and never run headless in normal operation.
//
// hideWindow is an explicit choice, never inferred from headless: spec §6
// step 5 scopes offscreen positioning to the GENERATION session only. A
// window the user has to interact with -- sign-in during `setup`, a
// Cloudflare challenge -- must stay where the user can see it, so those
// callers pass hideWindow=false. Only the generate/edit/probe paths, which
// no human ever looks at, pass true.
func Open(headless, hideWindow bool) (*Browser, error) {
	dir := ProfileDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if ws, ok := EndpointFromProfile(dir); ok {
		b := rod.New().ControlURL(ws)
		if err := b.Connect(); err == nil {
			return &Browser{Rod: b, Owned: false}, nil
		}
	}
	bin, err := ChromePath()
	if err != nil {
		return nil, err
	}
	l := launcher.New().
		Bin(bin).
		UserDataDir(dir).
		Headless(headless).
		Set("disable-blink-features", "AutomationControlled").
		Set("no-first-run").
		Set("no-default-browser-check")
	l.Delete("enable-automation")

	ctrl, err := l.Launch()
	if err != nil {
		return nil, err
	}
	pid := l.PID()
	b := rod.New().ControlURL(ctrl)
	if err := b.Connect(); err != nil {
		return nil, err
	}
	// NOTE: we deliberately never call the launcher's Cleanup method. It
	// runs os.RemoveAll(UserDataDir) and would delete the user's login.

	// Hide the automation window offscreen so it never steals focus. We only
	// do this when the caller explicitly asked for it, only on the launch
	// path, only when headful (headless has no window to hide), and only
	// when we have a real pid to target. The error is deliberately ignored:
	// a visible window is acceptable, a failed run is not.
	if hideWindow && !headless && pid != 0 {
		_ = HideWindow(pid)
	}

	return &Browser{Rod: b, Owned: true, PID: pid}, nil
}

// Close shuts Chrome down gracefully so cookies are flushed, but only if we
// launched it. A hard kill can drop recent cookies.
func (b *Browser) Close() {
	if b == nil || !b.Owned || b.Rod == nil {
		return
	}
	_ = b.Rod.Close()
	time.Sleep(1500 * time.Millisecond)
}

// Auth probes the session endpoint in its own throwaway tab so a page that may
// be mid-login is never navigated.
func (b *Browser) Auth() (AuthState, error) {
	p, err := b.Rod.Page(proto.TargetCreateTarget{URL: "about:blank"})
	if err != nil {
		return AuthState{}, err
	}
	defer p.Close()
	if err := p.Timeout(25 * time.Second).Navigate("https://chatgpt.com/api/auth/session"); err != nil {
		return AuthState{}, err
	}
	if err := p.Timeout(25 * time.Second).WaitLoad(); err != nil {
		return AuthState{}, err
	}
	el, err := p.Timeout(10 * time.Second).Element("body")
	if err != nil {
		return AuthState{}, errors.New("auth probe: no body")
	}
	txt, err := el.Text()
	if err != nil {
		return AuthState{}, err
	}
	return ParseAuthBody([]byte(strings.TrimSpace(txt)))
}
