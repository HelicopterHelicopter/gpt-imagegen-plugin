package session

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseDevToolsActivePort(t *testing.T) {
	// Exact two-line format Chrome writes, as observed by the spike.
	raw := []byte("62909\n/devtools/browser/e95edb1f-89fb-4db0-b419-2d919a02d5c3\n")
	port, path, err := ParseDevToolsActivePort(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if port != "62909" {
		t.Fatalf("port = %q", port)
	}
	if path != "/devtools/browser/e95edb1f-89fb-4db0-b419-2d919a02d5c3" {
		t.Fatalf("path = %q", path)
	}
	if _, _, err := ParseDevToolsActivePort([]byte("62909")); err == nil {
		t.Fatal("single-line file must be an error")
	}
	if _, _, err := ParseDevToolsActivePort(nil); err == nil {
		t.Fatal("empty file must be an error")
	}
}

func TestEndpointFromProfileVerifiesLiveness(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/json/version" {
			w.WriteHeader(404)
			return
		}
		w.Write([]byte(`{"Browser":"Chrome/152.0.7977.65"}`))
	}))
	defer srv.Close()
	port := srv.Listener.Addr().(interface{ String() string }).String()
	port = port[strings.LastIndex(port, ":")+1:]

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "DevToolsActivePort"), []byte(port+"\n/devtools/browser/abc\n"), 0o644)

	ws, ok := EndpointFromProfile(dir)
	if !ok {
		t.Fatal("live endpoint must be discovered")
	}
	if want := "ws://127.0.0.1:" + port + "/devtools/browser/abc"; ws != want {
		t.Fatalf("ws = %q, want %q", ws, want)
	}
}

func TestEndpointFromProfileRejectsDeadPort(t *testing.T) {
	dir := t.TempDir()
	// Port 1 is not listening; a stale file must not produce an endpoint.
	os.WriteFile(filepath.Join(dir, "DevToolsActivePort"), []byte("1\n/devtools/browser/abc\n"), 0o644)
	if _, ok := EndpointFromProfile(dir); ok {
		t.Fatal("stale DevToolsActivePort must not be treated as live")
	}
}

func TestEndpointFromProfileMissingFile(t *testing.T) {
	if _, ok := EndpointFromProfile(t.TempDir()); ok {
		t.Fatal("missing file must not yield an endpoint")
	}
}
