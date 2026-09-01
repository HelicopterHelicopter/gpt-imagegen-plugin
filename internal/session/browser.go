package session

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
)

const defaultChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

func ChromePath() (string, error) {
	p := os.Getenv("GPT_IMAGEGEN_CHROME")
	if p == "" {
		p = defaultChrome
	}
	if _, err := os.Stat(p); err != nil {
		return "", fmt.Errorf("chrome not found at %s", p)
	}
	return p, nil
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
// them, and never run headless.
func Open(headless bool) (*Browser, error) {
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
	// do this on the launch path, only when headful (headless has no window
	// to hide), and only when we have a real pid to target. The error is
	// deliberately ignored: a visible window is acceptable, a failed run is
	// not.
	if !headless && pid != 0 {
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
