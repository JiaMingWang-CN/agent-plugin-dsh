# Changelog

## Unreleased

- Completion delivery to the directing agent: agent-directed runs now stay in the foreground so the
  final DSH output reaches the agent that asked for the work. `/dsh:rescue` treats `--background` /
  `--wait` as host-side Agent execution controls and the `dsh:dsh-rescue` subagent always runs the
  companion task with `--wait` until DSH finishes, so Claude's native background Agent completion
  delivers the final output. `/dsh:review` and `/dsh:adversarial-review` run the companion with
  `--wait` and detach only through Claude's `Bash(..., run_in_background: true)` instead of letting
  the companion spawn its own worker; the Codex `dsh-delegate` and `dsh-review` skills keep the
  invoking agent alive with foreground `--wait` calls and return the final output. Direct CLI use is
  unchanged: `task` / `review --background` still create jobs managed by `status` / `result` /
  `cancel`, and cancellation and status behavior are untouched.
- The repository root is now the plugin root, matching the layout used by multi-host plugins such
  as Superpowers. Manifests, skills, commands, hooks, prompts, and scripts no longer live under an
  extra `plugins/dsh/` directory; both marketplace files point directly at `./`.
- Reworked both READMEs around installation, the basic workflow, optional capabilities,
  troubleshooting, and the root-level component layout.

## 0.2.0

- Claude Code host. The repository root now also carries `.claude-plugin/marketplace.json`, and
  `.claude-plugin/plugin.json` describes the same plugin to Claude Code, so one install
  serves both hosts (`codex plugin add dsh@dsh` and `/plugin install dsh@dsh`). Claude Code gains
  eight slash commands (`/dsh:setup`, `/dsh:review`, `/dsh:adversarial-review`, `/dsh:rescue`,
  `/dsh:status`, `/dsh:result`, `/dsh:cancel`, `/dsh:transfer`) and the `dsh:dsh-rescue` subagent;
  the four skills and the companion script were already host-neutral.
- `hooks/hooks.json` is now one file for both hosts: the Stop gate runs
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs"` and no longer needs
  `commandWindows`. Codex substitutes `${...}` placeholders inside a plugin hook command itself and
  exports `CLAUDE_PLUGIN_ROOT` next to `PLUGIN_ROOT`, while Claude Code resolves the same placeholder
  for the same `hooks/hooks.json` — so cmd.exe no longer has to expand anything, and Claude Code,
  which reports hook keys it does not know, sees only keys it understands.
- `transfer` hands over a Claude Code session as well as a Codex rollout: the shape is detected from
  the file's own contents, Claude `thinking` / `tool_use` / `tool_result` blocks and `isSidechain`
  records are skipped, the hand-over prompt names its source host, and `--json` gained a `host`
  field. `--source` is still required, and a transcript of neither shape is refused by name.
- Documentation: both READMEs describe the two hosts, the shared hooks file, the Claude Code trust
  model (plugin trust at install time instead of Codex's `trusted_hash`), and the new limitations —
  a Claude Code turn is blocked at most once, and `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` bounds
  consecutive blocks.

- Reasoning effort is no longer checked against a list this plugin carries. Which levels exist is a
  property of the selected model — a DeepSeek route advertises `off/low/high/max`, while a gateway
  route reached through pi-ai may advertise only `low/medium/high` — so the built-in whitelist both
  rejected levels the runtime accepts and accepted levels it refuses. The requested value now passes
  through and the runtime validates it against the route the turn actually runs on.
- Fixed: `--model` combined with `--effort` validated the effort against the *previous* model's
  advertised levels. A model switch answers with the whole option state recomputed for the new model,
  and that stale copy was being read; the switch response is now the source. `--model <gateway model>
  --effort medium` therefore works, and a rejection lists the levels of the model that was selected.
- Each turn now reports the effort it runs with and the set the route offers
  (`Reasoning effort: <in effect> (offered by this model: ...)`), so a turn that requests no effort
  still says which one it inherited and a model switch silently re-defaulting the level is visible.

## 0.1.2

- `models` now returns the per-model strength description the runtime advertises (for example
  "suited to focused, routine, or parallel tasks" versus "stronger agentic coding and difficult
  reasoning"), both in the text catalog and as a `description` field on each route in `--json`.
  The text catalog now also states that reasoning effort is one session-level option, whose values
  are the ones the currently selected model advertises, instead of looking like a per-model property.
- Fixed: an analyzed task whose research pass ends cleanly but answers an empty brief used to exit 0
  and be recorded as a completed job, while the payload said `failed`. It now exits 1, records a
  failed job, and reports the reason on stderr; nothing is executed.
- Fixed: a runtime killed by a signal was recorded as exit code 0, so `shutdown()` reported an
  "already-exited" success and the diagnostic read "exit code: 0". A signal death is now exit 1
  and the diagnostic names the signal.

## 0.1.1

- Analysis layer: `task --analyze` runs a read-only research pass (selectable with
  `--analyze-model` / `--analyze-provider` / `--analyze-effort`, defaulting to `pro`) that answers
  with a fixed-section task brief, then a fresh execution session carries the brief out. The research
  pass is always read-only, an empty or failed brief fails the job before execution, and `--analyze`
  is mutually exclusive with `--resume`. See `docs/phase-4-analysis-layer.md`.

## 0.1.0

- Initial release.
- Codex marketplace and plugin manifests, plus the `dsh-delegate`, `dsh-review`, `dsh-jobs`, and
  `dsh-setup` skills.
- `dsh-companion` subcommands: `setup`, `task`, `review`, `status`, `result`, `cancel`,
  `task-resume-candidate`, `task-worker`, and `transfer`.
- DSH transport over the ACP automation profile, chosen in Phase 0.1 because it is the only
  in-product surface that restores a persisted session in a later process
  (`docs/phase-0.1-resume-verification.md`).
- Workspace-scoped job store with confirmed-exit cancellation and terminal-state protection.
