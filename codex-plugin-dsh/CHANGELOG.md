# Changelog

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
