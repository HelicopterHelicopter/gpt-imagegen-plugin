// Package compose drives the ChatGPT composer. This file holds the pure
// decision logic so completion rules are unit-tested, not discovered live.
package compose

import (
	"encoding/json"

	"github.com/jheelr/gpt-imagegen/internal/capture"
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
