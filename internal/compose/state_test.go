package compose

import "testing"

const oneImage = `{"loading":false,"streaming":false,
"imageURLs":["https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs&sig=x"],
"alts":["Generated image: Teal Mountain"]}`

func TestParseState(t *testing.T) {
	s, err := ParseState([]byte(oneImage))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if s.Loading || s.Streaming {
		t.Fatalf("flags wrong: %+v", s)
	}
	if len(s.ImageURLs) != 1 {
		t.Fatalf("images = %v", s.ImageURLs)
	}
}

func TestDistinctImageIDs(t *testing.T) {
	// The spike saw the same generated image rendered by three <img> tags.
	s := PageState{ImageURLs: []string{
		"https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs",
		"https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs",
		"https://chatgpt.com/backend-api/estuary/content?id=file_bbb&p=fs",
		"https://chatgpt.com/cdn/assets/favicon-x.svg",
	}}
	got := s.DistinctImageIDs()
	if len(got) != 2 || got[0] != "file_aaa" || got[1] != "file_bbb" {
		t.Fatalf("DistinctImageIDs = %v, want [file_aaa file_bbb]", got)
	}
}

// TestAltForID_DriftCase is the exact drift scenario: a generated image
// rendered through two <img> tags (file_aaa twice) followed by a second
// distinct image (file_bbb). DistinctImageIDs collapses this to
// [file_aaa, file_bbb], but Alts stays parallel to the raw, undeduplicated
// ImageURLs ([Foo, Foo, Bar]). An index-based lookup (Alts[i] where i is the
// position in the deduplicated id list) gives file_bbb -> Alts[1] == "Foo",
// which is wrong: file_bbb's own alt is Alts[2] == "Bar".
func TestAltForID_DriftCase(t *testing.T) {
	s := PageState{
		ImageURLs: []string{
			"https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs",
			"https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs",
			"https://chatgpt.com/backend-api/estuary/content?id=file_bbb&p=fs",
		},
		Alts: []string{
			"Generated image: Foo",
			"Generated image: Foo",
			"Generated image: Bar",
		},
	}
	if got := s.AltForID("file_aaa"); got != "Generated image: Foo" {
		t.Fatalf("AltForID(file_aaa) = %q, want %q", got, "Generated image: Foo")
	}
	if got := s.AltForID("file_bbb"); got != "Generated image: Bar" {
		t.Fatalf("AltForID(file_bbb) = %q, want %q", got, "Generated image: Bar")
	}
}

func TestAltForID_UnknownIDReturnsEmpty(t *testing.T) {
	s := PageState{
		ImageURLs: []string{"https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs"},
		Alts:      []string{"Generated image: Foo"},
	}
	if got := s.AltForID("file_zzz"); got != "" {
		t.Fatalf("AltForID(unknown) = %q, want empty", got)
	}
}

func TestAltForID_AltsShorterThanImageURLsDoesNotPanic(t *testing.T) {
	s := PageState{
		ImageURLs: []string{
			"https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs",
			"https://chatgpt.com/backend-api/estuary/content?id=file_bbb&p=fs",
		},
		Alts: []string{"Generated image: Foo"}, // shorter than ImageURLs
	}
	if got := s.AltForID("file_aaa"); got != "Generated image: Foo" {
		t.Fatalf("AltForID(file_aaa) = %q, want %q", got, "Generated image: Foo")
	}
	if got := s.AltForID("file_bbb"); got != "" {
		t.Fatalf("AltForID(file_bbb) = %q, want empty (Alts too short)", got)
	}
}

// TestAltForID_NonGeneratedURLInterleaved guards against a non-generated tag
// (a favicon, which FileIDFromURL maps to "") shifting the pairing between
// generated ids and their alts.
func TestAltForID_NonGeneratedURLInterleaved(t *testing.T) {
	s := PageState{
		ImageURLs: []string{
			"https://chatgpt.com/cdn/assets/favicon-x.svg",
			"https://chatgpt.com/backend-api/estuary/content?id=file_aaa&p=fs",
			"https://chatgpt.com/backend-api/estuary/content?id=file_bbb&p=fs",
		},
		Alts: []string{
			"",
			"Generated image: Foo",
			"Generated image: Bar",
		},
	}
	if got := s.AltForID("file_aaa"); got != "Generated image: Foo" {
		t.Fatalf("AltForID(file_aaa) = %q, want %q", got, "Generated image: Foo")
	}
	if got := s.AltForID("file_bbb"); got != "Generated image: Bar" {
		t.Fatalf("AltForID(file_bbb) = %q, want %q", got, "Generated image: Bar")
	}
}

func TestDoneRequiresQuietAndEnoughImages(t *testing.T) {
	img := func(n int) []string {
		var out []string
		for i := 0; i < n; i++ {
			out = append(out, "https://chatgpt.com/backend-api/estuary/content?id=file_"+string(rune('a'+i))+"&p=fs")
		}
		return out
	}
	cases := []struct {
		name string
		s    PageState
		want int
		done bool
	}{
		{"still loading", PageState{Loading: true, ImageURLs: img(1)}, 1, false},
		{"still streaming", PageState{Streaming: true, ImageURLs: img(1)}, 1, false},
		{"quiet but no image", PageState{}, 1, false},
		{"quiet with image", PageState{ImageURLs: img(1)}, 1, true},
		{"set incomplete", PageState{ImageURLs: img(2)}, 3, false},
		{"set complete", PageState{ImageURLs: img(3)}, 3, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Done(c.s, c.want); got != c.done {
				t.Fatalf("Done = %v, want %v", got, c.done)
			}
		})
	}
}
