---
description: Show the stored final output for a finished DSH job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*), PowerShell(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve:
- the job ID, status, and the DSH session ID,
- the complete stored payload, including the final response,
- file paths and line numbers exactly as reported,
- any error messages,
- follow-up commands such as `/dsh:status <id>` and `/dsh:rescue`.

When the payload says `resumable: true`, offer `/dsh:rescue --resume <follow-up>`. When it says `false`, read `resumeUnavailableReason` and tell the user why instead of retrying: a cancelled job's session log may be incomplete.
