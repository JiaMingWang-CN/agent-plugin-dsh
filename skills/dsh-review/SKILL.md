---
name: dsh-review
description: Have DeepSeek Harness (DSH) review repository changes. Use only when the user explicitly asks DSH or DeepSeek Harness for a review or second opinion; an unqualified request to review code stays with the current agent.
---

# Review with DSH

DSH reads the repository itself; the companion sends it a bounded summary of the change. The review
is a **read-only** request, but that is a prompt contract, not a sandbox — never tell the user the
files are guaranteed untouched.

## Locating the companion script

This skill directory is the one containing this `SKILL.md`. Resolve the companion script from that
path in the same shell call you use to run it — never hardcode an install location:

```sh
DSH_COMPANION="$(dirname "<absolute path of this SKILL.md>")/../../scripts/dsh-companion.mjs"
```

Run every command as **one** shell invocation and return its stdout to the user **verbatim**. Do not
summarise, reformat, or editorialise. Progress lines arrive on stderr; keep them out of the answer
unless the command failed.

Run `review` with `--wait` in the foreground and give the call a generous timeout: a real DSH turn
can run for many minutes. Stay alive until it returns and hand DSH's final output back — do not
detach `--background` for agent-directed work, because nothing would deliver the result to the
invoking agent. Use `--background` only when the user explicitly asks to fire-and-forget a job, then
report the job id and manage it with the `dsh-jobs` skill.

## Workflow

```sh
# standard review of the current change
node "$DSH_COMPANION" review --wait

# adversarial review: attacks the design, tradeoffs, and hidden assumptions
node "$DSH_COMPANION" review --adversarial --wait

# a branch diff, with a focus
node "$DSH_COMPANION" review --base main --wait "concurrency and error handling"

# only when the user explicitly asked to fire-and-forget the job
node "$DSH_COMPANION" review --background
```

## Choosing the target

| Flag | Effect |
|---|---|
| *(default)* | `--scope auto`: the working tree when it is dirty, otherwise the branch diff against the detected default branch. |
| `--scope working-tree` | Always review staged, unstaged, and untracked changes. |
| `--scope branch` | Always review the branch diff. |
| `--base <ref>` | Review `<ref>...HEAD`; overrides `--scope`. |

Any extra positional words become the review focus and are passed to DSH as-is.

## Reporting

Return DSH's Markdown review to the user verbatim. It already carries locations and severities.
Do not re-rank, summarise, or add your own findings on top.
