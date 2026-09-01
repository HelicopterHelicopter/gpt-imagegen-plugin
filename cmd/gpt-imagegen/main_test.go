package main

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestUnknownCommandEmitsJSONOnStdout(t *testing.T) {
	var out, errBuf bytes.Buffer
	code := run([]string{"wat"}, &out, &errBuf)
	if code == 0 {
		t.Fatal("unknown command must exit non-zero")
	}
	var r map[string]any
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatalf("stdout must be a single JSON object, got %q", out.String())
	}
	if r["ok"] != false {
		t.Fatalf("want ok=false, got %v", r["ok"])
	}
}

func TestGenerateRequiresPromptAndOut(t *testing.T) {
	var out, errBuf bytes.Buffer
	if code := run([]string{"generate"}, &out, &errBuf); code == 0 {
		t.Fatal("generate without --prompt must fail")
	}
	if !strings.Contains(out.String(), `"ok":false`) {
		t.Fatalf("stdout = %q", out.String())
	}
	if strings.Count(strings.TrimSpace(out.String()), "\n") != 0 {
		t.Fatalf("stdout must be exactly one line, got %q", out.String())
	}
}

func TestGeneratePromptWithoutOutFails(t *testing.T) {
	var out, errBuf bytes.Buffer
	code := run([]string{"generate", "--prompt", "x"}, &out, &errBuf)
	if code == 0 {
		t.Fatal("generate without --out must fail")
	}
	var r map[string]any
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatalf("stdout must be a single JSON object, got %q", out.String())
	}
	if r["ok"] != false {
		t.Fatalf("want ok=false, got %v", r["ok"])
	}
	if strings.Count(strings.TrimSpace(out.String()), "\n") != 0 {
		t.Fatalf("stdout must be exactly one line, got %q", out.String())
	}
}

// edit with a nonexistent --image must fail before ever touching a browser,
// so this must return quickly and deterministically in CI.
func TestEditWithNonexistentImageFailsWithoutBrowser(t *testing.T) {
	var out, errBuf bytes.Buffer
	missing := filepath.Join(t.TempDir(), "does-not-exist.png")
	code := run([]string{"edit", "--image", missing, "--prompt", "make it blue", "--out", filepath.Join(t.TempDir(), "out.png")}, &out, &errBuf)
	if code == 0 {
		t.Fatal("edit with a nonexistent --image must fail")
	}
	var r map[string]any
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatalf("stdout must be a single JSON object, got %q", out.String())
	}
	if r["ok"] != false {
		t.Fatalf("want ok=false, got %v", r["ok"])
	}
	if strings.Count(strings.TrimSpace(out.String()), "\n") != 0 {
		t.Fatalf("stdout must be exactly one line, got %q", out.String())
	}
}

// Progress must never contaminate stdout, which the skill parses as JSON.
func TestStdoutHasNoProgressChatter(t *testing.T) {
	var out, errBuf bytes.Buffer
	run([]string{"wat"}, &out, &errBuf)
	if strings.Count(strings.TrimSpace(out.String()), "\n") != 0 {
		t.Fatalf("stdout must be exactly one line, got %q", out.String())
	}
}

func TestNoArgsEmitsJSONOnStdout(t *testing.T) {
	var out, errBuf bytes.Buffer
	code := run([]string{}, &out, &errBuf)
	if code == 0 {
		t.Fatal("no args must exit non-zero")
	}
	var r map[string]any
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatalf("stdout must be a single JSON object, got %q", out.String())
	}
	if r["ok"] != false {
		t.Fatalf("want ok=false, got %v", r["ok"])
	}
	if strings.Count(strings.TrimSpace(out.String()), "\n") != 0 {
		t.Fatalf("stdout must be exactly one line, got %q", out.String())
	}
}
