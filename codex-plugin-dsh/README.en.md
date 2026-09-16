# codex-plugin-dsh

A Codex plugin that hands work to **DeepSeek Harness (DSH)**: delegate a coding task, continue an
earlier DSH session, get a normal or adversarial code review, and manage the resulting background
jobs — all by shelling out to one zero-dependency Node script.

This repository is the mirror image of [`codex-plugin-cc`](../codex-plugin-cc): there, Claude Code
commands Codex. Here, **Codex commands DSH**.

> This file covers **installation and configuration**. Design and trade-offs live in `PLAN.md`;
> the Chinese edition is `README.md`.

---

## 1. Requirements

| Requirement | Notes |
|---|---|
| **DSH** | `dsh` must run from `PATH` (`dsh --version`). The plugin drives the `acp` profile, which ships with DSH. |
| **Node.js ≥ 18.18** | The plugin scripts run on Node. |
| **At least one usable model configured in DSH** | The plugin is **not tied to a provider**: any model your `DSH_HOME`/profile advertises works (DeepSeek official, Volcengine, GLM, …). Run `models` after install to see what is actually offered — see section 6. |

Models and credentials are configured **in DSH itself** (`DSH_HOME` settings / profile); the plugin
makes no assumptions and only reads the catalog the runtime actually advertises. Run `models` after
install to confirm what you can use.

The plugin itself has **no npm runtime dependencies** — it speaks the ACP JSON-RPC wire directly.

## 2. Install

```sh
# 1) Register this directory as a local marketplace (use an absolute path)
codex plugin marketplace add /absolute/path/to/codex-plugin-dsh

# 2) Install the plugin
codex plugin add dsh@dsh

# 3) Confirm it is installed and enabled
codex plugin list
```

A new Codex session then exposes four skills:

| Skill | Use it for |
|---|---|
| `dsh-delegate` | "ask DSH to …", "continue the DSH session" |
| `dsh-review` | "have DSH review this", "poke holes in this design" |
| `dsh-jobs` | "how is the DSH job doing", "cancel it" |
| `dsh-setup` | "is DSH configured?" |

## 3. First-time self-check

> **From a Codex session you never type these commands**: just say "**check the DSH
> configuration**" or "is DSH installed?", which triggers the `dsh-setup` skill — it runs the
> commands below and brings their output back verbatim. The shell commands are the same entry
> point the skill uses, so they also work **without a Codex session** (scripts, CI).

Run `setup` once after installing, to confirm dsh is available:

```sh
node plugins/dsh/scripts/dsh-companion.mjs setup
# or machine-readable output
node plugins/dsh/scripts/dsh-companion.mjs setup --json
```

The report covers: whether `dsh --version` is available, the profile in use, where the default
provider's credentials resolve from (the source only — a value is never echoed), the state
directory for this workspace, and the review-gate switch. **`setup` is a local, offline check.**

**Then run `models` to see which models you can use** — it lists every provider and model the
current environment actually advertises, and `--model` can only pick from it (in a Codex session
the same sentence works: "**have DSH list the usable models**", via the `dsh-setup` skill):

```sh
node plugins/dsh/scripts/dsh-companion.mjs models
```

```sh
# Optional: enable / disable the Stop review gate for this workspace (off by default)
node plugins/dsh/scripts/dsh-companion.mjs setup --enable-review-gate
node plugins/dsh/scripts/dsh-companion.mjs setup --disable-review-gate
```

## 4. Configuring models in DSH

**Models, providers and credentials are configured in DSH itself**; the plugin neither manages
nor assumes which one is used. Provider routes and models you add in `DSH_HOME` settings /
profile are used as-is.

So there is no plugin-side configuration step — the one thing to do is:

```sh
node plugins/dsh/scripts/dsh-companion.mjs models
```

`models` lists every provider and model the current `DSH_HOME`/profile actually advertises,
along with the strength description each model carries (fast and cheap versus stronger reasoning,
and so on), to help you pick per task. If the model you want is in the list, the configuration is
done; an empty list or an error means the problem is on the DSH side — fix it with DSH's own
tooling and come back.

