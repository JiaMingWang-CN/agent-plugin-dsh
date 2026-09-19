# The ACP wire this plugin speaks

Documentation only — there is no code in this file. `dsh.mjs` implements exactly this subset of
ACP v1 over newline-delimited JSON-RPC 2.0 on the runtime's stdio, against
`dsh --profile acp`. The measurements behind it are in
[`docs/phase-0.1-resume-verification.md`](../../../../docs/phase-0.1-resume-verification.md).

Frames are one JSON object per line: `{"jsonrpc":"2.0","id":…,"method":…,"params":…}` for a request,
`{"jsonrpc":"2.0","id":…,"result"|"error":…}` for a response, and `{"jsonrpc":"2.0","method":…,"params":…}`
for a notification.

## Client to agent

| Method | Params | Result |
|---|---|---|
| `initialize` | `{ protocolVersion: 1, clientCapabilities: { fs: { readTextFile, writeTextFile }, terminal } }` | `{ protocolVersion, agentInfo: { name: "deepseek-harness-acp", version }, agentCapabilities, authMethods }` |
| `session/new` | `{ cwd, mcpServers: [] }` | `{ sessionId, configOptions }` |
| `session/resume` | `{ sessionId, cwd, mcpServers: [] }` | `{ configOptions }` |
| `session/list` | `{ cwd? }` | `{ sessions: [{ sessionId, cwd }], nextCursor? }` |
| `session/set_config_option` | `{ sessionId, configId, value }` | `{ configOptions }` |
| `session/prompt` | `{ sessionId, prompt: [{ type: "text", text }] }` | `{ stopReason }` |
| `session/close` | `{ sessionId }` | `{}` |
| `session/cancel` (notification) | `{ sessionId }` | — |

`configOptions` entries are `{ id, name, category, type: "select", currentValue, options }`, where
`options` is either a flat list of `{ value, name }` or grouped as `{ group, name, options: [...] }`.

- `configId: "model"` — `value` is the JSON **string** `["<provider>","<model>"]`.
- `configId: "reasoning_effort"` — `value` is `off` | `low` | `high` | `max`.

## Agent to client

| Method | Params | Client must answer |
|---|---|---|
| `session/update` (notification) | `{ sessionId, update }` | — |
| `session/request_permission` (request) | `{ sessionId, toolCall: { toolCallId }, options: [{ optionId, name, kind }] }` | `{ outcome: { outcome: "selected", optionId } }` or `{ outcome: { outcome: "cancelled" } }` |

`update.sessionUpdate` values this plugin reads:

- `agent_message_chunk` `{ messageId, content: { type: "text", text } }` — the final answer.
- `agent_thought_chunk` `{ messageId, content }` — reasoning; not surfaced as progress.
- `tool_call` `{ toolCallId, title, kind, status: "in_progress", rawInput }`.
- `tool_call_update` `{ toolCallId, status: "completed"|"failed", content }`.
- `usage_update` `{ used, size }`.

## Settlement

`session/prompt` resolves when the session is back at idle:

- `{ stopReason: "end_turn" }` — the turn ended normally. DSH's own `completed`, `aborted`, and
  `blocked` endings all map here (`packages/acp/acp/src/codec.ts`), so they are not distinguishable
  from the client side.
- `{ stopReason: "max_tokens" }` / `{ stopReason: "cancelled" }`.
- A JSON-RPC **error response** — the turn failed, including a credentials failure. The message is
  the diagnostic.

## Shutdown

After `session/close`, ending the runtime's stdin makes the process exit with code 0. That is the
documented bounded shutdown; signals are only the fallback.
