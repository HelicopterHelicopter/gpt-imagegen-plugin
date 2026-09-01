package compose

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/input"
	"github.com/go-rod/rod/lib/proto"

	"github.com/jheelr/gpt-imagegen/internal/selectors"
)

// ErrSelectorMiss is the one error the CLI turns into SELECTOR_MISS, which
// is the only code the skill may self-heal from. Detail carries optional
// human context (counts, deadlines) without hiding the type: wrapping the
// error in a %w chain would still work through errors.As, but keeping the
// detail inside the value means the message the user sees and the code the
// skill branches on can never drift apart.
type ErrSelectorMiss struct {
	Key    string
	Detail string
}

func (e ErrSelectorMiss) Error() string {
	msg := "no selector matched for " + e.Key
	if e.Detail != "" {
		msg += ": " + e.Detail
	}
	return msg
}

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

// attachUploadTimeout bounds how long Send waits for reference files to
// finish uploading before it fails loudly instead of sending an unattached
// prompt.
const attachUploadTimeout = 60 * time.Second

const attachPollInterval = 500 * time.Millisecond

// countMatchesJS counts elements matching a CSS selector passed as an arg,
// so waitAttachmentsReady can probe each attachment_remove candidate.
const countMatchesJS = `(sel) => document.querySelectorAll(sel).length`

// countRemovalControls returns the highest match count seen across the
// candidate selectors for a key. Candidates are alternates for the same
// control (e.g. a css fallback and a testid), not additive signals, so the
// max avoids double-counting when more than one candidate matches the same
// elements.
func countRemovalControls(p *rod.Page, sels []string) (int, error) {
	max := 0
	for _, sel := range sels {
		res, err := p.Eval(countMatchesJS, sel)
		if err != nil {
			return 0, err
		}
		if n := res.Value.Int(); n > max {
			max = n
		}
	}
	return max, nil
}

// attachmentsReady is the pure decision behind waitAttachmentsReady's poll
// loop, split out so it can be unit-tested without a browser: proceed once
// at least one removal control exists per attached file.
func attachmentsReady(got, want int) bool {
	return got >= want
}

// attachTimeoutErr is what waitAttachmentsReady returns when the upload
// deadline passes. It is an ErrSelectorMiss, not a plain error, on purpose:
// attachment_remove is the ONE selector key with no spike provenance, so a
// wrong selector here is the likeliest failure of the whole edit/--ref path.
// Reporting it as TIMEOUT would put the most probable selector bug in the
// project permanently out of reach of the probe and the skill's one-shot
// self-heal. The observed counts stay in Detail so the human message loses
// nothing.
func attachTimeoutErr(got, want int, timeout time.Duration) error {
	return ErrSelectorMiss{
		Key:    "attachment_remove",
		Detail: fmt.Sprintf("attachments did not finish uploading: saw %d of %d removal controls after %s", got, want, timeout),
	}
}

// waitAttachmentsReady polls for one removal control per attached file --
// that is the signal ChatGPT has actually ingested the file, which is more
// reliable than a filename or a generic upload-progress indicator that can
// lag behind or never appear for a fast upload. It never uses a fixed sleep
// as its completion signal: on timeout it returns a descriptive error
// rather than letting Send silently proceed, because a run that sends with
// an unattached reference produces an image that ignored the reference and
// looks indistinguishable from a bad generation.
func waitAttachmentsReady(p *rod.Page, s selectors.Set, want int, timeout time.Duration) error {
	sels := s.Query("attachment_remove")
	if len(sels) == 0 {
		return ErrSelectorMiss{Key: "attachment_remove"}
	}
	deadline := time.Now().Add(timeout)
	var got int
	for {
		if n, err := countRemovalControls(p, sels); err == nil {
			got = n
			if attachmentsReady(got, want) {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return attachTimeoutErr(got, want, timeout)
		}
		time.Sleep(attachPollInterval)
	}
}

// SelectAllJS selects the full contents of the element it is evaluated
// against ("this"). ChatGPT's composer resolves to a contenteditable <div>
// (#prompt-textarea), not an <input>/<textarea>, so it has no DOM `.select()`
// method -- go-rod's Element.SelectAllText() calls exactly that and throws a
// TypeError on every run against the real page. This JS branches on which
// shape the element actually is: a form field selects the normal way, a
// contenteditable is selected via a Range/Selection, and anything else is
// reported back as false rather than throwing.
//
// Exported (rather than a package-local const) so the offline fixture test
// in tests/fixture_test.go can eval the exact same script go-rod runs in
// production against a real contenteditable composer -- that is what would
// have caught the original SelectAllText() bug.
const SelectAllJS = `() => {
	if (typeof this.select === 'function') { this.select(); return true; }
	if (this.isContentEditable) {
		const r = document.createRange();
		r.selectNodeContents(this);
		const s = window.getSelection();
		s.removeAllRanges();
		s.addRange(r);
		return true;
	}
	return false;
}`

// clearComposer selects any existing composer text so the following Input
// call (CDP InsertText, which inserts at the cursor rather than replacing
// the field) replaces it instead of appending after it. This is purely
// defensive: Send is always called right after NewChat, so the composer is
// normally already empty, and the only case this guards against is a retry
// against a composer that skipped NewChat. Because it is defensive rather
// than load-bearing, a failure here must never fail the run -- it is logged
// to stderr and Send proceeds straight to Input. Returning an error instead
// would mean a harmless clear failure (or, as happened here, a fixable bug
// in the clear JS itself) breaks 100% of generate/edit runs instead of, at
// worst, occasionally concatenating onto leftover text in a rare edge case.
func clearComposer(el *rod.Element) {
	res, err := el.Eval(SelectAllJS)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gpt-imagegen: clear composer text failed, continuing anyway: %v\n", err)
		return
	}
	if !res.Value.Bool() {
		fmt.Fprintln(os.Stderr, "gpt-imagegen: clear composer text: element was neither a form field nor contenteditable, continuing anyway")
	}
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
		if err := waitAttachmentsReady(p, s, len(refs), attachUploadTimeout); err != nil {
			return err
		}
	}
	el, err := Resolve(p, s, "composer_input", 20*time.Second)
	if err != nil {
		return err
	}
	if err := el.Click(proto.InputMouseButtonLeft, 1); err != nil {
		return err
	}
	clearComposer(el)
	if err := el.Input(prompt); err != nil {
		return err
	}
	time.Sleep(800 * time.Millisecond)
	return p.Keyboard.Type(input.Enter)
}

