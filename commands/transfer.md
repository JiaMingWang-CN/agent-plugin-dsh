---
description: Hand a Codex rollout or a Claude Code session over to DSH and print the new DSH session id
argument-hint: '--source <transcript.jsonl>'
disable-model-invocation: true
allowed-tools: Bash(node:*), PowerShell(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned, including the DSH session ID and whether the transcript was truncated.

Notes to pass on:
- `--source` is required. The plugin never guesses the current conversation; if the user has no path yet, the two supported shapes are a Codex rollout (`~/.codex/sessions/...`) and a Claude Code transcript (`~/.claude/projects/<slugified-cwd>/<session-id>.jsonl`). The format is detected from the file's own contents.
- The transfer runs one DSH turn and leaves a real DSH session behind, so it can be continued later with `/dsh:rescue --resume`.
- Compressed transcripts (`.jsonl.zst`) are refused with an explicit error; decompress first.
