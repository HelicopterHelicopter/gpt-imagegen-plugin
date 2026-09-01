package selectors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// productionKeys is every key the production code actually resolves or
// queries. It is exhaustive in BOTH directions on purpose: a key the code
// needs but the data lacks is a guaranteed runtime failure, and a key the
// data declares but no code reads is a selector that looks maintained,
// gets self-healed, and changes nothing -- the exact trap that shipped
// new_chat_button and composer_plus.
var productionKeys = []string{
	"composer_input",       // compose.Send
	"upload_input",         // compose.Send, --ref/edit
	"attachment_remove",    // compose.waitAttachmentsReady
	"loading_state",        // compose.ReadState
	"stop_button",          // compose.ReadState
	"generated_image",      // compose.ReadState
	"conversation_options", // compose.Archive
}

func TestLoadEmbeddedHasKnownKeys(t *testing.T) {
	s, err := Load("")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	for _, k := range productionKeys {
		if len(s[k]) == 0 {
			t.Fatalf("embedded set missing key %q", k)
		}
	}
}

// TestEmbeddedHasNoUnusedKeys is the other half: every embedded key must
// have a production reader. A declared-but-unused key is worse than a
// missing one, because self-heal will happily write a repair into it and
// the re-run will fail identically.
func TestEmbeddedHasNoUnusedKeys(t *testing.T) {
	s, err := Load("")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	used := map[string]bool{}
	for _, k := range productionKeys {
		used[k] = true
	}
	for k := range s {
		if !used[k] {
			t.Errorf("embedded set declares key %q that no production code reads; use it or delete it", k)
		}
	}
}

func TestEmbeddedHasAttachmentRemoveKey(t *testing.T) {
	s, err := Load("")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(s["attachment_remove"]) == 0 {
		t.Fatal("embedded set missing key \"attachment_remove\"")
	}
	got := s.Query("attachment_remove")
	if len(got) == 0 {
		t.Fatal("Query(\"attachment_remove\") returned no candidates")
	}
	if got[0] != "button[aria-label*='Remove' i]" {
		t.Fatalf("Query(\"attachment_remove\")[0] = %q, want the css form first", got[0])
	}
}

