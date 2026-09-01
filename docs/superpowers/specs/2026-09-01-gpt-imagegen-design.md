# gpt-imagegen — design

Date: 2026-09-01
Status: approved, ready for implementation planning

A Claude Code plugin that generates images by driving a signed-in ChatGPT
session in a real browser, saves them into the project, and lets Claude invoke
it on its own whenever a task needs an image.

## 1. Why this shape

### Why the browser and not Codex CLI

Codex CLI is already installed on this machine (`codex-cli 0.147.0`, logged in
via ChatGPT, feature flag `image_generation stable true`), and several existing
plugins wrap `codex exec $imagegen`. That path was rejected on cost, not
capability.

OpenAI's Codex pricing page states that image generation "counts toward the
same general usage limits as local messages and cloud chats" and that image
generations "use included limits 3-5x faster on average than similar turns
without image generation." Codex image generation is therefore metered against
per-model five-hour rolling windows.

ChatGPT Pro, which this user has, advertises unlimited image creation on the
consumer chat surface, qualified only by abuse guardrails. Driving chatgpt.com
draws from that bucket instead of a metered one.

Caveat recorded deliberately: "abuse guardrails" target automated bulk
generation. The tool therefore runs at human pace and never retries generation
automatically. See §7.

### Why Go

Considered Python + Playwright, Rust + chromiumoxide, and Go + go-rod.

- Python + Playwright was rejected because Playwright-Python is not a native
  library: it spawns a bundled Node.js driver process per run, adding a Node
  runtime dependency and roughly a second of startup. The skill auto-fires, so
  per-invocation overhead is paid constantly.
- Rust was rejected against Go, not against Python. chromiumoxide is healthy
  (0.9.1, Feb 2026), but Rust has no Playwright, so the locator and auto-wait
  engine would be hand-rolled. go-rod ships both.
- Go wins on the axes that bind here: go-rod and chromedp are more battle-tested
  against hostile, JS-heavy sites; `GOOS`/`GOARCH` cross-compilation needs no
  cross-linker; compile cycles are seconds. The workload is I/O-bound event
  waiting, so Rust's performance and memory-safety advantages buy nothing.

### Legal and ToS note

Driving ChatGPT's web UI programmatically sits outside OpenAI's terms for
automated access. This is a personal tool driving the user's own logged-in
session, accepted knowingly. The design fails closed and paces itself rather
than maximising throughput.

## 2. Scope

In scope for v1:

- Generate an image from a prompt, save to a caller-chosen path.
- Edit an existing local image with a natural-language instruction.
- Generate multiple images in one conversation so a set shares style.
- Auto-trigger: the skill fires without a slash command when a task needs an
  image.

Explicitly out of scope for v1:

- Copying images to the system clipboard (considered and dropped).
- A Codex fallback engine.
- Model or thinking-time selection.
- Deep Research, project sources, multi-turn consults.

## 3. Spike findings

A throwaway Go + go-rod spike proved every risky assumption before any plugin
code was written. All findings below are verified, not assumed.

| Finding | Consequence |
|---|---|
| `launcher.Cleanup()` runs `os.RemoveAll(UserDataDir)` | Never call it with a persistent profile. It destroyed a real login during the spike. |
| Logged-out `/api/auth/session` returns only `{"WARNING_BANNER": ...}` | Presence of a `user` key is a reliable auth signal; no DOM needed. |
| That payload contains `accessToken` and `sessionToken` | The auth probe logs key names only, never values. Hard rule. |
| Relaunching against a live profile fails with `Opening in existing browser session` | Must attach-or-launch via `DevToolsActivePort`. |
| Probing auth by navigating the active tab interrupts a login in progress | Auth probe runs in its own throwaway tab. |
| `leakless` SIGKILLs Chrome on parent exit, risking unflushed cookies | Close gracefully via `Browser.close` before exit. |
| No Cloudflare challenge with real Chrome, `--disable-blink-features=AutomationControlled`, `enable-automation` deleted | Launch flags are load-bearing; keep them. |
| Composer is `#prompt-textarea` | Primary selector. |
| Generated images come from `chatgpt.com/backend-api/estuary/content?id=file_...&p=fs&sig=...` | Same-origin and cookie-authed; allowlist this path. |
| `Network.getResponseBody` returns `base64Encoded=true` for these | Decode path verified byte-exact on a 954,177-byte PNG. |
| Generated images carry `alt="Generated image: <title>"` | DOM identifier and a free filename source. |
| No `<a download>` elements exist | Capture must be network-hook or fetch-by-URL. |
| Filtering `image/*` by size alone captures sprites, favicons and avatars | Use a path allowlist, not a size heuristic. |

