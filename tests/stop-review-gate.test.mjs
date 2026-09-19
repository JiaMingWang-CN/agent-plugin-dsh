/**
 * Tests for the Stop-time review gate.
 *
 * The gate is driven the way Codex drives it: one JSON payload on stdin, and
 * the only thing that may appear on stdout is a block decision.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test, { after } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const COMPANION = path.join(REPO_ROOT, "plugins", "dsh", "scripts", "dsh-companion.mjs");
const HOOK = path.join(REPO_ROOT, "plugins", "dsh", "scripts", "stop-review-gate-hook.mjs");
const FAKE_RUNTIME = path.join(HERE, "fake-acp-runtime.mjs");

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      // A leftover temp directory is not a test failure.
    }
  }
});

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeSandbox(prefix) {
  const workspace = makeTempDir(prefix + "-ws-");
  const stateRoot = makeTempDir(prefix + "-state-");
  const sessionStore = path.join(makeTempDir(prefix + "-store-"), "sessions.json");
  const baseEnv = {
    ...process.env,
    DSH_CODEX_DSH_BIN: FAKE_RUNTIME,
    DSH_COMPANION_DATA: stateRoot,
    FAKE_ACP_SESSION_STORE: sessionStore
  };

  const run = (args, options = {}) => {
    const result = spawnSync(process.execPath, [COMPANION, ...args], {
      cwd: options.cwd || workspace,
      encoding: "utf8",
      timeout: options.timeoutMs || 120000,
      env: { ...baseEnv, ...(options.env || {}) }
    });
    return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
  };

  /** Invoke the hook exactly as Codex does. */
  const gate = (payload, options = {}) => {
    const result = spawnSync(process.execPath, [HOOK], {
      cwd: options.cwd || workspace,
      encoding: "utf8",
      input: options.rawInput === undefined ? JSON.stringify(payload) : options.rawInput,
      timeout: options.timeoutMs || 120000,
      env: { ...baseEnv, ...(options.env || {}) }
    });
    return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
  };

  return { workspace, stateRoot, sessionStore, run, gate };
}

function enableGate(sandbox) {
  const result = sandbox.run(["setup", "--enable-review-gate"], { cwd: sandbox.workspace });
  assert.equal(result.status, 0, result.stderr);
}

const stopInput = (sandbox, extra = {}) => ({
  session_id: "codex-session-1",
  turn_id: "turn-1",
  transcript_path: null,
  cwd: sandbox.workspace,
  hook_event_name: "Stop",
  model: "gpt-5.4",
  permission_mode: "default",
  stop_hook_active: false,
  last_assistant_message: "I refactored the parser and the tests pass.",
  ...extra
});

test("a disabled gate writes nothing to stdout and exits 0", () => {
  const sandbox = makeSandbox("gate-off");
  const result = sandbox.gate(stopInput(sandbox));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "stdout stays empty so the hook is never recorded as failed");
});

test("a BLOCK verdict blocks the stop with the review's reason", () => {
  const sandbox = makeSandbox("gate-block");
  enableGate(sandbox);
  const result = sandbox.gate(stopInput(sandbox), {
    env: { FAKE_ACP_REPLY: "BLOCK: the new branch is unreachable when the cache is cold" }
  });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /unreachable when the cache is cold/);
  assert.ok(decision.reason.trim().length > 0, "the reason must be non-empty or Codex rejects the block");
  const status = JSON.parse(sandbox.run(["status", "--all", "--json"]).stdout);
  assert.equal(status.latestFinished, null, "the internal gate review is not recorded as a job");
  assert.deepEqual(status.recent, []);
});

