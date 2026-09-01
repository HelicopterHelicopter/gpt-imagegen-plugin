package selectors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadEmbeddedHasKnownKeys(t *testing.T) {
	s, err := Load("")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	for _, k := range []string{"composer_input", "loading_state", "stop_button", "upload_input", "new_chat_button", "generated_image", "conversation_options"} {
		if len(s[k]) == 0 {
			t.Fatalf("embedded set missing key %q", k)
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
