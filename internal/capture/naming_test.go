package capture

import (
	"path/filepath"
	"testing"
)

func TestTitleFromAlt(t *testing.T) {
	// Real alt text captured by the spike.
	if got := TitleFromAlt("Generated image: Geometric Teal Mountain Emblem"); got != "Geometric Teal Mountain Emblem" {
		t.Fatalf("got %q", got)
	}
	if got := TitleFromAlt(""); got != "" {
		t.Fatalf("got %q", got)
	}
	if got := TitleFromAlt("some other alt"); got != "" {
		t.Fatalf("non-generated alt must yield empty, got %q", got)
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Geometric Teal Mountain Emblem": "geometric-teal-mountain-emblem",
		"  Spaced   Out  ":               "spaced-out",
		"Punctuation!! & Symbols":        "punctuation-symbols",
		"":                               "",
	}
	for in, want := range cases {
		if got := Slugify(in); got != want {
			t.Fatalf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestOutputPathNumbersSiblings(t *testing.T) {
	if got := OutputPath("/a/hero.png", 0, "T", ".png"); got != "/a/hero.png" {
		t.Fatalf("index 0 must be verbatim, got %q", got)
	}
	if got := OutputPath("/a/hero.png", 1, "T", ".png"); got != "/a/hero-2.png" {
		t.Fatalf("index 1 = %q, want /a/hero-2.png", got)
	}
	if got := OutputPath("/a/hero.png", 2, "T", ".png"); got != "/a/hero-3.png" {
		t.Fatalf("index 2 = %q, want /a/hero-3.png", got)
	}
}

func TestOutputPathIntoDirectory(t *testing.T) {
	dir := t.TempDir()
	got := OutputPath(dir, 0, "Geometric Teal Mountain Emblem", ".png")
	want := filepath.Join(dir, "geometric-teal-mountain-emblem.png")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	got = OutputPath(dir, 0, "", ".png")
	if want := filepath.Join(dir, "image.png"); got != want {
		t.Fatalf("empty title fallback = %q, want %q", got, want)
	}
}
