package session

import (
	"strings"
	"testing"
)

func TestParseAuthBodyLoggedOut(t *testing.T) {
	// Exact logged-out shape observed by the spike.
	st, err := ParseAuthBody([]byte(`{"WARNING_BANNER":"DO NOT SHARE"}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if st.LoggedIn {
		t.Fatal("no user key must mean logged out")
	}
	if st.Summary() != "WARNING_BANNER" {
		t.Fatalf("summary = %q", st.Summary())
	}
}

func TestParseAuthBodyLoggedInNeverLeaksValues(t *testing.T) {
	body := []byte(`{"WARNING_BANNER":"x","accessToken":"SECRET-ACCESS","sessionToken":"SECRET-SESSION","user":{"email":"a@b.c"},"expires":"2026-10-01"}`)
	st, err := ParseAuthBody(body)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !st.LoggedIn {
		t.Fatal("user key present must mean logged in")
	}
	s := st.Summary()
	for _, secret := range []string{"SECRET-ACCESS", "SECRET-SESSION", "a@b.c"} {
		if strings.Contains(s, secret) {
			t.Fatalf("summary leaked a value: %q", s)
		}
	}
	if want := "WARNING_BANNER,accessToken,expires,sessionToken,user"; s != want {
		t.Fatalf("summary = %q, want sorted keys %q", s, want)
	}
}

func TestParseAuthBodyNullUserIsLoggedOut(t *testing.T) {
	st, err := ParseAuthBody([]byte(`{"user":null}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if st.LoggedIn {
		t.Fatal("null user must mean logged out")
	}
}

func TestParseAuthBodyNonJSON(t *testing.T) {
	if _, err := ParseAuthBody([]byte("<html>login</html>")); err == nil {
		t.Fatal("non-JSON body must error so the caller reports NOT_LOGGED_IN")
	}
}
