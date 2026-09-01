package session

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ParseDevToolsActivePort reads the two-line file Chrome writes into its
// user-data-dir: port on line 1, browser websocket path on line 2.
func ParseDevToolsActivePort(raw []byte) (string, string, error) {
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) < 2 {
		return "", "", errors.New("DevToolsActivePort: want 2 lines")
	}
	port := strings.TrimSpace(lines[0])
	path := strings.TrimSpace(lines[1])
	if port == "" || !strings.HasPrefix(path, "/") {
		return "", "", errors.New("DevToolsActivePort: malformed")
	}
	return port, path, nil
}

// EndpointFromProfile returns a websocket URL for a Chrome already running on
// this profile, verifying liveness first so a stale file is not trusted.
func EndpointFromProfile(dir string) (string, bool) {
	raw, err := os.ReadFile(filepath.Join(dir, "DevToolsActivePort"))
	if err != nil {
		return "", false
	}
	port, path, err := ParseDevToolsActivePort(raw)
	if err != nil {
		return "", false
	}
	cl := &http.Client{Timeout: 2 * time.Second}
	resp, err := cl.Get("http://127.0.0.1:" + port + "/json/version")
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", false
	}
	return fmt.Sprintf("ws://127.0.0.1:%s%s", port, path), true
}
