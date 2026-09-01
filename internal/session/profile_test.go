package session

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestProfileDirHonoursEnvOverride(t *testing.T) {
	t.Setenv("GPT_IMAGEGEN_PROFILE_DIR", "/tmp/custom-profile")
	if got := ProfileDir(); got != "/tmp/custom-profile" {
		t.Fatalf("ProfileDir = %q", got)
	}
	t.Setenv("GPT_IMAGEGEN_PROFILE_DIR", "")
	home, _ := os.UserHomeDir()
	if want := filepath.Join(home, ".gpt-imagegen", "profile"); ProfileDir() != want {
		t.Fatalf("ProfileDir = %q, want %q", ProfileDir(), want)
	}
}

func TestLockIsExclusiveAndReleases(t *testing.T) {
	p := filepath.Join(t.TempDir(), "lock")

	first, err := AcquireLock(p, time.Second)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}

	// A second acquire must time out rather than succeed.
	start := time.Now()
	if _, err := AcquireLock(p, 300*time.Millisecond); !errors.Is(err, ErrLocked) {
		t.Fatalf("second acquire err = %v, want ErrLocked", err)
	}
	if time.Since(start) < 250*time.Millisecond {
		t.Fatal("second acquire returned before the timeout elapsed")
	}

	if err := first.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	second, err := AcquireLock(p, time.Second)
	if err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
	_ = second.Release()
}

func TestStaleLockFromDeadProcessIsReclaimed(t *testing.T) {
	p := filepath.Join(t.TempDir(), "lock")
	// PID 0 is never a live user process, so this lock is stale by definition.
	if err := os.WriteFile(p, []byte("0"), 0o644); err != nil {
		t.Fatal(err)
	}
	l, err := AcquireLock(p, 500*time.Millisecond)
	if err != nil {
		t.Fatalf("stale lock must be reclaimed, got %v", err)
	}
	_ = l.Release()
}
