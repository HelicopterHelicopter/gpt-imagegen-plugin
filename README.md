# gpt-imagegen

Generate and edit images by driving a signed-in ChatGPT browser session with a
real (visible, on first sign-in) Chrome instance. Images are billed against
the user's ChatGPT plan, not an API key.

This repo is both a standalone Go CLI (`cmd/gpt-imagegen`) and a Claude Code
plugin (`plugins/gpt-imagegen`) that wraps that CLI with a launcher shim, an
auto-triggering skill, and slash commands.

## Requirements

- **Google Chrome**, signed in to ChatGPT (the plugin drives that session
  directly; it never uses an API key). Chromium, Brave and Edge also work in
  practice, since `ChromePath` searches for those too, but Chrome is what has
  actually been tested.
- Either a **prebuilt release binary** for your platform, or **Go 1.27** to
  build one yourself. The plugin's shell shim never downloads a binary on its
  own — you choose one of the two paths below.

## Installing as a Claude Code plugin

Add this repo as a marketplace and install the plugin:

```
/plugin marketplace add HelicopterHelicopter/gpt-imagegen-plugin
/plugin install gpt-imagegen@gpt-imagegen
```

Then provide the `gpt-imagegen` binary itself, by whichever of these two
paths is more convenient:

- **Build from source** (requires Go 1.27):

  ```bash
  make build
  ```

  This builds to `plugins/gpt-imagegen/bin/gpt-imagegen`, which is not
  committed to git — `make build` (or `make clean` to remove it) is the only
  way to produce or remove it locally.

- **Download a release binary** for your platform from this repo's Releases
  page and place it at `~/.gpt-imagegen/bin/gpt-imagegen` (`chmod +x` it).
  `make install-local` does the equivalent for a binary you built yourself,
  copying it from `plugins/gpt-imagegen/bin/` to that same location.

The launcher shim (`plugins/gpt-imagegen/scripts/gpt-imagegen`) looks for the
binary in this order: `$GPT_IMAGEGEN_BIN` if set, then the local build at
`plugins/gpt-imagegen/bin/`, then `~/.gpt-imagegen/bin/`. If none exist, it
prints one line of JSON with `error.code: "BINARY_MISSING"` telling you to do
one of the above — it never fetches anything itself.

Verify the install:

```bash
./plugins/gpt-imagegen/scripts/gpt-imagegen doctor
```

## Platform support

**macOS is the only platform this plugin has actually been tested on.**
Linux release binaries are built by CI and Chrome discovery (`ChromePath`)
does search the usual Linux install locations (`/usr/bin/google-chrome`,
`/usr/bin/chromium`, `$PATH`, and so on), but the plugin has not been run
end-to-end against a real ChatGPT session on Linux — treat it as untested,
not unsupported.

One concrete behavioural difference: hiding the automation window off-screen
during `generate`/`edit`/`probe` is implemented via AppleScript and is
macOS-only (`internal/session/window_darwin.go`). On every other platform
(`internal/session/window_other.go`) that window stays visible while a
generation runs, since there is no offscreen-positioning implementation for
it yet.

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
  JSON, for diagnosing a `SELECTOR_MISS` without needing a repro. Each
  candidate carries `testid` and `css` (the only two fields the selector
  resolver understands, so the only two that are actionable) plus `role`,
  `name` and `text` for human identification. The dump's `note` field says
  so inline. A candidate is given a `css` only when it is genuinely
  selective — an `#id` or a `[data-testid=...]` — never a bare tag name,
  which would resolve to an arbitrary element on the page.

Window policy is per command, never inferred: `setup` and `doctor` run a
**visible** window (the user signs in through it, and it is where a Cloudflare
challenge has to be solved), while `generate`, `edit` and `probe` move the
window offscreen on macOS so it never steals focus. Nothing runs headless —
headless is the strongest bot-detection signal there is.

A `SELECTOR_MISS` failure also carries `error.screenshot`: a PNG of the page
as it actually looked, written next to the probe dump in the same temp
directory. It is best-effort — if the capture fails the field is simply
absent, and the run still reports the miss.

## Known limitations

- **Not tested on Linux.** See Platform support above: Linux binaries build
  and Chrome discovery covers Linux install paths, but nobody has run a real
  generation against ChatGPT on Linux yet. The offscreen window-hiding used
  during `generate`/`edit`/`probe` is also macOS-only; on Linux the
  automation window stays visible for the duration of a run.

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

- **Partial success.** A run that saves fewer images than requested still
  exits 0 with `"ok":true`; the shortfall is reported only as a warning on
  stderr, not as part of the JSON result. Callers that care about getting
  exactly N images must compare `len(images)` in the JSON result against the
  `--count` they requested.

  This includes the timeout-salvage path: if the page never signals
  completion but images did arrive, they are saved and returned as a success
  with `"archived": false`, because the turn has already been spent and
  discarding real images would be the worst outcome under a no-retry
  discipline. The conversation is deliberately left unarchived so
  `conversation_url` remains a recovery path for whatever did not arrive. A
  timeout that salvaged nothing is still a `TIMEOUT` failure.

- **Selector self-heal is user-scoped, hand-written, and per-key
  destructive.** The override file at `~/.gpt-imagegen/selectors.json` is
  written by the skill itself, by hand — nothing in the CLI writes it.
  (`selectors.Patch` and `selectors.Save` exist as a library surface for
  building such a file programmatically, but no production code path calls
  either; they are exercised only by tests.)

  `selectors.Load` merges that file over the embedded defaults **per key,
  wholesale**: a key present in the user file replaces that key's entire
  candidate list rather than prepending to it. That is intentional — it is
  the only way to retire a shipped candidate that now matches the wrong
  element — but it has two consequences a repair must respect:

  1. Merge into the file's existing JSON object, never replace the file, or
     previously-applied repairs are silently lost.
  2. Within a key, write the new candidate *followed by* the shipped
     candidates. A single-candidate list deletes every fallback for that
     key.

  `SKILL.md` carries both rules with a worked before/after example, and
  `TestUserOverrideReplacesTheWholeKey` pins the behaviour. Deleting the file
  restores the shipped defaults. Self-heal is also exactly-once: one patch,
  one re-run, then stop; there is no retry loop anywhere in this codebase.

## Development

```bash
make build         # build the binary into plugins/gpt-imagegen/bin/
make test          # go test ./...
make smoke         # opt-in live smoke test; costs a real ChatGPT turn (~40s)
make install-local # copy the built binary to ~/.gpt-imagegen/bin/
make clean         # remove build output
```
