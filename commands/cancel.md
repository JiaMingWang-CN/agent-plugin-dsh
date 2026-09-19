---
description: Cancel an active background DSH job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*), PowerShell(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" cancel "$ARGUMENTS"`

Present the command output to the user.

Cancel is forced termination: it ends the DSH runtime process tree, and the companion only reports `cancelled` after it has confirmed the processes exited. A cancelled session is deliberately not offered for resume, so never claim its log is complete.
