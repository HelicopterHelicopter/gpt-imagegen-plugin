// Package tests holds regression tests that drive a real, offline DOM
// through the same selectors and JS the production code uses against
// chatgpt.com. Everything here runs against a saved fixture file over
// file:// — no network, no ChatGPT account — so a failure here means one
// thing: ChatGPT's DOM (or our selectors) drifted and needs repair. This is
// the only test in the project that can tell a maintainer that.
package tests

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"

	"github.com/jheelr/gpt-imagegen/internal/compose"
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
	keys := []string{
		"composer_input",
		"upload_input",
		"new_chat_button",
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

// TestReadStateOnFinishedConversation exercises the JS state-reading pipeline
// (compose.ReadState) against a finished, single-image conversation.
func TestReadStateOnFinishedConversation(t *testing.T) {
	p, done := fixturePage(t, "conversation.html")
	defer done()

	st, err := compose.ReadState(p)
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

	st, err := compose.ReadState(p)
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
