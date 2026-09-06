![gpt-imagegen — generate images by driving a signed-in ChatGPT browser session](assets/banner.png)

# gpt-imagegen

Generate and edit images by driving a signed-in ChatGPT browser session with a
real (visible, on first sign-in) Chrome instance. Images are billed against
the user's ChatGPT plan, not an API key.

This repo is a Node CLI (`src/`, bundled into the single committed file
`plugins/gpt-imagegen/dist/index.cjs`) and a Claude Code plugin
(`plugins/gpt-imagegen`) that wraps that bundle with a launcher shim, an
auto-triggering skill, and slash commands. The bundle lives *inside* the
plugin directory because `/plugin install` copies only that directory —
anything at the repo root never reaches an installed user.

## Requirements

- **Node.js 20 or later.** Nothing else needs installing — the plugin ships
  its own dependencies bundled into `plugins/gpt-imagegen/dist/index.cjs`,
  so there is no `npm install` step for an end user.
- **Google Chrome**, signed in to ChatGPT (the plugin drives that session
  directly; it never uses an API key). Chromium, Brave and Edge also work in
  practice, since `chromePath()` searches for those too, but Chrome is what
  has actually been tested.

## Installing as a Claude Code plugin

Add this repo as a marketplace and install the plugin:

```
/plugin marketplace add HelicopterHelicopter/gpt-imagegen-plugin
/plugin install gpt-imagegen@gpt-imagegen
```

That's it — there is no build step and no binary to download. The plugin's
launcher shim (`plugins/gpt-imagegen/scripts/gpt-imagegen`) execs `node` on
the committed bundle directly. If `node` isn't on `PATH`,
the shim prints one line of JSON with `error.code: "NODE_MISSING"` instead
of failing silently.

Verify the install:

```bash
./plugins/gpt-imagegen/scripts/gpt-imagegen doctor
```

## Platform support

**macOS is the only platform this plugin has actually been tested on,
end to end, against a real ChatGPT session.** Being plain Node + Chrome
automation (no compiled, per-platform binary) makes Linux plausible —
`chromePath()` does search the usual Linux install locations
(`/usr/bin/google-chrome`, `/usr/bin/chromium`, `$PATH`, and so on) — but
nobody has actually run this plugin on Linux. Treat it as untested, not
unsupported or supported.

One concrete behavioural difference: hiding the automation window off-screen
during `generate`/`edit`/`probe` is implemented via AppleScript and is
macOS-only (see `hideWindow` in `src/window.js`). On every other platform
that function is a no-op and the window stays visible for the duration of a
run, since there is no offscreen-positioning implementation for anything
other than macOS yet.

## CLI surface

```
gpt-imagegen setup
gpt-imagegen doctor
gpt-imagegen generate --prompt "<text>" --out <path> [--count N] [--ref FILE ...]
gpt-imagegen edit --image <path> --prompt "<text>" --out <path>
gpt-imagegen probe --stage <name>
gpt-imagegen selectors
```

stdout is always exactly one line of JSON (see `src/envelope.js`); all
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
- `selectors` prints the selector candidate lists the plugin ships, as
  JSON on the usual one-line envelope (in a `selectors` field). Self-heal
  needs them: a key written to `~/.gpt-imagegen/selectors.json` replaces
  that key's list wholesale, so a repair has to repeat the shipped
  candidates behind its new one or it deletes every fallback. It launches no
  browser and touches no profile, so it is safe to run mid-repair.
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

- **Not tested on Linux.** See Platform support above: Node + Chrome makes
  Linux plausible, and Chrome discovery covers Linux install paths, but
  nobody has run a real generation against ChatGPT on Linux yet. The
  offscreen window-hiding used during `generate`/`edit`/`probe` is also
  macOS-only; on Linux the automation window stays visible for the duration
  of a run.

- **A CDP call can stall, and the run then fails after ~3 minutes.**
  Observed once, live, inside the reference-image upload in `compose.send()`:
  a single Chrome DevTools call never returned and hit puppeteer's per-call
  cap (`protocolTimeout`, 180s, now set explicitly in `launchOptions`). The
  identical command succeeded immediately before and after, so this is a
  transient in Chrome or ChatGPT rather than something this code can
  prevent. It surfaces as `TIMEOUT` with a plain message telling you to run
  the command again — puppeteer's own text, which advises changing a setting
  no user of this plugin can reach, is rewritten before it is emitted. The
  no-retry discipline holds: nothing is retried for you.

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
  (`patch` and `save` in `src/selectors.js` exist as a library surface for
  building such a file programmatically, but no production code path calls
  either; they are exercised only by tests.)

  `load` merges that file over the embedded defaults **per key,
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
  `test/selectors.test.js`'s `'user override replaces the whole key,
  wholesale'` test pins the behaviour. Deleting the file restores the
  shipped defaults. Self-heal is also exactly-once: one patch, one re-run,
  then stop; there is no retry loop anywhere in this codebase.

## Development

```bash
npm test           # node --test test/*.test.js
make bundle        # rebuild the committed bundle from src/ (commit the result)
make bundle-check  # rebuild and fail if the bundle doesn't match what's committed
make smoke         # opt-in live smoke test; costs a real ChatGPT turn (~40s)
```

`plugins/gpt-imagegen/dist/index.cjs` is committed to git and is what the
plugin actually runs (via `plugins/gpt-imagegen/scripts/gpt-imagegen`).
Whenever you change anything under `src/`, run `make bundle` and commit the
updated bundle in the same change — CI's `make bundle-check` fails the build
otherwise.

Its path is load-bearing, not cosmetic: `test/install.test.js` copies
`plugins/gpt-imagegen/` alone into a temp directory and runs the shim there,
reproducing what `/plugin install` puts on disk. Every other test runs from a
full checkout, where the repo root is always present — which is exactly how an
earlier layout (bundle at the repo root, shim reaching it with `../../../`)
passed CI while being unrunnable for anyone who actually installed the
plugin.
