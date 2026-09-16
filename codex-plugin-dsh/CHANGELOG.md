# Changelog

## Unreleased

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