Stable testids observed: `image-gen-loading-state` (plus `-frame`,
`-entry-surface`, `-dots`), `stop-button`, `upload-photos-input`,
`composer-plus-btn`, `create-new-chat-button`, `conversation-turn-N`,
`conversation-options-button`, `copy-turn-action-button`.

## 4. Architecture

```
gpt-imagegen-plugin/                      # repo root doubles as the marketplace
├── .claude-plugin/marketplace.json       # -> ./plugins/gpt-imagegen
├── plugins/gpt-imagegen/
│   ├── .claude-plugin/plugin.json
│   ├── skills/gpt-imagegen/SKILL.md
│   ├── commands/{image,edit,setup,doctor}.md
│   └── scripts/gpt-imagegen              # shim: locate and exec the binary
├── cmd/gpt-imagegen/main.go
├── internal/session/                     # profile, attach-or-launch, lock, auth
├── internal/compose/                     # new chat, prompt, attach, send
├── internal/capture/                     # network hook, in-page fetch fallback
├── internal/selectors/                   # layered resolver, write-back
├── internal/probe/                       # candidate-element dump for self-heal
├── selectors.json                        # data, embedded at build, overridable
└── tests/
```

The split is deliberate: `compose` is DOM-dependent and expected to drift;
`capture` is DOM-free and expected to be stable. They fail independently.

### Selector resolution

Selectors live in `selectors.json` as data, not code, so a repair needs no
rebuild. Each logical key holds an ordered candidate list, tried in order:
`data-testid`, then ARIA role plus accessible name, then text, then CSS. The
resolver polls with a timeout rather than sleeping.

A user-level `~/.gpt-imagegen/selectors.json`, when present, overrides the
embedded copy. Self-heal writes there, so a plugin upgrade never clobbers a
local repair, and a stale local repair can be deleted to fall back to shipped
defaults.

## 5. CLI contract

The binary is the whole engine. The skill only shells out and reads JSON.

```
gpt-imagegen setup                     # visible Chrome, one-time login
gpt-imagegen doctor                    # chrome, profile, auth, lock, selectors
gpt-imagegen generate --prompt P --out PATH [--count N] [--ref FILE]...
gpt-imagegen edit --image FILE --prompt P --out PATH
gpt-imagegen probe --stage composer    # self-heal support
```

Every command emits one JSON object on stdout. Human-readable progress goes to
stderr, so stdout is always machine-parseable.

Success:

```json
{"ok": true,
 "images": [{"path": "/abs/hero.png", "bytes": 184203, "width": 1536, "height": 1024,
             "title": "Geometric Teal Mountain Emblem"}],
 "conversation_url": "https://chatgpt.com/c/...",
 "archived": true,
 "elapsed_s": 41.2}
```

Failure:

```json
{"ok": false,
 "error": {"code": "SELECTOR_MISS", "stage": "composer",
           "selector_key": "composer_input",
           "probe": "/tmp/.../probe-composer.json",
           "screenshot": "/tmp/.../fail.png",
           "conversation_url": "https://chatgpt.com/c/...",
           "message": "human-readable detail"}}
```

`conversation_url` is included on failure wherever known, because it is the
recovery path.

Error codes: `NOT_LOGGED_IN`, `SELECTOR_MISS`, `TIMEOUT`, `CHALLENGE`,
`RATE_LIMITED`, `PROFILE_LOCKED`, `NO_IMAGE_RETURNED`, `CHROME_MISSING`,
`REFUSED`.

With `--count N`, the first image writes to `--out` and the rest to numbered
siblings (`hero.png`, `hero-2.png`, `hero-3.png`), all from one conversation so
style stays coherent.

## 6. Runtime behaviour

### Session

1. Resolve profile dir (`~/.gpt-imagegen/profile`, override
   `GPT_IMAGEGEN_PROFILE_DIR`).
2. Acquire an exclusive lock at `~/.gpt-imagegen/lock` for the send moment, so
   concurrent Claude sessions cannot type into one composer. Wait with a
   timeout; on expiry return `PROFILE_LOCKED`.
