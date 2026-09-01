package main

import (
	"bytes"
	"encoding/json"
	"errors"
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

// emitPanic is the fixed-message helper safeRun calls on a panic. It never
// takes the panic value: that is safeRun's job to log to stderr, never
// stdout (see the safeRun tests below for the wiring that actually matters).
func TestEmitPanicWritesSingleJSONLine(t *testing.T) {
	var out bytes.Buffer
	code := emitPanic(&out)
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

// TestSafeRunRecoversFromPanic drives an actual panic through safeRun's real
// defer/recover/named-return wiring (not just the pure emitPanic helper), so
// a refactor that breaks that wiring has a test that can fail. A distinctive
// sentinel stands in for the panic value so its presence/absence in stdout
// vs stderr is unambiguous.
func TestSafeRunRecoversFromPanic(t *testing.T) {
	const sentinel = "SENTINEL_PANIC_VALUE_9271"
	var out, errBuf bytes.Buffer
	fn := func() int { panic(sentinel) }

	code := safeRun(fn, &out, &errBuf)

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
	if strings.Contains(out.String(), sentinel) {
		t.Fatalf("panic value must never leak into stdout, got %q", out.String())
	}
	if errBuf.Len() == 0 {
		t.Fatal("stderr must not be empty after a panic")
	}
	if !strings.Contains(errBuf.String(), sentinel) {
		t.Fatalf("panic value must be reported on stderr, got %q", errBuf.String())
	}
}

// TestSafeRunNormalReturnDoesNotTouchStdout guards against safeRun's refactor
// double-writing: on the non-panic path, fn owns stdout entirely and safeRun
// itself must write nothing.
func TestSafeRunNormalReturnDoesNotTouchStdout(t *testing.T) {
	var out, errBuf bytes.Buffer
	fn := func() int { return 0 }

	code := safeRun(fn, &out, &errBuf)

	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	if out.Len() != 0 {
		t.Fatalf("safeRun must not write to stdout itself on the normal path, got %q", out.String())
	}
	if errBuf.Len() != 0 {
		t.Fatalf("safeRun must not write to stderr itself on the normal path, got %q", errBuf.String())
	}
}

// TestSafeRunRecoversFromNonStringPanic confirms the fixed-message JSON
// output does not depend on the panic value being a string.
func TestSafeRunRecoversFromNonStringPanic(t *testing.T) {
	var out, errBuf bytes.Buffer
	fn := func() int { panic(errors.New("boom: nil pointer dereference")) }

	code := safeRun(fn, &out, &errBuf)

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
	if errBuf.Len() == 0 {
		t.Fatal("stderr must not be empty after a panic")
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
