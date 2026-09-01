# gpt-imagegen

Generate and edit images by driving a signed-in ChatGPT browser session with a
real (visible, on first sign-in) Chrome instance. Images are billed against
the user's ChatGPT plan, not an API key.

This repo is both a standalone Go CLI (`cmd/gpt-imagegen`) and a Claude Code
plugin (`plugins/gpt-imagegen`) that wraps that CLI with a launcher shim, an
auto-triggering skill, and slash commands.

## Installing as a Claude Code plugin

Add this repo as a marketplace and install the `gpt-imagegen` plugin, then
build the binary once:

```bash
make build
./plugins/gpt-imagegen/scripts/gpt-imagegen doctor
```

The binary is built to `plugins/gpt-imagegen/bin/gpt-imagegen` and is not
committed to git; `make build` (or `make clean` to remove it) is the only way
to produce or remove it locally.

## CLI surface

```
gpt-imagegen setup
gpt-imagegen doctor
gpt-imagegen generate --prompt "<text>" --out <path> [--count N] [--ref FILE ...]
gpt-imagegen edit --image <path> --prompt "<text>" --out <path>
gpt-imagegen probe --stage <name>
```

stdout is always exactly one line of JSON (see `internal/envelope`); all
progress and warnings are written to stderr. Callers must parse stdout and
branch on `error.code`, never on message text.

- `setup` opens a visible Chrome window on a dedicated profile and waits up
  to 10 minutes for the user to sign in to ChatGPT.
- `doctor` checks Chrome, the profile, and ChatGPT auth without generating
  anything.
- `generate` sends a prompt (optionally with reference images via repeated
  `--ref`) and saves one or more resulting images. `--count` requests more
  than one image from the same conversation, so style and palette match.
- `edit` is `generate` with a single existing image attached as a reference.
- `probe` dumps interactive/image elements from the live ChatGPT page as
  JSON, for diagnosing a `SELECTOR_MISS` without needing a repro.

## Known limitations

- **`RATE_LIMITED` and `CHALLENGE` are declared in the JSON error contract
  but are not emitted by any code path today.** Detection for these two was
  deliberately deferred rather than guessed at, since inventing selectors
  for pages that have never actually been observed by this project would
  just be speculative code that rots. Today:
  - A ChatGPT rate limit surfaces as `TIMEOUT` or `NO_IMAGE_RETURNED`
    instead of `RATE_LIMITED`.
  - A Cloudflare challenge surfaces as `NOT_LOGGED_IN` instead of
    `CHALLENGE`. This still routes the user to `gpt-imagegen setup`
    (`/gpt-imagegen:setup` as a plugin command), whose visible Chrome
    window is where a challenge can actually be solved.

  This does not weaken the no-retry discipline: nothing in this codebase
  retries a generation automatically under any error code, whether or not
  the code was correctly diagnosed.

- **Partial success with `--count N`.** A `generate --count N` run that
  manages to save fewer than N images still exits 0 with `"ok":true`; the
  shortfall is reported only as a warning on stderr, not as part of the JSON
  result. Callers that care about getting exactly N images must compare
  `len(images)` in the JSON result against the `--count` they requested.

- **Selector self-heal is user-scoped and additive only.** The override file
  at `~/.gpt-imagegen/selectors.json` is written by `Save`, which persists
  only the keys that differ from the embedded defaults — never the full set.
  A repair must merge into that file's existing JSON object, never replace
  it wholesale, or previously-applied repairs are silently lost. Self-heal
  is also exactly-once: one patch, one retry, then stop; there is no retry
  loop anywhere in this codebase.

## Development

```bash
make build   # build the binary into plugins/gpt-imagegen/bin/
make test    # go test ./...
make smoke   # opt-in live smoke test; costs a real ChatGPT turn (~40s)
make clean   # remove build output
```
