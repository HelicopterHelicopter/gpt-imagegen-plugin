---
description: One-time ChatGPT sign-in for image generation
---

Run `${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen setup`.

A Chrome window opens on a dedicated profile. Tell the user to sign in to
ChatGPT there; the command polls for up to 10 minutes and exits when the
session is live. Explain that this is needed once, not per image.
