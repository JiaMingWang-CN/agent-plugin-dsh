# agent-plugin-dsh

A plugin for **both Codex and Claude Code** that hands work to **DeepSeek Harness (DSH)**: delegate a
coding task, continue an earlier DSH session, get a normal or adversarial code review, and manage the
resulting background jobs — all through one zero-dependency Node script (`dsh-companion.mjs`). Both
hosts share the same scripts, the same prompt templates, and the same workspace-scoped job store.

Design and trade-offs live in `PLAN.md`; the Chinese edition is `README.md`.

## 1. Requirements

| Requirement | Notes |
|---|---|
| **DSH** | `dsh` must run from `PATH` (`dsh --version`). The plugin drives the `acp` profile, which ships with DSH. |
| **Node.js ≥ 18.18** | The plugin scripts run on Node. |
| **At least one usable model configured in DSH** | The plugin is **not tied to a provider**: any model your `DSH_HOME`/profile advertises works (DeepSeek official, Volcengine, GLM, …). Run `models` after install to see what is actually offered — see section 6. |

## 2. Install

```sh
# 1) Register this directory as a local marketplace (use an absolute path)
codex plugin marketplace add /absolute/path/to/agent-plugin-dsh

# 2) Install the plugin
codex plugin add dsh@dsh

# 3) Confirm it is installed and enabled
codex plugin list
```

Once published on GitHub, a git source works too — one command, no clone (the repository root's
`.agents/plugins/marketplace.json` is what makes codex recognize the whole repo; the Claude Code
side uses `.claude-plugin/marketplace.json`):

```sh
codex plugin marketplace add JiaMingWang-CN/codex-dsh
codex plugin add dsh@dsh
```

> **Why are there two layers of marketplace manifests?** Each host reads exactly one fixed path:
> Codex reads `.agents/plugins/marketplace.json` (its candidate list also accepts
> `.claude-plugin/marketplace.json` as a fallback), while Claude Code reads only
> `.claude-plugin/marketplace.json`. Registering the `agent-plugin-dsh/` directory itself therefore
> uses the two manifests at the repository root (`source: ./plugins/dsh`). Both point at the same
> `plugins/dsh`: the plugin itself is never copied or maintained twice.

### Codex side

A new Codex session then exposes four skills:

| Skill | Use it for |
|---|---|
| `dsh-delegate` | "ask DSH to …", "continue the DSH session" |
| `dsh-review` | "have DSH review this", "poke holes in this design" |
| `dsh-jobs` | "how is the DSH job doing", "cancel it" |
| `dsh-setup` | "is DSH configured?" |

### Claude Code side

Claude Code picks up the same repository and the same plugin through the root
`.claude-plugin/marketplace.json`:

```sh
# a local directory (absolute path), or straight from a git source:
/plugin marketplace add /absolute/path/to/agent-plugin-dsh
/plugin marketplace add JiaMingWang-CN/codex-dsh

/plugin install dsh@dsh
/reload-plugins
```

Claude Code then exposes the same four skills plus commands and a subagent:

| Command | Use it for |
|---|---|
| `/dsh:setup` | check `dsh`, the profile and where credentials resolve from; toggle the review gate |
| `/dsh:review` | read-only review of this workspace's changes (`--wait` / `--background` / `--base` / `--scope`) |
| `/dsh:adversarial-review` | the same review, steerable with focus text |
| `/dsh:rescue` | hand a substantial task to DSH through the `dsh:dsh-rescue` subagent |
| `/dsh:status` / `/dsh:result` / `/dsh:cancel` | inspect, retrieve or cancel a background job |
| `/dsh:transfer` | hand a Codex rollout or a Claude Code session over to DSH |

The commands and the subagent are thin forwarders: the execution body is always the same
`dsh-companion.mjs`, and jobs stay workspace-scoped, so a job started in Codex is visible from
`/dsh:status` in Claude Code.

## 3. First-time self-check

> **You do not type these commands from a session**: in Codex say "check the DSH configuration" (the
> `dsh-setup` skill), in Claude Code run `/dsh:setup` — both run the commands below and bring the output
> back verbatim. The shell commands themselves work without a host session (scripts, CI).

