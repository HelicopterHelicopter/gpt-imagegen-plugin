---
name: gpt-imagegen
description: Use when any task would be better delivered with a real generated image than a placeholder or a description - building or restyling a landing page, website, app screen, README or docs banner, OG/social card, slide deck, game sprites or tiles, app icon, logo, or marketing page; also when the user says generate/create/make/draw/render/design an image, picture, illustration, logo, icon, banner, hero, or sprite; and when an existing image needs editing. Runs a pre-flight check before shipping any build with a visual surface.
---

# Generating images through ChatGPT

Generate images by driving a signed-in ChatGPT browser session. Images are billed
against the user's ChatGPT plan, not an API key.

The CLI writes exactly one line of JSON to stdout and nothing else; all
progress and warnings go to stderr. Parse stdout and branch on `error.code`.
Never branch on prose, and never parse stderr.

## Before generating

Announce what you are about to generate and why. A generation costs a real
ChatGPT turn and takes roughly 40 seconds, so never do it silently.

## Do not trigger for

- SVG icons that match an icon set already wired into the project (lucide,
  heroicons, and similar).
- Charts, graphs or diagrams built from real data. Use the dataviz skill.
- Screenshots of running code.
- Anything the user excluded ("no images", "SVG only", "use placeholders").

## The CLI surface

Only these commands exist. Do not invent flags or subcommands.

```
gpt-imagegen setup
gpt-imagegen doctor
gpt-imagegen generate --prompt "<text>" --out <path> [--count N] [--ref FILE ...]
gpt-imagegen edit --image <path> --prompt "<text>" --out <path>
gpt-imagegen probe --stage <name>
```

## Generating

One image:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen generate \
  --prompt "<detailed prompt>" --out ./assets/hero.png
```

A coherent set, generated in one conversation so style and palette match:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen generate \
  --prompt "three enemy sprites: red, blue, green; same flat-vector style" \
  --out ./assets/enemy.png --count 3
```

Editing an existing image:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen edit \
  --image ./assets/hero.png --prompt "make the sky stormy" --out ./assets/hero-2.png
```

After a successful generation, wire the saved path into whatever referenced it:
the `<img src>`, the markdown image, the CSS `url()`.

### Partial success

A run can exit `"ok":true` having saved fewer images than were requested. The
shortfall is reported only as a warning on stderr, never in the JSON. So after
any `generate --count N`, count `result.images` yourself and compare it to N,
and tell the user the actual count instead of assuming N images landed.

This also covers the timeout-salvage case: if the generation produced images
but never signalled completion, the tool saves what genuinely arrived and
returns `"ok":true` with those images and `"archived":false`, rather than
discarding work that already cost a ChatGPT turn. The conversation is left
unarchived on purpose — `result.conversation_url` is where the missing images
can be recovered by hand. Do not re-run to make up the shortfall; that is a
second turn against the user's account.

## Handling failure

Branch on `error.code`. Never invent a retry that is not listed here.

| code | what to do |
|---|---|
| `NOT_LOGGED_IN` | Tell the user to run `/gpt-imagegen:setup`. Do not retry. |
| `CHALLENGE` | Stop. Ask the user to solve the challenge in the Chrome window. Never auto-retry. |
| `RATE_LIMITED` | Stop and report. Never retry. |
| `TIMEOUT` | Re-check `error.conversation_url` once, then stop. |
| `SELECTOR_MISS` | One self-heal attempt, below. |
| `NO_IMAGE_RETURNED` or `REFUSED` | Report it. Likely a model refusal, not a bug. |
| `PROFILE_LOCKED` | Another session holds the browser. Report and stop. |
| `CHROME_MISSING` | Tell the user to install Chrome or run `make build`. |

**Known limitation: `RATE_LIMITED` and `CHALLENGE` are not currently
detected by any code path.** They are part of the JSON contract (a future
version may start emitting them), so keep handling them as above, but do not
expect to see them today. In practice:

- A ChatGPT rate limit currently surfaces as `TIMEOUT` or
  `NO_IMAGE_RETURNED`, not as `RATE_LIMITED`.
- A Cloudflare challenge currently surfaces as `NOT_LOGGED_IN`, which is
  still the right thing to do: it routes the user to `/gpt-imagegen:setup`,
  whose visible Chrome window is where a challenge can actually be solved.

This does not weaken the no-retry rule: nothing here loops or retries
automatically under any code, today or after detection lands.

Archiving happens only on success. A failed run's `error.conversation_url`
(when present) is the user's recovery path back into the ChatGPT conversation
that was in progress.

## Self-heal, exactly once

On `SELECTOR_MISS`:

1. Read the JSON file at `error.probe`. Its `note` field restates the rules
   below; its `candidates` list describes elements with `testid`, `css`,
   `role`, `name` and `text`. `error.screenshot`, when present, is a PNG of
   the page as it actually was — open it if the candidate list is ambiguous.
2. Pick the candidate for `error.selector_key`. **Only `testid` and `css`
   are actionable.** The resolver understands those two fields and nothing
   else, so a patch built from `role`, `name` or `text` produces a key with
   no query at all: it is written without error and the re-run fails in
   exactly the same way. If no candidate for that element has a `testid` or
   a `css`, stop and report — there is nothing to patch with.
3. Merge the patch into `~/.gpt-imagegen/selectors.json`, writing the **new
   candidate first, followed by the key's existing candidates**.

   Two separate rules, both load-bearing:

   - **Between keys:** merge into the existing JSON object. Read the file
     first if it exists, start from `{}` if it does not. Overwriting the
     whole file silently deletes every earlier repair.
   - **Within a key:** a key in this file **replaces that key's candidate
     list wholesale** — it does not prepend to it. A single-candidate list
     therefore discards every fallback the plugin ships for that key, so the
     next small UI change that a fallback would have absorbed becomes a hard
     failure. Always repeat the shipped candidates behind your new one.

   The shipped candidates for a key are in the plugin's own data file at
   `${CLAUDE_PLUGIN_ROOT}/../../internal/selectors/selectors.json`. Read the
   key from there (and from the user file, if it already has that key) and
   carry every candidate through.

   Concrete example. `composer_input` ships as:

   ```json
   { "composer_input": [
       { "css": "#prompt-textarea" },
       { "testid": "prompt-textarea" },
       { "css": "div[contenteditable='true']" }
   ] }
   ```

   WRONG — this is a valid patch that quietly deletes all three fallbacks:

   ```json
   { "composer_input": [ { "testid": "composer-text-input" } ] }
   ```

   RIGHT — new candidate first, shipped candidates preserved behind it:

   ```json
   { "composer_input": [
       { "testid": "composer-text-input" },
       { "css": "#prompt-textarea" },
       { "testid": "prompt-textarea" },
       { "css": "div[contenteditable='true']" }
   ] }
   ```

4. Re-run the original command **once**.

If the second run also fails, stop and report, quoting `error.probe`. Never
loop, and never attempt a second self-heal for the same failure.

Deleting `~/.gpt-imagegen/selectors.json` restores the shipped defaults, which
is the escape hatch if a repair makes things worse.
