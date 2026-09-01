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
