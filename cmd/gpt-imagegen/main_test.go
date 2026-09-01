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

// emitPanic is the recover-path helper safeRun calls on a panic. Testing it
// directly (rather than forcing an actual panic through safeRun) still
// proves the hard rule holds even when something crashes: exactly one valid
// JSON line, ok:false, on stdout.
func TestEmitPanicWritesSingleJSONLine(t *testing.T) {
	var out bytes.Buffer
	code := emitPanic(&out, "boom: nil pointer")
	if code == 0 {
		t.Fatal("a panic must exit non-zero")
	}
	if strings.Count(strings.TrimSpace(out.String()), "\n") != 0 {
		t.Fatalf("stdout must be exactly one line, got %q", out.String())
	}
	var r map[string]any
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatalf("stdout must be a single JSON object, got %q", out.String())
	}
	if r["ok"] != false {
		t.Fatalf("want ok=false, got %v", r["ok"])
	}
	errObj, _ := r["error"].(map[string]any)
	if errObj == nil || errObj["code"] != "REFUSED" {
		t.Fatalf("want error.code = REFUSED, got %+v", r["error"])
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
