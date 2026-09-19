---
description: Check whether the local DSH (DeepSeek Harness) install is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), PowerShell(node:*), Bash(npm:*), PowerShell(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" setup --json $ARGUMENTS
```

If the report says DSH is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install DSH now.
- Put the install option first and suffix its label with `(Recommended)`.
- Use these two options: `Install DSH (Recommended)` and `Skip for now`.
- If the user chooses install, run:

```bash
npm install -g @deepseek-ai/dsh
```

- Then rerun the setup command above.

If DSH is installed, or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- The report states only `where` a credential resolves from and never prints its value. Never ask the user to paste a key into the conversation; point at the four locations the `dsh-setup` skill lists instead.
- If the report says the model catalog is empty, the fix belongs to the user's DSH install (`DSH_HOME` settings/profile), not to this plugin.
