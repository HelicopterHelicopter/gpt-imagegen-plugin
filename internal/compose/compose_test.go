package compose

import (
	"strings"
	"testing"
)

func TestErrSelectorMissIncludesKey(t *testing.T) {
	err := ErrSelectorMiss{Key: "composer_input"}
	msg := err.Error()
	if !strings.Contains(msg, "composer_input") {
		t.Fatalf("Error() = %q, want it to contain the key %q", msg, "composer_input")
	}
}

// TestAttachmentsReady covers the pure decision behind waitAttachmentsReady's
// poll loop. The poll loop itself needs a live *rod.Page (it evals JS against
// a real DOM) and is not unit-testable here, but the "have we seen enough
// removal controls yet" decision is a plain function and is fully covered
// without a browser.
func TestAttachmentsReady(t *testing.T) {
	cases := []struct {
		name string
		got  int
		want int
		done bool
	}{
		{"none seen, one wanted", 0, 1, false},
		{"short by one", 1, 2, false},
		{"exact match", 2, 2, true},
		{"more than enough", 3, 2, true},
		{"zero wanted is trivially satisfied", 0, 0, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := attachmentsReady(c.got, c.want); got != c.done {
				t.Fatalf("attachmentsReady(%d, %d) = %v, want %v", c.got, c.want, got, c.done)
			}
		})
	}
}