Run `setup` once after installing, to confirm dsh is available:

```sh
node plugins/dsh/scripts/dsh-companion.mjs setup
# or machine-readable output
node plugins/dsh/scripts/dsh-companion.mjs setup --json
```

The report covers: whether `dsh --version` is available, the profile in use, where the default
provider's credentials resolve from (the source only — a value is never echoed), the state
directory for this workspace, and the review-gate switch. **`setup` is a local, offline check.**

**Then run `models` to see which models you can use** — it lists every provider and model the current
environment advertises, and `--model` can only pick from that list:

```sh
node plugins/dsh/scripts/dsh-companion.mjs models
```

```sh
# Optional: enable / disable the Stop review gate for this workspace (off by default)
node plugins/dsh/scripts/dsh-companion.mjs setup --enable-review-gate
node plugins/dsh/scripts/dsh-companion.mjs setup --disable-review-gate
```

## 4. Configuring models in DSH

Models, providers and credentials are configured **in DSH itself** (`DSH_HOME` settings / profile); the
plugin assumes nothing and only reads the catalog the runtime advertises. So there is no plugin-side
configuration step: if `models` lists the model you want, the configuration is done; an empty list or an
error means the problem is on the DSH side — fix it there and come back.

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

> The `DSH_CODEX_*` prefix is this plugin's own naming and is host-agnostic: the same overrides apply
> when the plugin runs inside Claude Code instead of Codex.

## 6. Choosing a model

Which providers and models exist depends on your `DSH_HOME` and profile, so the plugin reads the
catalog the runtime advertises for each session instead of hardcoding one:

```sh
# what can I actually pick?
node plugins/dsh/scripts/dsh-companion.mjs models

# a bare model id resolves to whichever provider offers it
node plugins/dsh/scripts/dsh-companion.mjs task --wait --model glm-5.3 "..."

# disambiguate a model id that several providers offer
node plugins/dsh/scripts/dsh-companion.mjs task --wait --model deepseek-v4-pro --provider volcengine "..."
```

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
node plugins/dsh/scripts/dsh-companion.mjs transfer --source <transcript.jsonl> [--cwd <d>] [--json]
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

The plugin ships a `Stop` hook — **one `hooks/hooks.json` shared by both hosts** — that can refuse
to let the current host end a turn while DSH still sees a problem with it. It is **off by default**
and must be enabled per workspace (see section 3). Once on, the hook sends the turn's final message
to DSH with the prompt in `prompts/stop-review-gate.md` and reads back a verdict:

- a first line of `BLOCK: <reason>` writes `{"decision":"block","reason":"<reason>"}` to stdout,
  which makes the host continue the turn with that reason;
- anything else leaves stdout empty, which the host records as a normal hook run.

Points worth knowing:

- **Only an explicit `BLOCK:` blocks.** A disabled gate, a missing `dsh`, a timeout, a crash, or an
  unparseable answer all allow and print the problem on stderr. A gate that can trap a session
  because the environment is misconfigured is worse than no gate.
- **The second pass never blocks.** A host re-runs `Stop` hooks after a block; the hook allows
  immediately when the payload sets `stop_hook_active`, so a block cannot loop.
- **Each gate run leaves one closed DSH session** (ACP has no session-delete operation).

### Enabling it for real

1. **Trust the hook.** Codex runs plugin-supplied hooks only when their `hooks.state."<key>".trusted_hash`
   matches; an untrusted hook is silently skipped. Grant trust through Codex when it asks, or start
   Codex with `--dangerously-bypass-hook-trust` if you accept that risk. Claude Code is different:
   plugin hooks are trusted with the plugin at install time (the plugin trust prompt) rather than
   per hook, and `/hooks` lists the gate as coming from `Plugin Hooks`.
2. **Turn the gate on** for the workspace, as above. The flag is stored per workspace, so a second
   checkout needs its own `setup --enable-review-gate`.
3. **Check the wiring.** The hook command is
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs"` — both hosts substitute that
   placeholder, so one file is one command on both platforms.

