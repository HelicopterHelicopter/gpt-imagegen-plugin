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
			return fmt.Errorf("attachments did not finish uploading: saw %d of %d removal controls after %s", got, want, timeout)
		}
		time.Sleep(attachPollInterval)
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
	// Clear any leftover text (e.g. a retry against a composer that skipped
	// NewChat) so the prompt replaces it instead of Input appending after it.
	if err := el.SelectAllText(); err != nil {
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
	item, err := p.Timeout(8*time.Second).ElementR("div[role='menuitem'], button", "(?i)^archive$")
	if err != nil {
		return fmt.Errorf("archive menu item not found: %w", err)
	}
	return item.Click(proto.InputMouseButtonLeft, 1)
}
