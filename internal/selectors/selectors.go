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
// shipped defaults.
func UserPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".gpt-imagegen", "selectors.json")
}

// Load merges a user override over the embedded defaults, per key. An empty
// userPath, or a missing file, yields the defaults alone.
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
func (s Set) Patch(key string, c Candidate) {
	s[key] = append([]Candidate{c}, s[key]...)
}

func (s Set) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o600)
}
