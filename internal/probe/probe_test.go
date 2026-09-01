package probe

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteDumpProducesReadableJSON(t *testing.T) {
	dir := t.TempDir()
	cands := []Candidate{
		{TestID: "stop-button", Role: "button", Name: "Stop", CSS: "button[data-testid='stop-button']"},
		{CSS: "#prompt-textarea", Text: ""},
	}
	p, err := WriteDump(dir, "composer", "https://chatgpt.com/c/abc", cands)
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if filepath.Dir(p) != dir {
		t.Fatalf("dump written outside dir: %q", p)
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var back Dump
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("dump is not valid json: %v", err)
	}
	if back.Stage != "composer" || len(back.Candidates) != 2 {
		t.Fatalf("dump lost data: %+v", back)
	}
	if back.Candidates[0].TestID != "stop-button" {
		t.Fatalf("candidate mangled: %+v", back.Candidates[0])
	}
}

// TestWriteDumpSanitisesStage guards against a stage value escaping dir via
// path traversal. WriteDump is exported and writes files, so a stage of
// e.g. "../../etc/passwd" must not be able to write outside the given dir.
func TestWriteDumpSanitisesStage(t *testing.T) {
	cases := []struct {
		name  string
		stage string
	}{
		{"plain", "composer"},
		{"traversal", "../../etc/passwd"},
		{"nested_separator", "a/b"},
		{"dotdot_alone", ".."},
		{"empty", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			p, err := WriteDump(dir, c.stage, "https://example.com", nil)
			if err != nil {
				t.Fatalf("write: %v", err)
			}
			if filepath.Dir(p) != dir {
				t.Fatalf("stage %q escaped dir: got path %q, want it inside %q", c.stage, p, dir)
			}
			if _, err := os.Stat(p); err != nil {
				t.Fatalf("dump file not created at %q: %v", p, err)
			}
		})
	}
}