## 10. FAQ

**Does `--resume` really restore the previous context?**
Yes. It uses ACP `session/resume`, which was verified to restore a session across processes before
any of this was built — see `docs/phase-0.1-resume-verification.md`.

**Can I resume a cancelled job?**
No, and the plugin will tell you why rather than trying. Cancellation is forced termination of the
process tree, so DSH never got to flush the session log and the log may be incomplete.

**Why is `cancel` a process kill rather than a graceful stop?**
The ACP connection belongs to the worker process that owns the turn; a separate `cancel` invocation
has no channel to send `session/cancel` over. The plugin terminates the recorded runtime process
tree and only then reports `cancelled`, so "cancelled" means the processes are gone.

**Which dsh profile?**
`acp`. The `sdk` profile cannot resume across processes, so it is not used.

**Why didn't the review gate block anything?**
In order: the gate is off for this workspace, the host has not been told to trust the plugin hook
(Codex's `trusted_hash`, Claude Code's plugin trust prompt), or DSH answered something other than
`BLOCK:`. Each case prints a line on stderr; run the hook by hand with a captured payload to see
which one you are in.

## 11. Known limitations

1. **Read-only review is a prompt contract, not a sandbox.** The review and no-`--write` prompts
   instruct DSH not to modify files, and the plugin answers DSH's one-shot permission prompts with
   *allow once*. **Nothing prevents a write.** If you need a real barrier, launch with
   `DSH_PERMISSION_MODE=read-only`, which engages DSH's own sandbox policy — the plugin deliberately
   does not choose that for you. Never present "read-only review" as a guarantee that nothing was written.
2. **Turn-end granularity is coarser than DSH's own.** ACP maps DSH's `completed`, `aborted`, and
   `blocked` endings all onto `end_turn`, so the plugin cannot distinguish them; a failed turn
   instead rejects the prompt request and still exits non-zero.
3. **Cancellation does not promise a clean DSH log.** A forced kill does not run DSH's disposal path,
   flush, or write a `turn/end`; cancelled sessions are reported as not resumable for that reason.
4. **No structured review output.** The review result is fixed-section Markdown, not a JSON schema.
5. **Jobs are workspace-scoped.** Two sessions in the same workspace — from either host — share one job list.
6. **`transfer` is a bounded hand-over, not a native import.** `--source` is required and the
   transcript is truncated to a hard byte budget. Two shapes are accepted, a Codex rollout and a
   Claude Code session, and the file's own contents decide which; `.jsonl.zst` archives are not
   supported and must be decompressed first.
7. **The stop review gate needs `dsh` and host hook trust to do anything**: Codex through
   `trusted_hash`, Claude Code through the plugin trust prompt at install time. Claude Code also caps
   consecutive blocks — the gate always allows when `stop_hook_active` is true, so a turn is blocked at
   most once, and `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` ends the turn beyond that.

## 12. Repository layout

```
agent-plugin-dsh/
├─ .agents/plugins/marketplace.json     # Codex marketplace manifest
├─ .claude-plugin/marketplace.json      # Claude Code marketplace manifest
├─ plugins/dsh/
│  ├─ .codex-plugin/plugin.json         # Codex plugin manifest
│  ├─ .claude-plugin/plugin.json        # Claude Code plugin manifest
│  ├─ skills/{dsh-delegate,dsh-review,dsh-jobs,dsh-setup}/SKILL.md   # shared by both hosts
│  ├─ commands/*.md                     # Claude Code slash commands (setup/review/rescue/…)
│  ├─ agents/dsh-rescue.md              # Claude Code subagent: a thin forwarder to task
│  ├─ prompts/*.md                      # review / analysis / delegate / gate prompt templates
│  ├─ hooks/hooks.json                  # stop review gate (one file, both hosts)
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

The five in-project version fields are kept in step by `tests/claude-host.test.mjs` (`package.json`,
the two marketplace manifests, the two plugin manifests). Keep both marketplace manifests' `source`
at `./plugins/dsh` when bumping the version.

## License

MIT.
