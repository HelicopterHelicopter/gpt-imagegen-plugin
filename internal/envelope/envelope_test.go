package envelope

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestSuccessWritesSingleJSONLine(t *testing.T) {
	r := Success([]Image{{Path: "/abs/hero.png", Bytes: 184203, Width: 1536, Height: 1024, Title: "Teal Mountain"}},
		"https://chatgpt.com/c/abc", true, 41.2)
	var buf bytes.Buffer
	if err := r.Write(&buf); err != nil {
		t.Fatalf("write: %v", err)
	}
	out := buf.String()
	if strings.Count(out, "\n") != 1 || !strings.HasSuffix(out, "\n") {
		t.Fatalf("want exactly one trailing newline, got %q", out)
	}
	var back Result
	if err := json.Unmarshal([]byte(out), &back); err != nil {
		t.Fatalf("not valid json: %v", err)
	}
	if !back.OK || len(back.Images) != 1 || back.Images[0].Bytes != 184203 {
		t.Fatalf("round trip lost data: %+v", back)
	}
	if back.Error != nil {
		t.Fatalf("success must omit error, got %+v", back.Error)
	}
	if r.ExitCode() != 0 {
		t.Fatalf("success exit code = %d, want 0", r.ExitCode())
	}
}

func TestFailureOmitsImagesAndCarriesCode(t *testing.T) {
	r := Failure(CodeRateLimited, "hit the cap").WithConversation("https://chatgpt.com/c/xyz")
	var buf bytes.Buffer
	if err := r.Write(&buf); err != nil {
		t.Fatalf("write: %v", err)
	}
	if strings.Contains(buf.String(), `"images"`) {
		t.Fatalf("failure must omit images, got %s", buf.String())
	}
	var back Result
	if err := json.Unmarshal(buf.Bytes(), &back); err != nil {
		t.Fatalf("not valid json: %v", err)
	}
	if back.OK {
		t.Fatal("failure must have ok=false")
	}
	if back.Error.Code != CodeRateLimited {
		t.Fatalf("code = %q, want %q", back.Error.Code, CodeRateLimited)
	}
	if back.Error.ConversationURL != "https://chatgpt.com/c/xyz" {
		t.Fatalf("conversation url not carried on failure: %+v", back.Error)
	}
	if r.ExitCode() != 1 {
		t.Fatalf("failure exit code = %d, want 1", r.ExitCode())
	}
}

func TestWithConversationIsolatesFailures(t *testing.T) {
	base := Failure(CodeTimeout, "boom")
	a := base.WithConversation("https://chatgpt.com/c/url-a")
	b := base.WithConversation("https://chatgpt.com/c/url-b")

	if a.Error.ConversationURL != "https://chatgpt.com/c/url-a" {
		t.Fatalf("a.Error.ConversationURL = %q, want %q", a.Error.ConversationURL, "https://chatgpt.com/c/url-a")
	}
	if b.Error.ConversationURL != "https://chatgpt.com/c/url-b" {
		t.Fatalf("b.Error.ConversationURL = %q, want %q", b.Error.ConversationURL, "https://chatgpt.com/c/url-b")
	}
	if base.Error.ConversationURL != "" {
		t.Fatalf("base.Error.ConversationURL = %q, want empty", base.Error.ConversationURL)
	}
}

func TestWithConversationOnSuccess(t *testing.T) {
	r := Success([]Image{}, "https://chatgpt.com/c/conv", false, 1.5)
	r = r.WithConversation("https://chatgpt.com/c/updated")

	if r.ConversationURL != "https://chatgpt.com/c/updated" {
		t.Fatalf("r.ConversationURL = %q, want %q", r.ConversationURL, "https://chatgpt.com/c/updated")
	}
	if r.Error != nil {
		t.Fatalf("success must not have error, got %+v", r.Error)
	}
}
