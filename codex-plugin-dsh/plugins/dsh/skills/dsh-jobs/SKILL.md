---
name: dsh-jobs
description: Inspect, retrieve, or cancel DeepSeek Harness (DSH) jobs started from this workspace. Use when the user asks "how is the DSH job doing", "what did DSH say", "get me the DSH result", "cancel the DSH job", or otherwise refers to background DSH work.
---

# DSH jobs

Jobs are recorded per workspace.

## Locating the companion script

This skill directory is the one containing this `SKILL.md`. Resolve the companion script from that
path in the same shell call you use to run it — never hardcode an install location:

```sh
DSH_COMPANION="$(dirname "<absolute path of this SKILL.md>")/../../scripts/dsh-companion.mjs"
```

Run every command as **one** shell invocation and return its stdout to the user **verbatim**. Do not
summarise, reformat, or editorialise. Progress lines arrive on stderr; keep them out of the answer
unless the command failed.

Give foreground calls a generous timeout: a real DSH turn can run for many minutes. Use
`--background` for anything you expect to be long, then report the job id.

## Commands

```sh
node "$DSH_COMPANION" status              # running jobs and the latest finished one
node "$DSH_COMPANION" status --all        # every recorded job
node "$DSH_COMPANION" status <job-id>     # one job
node "$DSH_COMPANION" status <job-id> --wait --timeout-ms 600000
node "$DSH_COMPANION" result <job-id>     # the stored output and the DSH session id
node "$DSH_COMPANION" cancel <job-id>     # terminate the job
```

Add `--json` for structured output. Every response has the stable top-level keys `jobId`, `status`,
`sessionId`, `stopReason`, `finalResponse`, and `exitStatus`, using `null` when a key does not apply.
`status` additionally returns a workspace or single-job snapshot, `result` returns `job` plus the
full `storedJob`, and `cancel` returns the cancelled job.

## What to tell the user

- **Cancel is forced termination.** It ends the DSH runtime process tree. A cancelled job's DSH
  session log may be incomplete, so a cancelled session is deliberately **not** offered for resume.
  The companion only reports `cancelled` after it has confirmed the processes exited; if cleanup
  fails it reports the pids that are still running instead.
- **Resume** is only possible for a job that finished normally and recorded a session. Use
  `result --json` and read `resumable`; when it is `true`, offer
  `task --resume --wait "<follow-up>"`. When it is `false`, read
  `resumeUnavailableReason` and tell the user why instead of retrying.
- Never claim a job's log is complete after a cancel.
