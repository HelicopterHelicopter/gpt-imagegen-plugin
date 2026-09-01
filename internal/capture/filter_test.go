package capture

import "testing"

// Real URL captured by the spike from a finished generation.
const genURL = "https://chatgpt.com/backend-api/estuary/content?id=file_00000000e7148208927dc5bbece7a546&ts=496736&p=fs&cid=1&sig=88d3f46f4ff9b2c50cfcde0c8e819b36e6bd286c16c28191fd12097ea8afdeab&v=0"

func TestIsGeneratedImageURL(t *testing.T) {
	cases := []struct {
		name string
		url  string
		want bool
	}{
		{"generated image", genURL, true},
		{"sprite sheet", "https://chatgpt.com/cdn/assets/sprites-shell-097001e7.svg", false},
		{"sprites core", "https://chatgpt.com/cdn/assets/sprites-core-9b910f5e.svg", false},
		{"watercolor bg", "https://chatgpt.com/cdn/assets/watercolor-cxf1rp88.webp", false},
		{"favicon", "https://chatgpt.com/cdn/assets/favicon-l4nq08hd.svg", false},
		{"google avatar", "https://lh3.googleusercontent.com/a/ACg8ocLLmCTS11F6i2Dfz40Uj5DGahctKK4ds69P8cDsFAyhLSJ2=s96-c", false},
		{"auth0 avatar", "https://cdn.auth0.com/avatars/jr.png", false},
		{"ecosystem icon", "https://chatgpt.com/images/ecosystem/apps/slack/icon.png", false},
		{"empty", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsGeneratedImageURL(c.url); got != c.want {
				t.Fatalf("IsGeneratedImageURL(%q) = %v, want %v", c.url, got, c.want)
			}
		})
	}
}

func TestFileIDFromURL(t *testing.T) {
	if got := FileIDFromURL(genURL); got != "file_00000000e7148208927dc5bbece7a546" {
		t.Fatalf("FileIDFromURL = %q", got)
	}
	if got := FileIDFromURL("https://chatgpt.com/cdn/assets/x.svg"); got != "" {
		t.Fatalf("want empty for non-generated url, got %q", got)
	}
}
