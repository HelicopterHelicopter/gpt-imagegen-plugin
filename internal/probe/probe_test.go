package probe

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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
	// The dump has to carry its own instructions: the agent reading it is
	// one step removed from this codebase, and the trap it must avoid
	// (copying role/name into selectors.json, or replacing a key with a
	// single candidate) is invisible from the data alone.
	if back.Note == "" {
		t.Fatal("dump must carry the note explaining which fields are actionable")
	}
	for _, want := range []string{"testid", "css", "role", "actionable"} {
		if !strings.Contains(strings.ToLower(back.Note), want) {
			t.Errorf("note does not mention %q: %q", want, back.Note)
		}
	}
}

// TestActionableMarksOnlyCopyableCandidates: the resolver understands
// testid and css and nothing else, so a candidate described only by
// role/name/text is a dead end. Copying one into selectors.json produces a
// key with no query -- written without error, failing identically on
// re-run -- which is exactly the silent no-op self-heal must avoid.
func TestActionableMarksOnlyCopyableCandidates(t *testing.T) {
	cases := []struct {
		name string
		c    Candidate
		want bool
	}{
		{"testid", Candidate{TestID: "stop-button"}, true},
		{"css", Candidate{CSS: "#prompt-textarea"}, true},
		{"role and name only", Candidate{Role: "button", Name: "Send prompt"}, false},
		{"text only", Candidate{Text: "Send"}, false},
		{"empty", Candidate{}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.c.Actionable(); got != c.want {
				t.Fatalf("Actionable() = %v, want %v for %+v", got, c.want, c.c)
			}
		})
	}
}

// TestCandidateJSONMatchesSelectorsCandidate pins the field names the probe
// emits to the ones the selectors file understands. If these drift, a
// candidate copied verbatim out of a dump stops being a working patch and
// self-heal silently no-ops.
func TestCandidateJSONMatchesSelectorsCandidate(t *testing.T) {
	raw, err := json.Marshal(Candidate{TestID: "t", CSS: "#c", Role: "button", Name: "n", Text: "x"})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"testid", "css"} {
		if _, ok := got[k]; !ok {
			t.Errorf("probe candidate is missing the actionable field %q: %s", k, raw)
		}
	}
	// A selectors.Candidate is {testid, css, text}: unmarshalling a probe
	// candidate into one must keep the actionable fields intact.
	var sel struct {
		TestID string `json:"testid"`
		CSS    string `json:"css"`
	}
	if err := json.Unmarshal(raw, &sel); err != nil {
		t.Fatal(err)
	}
	if sel.TestID != "t" || sel.CSS != "#c" {
		t.Fatalf("probe candidate does not decode into a selectors candidate: %+v", sel)
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
