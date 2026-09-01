// Package session owns the browser profile, its lock, and the browser
// lifecycle. Everything here is about not corrupting the user's login.
package session

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var ErrLocked = errors.New("another gpt-imagegen run holds the browser lock")

func ProfileDir() string {
	if v := os.Getenv("GPT_IMAGEGEN_PROFILE_DIR"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".gpt-imagegen/profile"
	}
	return filepath.Join(home, ".gpt-imagegen", "profile")
}

func LockPath() string {
	return filepath.Join(filepath.Dir(ProfileDir()), "lock")
}

type Lock struct{ path string }

// AcquireLock serialises the send moment so two Claude sessions cannot type
// into the same composer. A lock whose owning PID is gone is reclaimed.
func AcquireLock(path string, timeout time.Duration) (*Lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			fmt.Fprintf(f, "%d", os.Getpid())
			f.Close()
			return &Lock{path: path}, nil
		}
		if !os.IsExist(err) {
			return nil, err
		}
		if stale(path) {
			_ = os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, ErrLocked
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func stale(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return true
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return true
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return true
	}
	// On Unix, signal 0 tests for existence without delivering a signal.
	return p.Signal(syscall.Signal(0)) != nil
}

func (l *Lock) Release() error {
	if l == nil || l.path == "" {
		return nil
	}
	return os.Remove(l.path)
}
