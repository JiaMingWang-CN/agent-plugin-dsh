# agent-plugin-dsh

[中文](README.md)

A Codex and Claude Code plugin for handing complex work to **DeepSeek Harness (DSH)**. It lets your primary agent delegate implementation, resume DSH sessions, request independent code reviews, and manage background jobs.

## Table of Contents

- [How it works](#how-it-works)
- [Installation](#installation)
- [The basic workflow](#the-basic-workflow)
- [Optional capabilities](#optional-capabilities)
- [What's inside](#whats-inside)
- [Models and permissions](#models-and-permissions)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## How it works

1. Ask for delegation or review in natural language in Codex, or invoke a `/dsh:*` command in Claude Code.
2. The plugin launches DSH's `acp` profile through the shared `scripts/dsh-companion.mjs` entry point.
3. DSH works in the current workspace. The plugin either returns its final response verbatim or records a long-running task as a background job.
4. Codex and Claude Code share the same workspace-scoped job store, so either host can inspect the same job.

The plugin does not bind a provider or maintain its own model catalog. Models, reasoning effort, and the real sandbox policy all come from DSH.

## Installation

Requirements:

- Node.js 18.18 or newer
- `dsh` available on `PATH`
- At least one working model configured in DSH

Install the plugin separately in each host you use.

### Codex

```sh
codex plugin marketplace add JiaMingWang-CN/codex-dsh
codex plugin add dsh@dsh
```

For local development, replace the repository name with the absolute path to this repository. Start a new Codex task after installing or updating so it loads the latest skills.

### Claude Code

```sh
/plugin marketplace add JiaMingWang-CN/codex-dsh
/plugin install dsh@dsh
/reload-plugins
```

For local development, the repository name can also be replaced with its absolute path.

## The basic workflow

### 1. Check the environment

```sh
npm run setup
node scripts/dsh-companion.mjs models
```

`setup` checks DSH, the profile, credential sources, and the workspace state directory. `models` lists the providers, models, and effort values actually offered by the current environment.

### 2. Delegate a task

In Codex, simply ask:

> Ask DSH to investigate and fix this failing test.

In Claude Code, use:

```text
/dsh:rescue investigate and fix this failing test
```

The shared script can also be called directly:

```sh
node scripts/dsh-companion.mjs task --wait "investigate and fix this failing test"
```

### 3. Manage long-running work

```sh
node scripts/dsh-companion.mjs task --background "run the full test suite and fix failures"
node scripts/dsh-companion.mjs status <job-id> --wait
node scripts/dsh-companion.mjs result <job-id>
node scripts/dsh-companion.mjs cancel <job-id>
```

In Codex, ask for the DSH job status directly. Claude Code provides `/dsh:status`, `/dsh:result`, and `/dsh:cancel`.

`--background` is an option for calling the CLI directly. When work is delegated through a skill or slash command (Codex's `dsh-delegate` / `dsh-review`, Claude Code's `/dsh:rescue`, `/dsh:review`, `/dsh:adversarial-review`), the agent runs DSH in the foreground with `--wait` and returns the final output to you when it finishes; the `--background` / `--wait` flags in `/dsh:rescue` and the two review commands only decide whether the host runs that call in the background — DSH never detaches from the agent on its own.

### 4. Resume a session

```sh
node scripts/dsh-companion.mjs task --resume "continue with the remaining issues"
```

`--resume` restores the real context through ACP `session/resume`. It fails when no resumable session exists instead of reconstructing history from a summary.

### 5. Request an independent review

```sh
node scripts/dsh-companion.mjs review --wait
node scripts/dsh-companion.mjs review --adversarial --base main --wait "focus on concurrency"
```

Codex triggers the `dsh-review` skill automatically. Claude Code provides `/dsh:review` and `/dsh:adversarial-review`.

For the complete CLI surface:

```sh
node scripts/dsh-companion.mjs --help
```

## Optional capabilities

### Analysis pass

`task --analyze` starts a read-only DSH session to produce a task brief, then starts a separate session to execute it:

```sh
node scripts/dsh-companion.mjs task --analyze --wait "make the login flow survive an expired session"
```

Execution does not start if analysis fails. This consumes an extra turn, leaves two DSH sessions, and cannot be combined with `--resume`.

### Stop review gate

The review gate asks DSH to inspect the final response before the host ends a turn. It is disabled by default and configured per workspace:

```sh
node scripts/dsh-companion.mjs setup --enable-review-gate
node scripts/dsh-companion.mjs setup --disable-review-gate
```

Only a first line of `BLOCK: <reason>` blocks the turn. A missing DSH, timeout, crash, or unparseable response allows the turn to finish. A host turn can be blocked at most once. Codex must also trust the plugin hook; Claude Code handles trust during installation.

## What's inside

Codex uses these skills automatically:

| Skill | Purpose |
|---|---|
| `dsh-delegate` | Delegate tasks and resume sessions |
| `dsh-review` | Standard and adversarial code review |
| `dsh-jobs` | Inspect, retrieve, and cancel background jobs |
| `dsh-setup` | Diagnose DSH and plugin configuration |

Claude Code also exposes these commands:

| Command | Purpose |
|---|---|
| `/dsh:setup` | Run diagnostics and manage the review gate |
| `/dsh:rescue` | Hand a task to the DSH subagent |
| `/dsh:review` / `/dsh:adversarial-review` | Request code review |
| `/dsh:status` / `/dsh:result` / `/dsh:cancel` | Manage background jobs |
| `/dsh:transfer` | Hand a Codex or Claude Code JSONL session to DSH |

The repository itself is the plugin root:

```text
agent-plugin-dsh/
├── .agents/plugins/marketplace.json
├── .claude-plugin/{marketplace.json,plugin.json}
├── .codex-plugin/plugin.json
├── agents/
├── commands/
├── hooks/
├── prompts/
├── scripts/
├── skills/
└── tests/
```

## Models and permissions

```sh
node scripts/dsh-companion.mjs models
node scripts/dsh-companion.mjs task --wait --model glm-5.3 "..."
node scripts/dsh-companion.mjs task --wait --model deepseek-v4-pro --provider volcengine "..."
```

- `flash` and `pro` are aliases for `deepseek-v4-flash` and `deepseek-v4-pro`.
- Without `--model`, the plugin preserves DSH's current selection.
- `--effort` must use a value advertised by the selected route.
- `--write` expresses write intent; it is not a sandbox. Set `DSH_PERMISSION_MODE=read-only` or `workspace-write` for real isolation.

Common environment variables:

| Variable | Purpose |
|---|---|
| `DSH_CODEX_DSH_BIN` | Select the `dsh` executable |
| `DSH_CODEX_MODEL` / `DSH_CODEX_PROVIDER` / `DSH_CODEX_EFFORT` | Default execution model |
| `DSH_CODEX_ANALYZE_MODEL` / `DSH_CODEX_ANALYZE_PROVIDER` / `DSH_CODEX_ANALYZE_EFFORT` | Default analysis model |
| `DSH_COMPANION_DATA` | Job state root |
| `DSH_HOME` | DSH home directory |
| `DSH_PERMISSION_MODE` | DSH sandbox policy |

## Troubleshooting

Start with:

```sh
node scripts/dsh-companion.mjs setup --json
node scripts/dsh-companion.mjs models --json
```

Keep these constraints in mind:

- A cancelled job may not flush its session log and cannot be resumed.
- Review-only behavior is a prompt contract by default; filesystem enforcement comes from the DSH sandbox.
- `transfer` is a bounded transcript handoff, not a native session import, and does not accept `.jsonl.zst`.
- ACP maps `completed`, `aborted`, and `blocked` to `end_turn`, so the plugin cannot distinguish them further.
- `models` and the review gate leave DSH sessions behind because ACP cannot delete sessions.

## Development

```sh
npm test
npm run setup
```

When changing the version, update `package.json`, both `plugin.json` files, and the Claude marketplace plugin version. Tests enforce that they stay in sync.

## License

MIT
