---
name: dsh-delegate
description: Delegate a coding task to DeepSeek Harness (DSH) or continue a previous DSH session. Use when the user says things like "ask DSH to ...", "let DeepSeek do ...", "hand this to dsh", "continue the DSH session", or otherwise asks another agent to investigate, fix, implement, or run something in this workspace.
---

# Delegate to DSH

DSH runs as its own agent in this workspace. It reads the repository itself, so pass the task, not
the context.

## Locating the companion script

This skill directory is the one containing this `SKILL.md`. Resolve the companion script from that
path in the same shell call you use to run it — never hardcode an install location:

```sh
DSH_COMPANION="$(dirname "<absolute path of this SKILL.md>")/../../scripts/dsh-companion.mjs"
```

Run every command as **one** shell invocation and return its stdout to the user **verbatim**. Do not
summarise, reformat, or editorialise. Progress lines arrive on stderr; keep them out of the answer
unless the command failed.

Run `task` with `--wait` in the foreground and give the call a generous timeout: a real DSH turn can
run for many minutes. Stay alive until it returns and hand DSH's final output back — do not detach
`--background` for agent-directed work, because nothing would deliver the result to the invoking
agent. Use `--background` only when the user explicitly asks to fire-and-forget a job, then report
the job id and manage it with the `dsh-jobs` skill.

## Workflow

1. Decide whether this continues earlier DSH work. If the user did not say, run exactly one
   discovery call:

   ```sh
   node "$DSH_COMPANION" task-resume-candidate --json
   ```

2. If that reports `"available": true`, ask the user **exactly once**: "Continue the DSH session from
   job <id>, or start a new one?" Then act on the answer.
   If it reports `false`, start a new session without asking.
   Never invent a session, and never carry context over by pasting a summary of the old
   conversation — only `--resume` restores the previous DSH context.

3. Run the task:

   ```sh
   # new session
   node "$DSH_COMPANION" task --wait "<the task>"
   # continue the previous session
   node "$DSH_COMPANION" task --resume --wait "<follow-up>"
   # long-running work is still run with --wait; use --background only when
   # the user explicitly asked to fire-and-forget the job
   node "$DSH_COMPANION" task --background "<the task>"
   ```

## When to use the analysis layer (`--analyze`)

Some tasks need the lay of the land before anyone touches the code. If you catch yourself writing a
long step-by-step description of how the work should be done, stop: that prescription is exactly what
makes the executor stop thinking. Hand over the intent instead and let the analysis layer research it:

```sh
node "$DSH_COMPANION" task --analyze --wait "make the login flow survive a expired session"
```

`--analyze` runs **two** DSH turns: a read-only research pass that answers with a task brief (goal,
scope, the files the executor must read, constraints, a checkable definition of done, risks), then a
fresh execution session that carries the brief out. The brief becomes part of the requirement the
executor must satisfy, so "do the work and verify it" is checked rather than hoped for.

Use it when the task touches code you have not read yet, when the request is fuzzy, or when the cost
of a wrong first move is high. Skip it for small, well-understood changes — it costs a second DSH
turn and leaves a second DSH session behind.

The research pass is always read-only, even with `--write`. Its model defaults to `pro` (the stronger
research model) and is chosen independently of the execution model:

```sh
node "$DSH_COMPANION" task --analyze --analyze-model pro --model flash --write "..."
```

If the analysis pass fails or produces an empty brief, the job fails and nothing is executed; the
reason is on stderr.

## Choosing a model

Model routes belong to the user's DSH install, not to this plugin, so never guess a provider and
never invent a model id. When the user names a model, or asks which ones exist, read the real
catalog first:

```sh
node "$DSH_COMPANION" models --json
```

Then pass `--model <id>`; the plugin resolves the provider from that catalog. Add `--provider <id>`
only when the same model id is offered by more than one provider. Leaving `--model` off keeps
whatever the user's DSH is configured to use — prefer that unless they asked for a specific model.

Two things to pass on if the user cares: reading the catalog requires a DSH session and ACP cannot
delete sessions, so `models` leaves one empty session behind and prints its id; and a rejected
`--model` already prints the whole catalog grouped by provider, so you do not need a second call to
explain a failure.

## Flags

| Flag | Meaning |
|---|---|
| `--wait` | Run in the foreground and print DSH's final answer (default). |
| `--background` | Queue the job, print its id, and return at once. |
| `--resume`, `--resume-last` | Continue the newest resumable DSH session in this workspace. Fails rather than starting a new session when there is nothing to resume. |
| `--fresh` | Force a new session. |
| `--write` | Tell DSH it may modify files. **Without it DSH is asked not to write**, but the plugin does not enforce that (see the plugin README); say so if the user asks for a guarantee. |
| `--analyze` | Run a read-only research pass first, then execute the brief it produces. Two DSH turns, two sessions. Cannot be combined with `--resume`. |
| `--analyze-model <id\|flash\|pro>` | Model for the research pass only. Defaults to `pro`, independent of `--model`. |
| `--analyze-provider <id>` | Disambiguates the analysis model the same way `--provider` disambiguates `--model`. |
| `--analyze-effort <level>` | Reasoning effort for the research pass only. Which levels exist is the route's business, not this plugin's. |
| `--model <id\|flash\|pro>` | `flash` and `pro` are aliases; any other value is a literal model id, resolved against the catalog the runtime advertises. Omit it to keep whatever DSH selected. |
| `--provider <id>` | Disambiguates a model id that several providers offer. Run `models` to see the real catalog before guessing. |
| `--effort <level>` | Reasoning effort for this turn. The selected route decides which levels exist — `models` prints them, and each turn reports the one in effect. |
| `--prompt-file <path>` | Read the task from a file. |
| `--cwd <dir>` | Run against another workspace. |
| `--json` | Emit the structured payload instead of text. |

The exit code is 0 only when DSH ended the turn normally; anything else is a failure, and the reason
is on stderr.

## Reporting

Return stdout unchanged. When the user wants the result later, use the `dsh-jobs` skill instead of
holding the turn open.
