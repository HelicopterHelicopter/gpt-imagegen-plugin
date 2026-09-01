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
		// Any other Send failure, including an attachment that never
		// finished uploading, is a timeout from the caller's perspective:
		// nothing was sent, so there is nothing to recover.
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
