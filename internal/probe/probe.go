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
