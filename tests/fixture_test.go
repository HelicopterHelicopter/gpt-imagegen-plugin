// Package tests holds regression tests that drive a real, offline DOM
// through the same selectors and JS the production code uses against
// chatgpt.com. Everything here runs against a saved fixture file over
// file:// — no network, no ChatGPT account — so a failure here means one
// thing: ChatGPT's DOM (or our selectors) drifted and needs repair. This is
// the only test in the project that can tell a maintainer that.
package tests

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"

	"github.com/jheelr/gpt-imagegen/internal/compose"
	"github.com/jheelr/gpt-imagegen/internal/probe"
	"github.com/jheelr/gpt-imagegen/internal/selectors"
	"github.com/jheelr/gpt-imagegen/internal/session"
)

// The single generated file in fixtures/conversation.html, rendered through
// two <img> tags the way ChatGPT actually renders a generation. Keep these
// in sync with the fixture HTML by hand; that duplication is deliberate,
// the same way a golden-file test's expectations live next to its input.
const (
	imgAID  = "file_00000000e7148208927dc5bbece7a546"
	imgAAlt = "Generated image: Geometric Teal Mountain Emblem"
)

// The second, different generated file added in
// fixtures/conversation_multi_image.html, used to prove AltForID actually
// distinguishes between images rather than trivially returning the only alt
// on a single-image page.
const (
	imgBID  = "file_9f8e7d6c5b4a39281706f5e4d3c2b1a0"
	imgBAlt = "Generated image: Sunset Origami Crane"
)

// nonGeneratedSrc is a real ChatGPT UI asset URL (see
// internal/capture/filter_test.go) placed in fixtures/conversation.html
// next to the generated image. It must never show up in ReadState's
// ImageURLs or contribute an id to DistinctImageIDs.
const nonGeneratedSrc = "https://chatgpt.com/cdn/assets/sprites-core-9b910f5e.svg"

// fixturePage loads a saved conversation fixture offline. It uses whatever
// Chrome the machine has; no network and no ChatGPT account are involved.
// Deliberately does NOT set a UserDataDir: a throwaway headless browser is
// correct for a fixture test, and it must never point at (or risk cleaning
// up) the real ~/.gpt-imagegen profile.
func fixturePage(t *testing.T, fixture string) (*rod.Page, func()) {
	t.Helper()
	bin, err := session.ChromePath()
	if err != nil {
		t.Skipf("chrome not available: %v", err)
	}
	l := launcher.New().Bin(bin).Headless(true)
	u, err := l.Launch()
	if err != nil {
		t.Skipf("cannot launch chrome: %v", err)
	}
	b := rod.New().ControlURL(u)
	if err := b.Connect(); err != nil {
		l.Kill()
		t.Skipf("cannot connect: %v", err)
	}
	abs, err := filepath.Abs(filepath.Join("fixtures", fixture))
	if err != nil {
		b.Close()
		l.Kill()
		t.Fatalf("resolve fixture path: %v", err)
	}
	p := b.MustPage("file://" + abs)
	p.MustWaitLoad()
	// NOTE: never call the launcher's Cleanup method here or anywhere else.
	// It runs os.RemoveAll(UserDataDir); Kill() is the correct teardown for
	// a launcher we started.
	return p, func() {
		_ = b.Close()
		l.Kill()
	}
}

// TestSelectorsResolveAgainstFixture is the drift detector: every key the
// production code depends on must still resolve against the DOM shape the
// spike observed. A failure here, and only here, means ChatGPT changed its
// markup and a selector needs repair.
func TestSelectorsResolveAgainstFixture(t *testing.T) {
	p, done := fixturePage(t, "conversation.html")
	defer done()

	set, err := selectors.Load("")
	if err != nil {
		t.Fatalf("load selectors: %v", err)
	}
	// Exactly the keys production reads on a FINISHED conversation. The two
	// completion keys (loading_state, stop_button) cannot be asserted here:
	// their whole meaning is "a generation is still running", so they live
	// in TestCompletionSelectorsResolveAgainstGeneratingFixture below,
	// against a fixture where one is. Between the two tests, every key in
	// selectors.json is covered -- which is the property that makes this a
	// drift detector rather than a spot check.
	keys := []string{
		"composer_input",
		"upload_input",
		"generated_image",
		"conversation_options",
		"attachment_remove",
	}
	for _, key := range keys {
		if _, err := compose.Resolve(p, set, key, 5*time.Second); err != nil {
			t.Errorf("selector %q no longer resolves: %v", key, err)
		}
	}
}

