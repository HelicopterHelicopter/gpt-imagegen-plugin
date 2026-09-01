package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"

	"github.com/jheel-knot/gpt-imagegen-plugin/internal/capture"
	"github.com/jheel-knot/gpt-imagegen-plugin/internal/compose"
	"github.com/jheel-knot/gpt-imagegen-plugin/internal/envelope"
	"github.com/jheel-knot/gpt-imagegen-plugin/internal/probe"
	"github.com/jheel-knot/gpt-imagegen-plugin/internal/selectors"
	"github.com/jheel-knot/gpt-imagegen-plugin/internal/session"
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

// Window policy, named rather than passed as bare booleans, because getting
// it wrong is invisible in a diff and catastrophic in use: hiding the setup
// window moves the sign-in (and any Cloudflare challenge) to {-9000,-9000}
// while the CLI cheerfully tells the user to sign in "in the Chrome window".
// Spec S6 step 5 scopes offscreen positioning to the GENERATION session
// only.
const (
	// headless is never true in normal operation: it is the strongest
	// bot-detection signal there is (spec S6 step 5).
	headful = false

	// visibleWindow is for any session a human must look at or touch.
	visibleWindow = false
	// hiddenWindow is for sessions no human ever sees.
	hiddenWindow = true
)

// Stage names for probe dumps and failure envelopes. They are literals
// chosen here, never user input, so they are safe as file-name components.
const (
	stageComposer   = "composer"
	stageGeneration = "generation"
)

// openBrowser is the seam every command opens its browser through. It exists
// so a unit test can assert what a command ASKS for -- notably that setup
// asks for a visible window -- without launching Chrome.
var openBrowser = session.Open

// writeScreenshot saves a PNG of the page next to the probe dump and returns
// its path, or "" if the capture failed. A screenshot is only worth taking
// on a selector miss, where the whole question is "what does the page
// actually look like now"; failing to take one must never fail the run,
// which is why every error here degrades to an empty path.
func writeScreenshot(p *rod.Page, stage, dir string) string {
	buf, err := p.Timeout(20*time.Second).Screenshot(false, nil)
	if err != nil || len(buf) == 0 {
		return ""
	}
	path := filepath.Join(dir, "fail-"+stage+".png")
	if err := os.WriteFile(path, buf, 0o600); err != nil {
		return ""
	}
	return path
}

// selectorMissResult builds the one failure the skill is allowed to repair:
// the probe dump it reads candidates from, the key it must patch, and a
// screenshot of the page as it actually was. stage is always a caller-side
// literal, never user input.
func selectorMissResult(p *rod.Page, miss compose.ErrSelectorMiss, stage string) envelope.Result {
	dir := artifactDir()
	probePath, _ := probe.Capture(p, stage, dir)
	r := envelope.Failure(envelope.CodeSelectorMiss, miss.Error())
	r.Error.SelectorKey = miss.Key
	r.Error.Stage = stage
	r.Error.Probe = probePath
	r.Error.Screenshot = writeScreenshot(p, stage, dir)
	return r
}

