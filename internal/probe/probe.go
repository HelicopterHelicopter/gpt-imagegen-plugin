// Package probe dumps candidate elements when a selector misses, so the skill
// can repair selectors.json without a live browser attach.
package probe

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-rod/rod"
)

// Candidate is one element the probe saw. The field split is the whole
// point of this struct: TestID and CSS are the ONLY two fields
// selectors.Candidate understands, so they are the only two that can be
// copied into ~/.gpt-imagegen/selectors.json and change anything. Role,
// Name and Text are informational -- they exist so a human or an agent can
// tell which element is which -- and a "repair" built from them resolves to
// nothing, is written without error, and fails identically on re-run. That
// silent no-op is why DumpNote spells the rule out in the dump itself.
type Candidate struct {
	// Actionable: directly copyable into selectors.json.
	TestID string `json:"testid,omitempty"`
	CSS    string `json:"css,omitempty"`
	// Informational only: never copied into selectors.json.
	Role string `json:"role,omitempty"`
	Name string `json:"name,omitempty"`
	Text string `json:"text,omitempty"`
}

// Actionable reports whether this candidate can actually become a working
// selector. A candidate with neither a testid nor a css is a description of
// an element, not a way to find it.
func (c Candidate) Actionable() bool { return c.TestID != "" || c.CSS != "" }

// DumpNote travels inside every dump so the instructions cannot be
// separated from the data the agent is reading.
const DumpNote = "Only the \"testid\" and \"css\" fields are actionable: they are the only two the selector resolver understands. \"role\", \"name\" and \"text\" are informational and are ignored by the resolver, so a patch built from them silently matches nothing. When patching ~/.gpt-imagegen/selectors.json, write the new candidate FIRST and then repeat the key's existing candidates: the user file replaces a key wholesale, so a single-candidate list discards every shipped fallback."

type Dump struct {
	Stage      string      `json:"stage"`
	URL        string      `json:"url"`
	CapturedAt string      `json:"captured_at"`
	Note       string      `json:"note"`
	Candidates []Candidate `json:"candidates"`
}

// WriteDump writes a probe dump for stage into dir as JSON and returns the
// path written. stage is sanitised to a safe file-name component before it
// is used in the path or recorded in the dump: it is reduced to its base
// name, and any path separator or ".." sequence still present is replaced,
// falling back to "unknown" if nothing safe remains. WriteDump is exported
// and stage may originate from caller-controlled strings, so without this a
// stage like "../../etc/foo" could escape dir (filepath.Join cleans the
// joined path, so the traversal is not caught by Join alone).
func WriteDump(dir, stage, url string, cands []Candidate) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	stage = sanitizeStage(stage)
	d := Dump{Stage: stage, URL: url, CapturedAt: time.Now().UTC().Format(time.RFC3339), Note: DumpNote, Candidates: cands}
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return "", err
	}
	p := filepath.Join(dir, fmt.Sprintf("probe-%s.json", stage))
	return p, os.WriteFile(p, append(b, '\n'), 0o600)
}

// sanitizeStage reduces stage to a safe, single-component file-name
// fragment: filepath.Base drops any leading directories, and any residual
// path separator or ".." sequence is replaced so the result cannot be used
// to traverse out of the directory WriteDump joins it into. An empty or
// still-unsafe result falls back to "unknown".
func sanitizeStage(stage string) string {
	stage = filepath.Base(stage)
	stage = strings.ReplaceAll(stage, string(os.PathSeparator), "_")
	stage = strings.ReplaceAll(stage, "..", "_")
	if stage == "" || stage == "." || stage == string(os.PathSeparator) {
		return "unknown"
	}
	return stage
}

// collectJS enumerates interactive and image elements with everything needed
// to write a new selector.
//
// css is emitted ONLY when it is genuinely selective: an #id or a
// [data-testid=...]. It deliberately never falls back to the bare tag name.
// A candidate of "button" or "div" looks like a repair and behaves like a
// landmine: patched to the front of a key, Resolve returns the FIRST button
// or div on the page, so the tool would type the prompt into an arbitrary
// control and report success. An empty css is strictly better -- a missing
// candidate is visible and safe, a wrong one is neither. An id is emitted
// only when it is a plain CSS identifier, since an id needing escaping
// would produce an invalid selector.
const collectJS = `() => {
	const out = [];
	const sel = 'button,[role=button],textarea,input,div[contenteditable=true],img,[data-testid]';
	const idOK = /^[A-Za-z_-][A-Za-z0-9_-]*$/;
	document.querySelectorAll(sel).forEach(e => {
		const r = e.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return;
		const testid = e.getAttribute('data-testid') || '';
		let css = '';
		if (e.id && idOK.test(e.id)) {
			css = '#' + e.id;
		} else if (testid) {
			css = '[data-testid="' + testid + '"]';
		}
		out.push({
			testid: testid,
			css: css,
			role: e.getAttribute('role') || e.tagName.toLowerCase(),
			name: (e.getAttribute('aria-label') || e.getAttribute('alt') || '').slice(0, 120),
			text: (e.textContent || '').trim().slice(0, 80)
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
