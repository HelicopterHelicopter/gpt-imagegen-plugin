// Package selectors keeps ChatGPT DOM selectors as data rather than code, so a
// repair after a UI change needs no rebuild. A user-level file overrides the
// embedded defaults per key, which is where self-heal writes.
package selectors

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

//go:embed selectors.json
var embedded []byte

type Candidate struct {
	TestID string `json:"testid,omitempty"`
	CSS    string `json:"css,omitempty"`
	Text   string `json:"text,omitempty"`
}

type Set map[string][]Candidate

// UserPath is where self-heal writes. Kept separate from the embedded copy so
// a plugin upgrade never clobbers a local repair, and deleting it restores
// shipped defaults. Returns an error if the home directory cannot be determined.
func UserPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".gpt-imagegen", "selectors.json"), nil
}

// Load merges a user override over the embedded defaults, per key. An empty
// userPath, or a missing file, yields the defaults alone.
//
// The merge is per key and WHOLESALE: a key present in the user file
// replaces that key's entire candidate list, it does not prepend to it. That
// is deliberate -- it is the only way a repair can retire a shipped
// candidate that now matches the wrong element -- but it means a patch of
// {"composer_input":[{"css":"#new"}]} deletes every shipped fallback for
// composer_input. Anything writing this file (today, the skill, by hand)
// must therefore write the new candidate FOLLOWED BY the key's existing
// candidates. SKILL.md carries that instruction with a worked example;
// TestUserOverrideReplacesTheWholeKey pins the behaviour.
func Load(userPath string) (Set, error) {
	base := Set{}
	if err := json.Unmarshal(embedded, &base); err != nil {
		return nil, fmt.Errorf("embedded selectors invalid: %w", err)
	}
	if userPath == "" {
		return base, nil
	}
	raw, err := os.ReadFile(userPath)
	if os.IsNotExist(err) {
		return base, nil
	}
	if err != nil {
		return nil, err
	}
	over := Set{}
	if err := json.Unmarshal(raw, &over); err != nil {
		return nil, fmt.Errorf("user selectors invalid: %w", err)
	}
	for k, v := range over {
		base[k] = v
	}
	return base, nil
}

// Query returns CSS selector strings in priority order. Text-only candidates
// are skipped; the caller resolves those separately.
func (s Set) Query(key string) []string {
	var out []string
	for _, c := range s[key] {
		switch {
		case c.TestID != "":
			out = append(out, fmt.Sprintf("[data-testid=%q]", c.TestID))
		case c.CSS != "":
			out = append(out, c.CSS)
		}
	}
	return out
}

// Patch puts a candidate at the front of a key's list.
//
// NOTE: nothing in the CLI calls Patch or Save. Self-heal is performed by
// the skill, which reads the probe dump and writes
// ~/.gpt-imagegen/selectors.json itself; these two are a library surface
// kept for callers that want to build a delta file programmatically. Do not
// document them as the mechanism that writes that file -- the README says
// what actually happens.
func (s Set) Patch(key string, c Candidate) {
	s[key] = append([]Candidate{c}, s[key]...)
}

// Save persists only the delta from embedded defaults to the given path.
//
// Like Patch, Save has no production caller today (see the note on Patch).
// This
// ensures that a plugin upgrade can improve a selector that was not patched, and
// deleting the file restores all shipped defaults. Keys absent from embedded are
// always written. Keep MkdirAll 0o700 and file mode 0o600.
func (s Set) Save(path string) error {
	// Load embedded defaults to compute delta.
	defaults := Set{}
	if err := json.Unmarshal(embedded, &defaults); err != nil {
		return fmt.Errorf("embedded selectors invalid: %w", err)
	}

	// Build delta: include only keys that differ from defaults or don't exist in defaults.
	delta := Set{}
	for k, v := range s {
		def, exists := defaults[k]
		// Include key if it doesn't exist in defaults or if values differ.
		if !exists || !candidateSlicesEqual(v, def) {
			delta[k] = v
		}
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(delta, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o600)
}

// candidateSlicesEqual compares two slices of Candidates for equality.
func candidateSlicesEqual(a, b []Candidate) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].TestID != b[i].TestID || a[i].CSS != b[i].CSS || a[i].Text != b[i].Text {
			return false
		}
	}
	return true
}
