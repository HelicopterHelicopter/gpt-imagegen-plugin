# gpt-imagegen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that generates, edits and sets images by driving a signed-in ChatGPT session in real Chrome, saving results into the project and invoking itself whenever a task needs an image.

**Architecture:** A single Go binary is the whole engine; the plugin's skill and slash commands only shell out to it and parse a JSON envelope from stdout. Inside the binary, DOM-dependent code (`compose`) is isolated from DOM-free code (`capture`) so they fail independently, and every selector lives in a data file rather than in code so a repair needs no rebuild.

**Tech Stack:** Go 1.27, go-rod v0.116.2 (Chrome DevTools Protocol), real Google Chrome, Go standard `testing`.

**Spec:** `docs/superpowers/specs/2026-09-01-gpt-imagegen-design.md`

## Global Constraints

- Go 1.27; module path `github.com/jheelr/gpt-imagegen`.
- go-rod pinned at `v0.116.2`.
- **Never call `launcher.Cleanup()`.** It runs `os.RemoveAll(UserDataDir)` and will destroy the user's persistent login.
- **Never log values from `/api/auth/session`.** It contains `accessToken` and `sessionToken`. Log sorted key names only.
- Chrome launch flags are load-bearing for avoiding bot detection: `--disable-blink-features=AutomationControlled`, `--no-first-run`, `--no-default-browser-check`, and `enable-automation` deleted. **Never headless.**
- Only shut down a browser this process launched; never one it attached to.
- **No automatic retry of a generation.** `RATE_LIMITED` and `CHALLENGE` stop immediately.
- Self-heal is capped at exactly one attempt per invocation.
- stdout carries exactly one line of JSON. All human-readable progress goes to stderr.
- Generated image URL path allowlist: `/backend-api/estuary/content`.
- Generated images are identified in the DOM by `img[alt^="Generated image: "]`.
- Profile dir: `~/.gpt-imagegen/profile`, overridable via `GPT_IMAGEGEN_PROFILE_DIR`.

---

### Task 1: Module scaffolding and the result envelope

**Files:**
- Create: `go.mod`
- Create: `internal/envelope/envelope.go`
- Test: `internal/envelope/envelope_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `envelope.Code` constants; `envelope.Image{Path string, Bytes int, Width int, Height int, Title string}`; `envelope.Err`; `envelope.Result`; `envelope.Success(images []Image, convURL string, archived bool, elapsed float64) Result`; `envelope.Failure(code Code, msg string) Result`; `(Result).WithConversation(url string) Result`; `(Result).Write(w io.Writer) error`; `(Result).ExitCode() int`.

- [ ] **Step 1: Initialise the module and git repo**

```bash
cd /Users/jheelr/personal/gpt-imagegen-plugin
git init
go mod init github.com/jheelr/gpt-imagegen
go get github.com/go-rod/rod@v0.116.2
printf 'out/\n*.png\ngpt-imagegen\ndist/\n' > .gitignore
```

- [ ] **Step 2: Write the failing test**

Create `internal/envelope/envelope_test.go`:

```go
package envelope

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestSuccessWritesSingleJSONLine(t *testing.T) {
	r := Success([]Image{{Path: "/abs/hero.png", Bytes: 184203, Width: 1536, Height: 1024, Title: "Teal Mountain"}},
		"https://chatgpt.com/c/abc", true, 41.2)
	var buf bytes.Buffer
	if err := r.Write(&buf); err != nil {
		t.Fatalf("write: %v", err)
	}
	out := buf.String()
	if strings.Count(out, "\n") != 1 || !strings.HasSuffix(out, "\n") {
		t.Fatalf("want exactly one trailing newline, got %q", out)
	}
	var back Result
	if err := json.Unmarshal([]byte(out), &back); err != nil {
		t.Fatalf("not valid json: %v", err)
	}
	if !back.OK || len(back.Images) != 1 || back.Images[0].Bytes != 184203 {
		t.Fatalf("round trip lost data: %+v", back)
	}
	if back.Error != nil {
		t.Fatalf("success must omit error, got %+v", back.Error)
	}
	if r.ExitCode() != 0 {
		t.Fatalf("success exit code = %d, want 0", r.ExitCode())
	}
}

