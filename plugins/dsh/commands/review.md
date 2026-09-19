---
description: Run a read-only DSH code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), PowerShell(node:*), Bash(git:*), PowerShell(git:*), AskUserQuestion
---

Run a DSH review through the companion script.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return DSH's output verbatim to the user.
- DSH reads the repository itself; the companion only sends it a bounded summary of the change.
- Read-only is a prompt contract, not a sandbox. Never tell the user the files are guaranteed untouched.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run it in the background.
- Otherwise, estimate the review size before asking:
  - For a working-tree review, start with `git status --short --untracked-files=all`.
  - Also inspect `git diff --shortstat --cached` and `git diff --shortstat`.
  - For a base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny: roughly 1-2 files total and no sign of a broader change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended one first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly. Do not strip `--wait` / `--background` yourself and do not rewrite the user's intent.
- The companion parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/dsh:review` is native review only: it takes no focus text. Use `/dsh:adversarial-review` to challenge a design.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is. Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issue the review mentions. A real DSH turn can run for many minutes, so set a generous timeout.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" review "$ARGUMENTS"`,
  description: "DSH review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching, tell the user: "DSH review started in the background. Check `/dsh:status` for progress."
