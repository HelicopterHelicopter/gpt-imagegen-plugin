package capture

import (
	"encoding/base64"
	"fmt"
	"sync"
	"testing"
)

// A 1x1 PNG, used to prove the decode and dimension paths without a browser.
const onePxPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

func TestExtFor(t *testing.T) {
	cases := map[string]string{
		"image/png":  ".png",
		"image/webp": ".webp",
		"image/jpeg": ".jpg",
		"image/gif":  ".png", // unknown types fall back to png
	}
	for mime, want := range cases {
		if got := ExtFor(mime); got != want {
			t.Fatalf("ExtFor(%q) = %q, want %q", mime, got, want)
		}
	}
}

func TestDecodeBase64AndRaw(t *testing.T) {
	got, err := Decode(onePxPNG, true)
	if err != nil {
		t.Fatalf("decode base64: %v", err)
	}
	want, _ := base64.StdEncoding.DecodeString(onePxPNG)
	if string(got) != string(want) {
		t.Fatal("base64 decode mismatch")
	}
	raw, err := Decode("plain", false)
	if err != nil {
		t.Fatalf("decode raw: %v", err)
	}
	if string(raw) != "plain" {
		t.Fatalf("raw decode = %q", raw)
	}
	if _, err := Decode("!!!not base64!!!", true); err == nil {
		t.Fatal("invalid base64 must error rather than write a corrupt file")
	}
}

func TestDimensions(t *testing.T) {
	png, _ := base64.StdEncoding.DecodeString(onePxPNG)
	w, h, err := Dimensions(png)
	if err != nil {
		t.Fatalf("dimensions: %v", err)
	}
	if w != 1 || h != 1 {
		t.Fatalf("got %dx%d, want 1x1", w, h)
	}
	if _, _, err := Dimensions([]byte("not an image")); err == nil {
		t.Fatal("non-image must error")
	}
}

// TestRecorderFilesReturnsCopy exercises the mutex-protected accessors
// directly on a constructed Recorder (no browser, no Start). It proves
// Files() hands back a copy: mutating the returned map, or reading it again
// later, must never observe changes made through the returned map itself.
func TestRecorderFilesReturnsCopy(t *testing.T) {
	r := NewRecorder(nil)
	r.mu.Lock()
	r.files["file_abc"] = []byte("original")
	r.mimes["file_abc"] = "image/webp"
	r.mu.Unlock()

	got := r.Files()
	if string(got["file_abc"]) != "original" {
		t.Fatalf("Files()[id] = %q, want %q", got["file_abc"], "original")
	}

	// Mutate the returned map. If Files() leaked the live map, this would
	// corrupt the Recorder's internal state.
	got["file_abc"] = []byte("mutated")
	delete(got, "file_abc")
	got["file_xyz"] = []byte("injected")

	again := r.Files()
	if string(again["file_abc"]) != "original" {
		t.Fatalf("Files() leaked the live map: got %q after external mutation, want %q", again["file_abc"], "original")
	}
	if _, ok := again["file_xyz"]; ok {
		t.Fatal("Files() leaked the live map: injected key visible on a second call")
	}

	if mime := r.Mime("file_abc"); mime != "image/webp" {
		t.Fatalf("Mime(known) = %q, want %q", mime, "image/webp")
	}
	if mime := r.Mime("file_unknown"); mime != "image/png" {
		t.Fatalf("Mime(unknown) = %q, want default %q", mime, "image/png")
	}
}

// TestRecorderConcurrentAccess drives the same lock-protected fields Start's
// event goroutine would, concurrently with reads through Files/Mime, so
// `go test -race` can catch a missing lock. It also asserts every concurrent
// write was observed, which would fail if the mutex ever dropped an update.
func TestRecorderConcurrentAccess(t *testing.T) {
	r := NewRecorder(nil)
	const n = 50
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := fmt.Sprintf("file_%d", i)
			r.mu.Lock()
			r.files[id] = []byte{byte(i)}
			r.mimes[id] = "image/png"
			r.mu.Unlock()
		}(i)
	}
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = r.Files()
			_ = r.Mime("file_0")
		}()
	}
	wg.Wait()

	files := r.Files()
	if len(files) != n {
		t.Fatalf("got %d files after concurrent writes, want %d", len(files), n)
	}
}
