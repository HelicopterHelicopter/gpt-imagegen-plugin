package selectors

import (
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
