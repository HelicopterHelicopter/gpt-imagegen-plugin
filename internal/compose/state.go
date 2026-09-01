// Package compose drives the ChatGPT composer. This file holds the pure
// decision logic so completion rules are unit-tested, not discovered live.
package compose

import (
	"encoding/json"

	"github.com/jheel-knot/gpt-imagegen-plugin/internal/capture"
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

// AltForID returns the alt text of the first <img> whose src maps to id, or
// "" if none. ImageURLs and Alts are parallel per-tag arrays (one entry per
// <img>, not per distinct image), so pairing must walk them together by
// index; indexing Alts with a position taken from the deduplicated id list
// (DistinctImageIDs) is wrong once a generated image is rendered through
// more than one <img> tag, which is the common case.
func (s PageState) AltForID(id string) string {
	if id == "" {
		return ""
	}
	for i, u := range s.ImageURLs {
		if capture.FileIDFromURL(u) != id {
			continue
		}
		if i < len(s.Alts) {
			return s.Alts[i]
		}
		return ""
	}
	return ""
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