// TestCompletionSelectorsResolveAgainstGeneratingFixture covers the other
// half of the key set: the two selectors that only exist while a generation
// is in flight. These are what stop the tool declaring a run finished before
// the images arrive, and since FIX 3 they come from selectors.json rather
// than being hardcoded in the state JS -- so a drift here is repairable by
// editing data, and this test is what catches it.
func TestCompletionSelectorsResolveAgainstGeneratingFixture(t *testing.T) {
	p, done := fixturePage(t, "conversation_generating.html")
	defer done()

	set, err := selectors.Load("")
	if err != nil {
		t.Fatalf("load selectors: %v", err)
	}
	for _, key := range []string{"loading_state", "stop_button"} {
		if _, err := compose.Resolve(p, set, key, 5*time.Second); err != nil {
			t.Errorf("selector %q no longer resolves: %v", key, err)
		}
	}

	st, err := compose.ReadState(p, set)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	if !st.Loading {
		t.Error("loading_state must be reported while an image generation is in flight")
	}
	if !st.Streaming {
		t.Error("stop_button must be reported while the turn is still streaming")
	}
	if len(st.ImageURLs) != 0 {
		t.Errorf("no image has arrived yet, got %v", st.ImageURLs)
	}
	if compose.Done(st, 1) {
		t.Fatal("Done must be false while the page is still generating")
	}
}

// TestStateJSFollowsAPatchedSelector proves the completion poll is really
// driven by the selector data and not by a hardcoded string: point
// generated_image at a selector that matches the fixture's NON-generated
// asset, and the state must follow the data. This is the difference between
// a repairable selector and a decorative one.
func TestStateJSFollowsAPatchedSelector(t *testing.T) {
	p, done := fixturePage(t, "conversation.html")
	defer done()

	set, err := selectors.Load("")
	if err != nil {
		t.Fatalf("load selectors: %v", err)
	}
	set["generated_image"] = []selectors.Candidate{{CSS: `img[alt="ChatGPT"]`}}

	st, err := compose.ReadState(p, set)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	if len(st.ImageURLs) != 1 || st.ImageURLs[0] != nonGeneratedSrc {
		t.Fatalf("ReadState ignored the patched selector: %v", st.ImageURLs)
	}
}

// TestReadStateOnFinishedConversation exercises the JS state-reading pipeline
// (compose.ReadState) against a finished, single-image conversation.
func TestReadStateOnFinishedConversation(t *testing.T) {
	p, done := fixturePage(t, "conversation.html")
	defer done()

	set, err := selectors.Load("")
	if err != nil {
		t.Fatalf("load selectors: %v", err)
	}
	st, err := compose.ReadState(p, set)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}

	if st.Loading || st.Streaming {
		t.Fatalf("finished conversation must be quiet: %+v", st)
	}

	// The fixture has an assistant-avatar <img> that is NOT a generated
	// image (its alt does not start with "Generated image: "). It must
	// contribute nothing: not to the raw tag list ReadState extracts, and
	// not to DistinctImageIDs.
	for _, u := range st.ImageURLs {
		if u == nonGeneratedSrc {
			t.Fatalf("non-generated image leaked into ImageURLs: %v", st.ImageURLs)
		}
	}

	// Two <img> tags point at the same underlying generated file: this is
	// the property that stops the tool saving the same image twice.
	if len(st.ImageURLs) != 2 {
		t.Fatalf("expected exactly the 2 tags for the one generated file, got %d: %v", len(st.ImageURLs), st.ImageURLs)
	}
	ids := st.DistinctImageIDs()
	if len(ids) != 1 {
		t.Fatalf("DistinctImageIDs = %v, want exactly one", ids)
	}
	if ids[0] != imgAID {
		t.Fatalf("DistinctImageIDs = %v, want [%s]", ids, imgAID)
	}

	if !compose.Done(st, 1) {
		t.Fatal("Done must be true for a finished single-image conversation")
	}
	if compose.Done(st, 2) {
		t.Fatal("Done must be false when a set of 2 was requested but only 1 arrived")
	}

	// AltForID must return the shared alt text for the id, regardless of
	// which of the two <img> tags it is read from.
	if got := st.AltForID(imgAID); got != imgAAlt {
		t.Fatalf("AltForID(%s) = %q, want %q", imgAID, got, imgAAlt)
	}
}