func TestFailureOmitsImagesAndCarriesCode(t *testing.T) {
	r := Failure(CodeRateLimited, "hit the cap").WithConversation("https://chatgpt.com/c/xyz")
	var buf bytes.Buffer
	if err := r.Write(&buf); err != nil {
		t.Fatalf("write: %v", err)
	}
	if strings.Contains(buf.String(), `"images"`) {
		t.Fatalf("failure must omit images, got %s", buf.String())
	}
	var back Result
	if err := json.Unmarshal(buf.Bytes(), &back); err != nil {
		t.Fatalf("not valid json: %v", err)
	}
	if back.OK {
		t.Fatal("failure must have ok=false")
	}
	if back.Error.Code != CodeRateLimited {
		t.Fatalf("code = %q, want %q", back.Error.Code, CodeRateLimited)
	}
	if back.Error.ConversationURL != "https://chatgpt.com/c/xyz" {
		t.Fatalf("conversation url not carried on failure: %+v", back.Error)
	}
	if r.ExitCode() != 1 {
		t.Fatalf("failure exit code = %d, want 1", r.ExitCode())
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/envelope/ -run TestSuccess -v`
Expected: FAIL — build error, `undefined: Success`.

- [ ] **Step 4: Write minimal implementation**

Create `internal/envelope/envelope.go`:

```go
// Package envelope defines the single JSON object the CLI writes to stdout.
// The skill branches on Error.Code, never on prose, so codes are a stable API.
package envelope

import (
	"encoding/json"
	"io"
)

type Code string

const (
	CodeNotLoggedIn   Code = "NOT_LOGGED_IN"
	CodeSelectorMiss  Code = "SELECTOR_MISS"
	CodeTimeout       Code = "TIMEOUT"
	CodeChallenge     Code = "CHALLENGE"
	CodeRateLimited   Code = "RATE_LIMITED"
	CodeProfileLocked Code = "PROFILE_LOCKED"
	CodeNoImage       Code = "NO_IMAGE_RETURNED"
	CodeChromeMissing Code = "CHROME_MISSING"
	CodeRefused       Code = "REFUSED"
)

type Image struct {
	Path   string `json:"path"`
	Bytes  int    `json:"bytes"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Title  string `json:"title,omitempty"`
}

type Err struct {
	Code            Code   `json:"code"`
	Stage           string `json:"stage,omitempty"`
	SelectorKey     string `json:"selector_key,omitempty"`
	Probe           string `json:"probe,omitempty"`
	Screenshot      string `json:"screenshot,omitempty"`
	ConversationURL string `json:"conversation_url,omitempty"`
	Message         string `json:"message,omitempty"`
}

type Result struct {
	OK              bool    `json:"ok"`
	Images          []Image `json:"images,omitempty"`
	ConversationURL string  `json:"conversation_url,omitempty"`
	Archived        bool    `json:"archived,omitempty"`
	ElapsedS        float64 `json:"elapsed_s,omitempty"`
	Error           *Err    `json:"error,omitempty"`
}

func Success(images []Image, convURL string, archived bool, elapsed float64) Result {
	return Result{OK: true, Images: images, ConversationURL: convURL, Archived: archived, ElapsedS: elapsed}
}

func Failure(code Code, msg string) Result {
	return Result{OK: false, Error: &Err{Code: code, Message: msg}}
}

// WithConversation attaches the conversation URL, which on failure is the
// recovery path a caller can revisit.
func (r Result) WithConversation(url string) Result {
	if r.Error != nil {
		r.Error.ConversationURL = url
	} else {
		r.ConversationURL = url
	}
	return r
}

func (r Result) Write(w io.Writer) error {
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	_, err = w.Write(b)
	return err
}

func (r Result) ExitCode() int {
	if r.OK {
		return 0
	}
	return 1
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/envelope/ -v`
Expected: PASS, both tests.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum .gitignore internal/envelope/
git commit -m "feat: result envelope with stable error codes"
```

---

### Task 2: Generated-image URL allowlist

The spike proved that filtering `image/*` by size captures sprites, favicons and avatars instead of the generated image. This task encodes the path allowlist that fixes it, tested against the exact URLs the spike captured.

**Files:**
- Create: `internal/capture/filter.go`
- Test: `internal/capture/filter_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `capture.IsGeneratedImageURL(u string) bool`; `capture.FileIDFromURL(u string) string`.

- [ ] **Step 1: Write the failing test**

Create `internal/capture/filter_test.go`:

```go
package capture

import "testing"

// Real URL captured by the spike from a finished generation.
const genURL = "https://chatgpt.com/backend-api/estuary/content?id=file_00000000e7148208927dc5bbece7a546&ts=496736&p=fs&cid=1&sig=88d3f46f4ff9b2c50cfcde0c8e819b36e6bd286c16c28191fd12097ea8afdeab&v=0"

func TestIsGeneratedImageURL(t *testing.T) {
	cases := []struct {
		name string
		url  string
		want bool
	}{
		{"generated image", genURL, true},
		{"sprite sheet", "https://chatgpt.com/cdn/assets/sprites-shell-097001e7.svg", false},
		{"sprites core", "https://chatgpt.com/cdn/assets/sprites-core-9b910f5e.svg", false},
		{"watercolor bg", "https://chatgpt.com/cdn/assets/watercolor-cxf1rp88.webp", false},
		{"favicon", "https://chatgpt.com/cdn/assets/favicon-l4nq08hd.svg", false},
		{"google avatar", "https://lh3.googleusercontent.com/a/ACg8ocLLmCTS11F6i2Dfz40Uj5DGahctKK4ds69P8cDsFAyhLSJ2=s96-c", false},
		{"auth0 avatar", "https://cdn.auth0.com/avatars/jr.png", false},
		{"ecosystem icon", "https://chatgpt.com/images/ecosystem/apps/slack/icon.png", false},
		{"empty", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsGeneratedImageURL(c.url); got != c.want {
				t.Fatalf("IsGeneratedImageURL(%q) = %v, want %v", c.url, got, c.want)
			}
		});
	}
}

func TestFileIDFromURL(t *testing.T) {
	if got := FileIDFromURL(genURL); got != "file_00000000e7148208927dc5bbece7a546" {
		t.Fatalf("FileIDFromURL = %q", got)
	}
	if got := FileIDFromURL("https://chatgpt.com/cdn/assets/x.svg"); got != "" {
		t.Fatalf("want empty for non-generated url, got %q", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/capture/ -v`
Expected: FAIL — `undefined: IsGeneratedImageURL`.

- [ ] **Step 3: Write minimal implementation**

Create `internal/capture/filter.go`:

```go
// Package capture pulls generated image bytes out of a ChatGPT conversation.
// It is deliberately DOM-free so it survives UI redesigns that break compose.
package capture

import (
	"net/url"
	"strings"
)

// generatedPath is the same-origin, cookie-authenticated endpoint ChatGPT
// serves generated images from. Verified by spike, 2026-09-01.
const generatedPath = "/backend-api/estuary/content"

// IsGeneratedImageURL reports whether a URL is a generated image rather than
// ChatGPT's own UI furniture. Matching on path, not size: the spike showed a
// size heuristic captures sprite sheets and avatars.
func IsGeneratedImageURL(u string) bool {
	if u == "" {
		return false
	}
	parsed, err := url.Parse(u)
	if err != nil {
		return false
	}
	return parsed.Path == generatedPath && parsed.Query().Get("id") != ""
}

// FileIDFromURL returns the file_... id, used to tell distinct images apart
// when generating a set. Returns "" if the URL is not a generated image.
func FileIDFromURL(u string) string {
	if !IsGeneratedImageURL(u) {
		return ""
	}
	parsed, err := url.Parse(u)
	if err != nil {
		return ""
	}
	id := parsed.Query().Get("id")
	if !strings.HasPrefix(id, "file_") {
		return ""
	}
	return id
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/capture/ -v`
Expected: PASS, all subtests.

- [ ] **Step 5: Commit**

```bash
git add internal/capture/
git commit -m "feat: allowlist generated image URLs by path"
```

---

### Task 3: Output filename derivation

**Files:**
- Create: `internal/capture/naming.go`
- Test: `internal/capture/naming_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `capture.TitleFromAlt(alt string) string`; `capture.Slugify(s string) string`; `capture.OutputPath(out string, index int, title string, ext string) string`.

`OutputPath` rules: if `out` ends in a path separator or names an existing directory, the filename is `<slug(title)><ext>` (falling back to `image<ext>` when title is empty). Otherwise index 0 uses `out` verbatim and index N>0 inserts `-<N+1>` before the extension.

- [ ] **Step 1: Write the failing test**

Create `internal/capture/naming_test.go`:

```go
package capture

import (
	"path/filepath"
	"testing"
)

func TestTitleFromAlt(t *testing.T) {
	// Real alt text captured by the spike.
	if got := TitleFromAlt("Generated image: Geometric Teal Mountain Emblem"); got != "Geometric Teal Mountain Emblem" {
		t.Fatalf("got %q", got)
	}
	if got := TitleFromAlt(""); got != "" {
		t.Fatalf("got %q", got)
	}
	if got := TitleFromAlt("some other alt"); got != "" {
		t.Fatalf("non-generated alt must yield empty, got %q", got)
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Geometric Teal Mountain Emblem": "geometric-teal-mountain-emblem",
		"  Spaced   Out  ":               "spaced-out",
		"Punctuation!! & Symbols":        "punctuation-symbols",
		"":                               "",
	}
	for in, want := range cases {
		if got := Slugify(in); got != want {
			t.Fatalf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestOutputPathNumbersSiblings(t *testing.T) {
	if got := OutputPath("/a/hero.png", 0, "T", ".png"); got != "/a/hero.png" {
		t.Fatalf("index 0 must be verbatim, got %q", got)
	}
	if got := OutputPath("/a/hero.png", 1, "T", ".png"); got != "/a/hero-2.png" {
		t.Fatalf("index 1 = %q, want /a/hero-2.png", got)
	}
	if got := OutputPath("/a/hero.png", 2, "T", ".png"); got != "/a/hero-3.png" {
		t.Fatalf("index 2 = %q, want /a/hero-3.png", got)
	}
}

func TestOutputPathIntoDirectory(t *testing.T) {
	dir := t.TempDir()
	got := OutputPath(dir, 0, "Geometric Teal Mountain Emblem", ".png")
	want := filepath.Join(dir, "geometric-teal-mountain-emblem.png")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	got = OutputPath(dir, 0, "", ".png")
	if want := filepath.Join(dir, "image.png"); got != want {
		t.Fatalf("empty title fallback = %q, want %q", got, want)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/capture/ -run TestTitle -v`
Expected: FAIL — `undefined: TitleFromAlt`.

- [ ] **Step 3: Write minimal implementation**

Create `internal/capture/naming.go`:

```go
package capture

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

// altPrefix is how ChatGPT labels generated images. Verified by spike.
const altPrefix = "Generated image: "

// TitleFromAlt extracts the model's own title, which makes a good filename.
func TitleFromAlt(alt string) string {
	if !strings.HasPrefix(alt, altPrefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(alt, altPrefix))
}

func Slugify(s string) string {
	var b strings.Builder
	lastDash := true // leading dashes suppressed
	for _, r := range strings.ToLower(s) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				b.WriteRune('-')
				lastDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

// OutputPath resolves where image number index should be written.
func OutputPath(out string, index int, title string, ext string) string {
	if isDir(out) {
		name := Slugify(title)
		if name == "" {
			name = "image"
		}
		if index > 0 {
			name = fmt.Sprintf("%s-%d", name, index+1)
		}
		return filepath.Join(out, name+ext)
	}
	if index == 0 {
		return out
	}
	e := filepath.Ext(out)
	stem := strings.TrimSuffix(out, e)
	return fmt.Sprintf("%s-%d%s", stem, index+1, e)
}

func isDir(p string) bool {
	if strings.HasSuffix(p, string(os.PathSeparator)) {
		return true
	}
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/capture/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/capture/
git commit -m "feat: derive output filenames from generated image titles"
```

---

### Task 4: Selector configuration with user override

**Files:**
- Create: `internal/selectors/selectors.json`
- Create: `internal/selectors/selectors.go`
- Test: `internal/selectors/selectors_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `selectors.Candidate{TestID, CSS, Text string}`; `selectors.Set map[string][]Candidate`; `selectors.Load(userPath string) (Set, error)`; `(Set).Query(key string) []string`; `(Set).Patch(key string, c Candidate)`; `(Set).Save(path string) error`; `selectors.UserPath() string`.

`Query` converts each candidate to a CSS selector string in order, skipping text-only candidates (those are resolved separately by the caller).

- [ ] **Step 1: Write the failing test**

Create `internal/selectors/selectors_test.go`:

```go
package selectors

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadEmbeddedHasKnownKeys(t *testing.T) {
	s, err := Load("")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	for _, k := range []string{"composer_input", "loading_state", "stop_button", "upload_input", "new_chat_button", "generated_image", "conversation_options"} {
		if len(s[k]) == 0 {
			t.Fatalf("embedded set missing key %q", k)
		}
	}
}

func TestQueryOrderPrefersTestID(t *testing.T) {
	s := Set{"k": {{TestID: "the-testid"}, {CSS: "#fallback"}}}
	got := s.Query("k")
	want := []string{`[data-testid="the-testid"]`, "#fallback"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("Query = %v, want %v", got, want)
	}
}

func TestUserOverrideWinsAndRoundTrips(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "selectors.json")
	if err := os.WriteFile(p, []byte(`{"composer_input":[{"css":"#patched"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Load(p)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := s.Query("composer_input"); len(got) == 0 || got[0] != "#patched" {
		t.Fatalf("user override ignored: %v", got)
	}
	// Keys absent from the override still come from the embedded defaults.
	if len(s["stop_button"]) == 0 {
		t.Fatal("override must merge over defaults, not replace the whole set")
	}
	// A patch persists and reloads.
	s.Patch("stop_button", Candidate{CSS: "#stopped"})
	if err := s.Save(p); err != nil {
		t.Fatalf("save: %v", err)
	}
	again, err := Load(p)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := again.Query("stop_button"); got[0] != "#stopped" {
		t.Fatalf("patch did not persist to the front: %v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/selectors/ -v`
Expected: FAIL — `undefined: Load`.

- [ ] **Step 3: Create the selector data file**

Create `internal/selectors/selectors.json`. Every value here was observed live by the spike on 2026-09-01:

```json
{
  "composer_input": [
    { "css": "#prompt-textarea" },
    { "testid": "prompt-textarea" },
    { "css": "div[contenteditable='true']" }
  ],
  "loading_state": [
    { "testid": "image-gen-loading-state" },
    { "testid": "image-gen-loading-state-frame" }
  ],
  "stop_button": [
    { "testid": "stop-button" }
  ],
  "upload_input": [
    { "testid": "upload-photos-input" },
    { "css": "input[type='file']" }
  ],
  "composer_plus": [
    { "testid": "composer-plus-btn" }
  ],
  "new_chat_button": [
    { "testid": "create-new-chat-button" }
  ],
  "generated_image": [
    { "css": "img[alt^='Generated image: ']" }
  ],
  "conversation_options": [
    { "testid": "conversation-options-button" }
  ]
}
```

- [ ] **Step 4: Write minimal implementation**

Create `internal/selectors/selectors.go`:

```go
// Package selectors keeps ChatGPT DOM selectors as data rather than code, so a
// repair after a UI change needs no rebuild. A user-level file overrides the
// embedded defaults per key, which is where self-heal writes.
package selectors

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

//go:embed selectors.json
var embedded []byte

type Candidate struct {
	TestID string `json:"testid,omitempty"`
	CSS    string `json:"css,omitempty"`
	Text   string `json:"text,omitempty"`
}

type Set map[string][]Candidate

// UserPath is where self-heal writes. Kept separate from the embedded copy so
// a plugin upgrade never clobbers a local repair, and deleting it restores
// shipped defaults.
func UserPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".gpt-imagegen", "selectors.json")
}

// Load merges a user override over the embedded defaults, per key. An empty
// userPath, or a missing file, yields the defaults alone.
func Load(userPath string) (Set, error) {
	base := Set{}
	if err := json.Unmarshal(embedded, &base); err != nil {
		return nil, fmt.Errorf("embedded selectors invalid: %w", err)
	}
	if userPath == "" {
		return base, nil
	}
	raw, err := os.ReadFile(userPath)
	if os.IsNotExist(err) {
		return base, nil
	}
	if err != nil {
		return nil, err
	}
	over := Set{}
	if err := json.Unmarshal(raw, &over); err != nil {
		return nil, fmt.Errorf("user selectors invalid: %w", err)
	}
	for k, v := range over {
		base[k] = v
	}
	return base, nil
}

// Query returns CSS selector strings in priority order. Text-only candidates
// are skipped; the caller resolves those separately.
func (s Set) Query(key string) []string {
	var out []string
	for _, c := range s[key] {
		switch {
		case c.TestID != "":
			out = append(out, fmt.Sprintf("[data-testid=%q]", c.TestID))
		case c.CSS != "":
			out = append(out, c.CSS)
		}
	}
	return out
}

// Patch puts a candidate at the front of a key's list.
func (s Set) Patch(key string, c Candidate) {
	s[key] = append([]Candidate{c}, s[key]...)
}

func (s Set) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o600)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/selectors/ -v`
Expected: PASS, all three tests.

- [ ] **Step 6: Commit**

```bash
git add internal/selectors/
git commit -m "feat: selector config as data with user override"
```

---

### Task 5: Profile directory and cross-process lock

**Files:**
- Create: `internal/session/profile.go`
- Test: `internal/session/profile_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `session.ProfileDir() string`; `session.LockPath() string`; `session.Lock` struct; `session.AcquireLock(path string, timeout time.Duration) (*Lock, error)`; `(*Lock).Release() error`; `session.ErrLocked` sentinel.

- [ ] **Step 1: Write the failing test**

Create `internal/session/profile_test.go`:

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/session/ -v`
Expected: FAIL — `undefined: ProfileDir`.

- [ ] **Step 3: Write minimal implementation**

Create `internal/session/profile.go`:

```go
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/session/ -v`
Expected: PASS, all three tests.

- [ ] **Step 5: Commit**

```bash
git add internal/session/
git commit -m "feat: profile dir resolution and stale-tolerant lock"
```

---

### Task 6: DevTools endpoint discovery

This is what turns the spike's `Opening in existing browser session` crash into a successful attach.

**Files:**
- Create: `internal/session/devtools.go`
- Test: `internal/session/devtools_test.go`

**Interfaces:**
- Consumes: `session.ProfileDir`.
- Produces: `session.ParseDevToolsActivePort(raw []byte) (port string, path string, err error)`; `session.EndpointFromProfile(dir string) (wsURL string, ok bool)`.

- [ ] **Step 1: Write the failing test**

Create `internal/session/devtools_test.go`:

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/session/ -run TestParseDevTools -v`
Expected: FAIL — `undefined: ParseDevToolsActivePort`.

- [ ] **Step 3: Write minimal implementation**

Create `internal/session/devtools.go`:

```go
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/session/ -v`
Expected: PASS, all tests in the package.

- [ ] **Step 5: Commit**

```bash
git add internal/session/
git commit -m "feat: discover a live DevTools endpoint for attach"
```

---

### Task 7: Auth payload interpretation

**Files:**
- Create: `internal/session/auth.go`
- Test: `internal/session/auth_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `session.AuthState{LoggedIn bool, Keys []string}`; `session.ParseAuthBody(body []byte) (AuthState, error)`; `(AuthState).Summary() string`.

`Summary` must contain only sorted key names. The payload holds `accessToken` and `sessionToken`; values must never reach a log.

- [ ] **Step 1: Write the failing test**

Create `internal/session/auth_test.go`:

```go
package session

import (
	"strings"
	"testing"
)

func TestParseAuthBodyLoggedOut(t *testing.T) {
	// Exact logged-out shape observed by the spike.
	st, err := ParseAuthBody([]byte(`{"WARNING_BANNER":"DO NOT SHARE"}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if st.LoggedIn {
		t.Fatal("no user key must mean logged out")
	}
	if st.Summary() != "WARNING_BANNER" {
		t.Fatalf("summary = %q", st.Summary())
	}
}

func TestParseAuthBodyLoggedInNeverLeaksValues(t *testing.T) {
	body := []byte(`{"WARNING_BANNER":"x","accessToken":"SECRET-ACCESS","sessionToken":"SECRET-SESSION","user":{"email":"a@b.c"},"expires":"2026-10-01"}`)
	st, err := ParseAuthBody(body)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !st.LoggedIn {
		t.Fatal("user key present must mean logged in")
	}
	s := st.Summary()
	for _, secret := range []string{"SECRET-ACCESS", "SECRET-SESSION", "a@b.c"} {
		if strings.Contains(s, secret) {
			t.Fatalf("summary leaked a value: %q", s)
		}
	}
	if want := "WARNING_BANNER,accessToken,expires,sessionToken,user"; s != want {
		t.Fatalf("summary = %q, want sorted keys %q", s, want)
	}
}

func TestParseAuthBodyNullUserIsLoggedOut(t *testing.T) {
	st, err := ParseAuthBody([]byte(`{"user":null}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if st.LoggedIn {
		t.Fatal("null user must mean logged out")
	}
}

func TestParseAuthBodyNonJSON(t *testing.T) {
	if _, err := ParseAuthBody([]byte("<html>login</html>")); err == nil {
		t.Fatal("non-JSON body must error so the caller reports NOT_LOGGED_IN")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/session/ -run TestParseAuthBody -v`
Expected: FAIL — `undefined: ParseAuthBody`.

- [ ] **Step 3: Write minimal implementation**

Create `internal/session/auth.go`:

```go
package session

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

// AuthState is the safe-to-log view of /api/auth/session. The raw payload
// carries accessToken and sessionToken, so only key names are retained.
type AuthState struct {
	LoggedIn bool
	Keys     []string
}

func ParseAuthBody(body []byte) (AuthState, error) {
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return AuthState{}, errors.New("auth endpoint did not return JSON")
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	u, ok := m["user"]
	return AuthState{LoggedIn: ok && u != nil, Keys: keys}, nil
}

// Summary is deliberately keys-only. Never add values to this.
func (a AuthState) Summary() string { return strings.Join(a.Keys, ",") }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/session/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/session/
git commit -m "feat: auth state parsing that never logs token values"
```

---

### Task 8: Completion-state decision logic

Pure logic, so the rule that broke the spike (exiting as soon as any image appeared) is unit-tested rather than discovered live.

**Files:**
- Create: `internal/compose/state.go`
- Test: `internal/compose/state_test.go`

**Interfaces:**
- Consumes: `capture.FileIDFromURL`.
- Produces: `compose.PageState{Loading bool, Streaming bool, ImageURLs []string, Alts []string}`; `compose.ParseState(raw []byte) (PageState, error)`; `(PageState).DistinctImageIDs() []string`; `compose.Done(s PageState, want int) bool`.

- [ ] **Step 1: Write the failing test**

Create `internal/compose/state_test.go`:

```go
package compose

import "testing"

const oneImage = `{"loading":false,"streaming":false,
"imageURLs":["https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs&sig=x"],
"alts":["Generated image: Teal Mountain"]}`

func TestParseState(t *testing.T) {
	s, err := ParseState([]byte(oneImage))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if s.Loading || s.Streaming {
		t.Fatalf("flags wrong: %+v", s)
	}
	if len(s.ImageURLs) != 1 {
		t.Fatalf("images = %v", s.ImageURLs)
	}
}

func TestDistinctImageIDs(t *testing.T) {
	// The spike saw the same generated image rendered by three <img> tags.
	s := PageState{ImageURLs: []string{
		"https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs",
		"https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs",
		"https://chatgpt.com/backend-api/estuary/content?id=file_bbb&p=fs",
		"https://chatgpt.com/cdn/assets/favicon-x.svg",
	}}
	got := s.DistinctImageIDs()
	if len(got) != 2 || got[0] != "file_aaa" || got[1] != "file_bbb" {
		t.Fatalf("DistinctImageIDs = %v, want [file_aaa file_bbb]", got)
	}
}

func TestDoneRequiresQuietAndEnoughImages(t *testing.T) {
	img := func(n int) []string {
		var out []string
		for i := 0; i < n; i++ {
			out = append(out, "https://chatgpt.com/backend-api/estuary/content?id=file_"+string(rune('a'+i))+"&p=fs")
		}
		return out
	}
	cases := []struct {
		name string
		s    PageState
		want int
		done bool
	}{
		{"still loading", PageState{Loading: true, ImageURLs: img(1)}, 1, false},
		{"still streaming", PageState{Streaming: true, ImageURLs: img(1)}, 1, false},
		{"quiet but no image", PageState{}, 1, false},
		{"quiet with image", PageState{ImageURLs: img(1)}, 1, true},
		{"set incomplete", PageState{ImageURLs: img(2)}, 3, false},
		{"set complete", PageState{ImageURLs: img(3)}, 3, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Done(c.s, c.want); got != c.done {
				t.Fatalf("Done = %v, want %v", got, c.done)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/compose/ -v`
Expected: FAIL — `undefined: ParseState`.

- [ ] **Step 3: Write minimal implementation**

Create `internal/compose/state.go`:

```go
// Package compose drives the ChatGPT composer. This file holds the pure
// decision logic so completion rules are unit-tested, not discovered live.
package compose

import (
	"encoding/json"

	"github.com/jheelr/gpt-imagegen/internal/capture"
)

type PageState struct {
	Loading   bool     `json:"loading"`
	Streaming bool     `json:"streaming"`
	ImageURLs []string `json:"imageURLs"`
	Alts      []string `json:"alts"`
}

func ParseState(raw []byte) (PageState, error) {
	var s PageState
	err := json.Unmarshal(raw, &s)
	return s, err
}

// DistinctImageIDs returns generated file ids in first-seen order. ChatGPT
// renders one generated image through several <img> tags, so counting tags
// would overcount.
func (s PageState) DistinctImageIDs() []string {
	seen := map[string]bool{}
	var out []string
	for _, u := range s.ImageURLs {
		id := capture.FileIDFromURL(u)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// Done requires the UI to be quiet AND to hold enough distinct images. The
// spike failed by returning as soon as any image byte arrived.
func Done(s PageState, want int) bool {
	if s.Loading || s.Streaming {
		return false
	}
	if want < 1 {
		want = 1
	}
	return len(s.DistinctImageIDs()) >= want
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/compose/ -v`
Expected: PASS, all subtests.

- [ ] **Step 5: Commit**

```bash
git add internal/compose/
git commit -m "feat: completion logic requiring a quiet UI and distinct images"
```

---

### Task 9: Browser lifecycle

**Files:**
- Create: `internal/session/browser.go`
- Create: `internal/session/window_darwin.go`
- Create: `internal/session/window_other.go`
- Test: `internal/session/browser_test.go`

**Interfaces:**
- Consumes: `session.ProfileDir`, `session.EndpointFromProfile`, `session.ParseAuthBody`.
- Produces: `session.Browser{Rod *rod.Browser, Owned bool}`; `session.Open(headless bool) (*Browser, error)`; `(*Browser).Close()`; `(*Browser).Auth() (AuthState, error)`; `session.ChromePath() (string, error)`; `session.HideWindow(pid int) error`.

- [ ] **Step 1: Write the failing test**

Create `internal/session/browser_test.go`:

```go
package session

import (
	"os"
	"testing"
)

func TestChromePathErrorsWhenMissing(t *testing.T) {
	t.Setenv("GPT_IMAGEGEN_CHROME", "/definitely/not/here")
	if _, err := ChromePath(); err == nil {
		t.Fatal("missing chrome binary must error so the CLI reports CHROME_MISSING")
	}
}

func TestChromePathHonoursOverride(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "chrome")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	t.Setenv("GPT_IMAGEGEN_CHROME", f.Name())
	got, err := ChromePath()
	if err != nil {
		t.Fatalf("ChromePath: %v", err)
	}
	if got != f.Name() {
		t.Fatalf("ChromePath = %q, want %q", got, f.Name())
	}
}

// TestCloseIsSafeOnAttached guards the rule that we never shut down a browser
// we did not launch.
func TestCloseIsSafeOnAttached(t *testing.T) {
	b := &Browser{Owned: false}
	b.Close() // must not panic and must not attempt a close on a nil Rod
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/session/ -run TestChromePath -v`
Expected: FAIL — `undefined: ChromePath`.

- [ ] **Step 3: Write the implementation**

Create `internal/session/browser.go`:

```go
package session

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
)

const defaultChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

func ChromePath() (string, error) {
	p := os.Getenv("GPT_IMAGEGEN_CHROME")
	if p == "" {
		p = defaultChrome
	}
	if _, err := os.Stat(p); err != nil {
		return "", fmt.Errorf("chrome not found at %s", p)
	}
	return p, nil
}

type Browser struct {
	Rod   *rod.Browser
	Owned bool
}

// Open attaches to a Chrome already running on our profile, else launches one.
// The launch flags are load-bearing for avoiding bot detection; do not trim
// them, and never run headless.
func Open(headless bool) (*Browser, error) {
	dir := ProfileDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if ws, ok := EndpointFromProfile(dir); ok {
		b := rod.New().ControlURL(ws)
		if err := b.Connect(); err == nil {
			return &Browser{Rod: b, Owned: false}, nil
		}
	}
	bin, err := ChromePath()
	if err != nil {
		return nil, err
	}
	l := launcher.New().
		Bin(bin).
		UserDataDir(dir).
		Headless(headless).
		Set("disable-blink-features", "AutomationControlled").
		Set("no-first-run").
		Set("no-default-browser-check")
	l.Delete("enable-automation")

	ctrl, err := l.Launch()
	if err != nil {
		return nil, err
	}
	b := rod.New().ControlURL(ctrl)
	if err := b.Connect(); err != nil {
		return nil, err
	}
	// NOTE: we deliberately never call l.Cleanup(). It runs
	// os.RemoveAll(UserDataDir) and would delete the user's login.
	return &Browser{Rod: b, Owned: true}, nil
}

// Close shuts Chrome down gracefully so cookies are flushed, but only if we
// launched it. A leakless SIGKILL can drop recent cookies.
func (b *Browser) Close() {
	if b == nil || !b.Owned || b.Rod == nil {
		return
	}
	_ = b.Rod.Close()
	time.Sleep(1500 * time.Millisecond)
}

// Auth probes the session endpoint in its own throwaway tab so a page that may
// be mid-login is never navigated.
func (b *Browser) Auth() (AuthState, error) {
	p, err := b.Rod.Page(proto.TargetCreateTarget{URL: "about:blank"})
	if err != nil {
		return AuthState{}, err
	}
	defer p.Close()
	if err := p.Timeout(25 * time.Second).Navigate("https://chatgpt.com/api/auth/session"); err != nil {
		return AuthState{}, err
	}
	if err := p.Timeout(25 * time.Second).WaitLoad(); err != nil {
		return AuthState{}, err
	}
	el, err := p.Timeout(10 * time.Second).Element("body")
	if err != nil {
		return AuthState{}, errors.New("auth probe: no body")
	}
	txt, err := el.Text()
	if err != nil {
		return AuthState{}, err
	}
	return ParseAuthBody([]byte(strings.TrimSpace(txt)))
}
```

Create `internal/session/window_darwin.go`:

```go
//go:build darwin

package session

import (
	"fmt"
	"os/exec"
)

// HideWindow moves the automation window offscreen so it never steals focus.
// Headless would be cleaner but is the strongest bot-detection signal, so we
// stay headful and hide instead. Failure is non-fatal: visible is acceptable.
func HideWindow(pid int) error {
	script := fmt.Sprintf(`tell application "System Events"
	set procs to (every process whose unix id is %d)
	repeat with p in procs
		try
			set position of front window of p to {-9000, -9000}
		end try
	end repeat
end tell`, pid)
	return exec.Command("osascript", "-e", script).Run()
}
```

Create `internal/session/window_other.go`:

```go
//go:build !darwin

package session

// HideWindow is macOS-only; elsewhere the window stays visible.
func HideWindow(pid int) error { return nil }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/session/ -v && go build ./...`
Expected: PASS and a clean build.

- [ ] **Step 5: Commit**

```bash
git add internal/session/
git commit -m "feat: attach-or-launch browser lifecycle with graceful shutdown"
```

---

### Task 10: Image capture

**Files:**
- Create: `internal/capture/capture.go`
- Test: `internal/capture/capture_test.go`

**Interfaces:**
- Consumes: `capture.IsGeneratedImageURL`, `capture.FileIDFromURL`, `capture.OutputPath`, `capture.TitleFromAlt`.
- Produces: `capture.Recorder`; `capture.NewRecorder(p *rod.Page) *Recorder`; `(*Recorder).Start()`; `(*Recorder).Files() map[string][]byte`; `(*Recorder).Mime(id string) string`; `capture.ExtFor(mime string) string`; `capture.Decode(body string, isBase64 bool) ([]byte, error)`; `capture.FetchInPage(p *rod.Page, url string) ([]byte, error)`; `capture.Dimensions(png []byte) (w, h int, err error)`.

- [ ] **Step 1: Write the failing test**

Create `internal/capture/capture_test.go`:

```go
package capture

import (
	"encoding/base64"
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/capture/ -run TestExtFor -v`
Expected: FAIL — `undefined: ExtFor`.

- [ ] **Step 3: Write the implementation**

Create `internal/capture/capture.go`:

```go
package capture

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"strings"
	"sync"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
)

func ExtFor(mime string) string {
	switch {
	case strings.Contains(mime, "webp"):
		return ".webp"
	case strings.Contains(mime, "jpeg"), strings.Contains(mime, "jpg"):
		return ".jpg"
	default:
		return ".png"
	}
}

func Decode(body string, isBase64 bool) ([]byte, error) {
	if !isBase64 {
		return []byte(body), nil
	}
	return base64.StdEncoding.DecodeString(body)
}

func Dimensions(b []byte) (int, int, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return 0, 0, err
	}
	return cfg.Width, cfg.Height, nil
}

type entry struct {
	url  string
	mime string
}

// Recorder is the primary capture path: it watches the network for generated
// image responses and pulls their bodies out of the CDP buffer.
type Recorder struct {
	page  *rod.Page
	mu    sync.Mutex
	wip   map[proto.NetworkRequestID]entry
	files map[string][]byte
	mimes map[string]string
}

func NewRecorder(p *rod.Page) *Recorder {
	return &Recorder{
		page:  p,
		wip:   map[proto.NetworkRequestID]entry{},
		files: map[string][]byte{},
		mimes: map[string]string{},
	}
}

// Start enables the network domain and begins recording. Keyed by file id, so
// the same image fetched by several <img> tags is stored once.
func (r *Recorder) Start() {
	_ = proto.NetworkEnable{}.Call(r.page)
	go r.page.EachEvent(
		func(e *proto.NetworkResponseReceived) {
			if !IsGeneratedImageURL(e.Response.URL) {
				return
			}
			r.mu.Lock()
			r.wip[e.RequestID] = entry{url: e.Response.URL, mime: e.Response.MIMEType}
			r.mu.Unlock()
		},
		func(e *proto.NetworkLoadingFinished) {
			r.mu.Lock()
			ent, ok := r.wip[e.RequestID]
			r.mu.Unlock()
			if !ok {
				return
			}
			res, err := proto.NetworkGetResponseBody{RequestID: e.RequestID}.Call(r.page)
			if err != nil {
				return // buffer evicted; FetchInPage is the fallback
			}
			data, err := Decode(res.Body, res.Base64Encoded)
			if err != nil {
				return
			}
			id := FileIDFromURL(ent.url)
			r.mu.Lock()
			r.files[id] = data
			r.mimes[id] = ent.mime
			r.mu.Unlock()
		},
	)()
}

func (r *Recorder) Files() map[string][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string][]byte, len(r.files))
	for k, v := range r.files {
		out[k] = v
	}
	return out
}

func (r *Recorder) Mime(id string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if m, ok := r.mimes[id]; ok {
		return m
	}
	return "image/png"
}

// FetchInPage is the fallback when the CDP response buffer has been evicted,
// which happens on long generations. The URL is same-origin and cookie-authed,
// so fetching from page context just works.
func FetchInPage(p *rod.Page, url string) ([]byte, error) {
	if !IsGeneratedImageURL(url) {
		return nil, errors.New("refusing to fetch a non-generated URL")
	}
	js := `(u) => fetch(u, {credentials: 'include'})
		.then(r => r.arrayBuffer())
		.then(b => {
			let s = '', bytes = new Uint8Array(b);
			for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
			return btoa(s);
		})`
	res, err := p.Eval(js, url)
	if err != nil {
		return nil, fmt.Errorf("in-page fetch: %w", err)
	}
	return base64.StdEncoding.DecodeString(res.Value.Str())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/capture/ -v && go build ./...`
Expected: PASS and a clean build.

- [ ] **Step 5: Commit**

```bash
git add internal/capture/
git commit -m "feat: network capture with in-page fetch fallback"
```

---

### Task 11: Composer driving and probe dump

**Files:**
- Create: `internal/compose/compose.go`
- Create: `internal/probe/probe.go`
- Test: `internal/probe/probe_test.go`

**Interfaces:**
- Consumes: `selectors.Set`, `compose.ParseState`, `compose.Done`.
- Produces: `compose.ErrSelectorMiss{Key string}`; `compose.Resolve(p *rod.Page, s selectors.Set, key string, timeout time.Duration) (*rod.Element, error)`; `compose.NewChat(p *rod.Page) error`; `compose.Send(p *rod.Page, s selectors.Set, prompt string, refs []string) error`; `compose.ReadState(p *rod.Page) (PageState, error)`; `compose.WaitDone(p *rod.Page, want int, timeout time.Duration) (PageState, error)`; `compose.Archive(p *rod.Page, s selectors.Set) error`; `probe.Candidate`; `probe.Dump`; `probe.WriteDump(dir, stage, url string, cands []Candidate) (string, error)`; `probe.Collect(p *rod.Page) ([]Candidate, error)`; `probe.Capture(p *rod.Page, stage, dir string) (string, error)`.

- [ ] **Step 1: Write the failing test**

Create `internal/probe/probe_test.go`:

```go
package probe

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteDumpProducesReadableJSON(t *testing.T) {
	dir := t.TempDir()
	cands := []Candidate{
		{TestID: "stop-button", Role: "button", Name: "Stop", CSS: "button[data-testid='stop-button']"},
		{CSS: "#prompt-textarea", Text: ""},
	}
	p, err := WriteDump(dir, "composer", "https://chatgpt.com/c/abc", cands)
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if filepath.Dir(p) != dir {
		t.Fatalf("dump written outside dir: %q", p)
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var back Dump
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("dump is not valid json: %v", err)
	}
	if back.Stage != "composer" || len(back.Candidates) != 2 {
		t.Fatalf("dump lost data: %+v", back)
	}
	if back.Candidates[0].TestID != "stop-button" {
		t.Fatalf("candidate mangled: %+v", back.Candidates[0])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/probe/ -v`
Expected: FAIL — `undefined: Candidate`.

- [ ] **Step 3: Write the probe implementation**

Create `internal/probe/probe.go`:

```go
// Package probe dumps candidate elements when a selector misses, so the skill
// can repair selectors.json without a live browser attach.
package probe

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/go-rod/rod"
)

type Candidate struct {
	TestID string `json:"testid,omitempty"`
	Role   string `json:"role,omitempty"`
	Name   string `json:"name,omitempty"`
	Text   string `json:"text,omitempty"`
	CSS    string `json:"css,omitempty"`
}

type Dump struct {
	Stage      string      `json:"stage"`
	URL        string      `json:"url"`
	CapturedAt string      `json:"captured_at"`
	Candidates []Candidate `json:"candidates"`
}

func WriteDump(dir, stage, url string, cands []Candidate) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	d := Dump{Stage: stage, URL: url, CapturedAt: time.Now().UTC().Format(time.RFC3339), Candidates: cands}
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return "", err
	}
	p := filepath.Join(dir, fmt.Sprintf("probe-%s.json", stage))
	return p, os.WriteFile(p, append(b, '\n'), 0o600)
}

// collectJS enumerates interactive and image elements with everything needed
// to write a new selector.
const collectJS = `() => {
	const out = [];
	const sel = 'button,[role=button],textarea,input,div[contenteditable=true],img,[data-testid]';
	document.querySelectorAll(sel).forEach(e => {
		const r = e.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return;
		out.push({
			testid: e.getAttribute('data-testid') || '',
			role: e.getAttribute('role') || e.tagName.toLowerCase(),
			name: (e.getAttribute('aria-label') || e.getAttribute('alt') || '').slice(0, 120),
			text: (e.textContent || '').trim().slice(0, 80),
			css: e.id ? '#' + e.id : (e.getAttribute('data-testid') ? '[data-testid="' + e.getAttribute('data-testid') + '"]' : e.tagName.toLowerCase())
		});
	});
	return JSON.stringify(out.slice(0, 400));
}`

func Collect(p *rod.Page) ([]Candidate, error) {
	res, err := p.Eval(collectJS)
	if err != nil {
		return nil, err
	}
	var cands []Candidate
	if err := json.Unmarshal([]byte(res.Value.Str()), &cands); err != nil {
		return nil, err
	}
	return cands, nil
}

// Capture collects candidates from a live page and writes the dump file.
func Capture(p *rod.Page, stage, dir string) (string, error) {
	cands, err := Collect(p)
	if err != nil {
		return "", err
	}
	info, err := p.Info()
	url := ""
	if err == nil {
		url = info.URL
	}
	return WriteDump(dir, stage, url, cands)
}
```

- [ ] **Step 4: Write the compose implementation**

Create `internal/compose/compose.go`:

```go
package compose

import (
	"fmt"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/input"
	"github.com/go-rod/rod/lib/proto"

	"github.com/jheelr/gpt-imagegen/internal/selectors"
)

type ErrSelectorMiss struct{ Key string }

func (e ErrSelectorMiss) Error() string { return "no selector matched for " + e.Key }

// Resolve tries each candidate for a key in priority order.
func Resolve(p *rod.Page, s selectors.Set, key string, timeout time.Duration) (*rod.Element, error) {
	qs := s.Query(key)
	if len(qs) == 0 {
		return nil, ErrSelectorMiss{Key: key}
	}
	per := timeout / time.Duration(len(qs))
	if per < time.Second {
		per = time.Second
	}
	for _, q := range qs {
		if el, err := p.Timeout(per).Element(q); err == nil && el != nil {
			return el, nil
		}
	}
	return nil, ErrSelectorMiss{Key: key}
}

func NewChat(p *rod.Page) error {
	if err := p.Navigate("https://chatgpt.com/"); err != nil {
		return err
	}
	if err := p.WaitLoad(); err != nil {
		return err
	}
	time.Sleep(3 * time.Second) // let the SPA settle before touching the composer
	return nil
}

// Send types the prompt, attaches any reference files, and submits.
func Send(p *rod.Page, s selectors.Set, prompt string, refs []string) error {
	if len(refs) > 0 {
		in, err := Resolve(p, s, "upload_input", 15*time.Second)
		if err != nil {
			return err
		}
		if err := in.SetFiles(refs); err != nil {
			return fmt.Errorf("attach refs: %w", err)
		}
		time.Sleep(4 * time.Second) // let upload chips settle
	}
	el, err := Resolve(p, s, "composer_input", 20*time.Second)
	if err != nil {
		return err
	}
	if err := el.Click(proto.InputMouseButtonLeft, 1); err != nil {
		return err
	}
	if err := el.Input(prompt); err != nil {
		return err
	}
	time.Sleep(800 * time.Millisecond)
	return p.Keyboard.Type(input.Enter)
}

const stateJS = `() => {
	const imgs = [...document.querySelectorAll('img[alt^="Generated image: "]')];
	return JSON.stringify({
		loading: !!document.querySelector('[data-testid^="image-gen-loading-state"]'),
		streaming: !!document.querySelector('[data-testid="stop-button"]'),
		imageURLs: imgs.map(i => i.src),
		alts: imgs.map(i => i.alt)
	});
}`

func ReadState(p *rod.Page) (PageState, error) {
	res, err := p.Eval(stateJS)
	if err != nil {
		return PageState{}, err
	}
	return ParseState([]byte(res.Value.Str()))
}

// WaitDone polls the DOM completion signals. It never sleeps a fixed duration
// and never returns early on the first image byte.
func WaitDone(p *rod.Page, want int, timeout time.Duration) (PageState, error) {
	deadline := time.Now().Add(timeout)
	var last PageState
	for time.Now().Before(deadline) {
		st, err := ReadState(p)
		if err == nil {
			last = st
			if Done(st, want) {
				return st, nil
			}
		}
		time.Sleep(3 * time.Second)
	}
	return last, fmt.Errorf("timed out after %s", timeout)
}

// Archive tidies a finished conversation out of the sidebar. Call it only
// after artifacts are safely on disk: on failure the conversation URL is the
// recovery path, so a failed run must never be archived.
func Archive(p *rod.Page, s selectors.Set) error {
	btn, err := Resolve(p, s, "conversation_options", 10*time.Second)
	if err != nil {
		return err
	}
	if err := btn.Click(proto.InputMouseButtonLeft, 1); err != nil {
		return err
	}
	time.Sleep(700 * time.Millisecond)
	item, err := p.Timeout(8 * time.Second).ElementR("div[role='menuitem'], button", "(?i)^archive$")
	if err != nil {
		return fmt.Errorf("archive menu item not found: %w", err)
	}
	return item.Click(proto.InputMouseButtonLeft, 1)
}
```

- [ ] **Step 5: Run tests and build**

Run: `go test ./... -v && go build ./...`
Expected: PASS and a clean build. Fix any import ordering the compiler flags.

- [ ] **Step 6: Commit**

```bash
git add internal/compose/ internal/probe/
git commit -m "feat: composer driving, completion polling, and probe dumps"
```

---

### Task 12: CLI wiring

**Files:**
- Create: `cmd/gpt-imagegen/main.go`
- Create: `cmd/gpt-imagegen/run.go`
- Test: `cmd/gpt-imagegen/main_test.go`

**Interfaces:**
- Consumes: everything above.
- Produces: the `gpt-imagegen` binary with subcommands `setup`, `doctor`, `generate`, `edit`, `probe`.

- [ ] **Step 1: Write the failing test**

Create `cmd/gpt-imagegen/main_test.go`:

```go
package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestUnknownCommandEmitsJSONOnStdout(t *testing.T) {
	var out, errBuf bytes.Buffer
	code := run([]string{"wat"}, &out, &errBuf)
	if code == 0 {
		t.Fatal("unknown command must exit non-zero")
	}
	var r map[string]any
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatalf("stdout must be a single JSON object, got %q", out.String())
	}
	if r["ok"] != false {
		t.Fatalf("want ok=false, got %v", r["ok"])
	}
}

func TestGenerateRequiresPromptAndOut(t *testing.T) {
	var out, errBuf bytes.Buffer
	if code := run([]string{"generate"}, &out, &errBuf); code == 0 {
		t.Fatal("generate without --prompt must fail")
	}
	if !strings.Contains(out.String(), `"ok":false`) {
		t.Fatalf("stdout = %q", out.String())
	}
}

// Progress must never contaminate stdout, which the skill parses as JSON.
func TestStdoutHasNoProgressChatter(t *testing.T) {
	var out, errBuf bytes.Buffer
	run([]string{"wat"}, &out, &errBuf)
	if strings.Count(strings.TrimSpace(out.String()), "\n") != 0 {
		t.Fatalf("stdout must be exactly one line, got %q", out.String())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/gpt-imagegen/ -v`
Expected: FAIL — `undefined: run`.

- [ ] **Step 3: Write the implementation**

Create `cmd/gpt-imagegen/main.go`:

```go
package main

import (
	"os"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}
```

Create `cmd/gpt-imagegen/run.go`:

```go
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/go-rod/rod/lib/proto"

	"github.com/jheelr/gpt-imagegen/internal/capture"
	"github.com/jheelr/gpt-imagegen/internal/compose"
	"github.com/jheelr/gpt-imagegen/internal/envelope"
	"github.com/jheelr/gpt-imagegen/internal/probe"
	"github.com/jheelr/gpt-imagegen/internal/selectors"
	"github.com/jheelr/gpt-imagegen/internal/session"
)

type stringList []string

func (s *stringList) String() string     { return fmt.Sprint(*s) }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }

// run returns the process exit code. stdout receives exactly one JSON line;
// all progress goes to stderr so the skill can parse stdout unconditionally.
func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		return emit(stdout, envelope.Failure(envelope.CodeRefused, "usage: gpt-imagegen <setup|doctor|generate|edit|probe>"))
	}
	switch args[0] {
	case "setup":
		return cmdSetup(stdout, stderr)
	case "doctor":
		return cmdDoctor(stdout, stderr)
	case "generate":
		return cmdGenerate(args[1:], stdout, stderr)
	case "edit":
		return cmdEdit(args[1:], stdout, stderr)
	case "probe":
		return cmdProbe(args[1:], stdout, stderr)
	default:
		return emit(stdout, envelope.Failure(envelope.CodeRefused, "unknown command "+args[0]))
	}
}

func emit(w io.Writer, r envelope.Result) int {
	_ = r.Write(w)
	return r.ExitCode()
}

func artifactDir() string {
	d := filepath.Join(os.TempDir(), "gpt-imagegen")
	_ = os.MkdirAll(d, 0o700)
	return d
}

func cmdSetup(stdout, stderr io.Writer) int {
	b, err := session.Open(false)
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeChromeMissing, err.Error()))
	}
	defer b.Close()
	if st, err := b.Auth(); err == nil && st.LoggedIn {
		fmt.Fprintln(stderr, "already signed in; keys="+st.Summary())
		return emit(stdout, envelope.Success(nil, "", false, 0))
	}
	p, err := b.Rod.Page(proto.TargetCreateTarget{URL: "https://chatgpt.com/"})
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeNotLoggedIn, err.Error()))
	}
	_ = p
	fmt.Fprintln(stderr, "Sign in to ChatGPT in the Chrome window. Waiting up to 10 minutes.")
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		st, err := b.Auth()
		if err == nil && st.LoggedIn {
			fmt.Fprintln(stderr, "signed in; keys="+st.Summary())
			return emit(stdout, envelope.Success(nil, "", false, 0))
		}
		time.Sleep(6 * time.Second)
	}
	return emit(stdout, envelope.Failure(envelope.CodeNotLoggedIn, "timed out waiting for sign-in"))
}

func cmdDoctor(stdout, stderr io.Writer) int {
	if _, err := session.ChromePath(); err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeChromeMissing, err.Error()))
	}
	b, err := session.Open(false)
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeChromeMissing, err.Error()))
	}
	defer b.Close()
	st, err := b.Auth()
	if err != nil || !st.LoggedIn {
		return emit(stdout, envelope.Failure(envelope.CodeNotLoggedIn, "run: gpt-imagegen setup"))
	}
	fmt.Fprintln(stderr, "chrome ok, profile ok, auth ok; keys="+st.Summary())
	return emit(stdout, envelope.Success(nil, "", false, 0))
}

func cmdGenerate(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("generate", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	prompt := fs.String("prompt", "", "image prompt")
	out := fs.String("out", "", "output path or directory")
	count := fs.Int("count", 1, "number of images")
	var refs stringList
	fs.Var(&refs, "ref", "reference image (repeatable)")
	if err := fs.Parse(args); err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeRefused, err.Error()))
	}
	if *prompt == "" || *out == "" {
		return emit(stdout, envelope.Failure(envelope.CodeRefused, "--prompt and --out are required"))
	}
	return generate(*prompt, *out, *count, refs, stdout, stderr)
}

func cmdEdit(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("edit", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	img := fs.String("image", "", "image to edit")
	prompt := fs.String("prompt", "", "edit instruction")
	out := fs.String("out", "", "output path")
	if err := fs.Parse(args); err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeRefused, err.Error()))
	}
	if *img == "" || *prompt == "" || *out == "" {
		return emit(stdout, envelope.Failure(envelope.CodeRefused, "--image, --prompt and --out are required"))
	}
	if _, err := os.Stat(*img); err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeRefused, "no such image: "+*img))
	}
	return generate(*prompt, *out, 1, stringList{*img}, stdout, stderr)
}

func cmdProbe(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("probe", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	stage := fs.String("stage", "composer", "stage name")
	if err := fs.Parse(args); err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeRefused, err.Error()))
	}
	b, err := session.Open(false)
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeChromeMissing, err.Error()))
	}
	defer b.Close()
	p, err := b.Rod.Page(proto.TargetCreateTarget{URL: "https://chatgpt.com/"})
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeTimeout, err.Error()))
	}
	_ = p.WaitLoad()
	time.Sleep(3 * time.Second)
	path, err := probe.Capture(p, *stage, artifactDir())
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeSelectorMiss, err.Error()))
	}
	r := envelope.Failure(envelope.CodeSelectorMiss, "probe written")
	r.Error.Probe = path
	r.Error.Stage = *stage
	return emit(stdout, r)
}

// generate is the shared path for both generate and edit.
func generate(prompt, out string, count int, refs []string, stdout, stderr io.Writer) int {
	start := time.Now()

	lock, err := session.AcquireLock(session.LockPath(), 3*time.Minute)
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeProfileLocked, err.Error()))
	}
	defer lock.Release()

	sel, err := selectors.Load(selectors.UserPath())
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeRefused, err.Error()))
	}

	b, err := session.Open(false)
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeChromeMissing, err.Error()))
	}
	defer b.Close()

	st, err := b.Auth()
	if err != nil || !st.LoggedIn {
		return emit(stdout, envelope.Failure(envelope.CodeNotLoggedIn, "run: gpt-imagegen setup"))
	}

	p, err := b.Rod.Page(proto.TargetCreateTarget{URL: "about:blank"})
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeTimeout, err.Error()))
	}
	rec := capture.NewRecorder(p)
	rec.Start()

	if err := compose.NewChat(p); err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeTimeout, err.Error()))
	}
	fmt.Fprintln(stderr, "composer ready; sending prompt")

	if err := compose.Send(p, sel, prompt, refs); err != nil {
		if miss, ok := err.(compose.ErrSelectorMiss); ok {
			path, _ := probe.Capture(p, "composer", artifactDir())
			r := envelope.Failure(envelope.CodeSelectorMiss, miss.Error())
			r.Error.SelectorKey = miss.Key
			r.Error.Stage = "composer"
			r.Error.Probe = path
			return emit(stdout, r)
		}
		return emit(stdout, envelope.Failure(envelope.CodeTimeout, err.Error()))
	}

	convURL := ""
	if info, err := p.Info(); err == nil {
		convURL = info.URL
	}

	state, err := compose.WaitDone(p, count, 6*time.Minute)
	if info, ierr := p.Info(); ierr == nil {
		convURL = info.URL
	}
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeTimeout, err.Error()).WithConversation(convURL))
	}

	ids := state.DistinctImageIDs()
	if len(ids) == 0 {
		return emit(stdout, envelope.Failure(envelope.CodeNoImage, "no generated image in the response").WithConversation(convURL))
	}

	files := rec.Files()
	var images []envelope.Image
	for i, id := range ids {
		data := files[id]
		if len(data) == 0 {
			// Fallback: the CDP buffer was evicted, so refetch from page context.
			for _, u := range state.ImageURLs {
				if capture.FileIDFromURL(u) == id {
					if d, ferr := capture.FetchInPage(p, u); ferr == nil {
						data = d
					}
					break
				}
			}
		}
		if len(data) == 0 {
			continue
		}
		title := ""
		if i < len(state.Alts) {
			title = capture.TitleFromAlt(state.Alts[i])
		}
		ext := capture.ExtFor(rec.Mime(id))
		dst := capture.OutputPath(out, i, title, ext)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return emit(stdout, envelope.Failure(envelope.CodeRefused, err.Error()).WithConversation(convURL))
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return emit(stdout, envelope.Failure(envelope.CodeRefused, err.Error()).WithConversation(convURL))
		}
		w, h, _ := capture.Dimensions(data)
		images = append(images, envelope.Image{Path: dst, Bytes: len(data), Width: w, Height: h, Title: title})
		fmt.Fprintf(stderr, "saved %s (%d bytes)\n", dst, len(data))
	}

	if len(images) == 0 {
		return emit(stdout, envelope.Failure(envelope.CodeNoImage, "image bytes could not be retrieved").WithConversation(convURL))
	}

	// Archive only now that every file is on disk. A failed run is never
	// archived, because its conversation URL is the recovery path. A failure
	// to archive is cosmetic and must not fail the run.
	archived := false
	if err := compose.Archive(p, sel); err != nil {
		fmt.Fprintln(stderr, "archive skipped:", err)
	} else {
		archived = true
	}

	return emit(stdout, envelope.Success(images, convURL, archived, time.Since(start).Seconds()))
}
```

Add `"github.com/go-rod/rod/lib/proto"` to the imports of `run.go`.

- [ ] **Step 4: Run tests and build**

Run: `go test ./... && go build -o gpt-imagegen ./cmd/gpt-imagegen && ./gpt-imagegen wat`
Expected: tests PASS; the binary prints one JSON line with `"ok":false`.

- [ ] **Step 5: Commit**

```bash
git add cmd/
git commit -m "feat: CLI with JSON-only stdout and stage-aware errors"
```

---

### Task 13: Plugin packaging

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/gpt-imagegen/.claude-plugin/plugin.json`
- Create: `plugins/gpt-imagegen/scripts/gpt-imagegen`
- Create: `plugins/gpt-imagegen/skills/gpt-imagegen/SKILL.md`
- Create: `plugins/gpt-imagegen/commands/{image,edit,setup,doctor}.md`
- Create: `Makefile`

**Interfaces:**
- Consumes: the `gpt-imagegen` binary.
- Produces: an installable plugin.

- [ ] **Step 1: Write the Makefile and build the binary into the plugin**

Create `Makefile`:

```make
BIN := plugins/gpt-imagegen/bin/gpt-imagegen

.PHONY: build test smoke clean
build:
	go build -o $(BIN) ./cmd/gpt-imagegen

test:
	go test ./...

# Live smoke costs a real ChatGPT turn; opt in explicitly.
smoke: build
	GPT_IMAGEGEN_LIVE=1 go test ./tests/live/ -run TestLiveGenerate -v -timeout 15m

clean:
	rm -rf plugins/gpt-imagegen/bin dist
```

- [ ] **Step 2: Write the manifests**

Create `.claude-plugin/marketplace.json`:

```json
{
  "name": "gpt-imagegen",
  "owner": { "name": "jheelr" },
  "metadata": {
    "description": "Generate images through a signed-in ChatGPT browser session.",
    "version": "0.1.0"
  },
  "plugins": [
    {
      "name": "gpt-imagegen",
      "description": "Generate, edit and set images via ChatGPT in a real browser.",
      "version": "0.1.0",
      "author": { "name": "jheelr" },
      "source": "./plugins/gpt-imagegen"
    }
  ]
}
```

Create `plugins/gpt-imagegen/.claude-plugin/plugin.json`:

```json
{
  "name": "gpt-imagegen",
  "description": "Generate, edit and set images via a signed-in ChatGPT browser session",
  "version": "0.1.0",
  "author": { "name": "jheelr" },
  "license": "MIT",
  "keywords": ["images", "chatgpt", "browser", "generation"]
}
```

Create `plugins/gpt-imagegen/scripts/gpt-imagegen` and `chmod +x` it:

```bash
#!/usr/bin/env bash
# Locate the plugin binary regardless of where the plugin is installed.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin="$here/../bin/gpt-imagegen"
if [[ ! -x "$bin" ]]; then
  echo '{"ok":false,"error":{"code":"CHROME_MISSING","message":"gpt-imagegen binary not built; run make build"}}'
  exit 1
fi
exec "$bin" "$@"
```

- [ ] **Step 3: Write the skill**

Create `plugins/gpt-imagegen/skills/gpt-imagegen/SKILL.md`:

```markdown
---
name: gpt-imagegen
description: Use when any task would be better delivered with a real generated image than a placeholder or a description - building or restyling a landing page, website, app screen, README or docs banner, OG/social card, slide deck, game sprites or tiles, app icon, logo, or marketing page; also when the user says generate/create/make/draw/render/design an image, picture, illustration, logo, icon, banner, hero, or sprite; and when an existing image needs editing. Runs a pre-flight check before shipping any build with a visual surface.
---

# Generating images through ChatGPT

Generate images by driving a signed-in ChatGPT browser session. Images are billed
against the user's ChatGPT plan, not an API key.

## Before generating

Announce what you are about to generate and why. A generation costs a real
ChatGPT turn and takes roughly 40 seconds, so never do it silently.

## Do not trigger for

- SVG icons that match an icon set already wired into the project (lucide,
  heroicons, and similar).
- Charts, graphs or diagrams built from real data. Use the dataviz skill.
- Screenshots of running code.
- Anything the user excluded ("no images", "SVG only", "use placeholders").

## Generating

One image:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen generate \
  --prompt "<detailed prompt>" --out ./assets/hero.png
```

A coherent set, generated in one conversation so style and palette match:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen generate \
  --prompt "three enemy sprites: red, blue, green; same flat-vector style" \
  --out ./assets/enemy.png --count 3
```

Editing an existing image:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen edit \
  --image ./assets/hero.png --prompt "make the sky stormy" --out ./assets/hero-2.png
```

stdout is exactly one JSON object. Parse it; never parse stderr.

After a successful generation, wire the saved path into whatever referenced it:
the `<img src>`, the markdown image, the CSS `url()`.

## Handling failure

Branch on `error.code`. Never invent a retry that is not listed here.

| code | what to do |
|---|---|
| `NOT_LOGGED_IN` | Tell the user to run `/gpt-imagegen:setup`. Do not retry. |
| `CHALLENGE` | Stop. Ask the user to solve the challenge in the Chrome window. Never auto-retry. |
| `RATE_LIMITED` | Stop and report. Never retry. |
| `TIMEOUT` | Re-check `error.conversation_url` once, then stop. |
| `SELECTOR_MISS` | One self-heal attempt, below. |
| `NO_IMAGE_RETURNED` or `REFUSED` | Report it. Likely a model refusal, not a bug. |
| `PROFILE_LOCKED` | Another session holds the browser. Report and stop. |
| `CHROME_MISSING` | Tell the user to install Chrome or run `make build`. |

## Self-heal, exactly once

On `SELECTOR_MISS`:

1. Read the JSON file at `error.probe`. It lists candidate elements with
   `testid`, `role`, `name`, `text` and `css`.
2. Pick the candidate that matches `error.selector_key`.
3. Merge it into `~/.gpt-imagegen/selectors.json` under that key, at the front
   of the list. Preserve the other keys in that file.
4. Re-run the original command **once**.

If the second run also fails, stop and report, quoting `error.probe`. Never
loop.
```

- [ ] **Step 4: Write the slash commands**

Create `plugins/gpt-imagegen/commands/image.md`:

```markdown
---
description: Generate an image with ChatGPT and save it into the project
---

Generate an image for: $ARGUMENTS

Run `${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen generate --prompt "<expanded prompt>" --out <path>`,
choosing a sensible project-relative path. Expand the user's words into a
detailed prompt covering subject, style, palette and background. Parse the JSON
on stdout and report the saved path. Follow the gpt-imagegen skill for error
handling.
```

Create `plugins/gpt-imagegen/commands/edit.md`:

```markdown
---
description: Edit an existing image with a natural-language instruction
---

Edit an image. Arguments: $ARGUMENTS (expected: a path, then the instruction)

Run `${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen edit --image <path> --prompt "<instruction>" --out <new path>`.
Never overwrite the source image unless the user asked for that. Follow the
gpt-imagegen skill for error handling.
```

Create `plugins/gpt-imagegen/commands/setup.md`:

```markdown
---
description: One-time ChatGPT sign-in for image generation
---

Run `${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen setup`.

A Chrome window opens on a dedicated profile. Tell the user to sign in to
ChatGPT there; the command polls for up to 10 minutes and exits when the
session is live. Explain that this is needed once, not per image.
```

Create `plugins/gpt-imagegen/commands/doctor.md`:

```markdown
---
description: Check Chrome, profile, and ChatGPT auth for image generation
---

Run `${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen doctor` and report what is
wrong in plain language. If it reports `NOT_LOGGED_IN`, point the user at
`/gpt-imagegen:setup`.
```

- [ ] **Step 5: Verify the packaging**

Run:

```bash
chmod +x plugins/gpt-imagegen/scripts/gpt-imagegen
make build
./plugins/gpt-imagegen/scripts/gpt-imagegen wat
python3 -c "import json;[json.load(open(p)) for p in ['.claude-plugin/marketplace.json','plugins/gpt-imagegen/.claude-plugin/plugin.json']];print('manifests valid')"
```

Expected: one JSON line with `"ok":false`, then `manifests valid`.

- [ ] **Step 6: Commit**

```bash
git add Makefile .claude-plugin plugins/
git commit -m "feat: plugin packaging, skill and slash commands"
```

---

### Task 14: Fixture regression test and live smoke

The fixture test is the one that earns its keep: it catches ChatGPT DOM drift without touching the network.

**Files:**
- Create: `tests/fixtures/conversation.html`
- Create: `tests/fixture_test.go`
- Create: `tests/live/live_test.go`

**Interfaces:**
- Consumes: `selectors.Load`, `compose.Resolve`, `compose.ReadState`, `compose.Done`.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/conversation.html`. It reproduces the structure the spike observed on a finished generation:

```html
<!doctype html>
<html><body>
  <button data-testid="create-new-chat-button">New chat</button>
  <div data-testid="conversation-turn-1">prompt text</div>
  <div data-testid="conversation-turn-2">
    <img alt="Generated image: Geometric Teal Mountain Emblem"
         src="https://chatgpt.com/backend-api/estuary/content?id=file_00000000e7148208927dc5bbece7a546&ts=1&p=fs&cid=1&sig=abc&v=0">
    <img alt=""
         src="https://chatgpt.com/backend-api/estuary/content?id=file_00000000e7148208927dc5bbece7a546&ts=1&p=fs&cid=1&sig=abc&v=0">
  </div>
  <button data-testid="conversation-options-button">Options</button>
  <div id="prompt-textarea" contenteditable="true"></div>
  <input type="file" data-testid="upload-photos-input">
</body></html>
```

- [ ] **Step 2: Write the failing test**

Create `tests/fixture_test.go`:

```go
package tests

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"

	"github.com/jheelr/gpt-imagegen/internal/compose"
	"github.com/jheelr/gpt-imagegen/internal/selectors"
	"github.com/jheelr/gpt-imagegen/internal/session"
)

// fixturePage loads the saved conversation offline. It uses whatever Chrome
// the machine has; no network and no ChatGPT account are involved.
func fixturePage(t *testing.T) (*rod.Page, func()) {
	t.Helper()
	bin, err := session.ChromePath()
	if err != nil {
		t.Skipf("chrome not available: %v", err)
	}
	l := launcher.New().Bin(bin).Headless(true)
	u, err := l.Launch()
	if err != nil {
		t.Skipf("cannot launch chrome: %v", err)
	}
	b := rod.New().ControlURL(u)
	if err := b.Connect(); err != nil {
		t.Skipf("cannot connect: %v", err)
	}
	abs, _ := filepath.Abs("fixtures/conversation.html")
	p := b.MustPage("file://" + abs)
	p.MustWaitLoad()
	return p, func() { _ = b.Close(); l.Kill() }
}

func TestSelectorsResolveAgainstFixture(t *testing.T) {
	p, done := fixturePage(t)
	defer done()

	set, err := selectors.Load("")
	if err != nil {
		t.Fatalf("load selectors: %v", err)
	}
	for _, key := range []string{"composer_input", "upload_input", "new_chat_button", "generated_image", "conversation_options"} {
		if _, err := compose.Resolve(p, set, key, 5*time.Second); err != nil {
			t.Errorf("selector %q no longer resolves: %v", key, err)
		}
	}
}

func TestReadStateOnFinishedConversation(t *testing.T) {
	p, done := fixturePage(t)
	defer done()

	st, err := compose.ReadState(p)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	if st.Loading || st.Streaming {
		t.Fatalf("finished conversation must be quiet: %+v", st)
	}
	// Two <img> tags, one underlying generated file.
	if got := st.DistinctImageIDs(); len(got) != 1 {
		t.Fatalf("DistinctImageIDs = %v, want exactly one", got)
	}
	if !compose.Done(st, 1) {
		t.Fatal("Done must be true for a finished single-image conversation")
	}
	if compose.Done(st, 2) {
		t.Fatal("Done must be false when a set of 2 was requested but 1 arrived")
	}
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `go test ./tests/ -v`
Expected: PASS, or SKIP if Chrome is unavailable. If a selector fails to resolve, that is the drift signal this test exists to produce.

- [ ] **Step 4: Write the opt-in live smoke**

Create `tests/live/live_test.go`:

```go
package live

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestLiveGenerate performs one real generation. It costs a real ChatGPT turn
// against the user's account, so it never runs unless explicitly enabled.
func TestLiveGenerate(t *testing.T) {
	if os.Getenv("GPT_IMAGEGEN_LIVE") != "1" {
		t.Skip("set GPT_IMAGEGEN_LIVE=1 to run the live smoke")
	}
	out := filepath.Join(t.TempDir(), "smoke.png")
	cmd := exec.Command("../../plugins/gpt-imagegen/bin/gpt-imagegen",
		"generate", "--prompt", "a plain solid teal square, no text", "--out", out)
	stdout, err := cmd.Output()
	if err != nil {
		t.Fatalf("run: %v (stdout=%s)", err, stdout)
	}
	var r struct {
		OK     bool `json:"ok"`
		Images []struct {
			Path  string `json:"path"`
			Bytes int    `json:"bytes"`
		} `json:"images"`
	}
	if err := json.Unmarshal(stdout, &r); err != nil {
		t.Fatalf("stdout not JSON: %s", stdout)
	}
	if !r.OK || len(r.Images) != 1 {
		t.Fatalf("unexpected result: %s", stdout)
	}
	fi, err := os.Stat(r.Images[0].Path)
	if err != nil || fi.Size() < 1000 {
		t.Fatalf("no real image written: %v", err)
	}
}
```

- [ ] **Step 5: Verify the smoke skips by default**

Run: `go test ./tests/live/ -v`
Expected: SKIP with "set GPT_IMAGEGEN_LIVE=1".

- [ ] **Step 6: Full verification and commit**

```bash
go vet ./...
go test ./... 
make build
git add tests/
git commit -m "test: fixture regression for DOM drift and opt-in live smoke"
```

Expected: `go vet` clean, all tests PASS or SKIP, binary builds.

---

## Post-implementation verification

Before declaring the plugin done, confirm each of these by running it, not by reading code:

- [ ] `go test ./...` passes.
- [ ] `make build` produces `plugins/gpt-imagegen/bin/gpt-imagegen`.
- [ ] `./plugins/gpt-imagegen/scripts/gpt-imagegen doctor` reports auth ok.
- [ ] `GPT_IMAGEGEN_LIVE=1 make smoke` writes a real image.
- [ ] `~/.gpt-imagegen/profile` still exists after every run above. This is the regression guard for the `launcher.Cleanup()` bug.
- [ ] Running two generations concurrently produces one success and one `PROFILE_LOCKED`, not two corrupted composers.
- [ ] Deleting `~/.gpt-imagegen/selectors.json` leaves the plugin working on embedded defaults.
- [ ] A successful run reports `"archived": true` and the conversation is gone from the ChatGPT sidebar.
- [ ] A failed run reports `archived` absent and its conversation is still present, so it can be recovered.
