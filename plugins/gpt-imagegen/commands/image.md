---
description: Generate an image with ChatGPT and save it into the project
---

Generate an image for: $ARGUMENTS

Run `${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen generate --prompt "<expanded prompt>" --out <path>`,
choosing a sensible project-relative path. Expand the user's words into a
detailed prompt covering subject, style, palette and background. Parse the JSON
on stdout and report the saved path. Follow the gpt-imagegen skill for error
handling.
