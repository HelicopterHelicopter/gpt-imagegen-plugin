// Package session owns the browser profile, its lock, and the browser
// lifecycle. Everything here is about not corrupting the user's login.
package session

import (
	"errors"
	"os"
	"path/filepath"
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

type Lock struct {
	path string
	f    *os.File // Must stay open for the lock's lifetime
}

// AcquireLock serialises the send moment so two Claude sessions cannot type
// into the same composer. Uses advisory flock which is released automatically
// by the kernel if the process dies.
func AcquireLock(path string, timeout time.Duration) (*Lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		if time.Now().After(deadline) {
			return nil, ErrLocked
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
		if err != nil {
			return nil, err
		}
		err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return &Lock{path: path, f: f}, nil
		}
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			if time.Now().After(deadline) {
				return nil, ErrLocked
			}
			time.Sleep(100 * time.Millisecond)
			continue
		}
		return nil, err
	}
}

func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	fd := int(l.f.Fd())
	err := syscall.Flock(fd, syscall.LOCK_UN)
	l.f.Close()
	l.f = nil
	return err
}