> **About "strength"**: the protocol has a single **session-level** reasoning-effort knob
> (`off / low / high / max` on a DeepSeek route; a gateway route reached through pi-ai may
> advertise only `low / medium / high` — **the plugin carries no vocabulary of its own**);
> there is no per-model set of tiers — which values the knob offers
> is decided by the currently selected model, so switching models can change the available
> levels. `models` therefore returns two things: each model's **strength description** (metadata
> the runtime advertises), and the `reasoning effort` list and current value the current model
> offers. Pick a level with `--effort`: the value passes straight to the runtime, which checks it
> against the model this turn actually selected — a rejection lists *that* model's levels — and
> every turn prints one line, `Reasoning effort: <in effect> (offered by this model: ...)`, so a
> model switch silently re-defaulting the level is visible in the log.

## 5. Environment variables

| Variable | Effect |
|---|---|
| `DSH_CODEX_DSH_BIN` | The `dsh` executable. A `.js`/`.mjs` path is run through this Node binary (on Windows it can point at `dsh.cmd`). |
| `DSH_CODEX_PROFILE` | The dsh profile. Defaults to `acp`; **do not change it** — another profile fails the ACP identity check. |
| `DSH_CODEX_MODEL`, `DSH_CODEX_EFFORT` | Defaults for `--model` and `--effort`. Unset means "do not change what DSH selected". |
| `DSH_CODEX_PROVIDER` | Default for `--provider`. Only disambiguates a model id offered by several providers. |
| `DSH_CODEX_ANALYZE_MODEL`, `DSH_CODEX_ANALYZE_PROVIDER`, `DSH_CODEX_ANALYZE_EFFORT` | Defaults for the `--analyze-*` options; they only affect the research pass of `task --analyze` (section 8). |
| `DSH_COMPANION_DATA` | State root. Defaults to `<tmpdir>/dsh-companion`. |
| `DSH_HOME` | DSH home, used for the model catalog, sessions, and the resume-consistency check. |
| `DSH_PERMISSION_MODE` | The real sandbox switch (`read-only`, `workspace-write`, `danger-full-access`). The plugin does **not** override it. |

Jobs are isolated **per workspace**, not per Codex session.

## 6. Choosing a model

**The provider is discovered, not assumed.** Which providers and models exist is a property of
your `DSH_HOME` and profile — `settings.yaml`'s `llm-pi-ai.providers` adds routes that a fresh
install does not have — so the plugin reads the catalog the runtime advertises for each session
instead of hardcoding one:

```sh
# what can I actually pick?
node plugins/dsh/scripts/dsh-companion.mjs models

# a bare model id resolves to whichever provider offers it
node plugins/dsh/scripts/dsh-companion.mjs task --wait --model glm-5.3 "..."

# disambiguate a model id that several providers offer
node plugins/dsh/scripts/dsh-companion.mjs task --wait --model deepseek-v4-pro --provider volcengine "..."
```

> **From a Codex session you do not need the commands**: to list models say "**have DSH list
> the usable models**" (the `dsh-setup` skill); to delegate with a model say something like
> "**use glm-5.3 to have DSH look into the API concurrency issue**" (the `dsh-delegate` skill),
> and the skill assembles `--model` / `--provider` for you. An unknown model fails **before the
> prompt is sent** and prints the real catalog grouped by provider.

Resolution rules:

1. `--model` (or `DSH_CODEX_MODEL`) is alias-resolved: `flash` → `deepseek-v4-flash`, `pro` →
   `deepseek-v4-pro`; anything else is taken as a literal model id.
2. The id is looked up in the catalog this session advertises. Not found → the command fails **before**
   the prompt, printing the real catalog grouped by provider.
3. Found under exactly one provider → that one is used.
4. Found under several → `--provider` / `DSH_CODEX_PROVIDER` decides; without it the preferred
   provider (`deepseek-official`) wins; if it is not among the candidates the command fails and lists
   them.
5. **With no `--model`, no model option is sent at all.** The plugin does not impose a default, so a
   DSH_HOME that configures its own model keeps it.

> `models` needs a session to read the catalog, and ACP has no session delete, so it creates one
> empty session that stays in your DSH session store. The command prints its id rather than
> hiding that.

## 7. Typical usage

Everything goes through `plugins/dsh/scripts/dsh-companion.mjs`:

