---
description: Show active and recent DSH jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*), PowerShell(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table covering the current and past runs in this workspace.
- Keep it compact. Do not add progress blocks or prose outside the table.
- Preserve the actionable fields: job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user. Do not summarize or condense it.

Jobs are scored per workspace, not per host or per session, so a job started from Codex shows up here too.
