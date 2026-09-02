---
description: One-time ChatGPT sign-in for image generation
---

Run `${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen setup`.

If that reports `error.code: "BINARY_MISSING"`, the `gpt-imagegen` binary
itself isn't installed yet. Offer to run
`${CLAUDE_PLUGIN_ROOT}/scripts/install-release` and explain what it does:
downloads the release binary for this platform from this repo's GitHub
releases, verifies its SHA-256 checksum against the release's own
`SHA256SUMS` file, and installs it to `~/.gpt-imagegen/bin/`. Present this
to the user and get their go-ahead before running it — it is the recommended
path, but it is not silent. If they'd rather build from source, `make build`
is the alternative (requires Go). Once the binary is in place, re-run
`gpt-imagegen setup`.

A Chrome window opens on a dedicated profile. Tell the user to sign in to
ChatGPT there; the command polls for up to 10 minutes and exits when the
session is live. Explain that this is needed once, not per image.