```sh
node plugins/dsh/scripts/dsh-companion.mjs setup [--json]

node plugins/dsh/scripts/dsh-companion.mjs models [--cwd <d>] [--dsh-profile <p>] [--json]

node plugins/dsh/scripts/dsh-companion.mjs task [--wait|--background] [--resume|--resume-last|--fresh] \
     [--write] [--model <id|flash|pro>] [--provider <id>] [--effort <level>] \
     [--analyze] [--analyze-model <id|flash|pro>] [--analyze-provider <id>] [--analyze-effort <level>] \
     [--prompt-file <p>] [--dsh-profile <p>] [--cwd <d>] [--json] [prompt ...]

node plugins/dsh/scripts/dsh-companion.mjs review [--adversarial] [--wait|--background] [--base <ref>] \
     [--scope auto|working-tree|branch] [--model <m>] [--provider <p>] [--effort <e>] [--cwd <d>] [--json] [focus ...]

node plugins/dsh/scripts/dsh-companion.mjs status [job-id] [--all] [--wait] \
     [--timeout-ms N] [--poll-interval-ms N] [--cwd <d>] [--json]
node plugins/dsh/scripts/dsh-companion.mjs result [job-id] [--cwd <d>] [--json]
node plugins/dsh/scripts/dsh-companion.mjs cancel [job-id] [--cwd <d>] [--json]
node plugins/dsh/scripts/dsh-companion.mjs task-resume-candidate [--cwd <d>] [--json]
node plugins/dsh/scripts/dsh-companion.mjs transfer --source <codex-rollout.jsonl> [--cwd <d>] [--json]
```

Every `--json` response includes the stable top-level keys `jobId`, `status`, `sessionId`,
`stopReason`, `finalResponse`, and `exitStatus`; a key is `null` when it does not apply.

**Delegate and read the answer.** `task --wait "<task>"` writes DSH's final answer to stdout
byte-for-byte and exits 0 only when the turn ended normally.

**Delegate something long.**

```sh
node plugins/dsh/scripts/dsh-companion.mjs task --background "run the full test suite and fix failures"
# → DSH Task started in the background as task-… .
node plugins/dsh/scripts/dsh-companion.mjs status task-… --wait --timeout-ms 1800000
node plugins/dsh/scripts/dsh-companion.mjs result task-…
```

**Continue an earlier session.** `task --resume "<follow-up>"` restores the previous DSH context
through `session/resume`. If nothing is resumable the command fails before creating a job; it never
starts a fresh session under the old name and never replays a summary in place of the real history.

**Review a change.**

```sh
node plugins/dsh/scripts/dsh-companion.mjs review --wait
node plugins/dsh/scripts/dsh-companion.mjs review --adversarial --base main --wait "concurrency"
```

## 8. Analysis layer (optional)

Some tasks should be researched before they are executed. `task --analyze` inserts a **read-only
research pass** between the request and the execution: a stronger model reads the repository and
answers with a task brief — goal, scope, the files the executor must read, constraints, a checkable
definition of done, and risks — and a fresh execution session then carries the brief out.

```sh
node plugins/dsh/scripts/dsh-companion.mjs task --analyze --wait "make the login flow survive an expired session"
```

Points worth knowing:

- The two turns are **two independent `dsh` processes and sessions**, so the research model can be
  chosen separately with `--analyze-model` (default `pro`), `--analyze-provider`, and
  `--analyze-effort`; `result --json` reports `analysisSessionId`.
- The research pass is **always read-only**, even with `--write`; only the execution turn may write.
- A failed research pass or an empty brief fails the job and **nothing is executed**. `--analyze`
  cannot be combined with `--resume`.
- The cost: **two** DSH turns and **two** sessions, i.e. running the task twice.

## 9. Stop review gate (optional)

The plugin ships a `Stop` hook that can refuse to let a Codex turn end while DSH still sees a
problem with it. It is **off by default** and must be enabled per workspace (see section 3). Once
on, the hook sends the turn's final message to DSH with the prompt in
`prompts/stop-review-gate.md` and reads back a verdict:

- a first line of `BLOCK: <reason>` writes `{"decision":"block","reason":"<reason>"}` to stdout,
  which makes Codex continue the turn with that reason;
- anything else leaves stdout empty, which Codex records as a normal hook run.

Points worth knowing:

- **Only an explicit `BLOCK:` blocks.** A disabled gate, a missing `dsh`, a timeout, a crash, or an
  unparseable answer all allow and print the problem on stderr. A gate that can trap a session
  because the environment is misconfigured is worse than no gate.
- **The second pass never blocks.** Codex re-runs `Stop` hooks after a block; the hook allows
  immediately when the payload sets `stop_hook_active`, so a block cannot loop.
- **Each gate run leaves one closed DSH session** (ACP has no session-delete operation).

### Enabling it for real

1. **Trust the hook.** Codex runs plugin-supplied hooks only when their `hooks.state."<key>".trusted_hash`
   matches; an untrusted hook is silently skipped. Grant trust through Codex when it asks, or start
   Codex with `--dangerously-bypass-hook-trust` if you accept that risk.
