package session

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
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

func TestLockReleasedWhenHolderProcessDies(t *testing.T) {
	// Helper mode: run as child holding the lock.
	if os.Getenv("GPT_IMAGEGEN_LOCK_HELPER") == "1" {
		path := os.Getenv("GPT_IMAGEGEN_LOCK_PATH")
		l, err := AcquireLock(path, 5*time.Second)
		if err != nil {
			fmt.Println("HELPER_ERR", err)
			os.Exit(1)
		}
		_ = l
		fmt.Println("HELPER_HELD")
		os.Stdout.Sync()
		time.Sleep(120 * time.Second)
		os.Exit(0)
	}

	path := filepath.Join(t.TempDir(), "lock")
	cmd := exec.Command(os.Args[0], "-test.run", "TestLockReleasedWhenHolderProcessDies")
	cmd.Env = append(os.Environ(), "GPT_IMAGEGEN_LOCK_HELPER=1", "GPT_IMAGEGEN_LOCK_PATH="+path)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() }()

	// Wait for HELPER_HELD on stdout with timeout.
	helperReady := make(chan bool, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			if line == "HELPER_HELD" {
				helperReady <- true
				return
			}
			if line == "HELPER_ERR" {
				helperReady <- false
				return
			}
		}
		helperReady <- false
	}()

	select {
	case ready := <-helperReady:
		if !ready {
			t.Fatal("helper failed to acquire lock")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper did not signal readiness")
	}

	// 1. While child holds lock, parent must get ErrLocked.
	if _, err := AcquireLock(path, 500*time.Millisecond); !errors.Is(err, ErrLocked) {
		t.Fatalf("expected ErrLocked while helper holds it, got %v", err)
	}

	// 2. Kill child WITHOUT cleanup, then parent must acquire.
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_, _ = cmd.Process.Wait()

	l, err := AcquireLock(path, 5*time.Second)
	if err != nil {
		t.Fatalf("kernel did not release the lock after holder death: %v", err)
	}
	_ = l.Release()
}