func cmdSetup(stdout, stderr io.Writer) int {
	// visibleWindow is load-bearing here, not a preference: this is the
	// window the user signs in through, and the one a Cloudflare challenge
	// has to be solved in.
	b, err := openBrowser(headful, visibleWindow)
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
	// doctor is a diagnostic a human runs and watches, so it stays visible:
	// seeing the real page is half the diagnosis.
	b, err := openBrowser(headful, visibleWindow)
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
	// Nobody watches a probe run; it only dumps the DOM.
	b, err := openBrowser(headful, hiddenWindow)
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
	r.Error.Screenshot = writeScreenshot(p, "probe", artifactDir())
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

	// selectors.UserPath can fail to resolve (e.g. no home dir). A silent
	// fallback to embedded defaults would disable self-heal without anyone
	// noticing, so surface it as a refusal instead of loading defaults.
	userPath, err := selectors.UserPath()
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeRefused, "resolve selectors path: "+err.Error()))
	}
	sel, err := selectors.Load(userPath)
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeRefused, err.Error()))
	}

	// The generation session is the ONLY one that hides its window: no
	// human ever looks at it, and it must not steal focus mid-task.
	b, err := openBrowser(headful, hiddenWindow)
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
		// errors.As, not a bare type assertion: an attachment timeout is
		// now an ErrSelectorMiss (attachment_remove) and a future wrap
		// must not silently demote it to TIMEOUT and put it out of
		// self-heal's reach.
		var miss compose.ErrSelectorMiss
		if errors.As(err, &miss) {
			return emit(stdout, selectorMissResult(p, miss, stageComposer))
		}
		// Any other Send failure is a timeout from the caller's
		// perspective: nothing was sent, so there is nothing to recover.
		return emit(stdout, envelope.Failure(envelope.CodeTimeout, err.Error()))
	}

	convURL := ""
	if info, err := p.Info(); err == nil {
		convURL = info.URL
	}

	// WaitDone deliberately returns the LAST observed state alongside its
	// error. waitErr is kept, not returned on, precisely so the salvage
	// path below can still read that state: a run that produced images but
	// tripped the deadline has already spent the ChatGPT turn, and under a
	// no-retry discipline throwing those images away is the worst outcome
	// available.
	state, waitErr := compose.WaitDone(p, sel, count, 6*time.Minute)
	if info, ierr := p.Info(); ierr == nil {
		convURL = info.URL
	}
	timedOut := false
	if waitErr != nil {
		var miss compose.ErrSelectorMiss
		if errors.As(waitErr, &miss) {
			// A completion selector with no usable candidate: repairable,
			// so report it as SELECTOR_MISS with a probe rather than
			// burying it in a TIMEOUT.
			return emit(stdout, selectorMissResult(p, miss, stageGeneration).WithConversation(convURL))
		}
		timedOut = true
		fmt.Fprintf(stderr, "generation did not signal completion (%v); salvaging whatever arrived\n", waitErr)
	}

	ids := state.DistinctImageIDs()
	if len(ids) == 0 {
		if timedOut {
			return emit(stdout, envelope.Failure(envelope.CodeTimeout, waitErr.Error()).WithConversation(convURL))
		}
		return emit(stdout, envelope.Failure(envelope.CodeNoImage, "no generated image in the response").WithConversation(convURL))
	}

	images, err := saveImages(p, rec, state, ids, out, stderr)
	if err != nil {
		return emit(stdout, envelope.Failure(envelope.CodeRefused, err.Error()).WithConversation(convURL))
	}

	if len(images) == 0 {
		if timedOut {
			return emit(stdout, envelope.Failure(envelope.CodeTimeout, waitErr.Error()).WithConversation(convURL))
		}
		return emit(stdout, envelope.Failure(envelope.CodeNoImage, "image bytes could not be retrieved").WithConversation(convURL))
	}

	if timedOut {
		// Salvaged run: real images on disk, so ok:true with exactly the
		// images that exist. Deliberately NOT archived -- the conversation
		// is the recovery path for the images that never arrived.
		fmt.Fprintf(stderr, "warning: run timed out (%v) and saved %d of %d requested images; the conversation is left unarchived at %s for recovery\n",
			waitErr, len(images), count, convURL)
		return emit(stdout, envelope.Success(images, convURL, false, time.Since(start).Seconds()))
	}

	// A partial save is still ok:true (the schema is unchanged; the caller
	// already knows what it asked for and can compare len(images) to
	// count), but silently shipping fewer images than requested deserves a
	// visible warning. stdout stays exactly one line; this goes to stderr.
	if len(images) < count {
		fmt.Fprintf(stderr, "warning: saved %d of %d requested images\n", len(images), count)
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

// saveImages writes every generated image it can actually retrieve and
// returns the envelope entries for them. It is shared by the success path
// and the timeout-salvage path so the two can never drift: salvaging is the
// SAME save, just without the archive step afterwards. The only error it
// returns is a genuine filesystem failure; an image whose bytes cannot be
// retrieved is skipped, leaving a shorter list rather than failing the run.
func saveImages(p *rod.Page, rec *capture.Recorder, state compose.PageState, ids []string, out string, stderr io.Writer) ([]envelope.Image, error) {
	files := rec.Files()
	var images []envelope.Image
	for i, id := range ids {
		data := files[id]
		if len(data) == 0 {
			// Fallback: the CDP buffer was evicted, so refetch from page
			// context. rec.URL(id) is the preferred source: the recorder
			// keeps url+mime metadata even when the body fetch failed.
			// Only fall back to scanning the DOM-reported image URLs if the
			// recorder never saw this id at all.
			srcURL := rec.URL(id)
			if srcURL == "" {
				for _, u := range state.ImageURLs {
					if capture.FileIDFromURL(u) == id {
						srcURL = u
						break
					}
				}
			}
			if srcURL != "" {
				if d, ferr := capture.FetchInPage(p, srcURL); ferr == nil {
					data = d
				}
			}
		}
		if len(data) == 0 {
			continue
		}
		// Alts is parallel to the raw, per-tag ImageURLs, not to the
		// deduplicated ids: AltForID walks ImageURLs itself to find the
		// alt that actually belongs to this id, rather than indexing Alts
		// by this id's position in the deduplicated list.
		title := capture.TitleFromAlt(state.AltForID(id))
		ext := capture.ExtFor(rec.Mime(id))
		dst := capture.OutputPath(out, i, title, ext)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return images, err
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return images, err
		}
		w, h, _ := capture.Dimensions(data)
		images = append(images, envelope.Image{Path: dst, Bytes: len(data), Width: w, Height: h, Title: title})
		fmt.Fprintf(stderr, "saved %s (%d bytes)\n", dst, len(data))
	}
	return images, nil
}
