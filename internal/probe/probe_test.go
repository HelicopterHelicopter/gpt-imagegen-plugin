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