// TestUserOverrideReplacesTheWholeKey pins the merge semantic the skill's
// self-heal instructions have to be written against. A key in the user file
// REPLACES that key's candidate list; it does not prepend to it. So the
// natural-looking patch -- one new candidate under one key -- silently
// deletes every shipped fallback for that key, and the next UI wobble that
// the fallback would have absorbed becomes a hard failure instead.
//
// The behaviour is intentional (a repair must be able to retire a shipped
// candidate that now matches the wrong element), so the fix is instructional,
// not behavioural: whoever writes the file must repeat the existing
// candidates after the new one. This test exists so that instruction can
// never quietly stop being true.
func TestUserOverrideReplacesTheWholeKey(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "selectors.json")

	embedded, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if len(embedded["composer_input"]) < 2 {
		t.Fatalf("this test needs a key with fallbacks; composer_input has %d", len(embedded["composer_input"]))
	}

	// The naive patch: one candidate, one key.
	if err := os.WriteFile(p, []byte(`{"composer_input":[{"css":"#new"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	naive, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if got := naive.Query("composer_input"); len(got) != 1 || got[0] != "#new" {
		t.Fatalf("Query = %v, want exactly [#new]: the user file replaces a key wholesale", got)
	}

	// The correct patch: the new candidate FOLLOWED BY the shipped ones.
	if err := os.WriteFile(p, []byte(`{"composer_input":[{"css":"#new"},{"css":"#prompt-textarea"},{"testid":"prompt-textarea"},{"css":"div[contenteditable='true']"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	merged, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	got := merged.Query("composer_input")
	if len(got) != len(embedded.Query("composer_input"))+1 {
		t.Fatalf("Query = %v, want the new candidate plus every shipped fallback", got)
	}
	if got[0] != "#new" || got[1] != "#prompt-textarea" {
		t.Fatalf("Query = %v, want the patch first and the shipped fallbacks behind it", got)
	}
}

func TestQueryOrderPrefersTestID(t *testing.T) {
	s := Set{"k": {{TestID: "the-testid"}, {CSS: "#fallback"}}}
	got := s.Query("k")
	want := []string{`[data-testid="the-testid"]`, "#fallback"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("Query = %v, want %v", got, want)
	}
}

func TestUserOverrideWinsAndRoundTrips(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "selectors.json")
	if err := os.WriteFile(p, []byte(`{"composer_input":[{"css":"#patched"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Load(p)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := s.Query("composer_input"); len(got) == 0 || got[0] != "#patched" {
		t.Fatalf("user override ignored: %v", got)
	}
	// Keys absent from the override still come from the embedded defaults.
	if len(s["stop_button"]) == 0 {
		t.Fatal("override must merge over defaults, not replace the whole set")
	}
	// Verify the non-overridden key's content still equals the embedded default.
	embedded, _ := Load("")
	if len(s["stop_button"]) != len(embedded["stop_button"]) {
		t.Fatalf("stop_button should equal embedded default")
	}
	// A patch persists and reloads.
	s.Patch("stop_button", Candidate{CSS: "#stopped"})
	if err := s.Save(p); err != nil {
		t.Fatalf("save: %v", err)
	}
	again, err := Load(p)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := again.Query("stop_button"); got[0] != "#stopped" {
		t.Fatalf("patch did not persist to the front: %v", got)
	}
}

func TestSaveWritesOnlyDelta(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "selectors.json")
	// Load embedded, patch ONE key, save.
	s, _ := Load("")
	s.Patch("stop_button", Candidate{CSS: "#stopped"})
	if err := s.Save(p); err != nil {
		t.Fatalf("save: %v", err)
	}
	// Read back as raw JSON and verify it contains EXACTLY ONE key.
	raw, _ := os.ReadFile(p)
	var saved Set
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved) != 1 {
		t.Fatalf("Save wrote %d keys, want 1; keys: %v", len(saved), keysOf(saved))
	}
	if len(saved["stop_button"]) == 0 {
		t.Fatal("saved file missing patched key")
	}
}

func TestNonPatchedKeyStaysEmbedded(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "selectors.json")
	// Load embedded, patch ONE key, save, then reload.
	s, _ := Load("")
	s.Patch("stop_button", Candidate{CSS: "#stopped"})
	s.Save(p)
	// Load from the temp file and assert a non-patched key resolves to embedded.
	reloaded, _ := Load(p)
	embedded, _ := Load("")
	// "composer_input" was not patched, so it should still be the embedded default.
	if len(reloaded["composer_input"]) != len(embedded["composer_input"]) {
		t.Fatalf("non-patched key shadowed; got %d candidates, want %d", len(reloaded["composer_input"]), len(embedded["composer_input"]))
	}
}

func TestUpgradedDefaultVisibleThroughUserFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "selectors.json")
	// User file with only one key patched.
	if err := os.WriteFile(p, []byte(`{"stop_button":[{"css":"#custom"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s, _ := Load(p)
	embedded, _ := Load("")
	// Keys absent from the file should still resolve to embedded defaults.
	if len(s["composer_input"]) == 0 {
		t.Fatal("key absent from user file should come from embedded")
	}
	if len(s["composer_input"]) != len(embedded["composer_input"]) {
		t.Fatal("absent key should equal embedded default")
	}
}

func TestSaveIncludesKeysNotInEmbedded(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "selectors.json")
	// Create a Set with a key that does not exist in embedded.
	s := Set{"new_custom_key": {{CSS: "#custom"}}}
	if err := s.Save(p); err != nil {
		t.Fatalf("save: %v", err)
	}
	raw, _ := os.ReadFile(p)
	var saved Set
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved["new_custom_key"]) == 0 {
		t.Fatal("Save should include keys not in embedded defaults")
	}
}

func TestUserPathReturnsValidPath(t *testing.T) {
	path, err := UserPath()
	if err != nil {
		t.Fatalf("UserPath error: %v", err)
	}
	if path == "" {
		t.Fatal("UserPath should return non-empty path")
	}
}

// Helper to extract keys from Set for error messages
func keysOf(s Set) []string {
	var keys []string
	for k := range s {
		keys = append(keys, k)
	}
	return keys
}
