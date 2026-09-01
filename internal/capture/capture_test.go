package capture

import (
	"encoding/base64"
	"errors"
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
// This is a pure accessor-contract test (map-copy semantics); it does not
// exercise the recording logic in Start/recordFinished, which is covered
// separately below.
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

// TestURLAccessor exercises URL()'s own contract (map lookup, "" for an
// unknown id) directly, the same way TestRecorderFilesReturnsCopy exercises
// Files(). URL() has no branching logic beyond that lookup, so poking the
// map directly is a faithful test of its contract; it is not a substitute
// for testing recordFinished's recording behavior (see below).
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

// TestRecorderConcurrentAccess drives the accessor-owned fields concurrently
// with reads through Files/Mime/URL/IDs, so `go test -race` can catch a
// missing lock in the accessors themselves. The recording PATH (Start's
// NetworkLoadingFinished handler, via recordFinished) has its own
// concurrency test below, since that is the code that actually decides what
// gets written.
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

// --- recordFinished: the actual NetworkLoadingFinished handler logic ---
//
// The tests above poke Recorder's maps directly, which only proves the
// accessors behave correctly once state exists — it says nothing about
// whether the recording logic in Start's NetworkLoadingFinished handler
// puts the right state there in the first place. recordFinished is the
// seam Start delegates to (wiring fetchBody to a real CDP call); these
// tests drive it directly with a stub fetchBody, exercising the exact
// logic that had the eviction bug, without a browser.

// TestRecordFinishedOnFetchFailureKeepsMetadata is the regression test for
// the eviction bug fixed in round 1: url+mime must be recorded even when
// fetchBody fails, so Mime/URL/IDs still report the id, while Files() must
// NOT contain it (no bytes were ever obtained).
//
// Mutation check: temporarily deleting the "r.mimes[id] = ent.mime" line
// from recordFinished (so the mime is never recorded on the failure path)
// makes this test fail with "Mime(id) = "image/png", want "image/webp"".
// See task-10-report.md, "Fix round 2", for the exact command and output.
func TestRecordFinishedOnFetchFailureKeepsMetadata(t *testing.T) {
	r := NewRecorder(nil)
	ent := entry{
		url:  "https://chatgpt.com/backend-api/estuary/content?id=file_abc",
		mime: "image/webp",
	}
	r.recordFinished(ent, func() (string, bool, error) {
		return "", false, errors.New("buffer evicted")
	})

	if got := r.Mime("file_abc"); got != "image/webp" {
		t.Fatalf("Mime(id) = %q, want %q", got, "image/webp")
	}
	if got := r.URL("file_abc"); got != ent.url {
		t.Fatalf("URL(id) = %q, want %q", got, ent.url)
	}
	ids := r.IDs()
	if len(ids) != 1 || ids[0] != "file_abc" {
		t.Fatalf("IDs() = %v, want [file_abc]", ids)
	}
	if files := r.Files(); len(files) != 0 {
		t.Fatalf("Files() = %v, want empty — the fetch failed, no bytes should be stored", files)
	}
}

// TestRecordFinishedOnFetchSuccessStoresBytes is the success-path
// counterpart: metadata AND bytes both land, through the same seam.
func TestRecordFinishedOnFetchSuccessStoresBytes(t *testing.T) {
	r := NewRecorder(nil)
	ent := entry{
		url:  "https://chatgpt.com/backend-api/estuary/content?id=file_ok",
		mime: "image/png",
	}
	r.recordFinished(ent, func() (string, bool, error) {
		return onePxPNG, true, nil
	})

	want, _ := base64.StdEncoding.DecodeString(onePxPNG)
	files := r.Files()
	if string(files["file_ok"]) != string(want) {
		t.Fatalf("Files()[id] = %v, want decoded PNG bytes", files["file_ok"])
	}
	if got := r.Mime("file_ok"); got != "image/png" {
		t.Fatalf("Mime(id) = %q, want %q", got, "image/png")
	}
	if got := r.URL("file_ok"); got != ent.url {
		t.Fatalf("URL(id) = %q, want %q", got, ent.url)
	}
}

// TestRecordFinishedOnDecodeFailureKeepsMetadataButNotBytes covers a fetch
// that succeeds at the transport level but returns unparseable base64: the
// url+mime must still be recorded, and no corrupt bytes should land in
// Files().
func TestRecordFinishedOnDecodeFailureKeepsMetadataButNotBytes(t *testing.T) {
	r := NewRecorder(nil)
	ent := entry{
		url:  "https://chatgpt.com/backend-api/estuary/content?id=file_bad",
		mime: "image/jpeg",
	}
	r.recordFinished(ent, func() (string, bool, error) {
		return "!!!not base64!!!", true, nil
	})

	if files := r.Files(); len(files) != 0 {
		t.Fatalf("Files() = %v, want empty after a decode failure", files)
	}
	if got := r.Mime("file_bad"); got != "image/jpeg" {
		t.Fatalf("Mime(id) = %q, want %q", got, "image/jpeg")
	}
	if got := r.URL("file_bad"); got != ent.url {
		t.Fatalf("URL(id) = %q, want %q", got, ent.url)
	}
}

// TestRecordFinishedIgnoresNonGeneratedURL proves an entry whose URL is not
// a generated-image URL (FileIDFromURL returns "") records nothing at all —
// no metadata, no attempted body fetch — and does not panic.
func TestRecordFinishedIgnoresNonGeneratedURL(t *testing.T) {
	r := NewRecorder(nil)
	ent := entry{
		url:  "https://chatgpt.com/cdn/assets/sprite-shell.svg",
		mime: "image/svg+xml",
	}
	fetchCalled := false
	r.recordFinished(ent, func() (string, bool, error) {
		fetchCalled = true
		return "", false, nil
	})

	if fetchCalled {
		t.Fatal("recordFinished must not attempt a body fetch for a non-generated-image URL")
	}
	if ids := r.IDs(); len(ids) != 0 {
		t.Fatalf("IDs() = %v, want empty", ids)
	}
	if files := r.Files(); len(files) != 0 {
		t.Fatalf("Files() = %v, want empty", files)
	}
}

// TestRecordFinishedConcurrent drives recordFinished itself from many
// goroutines, so `go test -race` exercises the real recording path — not
// just the accessors — for races.
func TestRecordFinishedConcurrent(t *testing.T) {
	r := NewRecorder(nil)
	const n = 50
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := fmt.Sprintf("file_%d", i)
			ent := entry{
				url:  fmt.Sprintf("https://chatgpt.com/backend-api/estuary/content?id=%s", id),
				mime: "image/png",
			}
			r.recordFinished(ent, func() (string, bool, error) {
				return string([]byte{byte(i)}), false, nil
			})
		}(i)
	}
	wg.Wait()

	files := r.Files()
	if len(files) != n {
		t.Fatalf("got %d files after concurrent recordFinished calls, want %d", len(files), n)
	}
	ids := r.IDs()
	if len(ids) != n {
		t.Fatalf("got %d ids after concurrent recordFinished calls, want %d", len(ids), n)
	}
}
