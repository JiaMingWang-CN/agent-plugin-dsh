# DSH Companion — Agent Guidelines

## If you are an AI agent

Read this file completely before changing the repository. These instructions apply to every file in
this repository and are the single source of truth for project structure, documentation, and
verification. Do not infer a host-specific layout from conventions used by other plugins.

## Project identity

This repository is a single plugin for both Codex and Claude Code. The repository root is the
plugin root. Do not recreate a `plugins/dsh/` wrapper or move shared components under a host-specific
directory.

The plugin delegates tasks and reviews to DeepSeek Harness (DSH) through the ACP profile. Keep the
runtime host-neutral: Codex and Claude Code should use the same scripts, prompts, skills, hooks, and
workspace-scoped job store.

## Repository layout

```text
agent-plugin-dsh/                       # Plugin root; do not add another wrapper directory
├── .agents/plugins/marketplace.json   # Codex marketplace; source points to ./
├── .codex-plugin/plugin.json          # Codex plugin manifest
├── .claude-plugin/
│   ├── marketplace.json               # Claude Code marketplace; source points to ./
│   └── plugin.json                    # Claude Code plugin manifest
├── agents/                             # Thin Claude Code subagent definitions
├── commands/                           # Claude Code slash commands
├── hooks/hooks.json                    # Shared Stop review gate
├── preferences/                        # Checked-in default prompt preferences
├── probes/                             # Manual probes against a real DSH installation
├── prompts/                            # Shared task and review prompt templates
├── scripts/
│   ├── dsh-companion.mjs               # User-facing CLI entry point
│   ├── stop-review-gate-hook.mjs       # Shared Stop hook entry point
│   └── lib/                            # Runtime, git, state, process, and rendering helpers
├── skills/                             # Skills used by both hosts
├── tests/                              # Node tests and fake ACP runtime
├── AGENTS.md                           # Authoritative repository instructions
├── CLAUDE.md                           # Claude Code pointer to AGENTS.md
├── README.md                           # Chinese user guide
├── README.en.md                        # English user guide
├── CHANGELOG.md                        # Release history
└── package.json                        # Package metadata and test scripts
```

When adding a file, put it in the existing directory that owns that concern. Add a new top-level
directory only when none of the responsibilities above fit, and update this tree in the same change.
Do not mirror shared files into separate Codex and Claude Code trees.

## Structural invariants

- Treat the repository root as the plugin root in code, tests, manifests, and documentation.
- Marketplace sources must remain rooted at `./`. Never document or restore `./plugins/dsh`.
- Keep `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json` at the repository root.
- Keep shared implementation in `scripts/`, `prompts/`, `skills/`, and `hooks/`; do not fork copies
  for each host.
- Claude Code commands and the shared hook must invoke scripts through
  `${CLAUDE_PLUGIN_ROOT}/scripts/...`, not an absolute checkout path.
- Let Claude Code discover `skills/`, `commands/`, `agents/`, and `hooks/hooks.json` from their
  default locations. Do not add discovery overrides to `.claude-plugin/plugin.json`.
- Do not add a `hooks` override to `.codex-plugin/plugin.json`; Codex discovers
  `hooks/hooks.json` from the plugin root.
- Keep runtime dependencies at zero unless a task explicitly requires adding one.

## Adding another agent host

When adding support for another coding-agent host, extend this plugin in place. Do not create a
second plugin root or copy the shared runtime into a host-specific tree. Use the following fixed
locations; do not invent alternate host directory names:

```text
agent-plugin-dsh/
├── .agents/
│   └── plugins/marketplace.json        # Codex marketplace metadata
├── .claude-plugin/
│   ├── marketplace.json                # Claude Code marketplace metadata
│   └── plugin.json                     # Claude Code plugin manifest
├── .codex-plugin/
│   └── plugin.json                     # Codex plugin manifest
├── .cursor-plugin/
│   └── plugin.json                     # Cursor plugin manifest
├── .devin-plugin/
│   └── plugin.json                     # Devin plugin manifest
├── .hermes-plugin/
│   ├── __init__.py                     # Hermes hook adapter
│   └── plugin.yaml                     # Hermes plugin manifest
├── .kimi-plugin/
│   └── plugin.json                     # Kimi Code plugin manifest
├── .muse-plugin/
│   ├── marketplace.json                # Muse marketplace metadata
│   └── plugin.json                     # Muse plugin manifest
├── .opencode/
│   ├── INSTALL.md                      # OpenCode-specific installation instructions
│   └── plugins/dsh.js                  # OpenCode runtime adapter
├── .pi/
│   └── extensions/dsh.ts               # Pi startup/bootstrap extension
├── hooks/
│   ├── hooks.json                      # Shared Claude Code and Codex hooks
│   ├── hooks-cursor.json               # Cursor hook mapping
│   └── session-start                   # Shared session-start executable
├── GEMINI.md                           # Gemini context entry point
├── gemini-extension.json               # Gemini extension manifest
└── index.js                            # OpenCode directory-form entry point
```

