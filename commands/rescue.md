---
description: Hand a substantial coding task to DSH through the dsh:dsh-rescue subagent
argument-hint: '[--background|--wait] [--resume|--fresh] [--model <id|flash|pro>] [--effort <level>] [task ...]'
allowed-tools: Bash(node:*), PowerShell(node:*), AskUserQuestion, Agent
---

Hand the user's request to DSH. The routing is explicit: run the `dsh:dsh-rescue` subagent; do not call `Skill(dsh:rescue)` and do not re-enter this command, which would recurse.

Raw slash-command arguments:
`$ARGUMENTS`

Before routing, decide whether this continues earlier DSH work:
- If the request includes `--resume` or `--fresh`, do not ask whether to continue.
- Otherwise run exactly one discovery call:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" task-resume-candidate --json
```
- If it reports `"available": true`, use `AskUserQuestion` exactly once: "Continue the DSH session from job <id>, or start a new one?" with `Continue current DSH session` and `Start a new DSH session`. If the user chooses continue, add `--resume`; if they choose a new one, add `--fresh`.
- If it reports `false`, do not ask; route a fresh task.
- Never invent a session and never carry context over by pasting a summary of the old conversation.

Routing:
- `--background` and `--wait` in the request are host-side Agent execution controls, not companion flags:
  - `--background`: route with the `Agent` tool and `subagent_type: "dsh:dsh-rescue"`, running the Agent call in the background. Claude notifies this conversation with the subagent's final output when DSH finishes.
  - `--wait` or no explicit choice: route the same Agent call in the foreground.
- Strip `--background` and `--wait` from the raw arguments before forwarding; never forward either token to the subagent, because the subagent's own skill contract permits `--background` when its user explicitly asks, and a forwarded token would detach the companion. Keep `--resume`, `--fresh`, `--model`, and `--effort` in the forwarded request.
- Either way, the subagent itself runs the companion task in the foreground with `--wait` until DSH finishes, so DSH's final output reaches this conversation through the Agent result.
- Leave `--resume` and `--fresh` in the forwarded request. Leave `--model` and `--effort` in it as runtime-selection flags but do not add them yourself unless the user asked.
- The request is a thin forwarder only: it must not inspect the repository, poll status, fetch results, or summarize.

Response:
- Return the DSH companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- If the subagent reports that DSH could not be invoked, say so and suggest `/dsh:setup`.
