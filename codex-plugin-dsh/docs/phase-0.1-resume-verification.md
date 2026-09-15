# Phase 0.1 — cross-process resume verification

**Status: PASSED, via the ACP profile.** The plugin drives `dsh --profile acp`; it does not drive the
SDK JSON-RPC profile.

Everything below was measured against the DSH installed on this machine
(`dsh 0.1.5-rc.1`, Node v24.16.0, Windows), not read off the source tree. The probes that produced
it are checked in under `probes/` and can be re-run.

## 1. The question

PLAN.md §5 Phase 0.1 asks whether a session created by one `dsh` process can be continued by a
**later** process, so that `task --resume` restores the previous DSH context instead of faking it.
The plan forbids the two things that would look like success without being it: reusing the same
session id to create a new same-named session, and replaying a summary of the old conversation.

## 2. Probe A — the SDK profile (fails)

`probes/resume-probe.mjs` starts `dsh --profile sdk` in an isolated `DSH_HOME`, creates a session,
asks it to remember a random marker, shuts the runtime down, and then starts a **second** process
that sends the same session id and asks only for the marker.

Result:

```json
{
  "verdict": "NOT-RESUMED",
  "rounds": [
    { "label": "A", "finalResponse": "ACK", "turnEnd": { "kind": "completed" }, "exitCode": 0 },
    { "label": "B", "finalResponse": "", "turnEnd": null,
      "error": "{\"code\":-32603,\"message\":\"session \\\"probe-c5bf904b3fcd\\\" already exists\"}" }
  ],
  "sessionStoreAfterA": ["--…--/probe-c5bf904b3fcd/session.v3.jsonl.zstd (13456B)"],
  "sessionStoreAfterB": ["--…--/probe-c5bf904b3fcd/session.v3.jsonl.zstd (13456B)"],
  "sessionStoreGrew": false
}
```

Two facts matter:

1. The second process **cannot** continue the first process's session. Its
   `session/prompt` fails with `-32603`.
2. It does not silently create a same-named session either. `ctx.agents.create()` collides with the
   persisted session id and fails loudly, which is the behaviour PLAN.md §6 asks for and the reason
   the "reuse the same id" shortcut is not merely wrong but impossible.

The SDK server has no resume path: `packages/sdk/server/src/server.ts` creates a session per id and
never calls the agent registry's `resume()`.

## 3. Probe B — the ACP profile (passes)

`probes/acp-resume-probe.mjs` repeats the same experiment against `dsh --profile acp`, using
`session/new` in process A and `session/resume` in process B.

Result:

```json
{
  "verdict": "RESUMED",
  "marker": "MG-AF27EBCFC98B406D",
  "rounds": [
    { "label": "A", "sessionId": "77d935e7-…", "stopReason": "end_turn",
      "assistantText": "ACK", "updateKinds": ["agent_message_chunk", "usage_update"] },
    { "label": "B", "resumeResult": { "configOptions": ["model", "reasoning_effort"] },
      "stopReason": "end_turn", "assistantText": "MG-AF27EBCFC98B406D",
      "updateKinds": ["agent_thought_chunk", "agent_message_chunk", "usage_update"] }
  ],
  "sessionStoreAfterA": ["--…--/77d935e7-…/session.v3.jsonl.zstd (12331B)"],
  "sessionStoreAfterB": ["--…--/77d935e7-…/session.v3.jsonl.zstd (22618B)"]
}
```

Process B was a brand-new process. The marker it returned was only ever sent in process A and appears
nowhere in the prompt of round B (`markerEchoedInPromptB` guards against exactly that). The session
log grew by the second turn's events. This is persisted-history restore, not id reuse and not a
replayed summary.

## 4. Probe C — lifecycle semantics the plugin depends on

`probes/acp-lifecycle-probe.mjs` measured the rest of the contract:

| Observation | Value |
|---|---|
| `session/prompt` settlement | resolves with `{ "stopReason": "end_turn" } ` |
| Tool progress | `tool_call` with `{ toolCallId, title, kind, status, rawInput }`, then `tool_call_update` with `{ toolCallId, status, content }` |
| `session/cancel` mid-turn | the in-flight prompt resolves `{ "stopReason": "cancelled" } ` |
| Shutdown | after `session/close`, ending stdin makes the process exit with code **0** (bounded, no kill needed) |

The ACP bridge also opens `session/request_permission` (one-shot allow/reject choices). The
`acp` profile's approval policy is `ask` unless `DSH_PERMISSION_MODE=danger-full-access`, so the
client must answer it or the turn stalls.

## 5. The wire the plugin speaks

`initialize` `{ protocolVersion: 1, clientCapabilities }` → `{ protocolVersion, agentInfo: { name: "deepseek-harness-acp", version }, agentCapabilities, authMethods }`

`session/new` `{ cwd, mcpServers: [] }` → `{ sessionId, configOptions }`

`session/resume` `{ sessionId, cwd, mcpServers: [] }` → `{ configOptions }`

`session/list` `{ cwd? }` → `{ sessions: [{ sessionId, cwd }], nextCursor? }`

`session/set_config_option` `{ sessionId, configId, value }` → `{ configOptions }`, where the
`model` value is the JSON string `["<provider>","<model>"]` and `reasoning_effort` is a plain
`off|low|high|max`.

`session/prompt` `{ sessionId, prompt: [{ type: "text", text }] }` → `{ stopReason }`; committed
output arrives as `session/update` notifications `{ sessionId, update }` with
`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, and `usage_update`.

`session/close` `{ sessionId }` → `{}`. `session/cancel` is a notification.

## 6. Decision

The plugin uses the **ACP profile**. It is the only in-product transport that satisfies PLAN.md §5
Phase 0.1 step 2, it is a stable versioned automation protocol rather than an internal one, and it
additionally provides a real `session/cancel` and an explicit configuration surface for model and
reasoning effort.

Consequences, all reflected in the plugin:

1. **Session ids come from the runtime.** `session/new` mints a UUID, so the plugin records the
   assigned id instead of choosing `codex-<jobId>` itself (PLAN.md §4.2 step 3 is superseded).
2. **Exit codes come from `stopReason`.** `session/prompt` resolves `end_turn`, `max_tokens`, or
   `cancelled`, and **rejects** when the turn failed (including a credentials failure), so a failure
   is still distinguishable and still exits non-zero. `aborted` and `blocked` turn endings, which
   the SDK profile would have reported verbatim, both map to `end_turn` in the ACP codec
   (`packages/acp/acp/src/codec.ts`) and are therefore not distinguishable. See the README's
   limitations.
3. **Cancellation stays process-tree termination.** The ACP connection lives inside the worker
   process, so a separate `cancel` invocation cannot send `session/cancel` over it; it terminates
   the owned process tree and confirms the exit, exactly as PLAN.md §4.3 requires.
4. **Shutdown is bounded.** Ending stdin is the runtime's documented successful shutdown and needs no
   signal; the signal/kill ladder remains as the fallback and is never reported as success without a
   confirmed exit.
