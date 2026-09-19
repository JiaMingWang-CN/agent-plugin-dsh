---
name: dsh-setup
description: Diagnose a broken DeepSeek Harness (DSH) setup for this plugin — dsh missing from PATH, a missing or unreadable DEEPSEEK_API_KEY, wrong DSH_HOME, or a dsh profile that cannot serve the ACP automation protocol. Use when DSH tasks fail immediately, when the user asks "is DSH configured", "why can't DSH run", or before the first delegation in a new machine.
---

# DSH setup check

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

## Workflow

```sh
node "$DSH_COMPANION" setup
node "$DSH_COMPANION" setup --json
```

The report covers: whether `dsh --version` runs, which profile is used, where
`DEEPSEEK_API_KEY` resolves from, the per-workspace state directory, and the stop-review-gate flag.

## Credential resolution order

The companion reports only **where** the key would be found; it never prints the value.

1. the process environment (`DEEPSEEK_API_KEY`),
2. `$DSH_HOME/.credentials.yaml`, in its `refs:` section,
3. `<workspace>/.env`,
4. `$DSH_HOME/.env`.

## Fixing what the report finds

| Symptom | Fix |
|---|---|
| `dsh: NOT available` | Install DeepSeek Harness so `dsh` is on `PATH`, then re-run `setup`. |
| `credentials: ... not found` | Put `DEEPSEEK_API_KEY` in one of the four places above, in that order of preference. |
| Tasks fail with an unexpected ACP agent identity | `DSH_CODEX_PROFILE` points at a profile that is not the ACP automation profile. Unset it, or set it to `acp`. |
| Tasks fail with `no adapter registered` | The ACP profile cannot reach the provider; check `DSH_HOME` and the profile's model row. |
| The wrong workspace is reported | `--cwd` or the current directory decides the workspace; job records are isolated per workspace. |

| `task --model X` fails with "not offered" | The catalog is per `DSH_HOME`/profile. Run `models` to see what this environment actually advertises. |

Overrides the plugin honours: `DSH_CODEX_DSH_BIN` (dsh executable), `DSH_CODEX_PROFILE`
(default `acp`), `DSH_CODEX_MODEL`, `DSH_CODEX_PROVIDER`, `DSH_CODEX_EFFORT`,
`DSH_COMPANION_DATA` (state root), `DSH_HOME`, `DSH_PERMISSION_MODE` (the real sandbox switch; the
plugin does not override it).

The `DSH_CODEX_*` prefix is this plugin's own naming and is host-agnostic: the same overrides apply
when the plugin runs inside Claude Code instead of Codex. The Stop review gate works in both hosts,
and it is still enabled per workspace with `setup --enable-review-gate`.
