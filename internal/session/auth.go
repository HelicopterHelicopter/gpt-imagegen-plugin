package session

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

// AuthState is the safe-to-log view of /api/auth/session. The raw payload
// carries accessToken and sessionToken, so only key names are retained.
type AuthState struct {
	LoggedIn bool
	Keys     []string
}

func ParseAuthBody(body []byte) (AuthState, error) {
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return AuthState{}, errors.New("auth endpoint did not return JSON")
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	u, ok := m["user"]
	return AuthState{LoggedIn: ok && u != nil, Keys: keys}, nil
}

// Summary is deliberately keys-only. Never add values to this.
func (a AuthState) Summary() string { return strings.Join(a.Keys, ",") }
