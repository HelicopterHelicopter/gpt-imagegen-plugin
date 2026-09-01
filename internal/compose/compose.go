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
	item, err := p.Timeout(8*time.Second).ElementR("div[role='menuitem'], button", "(?i)^archive$")
	if err != nil {
		return fmt.Errorf("archive menu item not found: %w", err)
	}
	return item.Click(proto.InputMouseButtonLeft, 1)
}
