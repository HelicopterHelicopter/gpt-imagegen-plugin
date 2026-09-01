// Package live holds the opt-in end-to-end smoke test. It drives the real,
// built gpt-imagegen binary against a real, signed-in ChatGPT session and
// therefore costs a real ChatGPT turn against the user's account. It never
// runs unless explicitly enabled via GPT_IMAGEGEN_LIVE=1.
package live

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestLiveGenerate performs one real generation through the packaged plugin
// binary at plugins/gpt-imagegen/bin/gpt-imagegen and checks that a real
// image landed on disk.
func TestLiveGenerate(t *testing.T) {
	if os.Getenv("GPT_IMAGEGEN_LIVE") != "1" {
		t.Skip("set GPT_IMAGEGEN_LIVE=1 to run the live smoke")
	}

	bin, err := filepath.Abs("../../plugins/gpt-imagegen/bin/gpt-imagegen")
	if err != nil {
		t.Fatalf("resolve binary path: %v", err)
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("built binary not found at %s (run `make build` first): %v", bin, err)
	}

	out := filepath.Join(t.TempDir(), "smoke.png")
	cmd := exec.Command(bin,
		"generate", "--prompt", "a plain solid teal square, no text", "--out", out)
	stdout, err := cmd.Output()
	if err != nil {
		t.Fatalf("run: %v (stdout=%s)", err, stdout)
	}

	var r struct {
		OK     bool `json:"ok"`
		Images []struct {
			Path  string `json:"path"`
			Bytes int    `json:"bytes"`
		} `json:"images"`
	}
	if err := json.Unmarshal(stdout, &r); err != nil {
		t.Fatalf("stdout not JSON: %s", stdout)
	}
	if !r.OK || len(r.Images) != 1 {
		t.Fatalf("unexpected result: %s", stdout)
	}

	fi, err := os.Stat(r.Images[0].Path)
	if err != nil || fi.Size() < 1000 {
		t.Fatalf("no real image written: %v", err)
	}
}
