---
description: Run a steerable DSH review that attacks the design, tradeoffs, and hidden assumptions
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), PowerShell(node:*), Bash(git:*), PowerShell(git:*), AskUserQuestion
---

Run a **steerable** DSH review through the companion script.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only. Do not fix issues or apply patches.
- Your only job is to run the review and return DSH's output verbatim to the user.
- Read-only is a prompt contract, not a sandbox. Never promise that nothing was written.

Differences from `/dsh:review`:
- It uses the same review target selection, including `--base <ref>`.
- It can still take extra focus text after the flags, which is passed to DSH as-is.
- It asks DSH to pressure-test the direction: tradeoffs, failure modes, hidden assumptions, and whether a simpler or safer approach exists.
- It does not support `--scope staged` or `--scope unstaged`; `--scope auto|working-tree|branch` is the whole vocabulary.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask: run it in the foreground.
- If they include `--background`, do not ask: run it in the background.
- Otherwise estimate the scoped review the same way `/dsh:review` does (`git status --short --untracked-files=all`, `git diff --shortstat`, `git diff --shortstat --cached`, `git diff --shortstat <base>...HEAD`), then use `AskUserQuestion` exactly once with two options, recommended one first and suffixed `(Recommended)`:
  - `Wait for results`
  - `Run in background`
- Recommend waiting only when the scoped review is clearly tiny (roughly 1-2 files). In every other case, including unclear size, recommend background. When in doubt, run the review.

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" review --adversarial "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is. Do not paraphrase, summarize, or add commentary.

Background flow:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" review --adversarial "$ARGUMENTS"`,
  description: "DSH adversarial review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching, tell the user: "DSH adversarial review started in the background. Check `/dsh:status` for progress."