test("an ALLOW verdict keeps stdout empty", () => {
  const sandbox = makeSandbox("gate-allow");
  enableGate(sandbox);
  const result = sandbox.gate(stopInput(sandbox), { env: { FAKE_ACP_REPLY: "ALLOW: the turn only ran the test suite" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const status = JSON.parse(sandbox.run(["status", "--all", "--json"]).stdout);
  assert.equal(status.latestFinished, null, "an allowed gate review is also ephemeral");
});

test("a gate review cannot replace the user's resumable task", () => {
  const sandbox = makeSandbox("gate-resume");
  const task = sandbox.run(["task", "--wait", "--json", "remember this task"]);
  assert.equal(task.status, 0, task.stderr);
  const taskId = JSON.parse(task.stdout).jobId;

  enableGate(sandbox);
  const gate = sandbox.gate(stopInput(sandbox), { env: { FAKE_ACP_REPLY: "ALLOW: checked" } });
  assert.equal(gate.status, 0, gate.stderr);

  const candidate = JSON.parse(sandbox.run(["task-resume-candidate", "--json"]).stdout);
  assert.equal(candidate.available, true);
  assert.equal(candidate.candidate.id, taskId);
});

test("the gate never runs twice for one turn", () => {
  const sandbox = makeSandbox("gate-active");
  enableGate(sandbox);
  const result = sandbox.gate(stopInput(sandbox, { stop_hook_active: true }), {
    env: { FAKE_ACP_REPLY: "BLOCK: this must not be reached" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "a second pass must allow, or a block would loop forever");
  assert.match(result.stderr, /already ran for this turn/);

  const status = sandbox.run(["status", "--all", "--json"]);
  assert.equal(JSON.parse(status.stdout).recent.length + JSON.parse(status.stdout).running.length, 0);
});

test("a review that cannot run reports the problem and allows", () => {
  const sandbox = makeSandbox("gate-fail");
  enableGate(sandbox);
  const result = sandbox.gate(stopInput(sandbox), { env: { FAKE_ACP_FAIL: "1" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "an unrunnable gate must not trap the session");
  assert.match(result.stderr, /dsh review gate:/);
});

test("an unparseable review answer is reported and allowed", () => {
  const sandbox = makeSandbox("gate-garbage");
  enableGate(sandbox);
  const result = sandbox.gate(stopInput(sandbox), { env: { FAKE_ACP_REPLY: "I think the code is fine, honestly." } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /neither ALLOW: nor BLOCK:/);
});

test("a missing dsh is reported on stderr and allows", () => {
  const sandbox = makeSandbox("gate-nodsh");
  enableGate(sandbox);
  const result = sandbox.gate(stopInput(sandbox), {
    env: { DSH_CODEX_DSH_BIN: path.join(sandbox.workspace, "no-such-dsh.mjs") }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /dsh is not available/);
});

test("an unreadable Stop payload is reported on stderr and allows", () => {
  const sandbox = makeSandbox("gate-badjson");
  enableGate(sandbox);
  const result = sandbox.gate({}, { rawInput: "{not json" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unreadable Stop payload/);
});

test("a blocking verdict also surfaces a still-running DSH job", async () => {
  const sandbox = makeSandbox("gate-running");
  enableGate(sandbox);

  const started = sandbox.run(["task", "--background", "--json", "long work"], {
    env: { FAKE_ACP_DELAY_MS: "120000" }
  });
  assert.equal(started.status, 0, started.stderr);
  const jobId = JSON.parse(started.stdout).jobId;

  const result = sandbox.gate(stopInput(sandbox), { env: { FAKE_ACP_REPLY: "BLOCK: leftovers" } });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, new RegExp(jobId));

  sandbox.run(["cancel", jobId, "--json"]);
});

test("the manifest does not override the default hooks file", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "plugins", "dsh", ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(
    manifest.hooks,
    undefined,
    "a manifest hooks path replaces hooks/hooks.json, so it must stay unset"
  );
  const claudeManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "plugins", "dsh", ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(
    claudeManifest.hooks,
    undefined,
    "Claude Code discovers hooks/hooks.json on its own; a manifest override would register a second gate"
  );
  const hooks = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "plugins", "dsh", "hooks", "hooks.json"), "utf8"));
  const handler = hooks.hooks.Stop[0].hooks[0];
  assert.equal(handler.type, "command");
  assert.equal(handler.async, undefined, "an async handler cannot apply control effects, so it can never block");
  assert.ok(handler.timeout >= 600);
  // One command serves both hosts. Codex substitutes ${KEY} placeholders into a
  // plugin hook command itself (codex-rs/hooks/src/engine/discovery.rs, pinned by
  // plugin_hook_sources_expand_plugin_placeholders in that crate's mod_tests.rs),
  // and exports CLAUDE_PLUGIN_ROOT next to PLUGIN_ROOT; Claude Code resolves the
  // same placeholder for the hooks/hooks.json it reads. commandWindows is gone
  // because nothing has to be expanded by cmd.exe any more, and Claude Code
  // reports hook keys it does not know.
  assert.deepEqual(Object.keys(handler).sort(), ["command", "timeout", "type"]);
  assert.match(handler.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/stop-review-gate-hook\.mjs/);
  assert.equal(handler.commandWindows, undefined);
});

test("the internal stop-review command is not advertised as a task option", () => {
  const sandbox = makeSandbox("gate-help");
  const result = sandbox.run(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /ephemeral|stop-review-gate/);
});
