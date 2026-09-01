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
		e := *r.Error          // copy the struct
		e.ConversationURL = url
		r.Error = &e           // point the copy at the returned value only
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
