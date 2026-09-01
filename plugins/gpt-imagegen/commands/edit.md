---
description: Edit an existing image with a natural-language instruction
---

Edit an image. Arguments: $ARGUMENTS (expected: a path, then the instruction)

Run `${CLAUDE_PLUGIN_ROOT}/scripts/gpt-imagegen edit --image <path> --prompt "<instruction>" --out <new path>`.
Never overwrite the source image unless the user asked for that. Follow the
gpt-imagegen skill for error handling.
