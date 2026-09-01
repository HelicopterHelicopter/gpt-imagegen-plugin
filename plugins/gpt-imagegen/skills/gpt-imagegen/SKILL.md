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

### Partial success with `--count`

A `--count N` run can still exit `"ok":true` after saving fewer than N images:
the shortfall is reported only as a warning on stderr, not as a failure. After
any `generate --count N`, count `len(result.images)` yourself and compare it
to N. If fewer images were saved than requested, tell the user the actual
count instead of assuming N images landed.

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

1. Read the JSON file at `error.probe`. It lists candidate elements with
   `testid`, `role`, `name`, `text` and `css`.
2. Pick the candidate that matches `error.selector_key`.
3. Merge it into `~/.gpt-imagegen/selectors.json` under that key, at the
   front of the list. This file holds only the keys that differ from the
   plugin's built-in defaults, so **merge your patch into the existing JSON
   object** (read it first if it exists; start from `{}` if it does not) —
   never overwrite the whole file, or you will silently delete every other
   repair a previous self-heal made.
4. Re-run the original command **once**.

If the second run also fails, stop and report, quoting `error.probe`. Never
loop, and never attempt a second self-heal for the same failure.
