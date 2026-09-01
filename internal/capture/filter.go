// Package capture pulls generated image bytes out of a ChatGPT conversation.
// It is deliberately DOM-free so it survives UI redesigns that break compose.
package capture

import (
	"net/url"
	"strings"
)

// generatedPath is the same-origin, cookie-authenticated endpoint ChatGPT
// serves generated images from. Verified by spike, 2026-09-01.
const generatedPath = "/backend-api/estuary/content"

// IsGeneratedImageURL reports whether a URL is a generated image rather than
// ChatGPT's own UI furniture. Matching on path, not size: the spike showed a
// size heuristic captures sprite sheets and avatars.
func IsGeneratedImageURL(u string) bool {
	if u == "" {
		return false
	}
	parsed, err := url.Parse(u)
	if err != nil {
		return false
	}
	return parsed.Path == generatedPath && parsed.Query().Get("id") != ""
}

// FileIDFromURL returns the file_... id, used to tell distinct images apart
// when generating a set. Returns "" if the URL is not a generated image.
func FileIDFromURL(u string) string {
	if !IsGeneratedImageURL(u) {
		return ""
	}
	parsed, err := url.Parse(u)
	if err != nil {
		return ""
	}
	id := parsed.Query().Get("id")
	if !strings.HasPrefix(id, "file_") {
		return ""
	}
	return id
}
