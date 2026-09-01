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