Only create a listed path when implementing and testing that host. Hosts that accept an existing
plugin format must reuse its manifest and shared directories rather than receive another adapter.
In particular, keep all reusable behavior in `scripts/`, `prompts/`, `skills/`, and `hooks/`.
Host-specific files may translate lifecycle events or tool names, but must remain thin adapters to
that shared implementation.

For every new host integration:

1. Use the exact manifest and adapter location shown above.
2. Point the host at the existing `skills/` directory and shared runtime wherever its manifest format
   permits it.
3. Make host-specific commands, hooks, and extensions invoke `scripts/dsh-companion.mjs`; do not
   reimplement DSH job handling in the adapter.
4. Use plugin-root-relative paths or the host's plugin-root environment variable; never use an
   absolute checkout path.
5. Add isolated integration tests using the fake ACP runtime. Do not access a user's real DSH state.
6. Add a separate installation subsection for the host to both READMEs and update workflow,
   capability, troubleshooting, and safety text only where behavior differs.
7. Update the main repository tree, manifests, package scripts, and `CHANGELOG.md` in the same
   change. Add every new version-bearing manifest to the version synchronization list below.
8. Verify installation, startup, skill discovery, and hook execution in a clean host session when
   that host is available. Report explicitly when this end-to-end check could not be run.

Do not create empty host directories or parallel copies of shared files in advance of a real,
tested integration.

## Version synchronization

When changing the plugin version, update all four version-bearing locations together:

1. `package.json`
2. `.codex-plugin/plugin.json`
3. `.claude-plugin/plugin.json`
4. The `dsh` entry in `.claude-plugin/marketplace.json`

The Codex marketplace intentionally does not carry a duplicate version field.

## Change routing

- CLI behavior belongs in `scripts/dsh-companion.mjs` or a focused module under `scripts/lib/`.
- Shared task wording belongs in `prompts/`; do not embed large prompt copies in host adapters.
- Codex behavior is described by `skills/*/SKILL.md` and each skill's `agents/openai.yaml`.
- Claude Code user commands belong in `commands/`. Preserve each command's frontmatter contract,
  including `description`, `argument-hint`, allowed tools, and whether model invocation is disabled.
- Keep `agents/dsh-rescue.md` a thin forwarder. It must pass the task to DSH rather than inspect or
  implement the task itself.
- Stop-gate changes must preserve fail-open behavior and the one-block-per-turn guard.
- Any path or component move must update manifests, package scripts, tests, both READMEs, and the
  changelog in the same change.
- Tests must use the fake ACP runtime and isolated temporary state. Never read or write a user's real
  DSH state during tests.

## README contract

`README.md` is the Chinese guide. `README.en.md` is its English mirror. Keep them structurally and
factually synchronized; do not update only one language.

Use this section order unless a change clearly requires a new section:

1. One-paragraph product description
2. Table of contents
3. How it works
4. Installation, separated by Codex and Claude Code
5. The basic workflow
6. Optional capabilities
7. What's inside
8. Models and permissions
9. Troubleshooting
10. Development and license

When editing the READMEs:

- First verify the behavior against manifests, commands, skills, and `--help`; do not document
  planned or assumed behavior.
- Make the same structural and factual change in both files in one patch. The text may be idiomatic
  in each language; it does not need to be a sentence-by-sentence literal translation.
- Write for plugin users, not for maintainers reconstructing implementation history.
- Keep the explanation concise and task-oriented. Put release history in `CHANGELOG.md`.
- State that the repository root is the plugin root.
- Use root-relative examples such as `node scripts/dsh-companion.mjs ...`.
- Never use `plugins/dsh/...` in commands, diagrams, or prose.
- Keep Codex and Claude Code installation instructions separate because each host is installed and
  refreshed independently.
- Keep the skill and slash-command tables aligned with the actual contents of `skills/` and
  `commands/`.
- Show a small set of representative commands. Point readers to
  `node scripts/dsh-companion.mjs --help` instead of duplicating the complete option grammar.
- Document safety-relevant behavior where users make decisions: sandbox boundaries, cancellation,
  session resume, transcript transfer, and Stop-gate fail-open behavior.
- Keep limitations honest. A prompt-level read-only request is not a filesystem sandbox.
- Add or remove headings, examples, links, and caveats in both language versions together.
- Check every command and relative link from the repository root. Prefer fenced `sh` blocks for
  shell commands and use the same representative examples in both languages.

## Verification

Run checks proportional to the change. For structural, runtime, manifest, or command changes, the
minimum completion bar is:

```sh
npm test
node scripts/dsh-companion.mjs --help
git diff --check
```

For documentation-only changes, `git diff --check` plus targeted checks of paths, commands, and
mirrored headings is sufficient. When changing plugin manifests, also run the available Codex plugin
validator.

Do not claim success while tests are still running. Report any test that was not run or did not
finish.

## Change discipline

- Make the smallest change that fully solves the request.
- Preserve unrelated user edits and existing behavior.
- Match the existing ESM and Node.js style.
- Do not add generated files, local state, probe output, or credentials to the repository.
- Update `CHANGELOG.md` for user-visible behavior or structural changes, not for typo-only edits.
