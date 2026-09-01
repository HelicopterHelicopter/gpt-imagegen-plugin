package capture

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

// altPrefix is how ChatGPT labels generated images. Verified by spike.
const altPrefix = "Generated image: "

// TitleFromAlt extracts the model's own title, which makes a good filename.
func TitleFromAlt(alt string) string {
	if !strings.HasPrefix(alt, altPrefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(alt, altPrefix))
}

func Slugify(s string) string {
	var b strings.Builder
	lastDash := true // leading dashes suppressed
	for _, r := range strings.ToLower(s) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				b.WriteRune('-')
				lastDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

// OutputPath resolves where image number index should be written.
func OutputPath(out string, index int, title string, ext string) string {
	if isDir(out) {
		name := Slugify(title)
		if name == "" {
			name = "image"
		}
		if index > 0 {
			name = fmt.Sprintf("%s-%d", name, index+1)
		}
		return filepath.Join(out, name+ext)
	}
	if index == 0 {
		return out
	}
	e := filepath.Ext(out)
	stem := strings.TrimSuffix(out, e)
	return fmt.Sprintf("%s-%d%s", stem, index+1, e)
}

func isDir(p string) bool {
	if strings.HasSuffix(p, string(os.PathSeparator)) {
		return true
	}
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}
