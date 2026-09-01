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

// TestMimeSurvivesBodyEviction proves the fix for the eviction bug: when a
// generated image's body could not be read from the CDP buffer (which is
// exactly when FetchInPage's fallback is needed), the mime recorded from the
// ResponseReceived event must still be retrievable via Mime(), not silently
// replaced by the "image/png" last-resort default. It drives the Recorder's
// maps directly under the mutex, deliberately leaving files[id] unset to
// stand in for "body fetch failed" — no browser involved.
//
// Before the fix, Recorder had no urls field at all, so this test failed to
// compile (undefined: r.urls). See task-10-report.md, "Fix round 1" section,
// for the exact pre-fix output.
func TestMimeSurvivesBodyEviction(t *testing.T) {
	r := NewRecorder(nil)
	r.mu.Lock()
	r.urls["file_abc"] = "https://chatgpt.com/backend-api/estuary/content?id=file_abc"
	r.mimes["file_abc"] = "image/webp"
	// Deliberately no r.files["file_abc"]: this is the buffer-eviction case
	// where metadata is known but bytes are not.
	r.mu.Unlock()

	if got := r.Mime("file_abc"); got != "image/webp" {
		t.Fatalf("Mime(id) = %q, want %q — a recorded mime must survive a body-fetch failure, not fall back to the image/png default", got, "image/webp")
	}
}

// TestURLAccessor exercises URL() the same way TestRecorderFilesReturnsCopy
// exercises Files(): seed the map directly under the mutex, no browser.
func TestURLAccessor(t *testing.T) {
	r := NewRecorder(nil)
	r.mu.Lock()
	r.urls["file_abc"] = "https://chatgpt.com/backend-api/estuary/content?id=file_abc"
	r.mu.Unlock()

	if got := r.URL("file_abc"); got != "https://chatgpt.com/backend-api/estuary/content?id=file_abc" {
		t.Fatalf("URL(known) = %q", got)
	}
	if got := r.URL("file_unknown"); got != "" {
		t.Fatalf("URL(unknown) = %q, want empty string", got)
	}
}

// TestIDsIncludesEvictedEntries proves IDs() surfaces an id the recorder has
// seen (url+mime known) even though its body never arrived, and that the
// returned slice is a copy: mutating it must not affect a later call.
func TestIDsIncludesEvictedEntries(t *testing.T) {
	r := NewRecorder(nil)
	r.mu.Lock()
	r.urls["file_abc"] = "https://chatgpt.com/backend-api/estuary/content?id=file_abc"
	r.mimes["file_abc"] = "image/webp"
	// No bytes recorded: file_abc was seen but evicted, same as above.
	r.mu.Unlock()

	ids := r.IDs()
	if len(ids) != 1 || ids[0] != "file_abc" {
		t.Fatalf("IDs() = %v, want [file_abc]", ids)
	}

	// Mutate the returned slice; the Recorder's internal state must be
	// unaffected on a second call.
	ids[0] = "tampered"
	ids = append(ids, "injected")

	again := r.IDs()
	if len(again) != 1 || again[0] != "file_abc" {
		t.Fatalf("IDs() leaked the live slice: got %v after external mutation, want [file_abc]", again)
	}
}

// TestFilesExcludesBytelessEntries proves Files() still only reports ids
// with actual bytes: an id known only from url+mime (the eviction case)
// must not show up there, or a caller would think it had image data it
// does not.
func TestFilesExcludesBytelessEntries(t *testing.T) {
	r := NewRecorder(nil)
	r.mu.Lock()
	r.urls["file_abc"] = "https://chatgpt.com/backend-api/estuary/content?id=file_abc"
	r.mimes["file_abc"] = "image/webp"
	r.mu.Unlock()

	files := r.Files()
	if _, ok := files["file_abc"]; ok {
		t.Fatalf("Files() must not include an id with no recorded bytes, got %v", files)
	}
}

// TestRecorderConcurrentAccess drives the same lock-protected fields Start's
// event goroutine would — files, mimes, and urls together — concurrently
// with reads through Files/Mime/URL/IDs, so `go test -race` can catch a
// missing lock anywhere across all four. It also asserts every concurrent
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
			url := fmt.Sprintf("https://chatgpt.com/backend-api/estuary/content?id=%s", id)
			r.mu.Lock()
			r.urls[id] = url
			r.mimes[id] = "image/png"
			r.files[id] = []byte{byte(i)}
			r.mu.Unlock()
		}(i)
	}
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = r.Files()
			_ = r.Mime("file_0")
			_ = r.URL("file_0")
			_ = r.IDs()
		}()
	}
	wg.Wait()

	files := r.Files()
	if len(files) != n {
		t.Fatalf("got %d files after concurrent writes, want %d", len(files), n)
	}
	ids := r.IDs()
	if len(ids) != n {
		t.Fatalf("got %d ids after concurrent writes, want %d", len(ids), n)
	}
}