// The three selector keys the completion poll depends on. They are the keys
// most likely to drift, so they live in selectors.json like every other key
// and are read from there: hardcoding them here would mean a rebuild to
// repair the very selectors self-heal exists to repair (spec §4).
const (
	KeyLoadingState   = "loading_state"
	KeyStopButton     = "stop_button"
	KeyGeneratedImage = "generated_image"
)

// stateJSTemplate is completed by stateScript. The three %s holes are filled
// with JSON-encoded selector strings (never raw interpolation), so a quote
// inside a selector cannot escape the literal and break the script.
//
// alts is read from the SAME elements as imageURLs, so the alt-prefix filter
// stays encoded in the generated_image selector itself
// (img[alt^='Generated image: ']) rather than being duplicated here: the two
// arrays are parallel per-tag lists and PageState.AltForID depends on that.
const stateJSTemplate = `() => {
	const imgs = [...document.querySelectorAll(%s)];
	return JSON.stringify({
		loading: !!document.querySelector(%s),
		streaming: !!document.querySelector(%s),
		imageURLs: imgs.map(i => i.src),
		alts: imgs.map(i => i.alt)
	});
}`

// joinQuery collapses a key's ordered candidates into one CSS selector list.
// A selector list is the right shape here because, unlike Resolve, this is a
// presence test rather than a pick: any candidate matching is the signal.
// Note the tradeoff a list carries -- one syntactically invalid candidate
// makes the whole list throw -- which is why a repair must be a valid CSS
// selector, and why a key with no usable candidate is an ErrSelectorMiss the
// skill can self-heal rather than a silent "nothing is loading".
func joinQuery(s selectors.Set, key string) (string, error) {
	qs := s.Query(key)
	if len(qs) == 0 {
		return "", ErrSelectorMiss{Key: key, Detail: "no usable candidate in selectors.json (only testid and css are actionable)"}
	}
	b, err := json.Marshal(strings.Join(qs, ","))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// stateScript builds the completion-poll JS for a selector set.
func stateScript(s selectors.Set) (string, error) {
	img, err := joinQuery(s, KeyGeneratedImage)
	if err != nil {
		return "", err
	}
	loading, err := joinQuery(s, KeyLoadingState)
	if err != nil {
		return "", err
	}
	stop, err := joinQuery(s, KeyStopButton)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf(stateJSTemplate, img, loading, stop), nil
}

func ReadState(p *rod.Page, s selectors.Set) (PageState, error) {
	js, err := stateScript(s)
	if err != nil {
		return PageState{}, err
	}
	return readState(p, js)
}

func readState(p *rod.Page, js string) (PageState, error) {
	res, err := p.Eval(js)
	if err != nil {
		return PageState{}, err
	}
	return ParseState([]byte(res.Value.Str()))
}

// WaitDone polls the DOM completion signals. It never sleeps a fixed duration
// and never returns early on the first image byte. The script is built once,
// up front, so a key with no usable candidate fails immediately as an
// ErrSelectorMiss instead of burning the whole timeout and reporting a
// misleading TIMEOUT.
//
// On timeout it returns the LAST observed state alongside the error: a run
// that produced images but tripped the deadline still has salvageable work,
// and under a no-retry discipline discarding it is the worst outcome
// available. Callers must use the returned state on the error path.
func WaitDone(p *rod.Page, s selectors.Set, want int, timeout time.Duration) (PageState, error) {
	js, err := stateScript(s)
	if err != nil {
		return PageState{}, err
	}
	deadline := time.Now().Add(timeout)
	var last PageState
	for time.Now().Before(deadline) {
		st, err := readState(p, js)
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
	item, err := p.Timeout(8*time.Second).ElementR("div[role='menuitem'], button", "(?i)^archive$")
	if err != nil {
		return fmt.Errorf("archive menu item not found: %w", err)
	}
	return item.Click(proto.InputMouseButtonLeft, 1)
}
