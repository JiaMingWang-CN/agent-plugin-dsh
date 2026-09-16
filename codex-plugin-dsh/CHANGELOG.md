# Changelog

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