2. **Turn the gate on** for the workspace, as above. The flag is stored per workspace, so a second
   checkout needs its own `setup --enable-review-gate`.
3. **Check the wiring** with the plugin installed: `codex` lists the hook for the `Stop` event, and
   the command it runs is
   `node "$PLUGIN_ROOT/scripts/stop-review-gate-hook.mjs"` (POSIX) or
   `node "%PLUGIN_ROOT%\scripts\stop-review-gate-hook.mjs"` (Windows).

## 10. FAQ

**Does `--resume` really restore the previous context?**
Yes. It uses ACP `session/resume`, which was verified to restore a session across processes before
any of this was built — see `docs/phase-0.1-resume-verification.md`.

**Can I resume a cancelled job?**
No, and the plugin will tell you why rather than trying. Cancellation is forced termination of the
process tree, so DSH never got to flush the session log and the log may be incomplete.

**What does `--write` actually enforce?**
Nothing by itself. It changes the instruction DSH receives. For the real barrier see limitation 1
below.

**Why is `cancel` a process kill rather than a graceful stop?**
The ACP connection belongs to the worker process that owns the turn; a separate `cancel` invocation
has no channel to send `session/cancel` over. The plugin terminates the recorded runtime process
tree and only then reports `cancelled`, so "cancelled" means the processes are gone.

**Which dsh profile?**
`acp`. The `sdk` profile cannot resume across processes, so it is not used.

**Why didn't the review gate block anything?**
In order: the gate is off for this workspace, Codex has not been told to trust the plugin hook, or
DSH answered something other than `BLOCK:`. Each case prints a line on stderr; run the hook by hand
with a captured payload to see which one you are in.

## 11. Known limitations

1. **Read-only review is a prompt contract, not a sandbox.** The review and no-`--write` prompts
   instruct DSH not to modify files, and the plugin answers DSH's one-shot permission prompts with
   *allow once*. **Nothing prevents a write.** If you need a real barrier, launch with
   `DSH_PERMISSION_MODE=read-only`, which engages DSH's own sandbox policy — the plugin deliberately
   does not choose that for you. Do not tell a user their files are guaranteed untouched.
2. **Turn-end granularity is coarser than DSH's own.** ACP maps DSH's `completed`, `aborted`, and
   `blocked` endings all onto `end_turn`, so the plugin cannot distinguish them; a failed turn
   instead rejects the prompt request and still exits non-zero.
3. **Cancellation does not promise a clean DSH log.** A forced kill does not run DSH's disposal path,
   flush, or write a `turn/end`; cancelled sessions are reported as not resumable for that reason.
4. **No structured review output.** The review result is fixed-section Markdown, not a JSON schema.
5. **Jobs are workspace-scoped.** Two Codex sessions in the same workspace share one job list.
6. **`transfer` is a bounded hand-over, not a native import.** `--source` is required and the
   transcript is truncated to a hard byte budget; `.jsonl.zst` archives are not supported and must
   be decompressed first.
7. **The stop review gate needs `dsh` and Codex hook trust to do anything.**

## 12. Repository layout

```
codex-plugin-dsh/
├─ .agents/plugins/marketplace.json     # local marketplace manifest
├─ plugins/dsh/
│  ├─ .codex-plugin/plugin.json         # plugin manifest
│  ├─ skills/{dsh-delegate,dsh-review,dsh-jobs,dsh-setup}/SKILL.md
│  ├─ prompts/*.md                      # review / analysis / delegate / gate prompt templates
│  ├─ hooks/hooks.json                  # stop review gate
│  └─ scripts/
│     ├─ dsh-companion.mjs              # entry point for every subcommand
│     ├─ stop-review-gate-hook.mjs
│     └─ lib/*.mjs                      # transport / state / process / job control / git
├─ tests/*.test.mjs                     # node --test, including the fake ACP runtime end to end
├─ probes/                              # throwaway probes that verify the real dsh protocol layer
├─ docs/                                # per-phase verification records
└─ PLAN.md                              # full design and acceptance record
```

## 13. Development and tests

```sh
npm test          # node --test tests/*.test.mjs
npm run setup     # equivalent to running companion setup once
```

The tests use an injected fake ACP runtime (`DSH_CODEX_DSH_BIN`) to cover foreground and
background tasks, cross-process resume, review, status/result/cancel, permission requests,
transfer, process-tree cleanup, and worker-crash reclamation.

## License

MIT.
