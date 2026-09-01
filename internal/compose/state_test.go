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