3. Attach-or-launch: read `DevToolsActivePort` from the profile dir, verify with
   `/json/version`, connect. Otherwise launch real Chrome with the load-bearing
   flags from §3. Record whether we own the process.
4. Probe auth in a throwaway tab. Missing `user` key returns `NOT_LOGGED_IN`.
5. On macOS, move the window offscreen via AppleScript; fall back to visible if
   that fails. Never headless — headless is the strongest bot-detection signal.
6. On exit, close gracefully only if we own the browser. Never call
   `launcher.Cleanup()`.

### Compose

Open a new chat, resolve the composer, type the prompt, attach any `--ref`
files through `upload-photos-input` via `DOM.setFileInputFiles`, wait for upload
chips to settle, then send. `edit` is the same path with the source image
attached.

### Capture

Two independent mechanisms, because each alone has a hole:

1. Primary: a `Network.responseReceived` / `Network.loadingFinished` hook
   allowlisted to `/backend-api/estuary/content`, then
   `Network.getResponseBody` and base64 decode.
2. Fallback: if the CDP response buffer was evicted, read the `src` of
   `img[alt^="Generated image: "]` and re-fetch it in page context with
   credentials, returning base64. Same-origin, so cookies apply.

Completion is DOM-signalled, never a fixed sleep: poll until
`image-gen-loading-state` is absent, `stop-button` is absent, and at least one
`img[alt^="Generated image: "]` exists. For `--count N`, wait for N distinct
`file_...` ids.

Filenames derive from the `alt` title, slugified, when `--out` names a
directory rather than a file.

### Archiving

On success only, via `conversation-options-button`. Never on failure: a failed
run's conversation URL is the recovery path.

## 7. Rate and abuse discipline

Load-bearing, not decoration. The tool never retries a generation
automatically. `RATE_LIMITED` and `CHALLENGE` stop immediately and hand back to
the user. Self-heal is capped at one attempt per invocation. The skill never
generates in a loop; a set of N images is one conversation, not N runs.

## 8. Skill behaviour

The skill fires as a pre-flight check before shipping any build with a visual
surface: landing pages, README banners, sprites, OG cards, slide decks.

Non-triggers, deliberately narrow: SVG icons matching an icon set already wired
into the project, charts or graphs from real data, screenshots of running code,
and anything the user excluded ("no images", "SVG only").

Because a generation costs a ChatGPT turn and roughly 40 seconds, the skill
announces before generating rather than doing it silently. After saving, it
wires the file into the referencing `<img src>` or markdown.

Error handling branches on `code`:

| code | behaviour |
|---|---|
| `NOT_LOGGED_IN` | instruct the user to run `/gpt-imagegen:setup`; no retry |
| `CHALLENGE` | stop; ask the user to solve it in the window; never auto-retry |
| `RATE_LIMITED` | stop and report; never retry |
| `TIMEOUT` | one re-check of `conversation_url`, then stop |
| `SELECTOR_MISS` | one self-heal attempt, then stop |
| `NO_IMAGE_RETURNED` / `REFUSED` | report; likely a model refusal, not a bug |
| `PROFILE_LOCKED` | report; another session holds the browser |

### Self-heal

On `SELECTOR_MISS`, the skill reads the probe JSON, picks a candidate, writes it
to `~/.gpt-imagegen/selectors.json`, and re-runs exactly once. A second failure
stops and reports, including the probe path so a human can inspect it.

## 9. Testing

- Unit: selector-resolver layering and fallback order; JSON envelope shape for
  every error code; the `/backend-api/estuary/content` allowlist against the
  real false-positive URLs the spike captured (sprites, favicons, avatars);
  filename slugification from `alt`.
- Integration: a saved HTML fixture of a real conversation, asserting the
  resolver finds composer, loading state, stop button and generated image. This
  is the regression test for DOM drift and runs without network.
- Live smoke: one real generation behind an opt-in env var. Never in CI, because
  it costs a real turn against the user's account.

## 10. Risks and open items

- ChatGPT DOM drift is the standing risk. Mitigated by data-file selectors, the
  probe, and one-shot self-heal; not eliminated.
- The `estuary/content` path is a private API and may be renamed. The in-page
  `img[alt^=...]` fallback covers that case, which is why both mechanisms exist.
- AppleScript offscreen positioning is macOS-only. Other platforms run visible.
- Cross-platform release artifacts are deferred; v1 builds locally.
- Whether `--count N` in a single conversation degrades image quality versus
  separate conversations is untested. Verify during implementation.
