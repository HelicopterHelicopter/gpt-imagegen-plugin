package compose

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jheel-knot/gpt-imagegen-plugin/internal/selectors"
)

func TestErrSelectorMissIncludesKey(t *testing.T) {
	err := ErrSelectorMiss{Key: "composer_input"}
	msg := err.Error()
	if !strings.Contains(msg, "composer_input") {
		t.Fatalf("Error() = %q, want it to contain the key %q", msg, "composer_input")
	}
}

// TestAttachmentsReady covers the pure decision behind waitAttachmentsReady's
// poll loop. The poll loop itself needs a live *rod.Page (it evals JS against
// a real DOM) and is not unit-testable here, but the "have we seen enough
// removal controls yet" decision is a plain function and is fully covered
// without a browser.
func TestAttachmentsReady(t *testing.T) {
	cases := []struct {
		name string
		got  int
		want int
		done bool
	}{
		{"none seen, one wanted", 0, 1, false},
		{"short by one", 1, 2, false},
		{"exact match", 2, 2, true},
		{"more than enough", 3, 2, true},
		{"zero wanted is trivially satisfied", 0, 0, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := attachmentsReady(c.got, c.want); got != c.done {
				t.Fatalf("attachmentsReady(%d, %d) = %v, want %v", c.got, c.want, got, c.done)
			}
		})
	}
}

// TestStateScriptComesFromSelectorsFile is the point of FIX 3: the three
// completion selectors are the ones most likely to drift, so they must be
// repairable by editing data, not by rebuilding the binary. If the built
// script ever stops reflecting the set it was given, self-heal is a lie for
// these keys.
func TestStateScriptComesFromSelectorsFile(t *testing.T) {
	s := selectors.Set{
		KeyGeneratedImage: {{CSS: "img.gen"}, {TestID: "gen-img"}},
		KeyLoadingState:   {{CSS: ".spinner"}},
		KeyStopButton:     {{TestID: "halt"}},
	}
	js, err := stateScript(s)
	if err != nil {
		t.Fatalf("stateScript: %v", err)
	}
	for _, want := range []string{
		`"img.gen,[data-testid=\"gen-img\"]"`, // candidates joined into one list
		`".spinner"`,
		`"[data-testid=\"halt\"]"`,
	} {
		if !strings.Contains(js, want) {
			t.Errorf("script does not use %s:\n%s", want, js)
		}
	}
	// The old hardcoded selectors must be gone: their presence would mean
	// the set is decorative.
	for _, gone := range []string{"image-gen-loading-state", "stop-button", "Generated image: "} {
		if strings.Contains(js, gone) {
			t.Errorf("script still hardcodes %q:\n%s", gone, js)
		}
	}
}

// TestStateScriptEscapesSelectorQuotes guards the interpolation: a selector
// containing a quote must not be able to terminate the JS string literal and
// rewrite the script.
func TestStateScriptEscapesSelectorQuotes(t *testing.T) {
	s := selectors.Set{
		KeyGeneratedImage: {{CSS: `img[alt^="Generated image: "]`}},
		KeyLoadingState:   {{CSS: ".spinner"}},
		KeyStopButton:     {{TestID: "halt"}},
	}
	js, err := stateScript(s)
	if err != nil {
		t.Fatalf("stateScript: %v", err)
	}
	if !strings.Contains(js, `"img[alt^=\"Generated image: \"]"`) {
		t.Fatalf("selector quotes were not escaped:\n%s", js)
	}
}

// TestStateScriptMissingKeyIsASelectorMiss: a completion key with no usable
// candidate must surface as the one repairable error code, immediately.
// Treating it as "nothing is loading" would make Done fire instantly, and
// burning the full timeout would report a misleading TIMEOUT.
func TestStateScriptMissingKeyIsASelectorMiss(t *testing.T) {
	full := selectors.Set{
		KeyGeneratedImage: {{CSS: "img.gen"}},
		KeyLoadingState:   {{CSS: ".spinner"}},
		KeyStopButton:     {{TestID: "halt"}},
	}
	for _, key := range []string{KeyGeneratedImage, KeyLoadingState, KeyStopButton} {
		t.Run(key, func(t *testing.T) {
			s := selectors.Set{}
			for k, v := range full {
				if k != key {
					s[k] = v
				}
			}
			_, err := stateScript(s)
			var miss ErrSelectorMiss
			if !errors.As(err, &miss) {
				t.Fatalf("err = %v, want an ErrSelectorMiss", err)
			}
			if miss.Key != key {
				t.Fatalf("miss.Key = %q, want %q", miss.Key, key)
			}
		})
	}
}

// TestStateScriptRejectsUnactionableCandidates: a candidate carrying only
// role/name/text (the shape a probe dump describes but the resolver cannot
// express) yields no query at all. It must be reported as a selector miss,
// not silently treated as a present-but-matching-nothing selector.
func TestStateScriptRejectsUnactionableCandidates(t *testing.T) {
	s := selectors.Set{
		KeyGeneratedImage: {{CSS: "img.gen"}},
		KeyLoadingState:   {{Text: "Creating image"}},
		KeyStopButton:     {{TestID: "halt"}},
	}
	_, err := stateScript(s)
	var miss ErrSelectorMiss
	if !errors.As(err, &miss) || miss.Key != KeyLoadingState {
		t.Fatalf("err = %v, want an ErrSelectorMiss for %q", err, KeyLoadingState)
	}
}

// TestAttachTimeoutErrIsASelectorMiss is FIX 7: the likeliest failure of the
// whole edit/--ref path must be reachable by the probe and one-shot
// self-heal, and must not lose the observed counts on the way.
func TestAttachTimeoutErrIsASelectorMiss(t *testing.T) {
	err := attachTimeoutErr(0, 2, 60*time.Second)

	var miss ErrSelectorMiss
	if !errors.As(err, &miss) {
		t.Fatalf("err = %v (%T), want an ErrSelectorMiss so run.go emits SELECTOR_MISS", err, err)
	}
	if miss.Key != "attachment_remove" {
		t.Fatalf("miss.Key = %q, want %q", miss.Key, "attachment_remove")
	}
	for _, want := range []string{"attachment_remove", "0 of 2", "1m0s"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("message %q lost the detail %q", err.Error(), want)
		}
	}
}
