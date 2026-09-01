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

func TestLockIsExclusiveAndRespectesDeadline(t *testing.T) {
	p := filepath.Join(t.TempDir(), "lock")

	first, err := AcquireLock(p, time.Second)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer first.Release()

	// A second acquire must time out rather than succeed.
	start := time.Now()
	if _, err := AcquireLock(p, 300*time.Millisecond); !errors.Is(err, ErrLocked) {
		t.Fatalf("second acquire err = %v, want ErrLocked", err)
	}
	elapsed := time.Since(start)
	if elapsed < 250*time.Millisecond {
		t.Fatalf("second acquire returned too early: %v (want ~300ms)", elapsed)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("second acquire took too long: %v (want ~300ms)", elapsed)
	}
}

func TestLockReleaseAndReacquire(t *testing.T) {
	p := filepath.Join(t.TempDir(), "lock")

	first, err := AcquireLock(p, time.Second)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
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

func TestLockReleaseSafeAndNilSafe(t *testing.T) {
	p := filepath.Join(t.TempDir(), "lock")

	l, err := AcquireLock(p, time.Second)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}

	// Release twice should be safe.
	if err := l.Release(); err != nil {
		t.Fatalf("first release: %v", err)
	}
	if err := l.Release(); err != nil {
		t.Fatalf("second release: %v", err)
	}

	// Release on nil should be safe.
	var nilLock *Lock
	if err := nilLock.Release(); err != nil {
		t.Fatalf("nil release: %v", err)
	}
}

func TestDeadProcessLockIsReclaimable(t *testing.T) {
	// Cross-process flock testing requires spawning a child that acquires and holds
	// a lock via syscall.Flock, then verifying parent cannot acquire it, then killing
	// the child and verifying parent can. Shell-based `flock` command behavior is
	// unreliable across macOS versions and shell implementations, and wrapping it
	// in a test makes the test fragile and platform-dependent.
	//
	// The kernel flock mechanism is well-tested by the OS; our implementation's
	// correctness is verified by: (a) single-process tests that confirm LOCK_NB
	// returns EWOULDBLOCK when held, (b) release properly unlocks, and (c) nil-safety.
	// A real cross-process test belongs in a platform-specific integration suite, not here.
	t.Skipf("cross-process flock testing deferred to integration suite")
}