// TestReadStateWithTwoDistinctGeneratedImages loads a second fixture where a
// generation produced two DIFFERENT images (the first also duplicated across
// two <img> tags, as ChatGPT does). This is what makes the AltForID check
// meaningful rather than trivial: on a page with only one image, returning
// "the only alt on the page" would pass even with the id/alt pairing broken.
func TestReadStateWithTwoDistinctGeneratedImages(t *testing.T) {
	p, done := fixturePage(t, "conversation_multi_image.html")
	defer done()

	set, err := selectors.Load("")
	if err != nil {
		t.Fatalf("load selectors: %v", err)
	}
	st, err := compose.ReadState(p, set)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	if st.Loading || st.Streaming {
		t.Fatalf("finished conversation must be quiet: %+v", st)
	}

	ids := st.DistinctImageIDs()
	if len(ids) != 2 {
		t.Fatalf("DistinctImageIDs = %v, want exactly two", ids)
	}
	if ids[0] != imgAID || ids[1] != imgBID {
		t.Fatalf("DistinctImageIDs = %v, want [%s %s]", ids, imgAID, imgBID)
	}

	if !compose.Done(st, 2) {
		t.Fatal("Done must be true once both requested images have arrived")
	}
	if compose.Done(st, 3) {
		t.Fatal("Done must be false when a set of 3 was requested but only 2 arrived")
	}

	if got := st.AltForID(imgAID); got != imgAAlt {
		t.Fatalf("AltForID(%s) = %q, want %q", imgAID, got, imgAAlt)
	}
	if got := st.AltForID(imgBID); got != imgBAlt {
		t.Fatalf("AltForID(%s) = %q, want %q", imgBID, got, imgBAlt)
	}
}

// TestProbeNeverEmitsABareTagSelector is the guard on the self-heal input.
// A probe candidate is copied more or less verbatim into
// ~/.gpt-imagegen/selectors.json and patched to the FRONT of a key, so a css
// of "button" or "div" does not degrade gracefully: it resolves to the first
// such element on the page, and the tool would happily type the prompt into
// it and report success. Every css the probe emits must therefore be
// selective (an #id or a [data-testid=...]); anything less selective must be
// omitted, leaving role/name/text as description only.
func TestProbeNeverEmitsABareTagSelector(t *testing.T) {
	p, done := fixturePage(t, "conversation_generating.html")
	defer done()

	cands, err := probe.Collect(p)
	if err != nil {
		t.Fatalf("probe collect: %v", err)
	}
	if len(cands) == 0 {
		t.Fatal("probe found no candidates at all; the dump would be useless")
	}

	actionable := 0
	for _, c := range cands {
		if c.CSS == "" {
			continue
		}
		actionable++
		if !strings.HasPrefix(c.CSS, "#") && !strings.HasPrefix(c.CSS, "[data-testid=") {
			t.Errorf("probe emitted a non-selective css %q (role=%q name=%q); patched to the front of a key it would match an arbitrary element", c.CSS, c.Role, c.Name)
		}
	}
	if actionable == 0 {
		t.Fatal("probe emitted no actionable candidate; self-heal would have nothing to copy")
	}

	// The fixture's id-less, testid-less button must be described but not
	// given a fabricated selector.
	found := false
	for _, c := range cands {
		if c.Name != "Add photos and files" {
			continue
		}
		found = true
		if c.CSS != "" {
			t.Errorf("element with no id and no testid got css %q, want empty", c.CSS)
		}
		if c.Actionable() {
			t.Error("a candidate with neither testid nor css must report Actionable() == false")
		}
	}
	if !found {
		t.Fatal("probe missed the id-less button; the degradation path is not being exercised")
	}
}
