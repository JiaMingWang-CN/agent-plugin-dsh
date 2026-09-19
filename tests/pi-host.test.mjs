/**
 * Tests for the pi host integration.
 *
 * Four layers, mirroring the other host tests:
 *   1. manifest/structure assertions (always run),
 *   2. scripts/lib/pi-host.mjs units (always run, any Node),
 *   3. .pi/extensions/dsh.ts adapter behavior against a stub pi (skipped when
 *      this Node cannot strip TypeScript at import time),
 *   4. one end-to-end run through the fake ACP runtime (same TypeScript guard, no model).
 *
 * Nothing here touches a user's real DSH state: DSH_COMPANION_DATA always
 * points at a fresh temp directory.
 */

import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import {
  taskArgs,
  reviewArgs,
  jobsArgs,
  setupArgs,
  modelsArgs,
  resumeCandidateArgs,
  parseResumeCandidate,
  buildGatePayload,
  parseGateDecision,
  lastAssistantText,
  formatToolResult,
  runNodeScript
} from "../scripts/lib/pi-host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const COMPANION = path.join(REPO_ROOT, "scripts", "dsh-companion.mjs");
const GATE = path.join(REPO_ROOT, "scripts", "stop-review-gate-hook.mjs");
const ADAPTER = path.join(REPO_ROOT, ".pi", "extensions", "dsh.ts");
const FAKE_RUNTIME = path.join(HERE, "fake-acp-runtime.mjs");
const SKILLS = path.join(REPO_ROOT, "skills");

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

function readRepo(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function readRepoJson(relativePath) {
  return JSON.parse(readRepo(relativePath));
}

// ---------------------------------------------------------------------------
// 1. manifest and structure
// ---------------------------------------------------------------------------

test("the pi package manifest declares exactly the extension and the skills", () => {
  const pkg = readRepoJson("package.json");
  assert.deepEqual(pkg.pi.extensions, ["./.pi/extensions/dsh.ts"]);
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.equal(pkg.pi.prompts, undefined, "prompts are not declared so the repo templates never become pi user templates");
  assert.equal(pkg.pi.themes, undefined);
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes("pi-package"), "the pi-package keyword makes the package discoverable");
});

test("the pi adapter is the only TypeScript file in the project-level extension directory", () => {
  assert.ok(fs.existsSync(ADAPTER), "the pi adapter exists at its fixed path");
  const entries = fs.readdirSync(path.join(REPO_ROOT, ".pi", "extensions")).filter((name) => name.endsWith(".ts"));
  assert.deepEqual(entries, ["dsh.ts"], "the auto-discovery directory loads every .ts file, so helpers must not live here");
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "scripts", "lib", "pi-host.mjs")), "the shared adapter logic lives next to the other libs");
});

test("the pi manifest does not disturb the other two hosts", () => {
  const pkg = readRepoJson("package.json");
  assert.equal(pkg.private, true, "the plugin stays unpublished; pi installs it from a path or git source");
  assert.equal(pkg.type, "module");
  assert.deepEqual(
    [pkg.version, readRepoJson(".codex-plugin/plugin.json").version, readRepoJson(".claude-plugin/plugin.json").version, readRepoJson(".claude-plugin/marketplace.json").plugins[0].version],
    [pkg.version, pkg.version, pkg.version, pkg.version],
    "every version-bearing manifest stays in sync"
  );
});

// ---------------------------------------------------------------------------
// 2. lib units
// ---------------------------------------------------------------------------

test("taskArgs maps every session and option onto the companion argv", () => {
  const cwd = path.join(os.tmpdir(), "ws");
  assert.deepEqual(
    taskArgs({ task: "fix the bug", session: "new" }, cwd),
    ["task", "--fresh", "--wait", "--cwd", cwd, "--", "fix the bug"]
  );
  assert.deepEqual(
    taskArgs({ task: "keep going", session: "continue" }, cwd),
    ["task", "--resume", "--wait", "--cwd", cwd, "--", "keep going"]
  );
  assert.deepEqual(
    taskArgs({ task: "x", session: "new", analyze: true, model: "pro", provider: "volcengine", effort: "high" }, cwd),
    ["task", "--fresh", "--analyze", "--model", "pro", "--provider", "volcengine", "--effort", "high", "--wait", "--cwd", cwd, "--", "x"]
  );
  assert.deepEqual(
    taskArgs({ task: "x", session: "new", background: true }, cwd),
    ["task", "--fresh", "--background", "--cwd", cwd, "--", "x"]
  );
  // An unresolved "auto" is treated as a fresh run; the adapter always resolves
  // it first, so the builder never has to guess a session.
  assert.deepEqual(taskArgs({ task: "x" }, cwd), ["task", "--fresh", "--wait", "--cwd", cwd, "--", "x"]);
});

test("reviewArgs keeps the focus text as the only positional and drops it when empty", () => {
  const cwd = path.join(os.tmpdir(), "ws");
  assert.deepEqual(
    reviewArgs({ focus: "concurrency", adversarial: true, base: "main", scope: "branch" }, cwd),
    ["review", "--adversarial", "--base", "main", "--scope", "branch", "--wait", "--cwd", cwd, "--", "concurrency"]
  );
  assert.deepEqual(reviewArgs({}, cwd), ["review", "--wait", "--cwd", cwd]);
  assert.deepEqual(reviewArgs({ background: true }, cwd), ["review", "--background", "--cwd", cwd]);
});

test("jobsArgs covers list, status, result, and cancel", () => {
  const cwd = path.join(os.tmpdir(), "ws");
  assert.deepEqual(jobsArgs({ action: "list" }, cwd), ["status", "--all", "--cwd", cwd]);
  assert.deepEqual(jobsArgs({ action: "status", jobId: "task-1" }, cwd), ["status", "task-1", "--cwd", cwd]);
  assert.deepEqual(
    jobsArgs({ action: "status", jobId: "task-1", wait: true, timeoutMs: 60000 }, cwd),
    ["status", "task-1", "--wait", "--timeout-ms", "60000", "--cwd", cwd]
  );
  assert.deepEqual(jobsArgs({ action: "result", jobId: "task-1" }, cwd), ["result", "task-1", "--cwd", cwd]);
  assert.deepEqual(jobsArgs({ action: "cancel", jobId: "task-1" }, cwd), ["cancel", "task-1", "--cwd", cwd]);
  assert.throws(() => jobsArgs({ action: "bogus" }, cwd), /Unsupported dsh_jobs action/);
  assert.throws(() => jobsArgs({ action: "cancel" }, cwd), /requires jobId/);
  assert.throws(() => jobsArgs({ action: "status", wait: true }, cwd), /requires jobId/);
});

test("setupArgs never carries --cwd and modelsArgs always does", () => {
  assert.deepEqual(setupArgs({ action: "check" }), ["setup"]);
  assert.deepEqual(setupArgs({ action: "enable-gate" }), ["setup", "--enable-review-gate"]);
  assert.deepEqual(setupArgs({ action: "disable-gate" }), ["setup", "--disable-review-gate"]);
  assert.deepEqual(modelsArgs("/some/ws"), ["models", "--cwd", "/some/ws"]);
  assert.deepEqual(resumeCandidateArgs("/some/ws"), ["task-resume-candidate", "--json", "--cwd", "/some/ws"]);
});

test("parseResumeCandidate is fail-safe", () => {
  assert.deepEqual(
    parseResumeCandidate(JSON.stringify({ available: true, candidate: { id: "task-1", status: "completed" } }), 0),
    { available: true, reason: null, candidate: { id: "task-1", status: "completed" } }
  );
  assert.deepEqual(
    parseResumeCandidate(JSON.stringify({ available: false, reason: "no finished DSH task job in this workspace" }), 0),
    { available: false, reason: "no finished DSH task job in this workspace", candidate: null }
  );
  assert.deepEqual(parseResumeCandidate("not json", 0), { available: false, reason: null, candidate: null });
  assert.deepEqual(parseResumeCandidate("", 1), { available: false, reason: null, candidate: null });
});

test("buildGatePayload speaks the shared Stop-gate hook contract", () => {
  const payload = buildGatePayload({ cwd: "/ws", lastAssistantText: "done", stopHookActive: true });
  assert.deepEqual(payload, { cwd: "/ws", stop_hook_active: true, last_assistant_message: "done" });
  assert.deepEqual(buildGatePayload(), { cwd: "", stop_hook_active: false, last_assistant_message: "" });
});

test("parseGateDecision allows on anything but an explicit block", () => {
  assert.deepEqual(parseGateDecision(JSON.stringify({ decision: "block", reason: "the fix is untested" })), {
    block: true,
    reason: "the fix is untested"
  });
  assert.deepEqual(parseGateDecision(""), { block: false, reason: null });
  assert.deepEqual(parseGateDecision("garbage"), { block: false, reason: null });
  assert.deepEqual(parseGateDecision(JSON.stringify({ decision: "block", reason: "  " })), { block: false, reason: null });
});

test("lastAssistantText keeps only text blocks and the stop reason", () => {
  assert.deepEqual(
    lastAssistantText({
      role: "assistant",
      content: [
        { type: "thinking", text: "internal reasoning" },
        { type: "text", text: "the answer" },
        { type: "toolCall", name: "bash" }
      ],
      stopReason: "end_turn"
    }),
    { text: "the answer", stopReason: "end_turn" }
  );
  assert.deepEqual(lastAssistantText(null), { text: "", stopReason: null });
  assert.deepEqual(lastAssistantText({ content: "plain string" }), { text: "", stopReason: null });
});

test("formatToolResult returns stdout on success and an error text otherwise", () => {
  assert.equal(formatToolResult({ code: 0, stdout: "  the answer  ", stderr: "progress" }), "the answer");
  assert.match(formatToolResult({ code: 1, stdout: "", stderr: "boom" }), /exited with code 1[\s\S]*boom/);
  assert.match(formatToolResult({ code: 0, stdout: "", stderr: "", aborted: true }), /aborted before it finished/);
  const byBytes = "x".repeat(60000);
  const byteCapped = formatToolResult({ code: 0, stdout: byBytes, stderr: "" });
  assert.ok(byteCapped.includes("[truncated:"), "a byte-oversized result is capped");
  assert.ok(byteCapped.length < byBytes.length, "the byte cap actually cuts the output");
  const lineSource = "line\n".repeat(5000);
  const lineCapped = formatToolResult({ code: 0, stdout: lineSource, stderr: "" });
  assert.ok(lineCapped.includes("[truncated:"), "a line-oversized result is capped");
  assert.ok(lineCapped.length < lineSource.length, "the line cap actually cuts the output");
  assert.ok(lineCapped.split("\n").length <= 2000, "the line cap includes the truncation notice in the budget");
  const multibyteSource = "汉".repeat(60000);
  const multibyteCapped = formatToolResult({ code: 0, stdout: multibyteSource, stderr: "" });
  assert.ok(Buffer.byteLength(multibyteCapped, "utf8") <= 50 * 1024, "the byte cap includes the truncation notice");
  assert.equal(multibyteCapped.includes("�"), false, "the byte cap does not split a UTF-8 character");
  const errorCapped = formatToolResult({ code: 1, stdout: "", stderr: multibyteSource });
  assert.ok(Buffer.byteLength(errorCapped, "utf8") <= 50 * 1024, "error output uses the same byte cap");
});

test("runNodeScript passes argv, stdin, and stdout through an injectable spawn", async () => {
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: (data) => { child.stdinData = data; }, end: () => { child.stdinEnded = true; } };
  child.pid = 4321;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    process.nextTick(() => {
      const stdoutBytes = Buffer.from("the 汉 answer", "utf8");
      const stderrBytes = Buffer.from("progress 线\n", "utf8");
      child.stdout.emit("data", stdoutBytes.subarray(0, 5));
      child.stdout.emit("data", stdoutBytes.subarray(5, 6));
      child.stdout.emit("data", stdoutBytes.subarray(6));
      child.stderr.emit("data", stderrBytes.subarray(0, 10));
      child.stderr.emit("data", stderrBytes.subarray(10, 11));
      child.stderr.emit("data", stderrBytes.subarray(11));
      child.emit("close", 0);
    });
    return child;
  };

  const result = await runNodeScript({ scriptPath: COMPANION, args: ["task", "--", "do it"], cwd: "/ws", stdin: "{\"cwd\":\"/ws\"}", spawn });
  assert.deepEqual(calls[0].args, [COMPANION, "task", "--", "do it"]);
  assert.equal(calls[0].options.cwd, "/ws");
  assert.equal(child.stdinData, "{\"cwd\":\"/ws\"}");
  assert.ok(child.stdinEnded);
  assert.deepEqual(result, { code: 0, stdout: "the 汉 answer", stderr: "progress 线\n", killed: false });
});

test("runNodeScript contains stdin pipe errors instead of crashing the host", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = () => {
    child.stdin.emit("error", new Error("write EPIPE"));
  };
  child.stdin.end = () => {};
  child.pid = 4321;
  const spawn = () => {
    process.nextTick(() => child.emit("close", 1));
    return child;
  };

  const result = await runNodeScript({ scriptPath: GATE, cwd: "/ws", stdin: "payload", spawn });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /write EPIPE/);
});

// ---------------------------------------------------------------------------
// 3. adapter behavior (stub pi), only when this Node can load the .ts adapter
// ---------------------------------------------------------------------------

const tsCapable = Boolean(process.features && process.features.typescript);
const adapter = tsCapable ? await import(pathToFileURL(ADAPTER).href) : null;

function makeStubPi() {
  const handlers = new Map();
  const tools = [];
  const sent = [];
  return {
    api: {
      on(event, handler) {
        if (!handlers.has(event)) {
          handlers.set(event, []);
        }
        handlers.get(event).push(handler);
      },
      registerTool(definition) {
        tools.push(definition);
      },
      sendMessage(message, options) {
        sent.push({ message, options });
      }
    },
    tools,
    sent,
    emit(event, eventPayload, ctx) {
      return Promise.all((handlers.get(event) || []).map((handler) => handler(eventPayload, ctx)));
    }
  };
}

/** A spawn whose children emit canned output and close on the next tick. */
function cannedSpawn(scripts) {
  const calls = [];
  const remaining = scripts.slice();
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const spec = remaining.shift() || { code: 0, stdout: "", stderr: "" };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {} };
    child.pid = 1000 + calls.length;
    process.nextTick(() => {
      if (spec.stdout) {
        child.stdout.emit("data", Buffer.from(spec.stdout, "utf8"));
      }
      if (spec.stderr) {
        child.stderr.emit("data", Buffer.from(spec.stderr, "utf8"));
      }
      child.emit("close", spec.code === undefined ? 0 : spec.code);
    });
    return child;
  };
  return { calls, spawn };
}

test("the adapter registers four tools and five handlers", { skip: tsCapable ? false : "this Node cannot strip TypeScript types" }, async () => {
  const stub = makeStubPi();
  adapter.default(stub.api, {});
  assert.deepEqual(stub.tools.map((tool) => tool.name).sort(), ["dsh_jobs", "dsh_review", "dsh_setup", "dsh_task"]);
  for (const tool of stub.tools) {
    assert.equal(Object.getOwnPropertySymbols(tool.parameters).length, 0, tool.name + " uses plain JSON Schema, not TypeBox");
    assert.ok(tool.description.length > 20, tool.name + " describes itself for the LLM");
    assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0, tool.name + " adds guideline bullets");
    assert.equal(tool.parameters.additionalProperties, false, tool.name + " rejects unknown arguments");
  }
});

test("resources_discover points at the repository skills", { skip: tsCapable ? false : "this Node cannot strip TypeScript types" }, async () => {
  const stub = makeStubPi();
  adapter.default(stub.api, {});
  const results = await stub.emit("resources_discover", { type: "resources_discover", cwd: REPO_ROOT, reason: "startup" }, { cwd: REPO_ROOT });
  assert.deepEqual(results[0], { skillPaths: [SKILLS] });
});

test("dsh_task builds the companion argv and returns stdout verbatim", { skip: tsCapable ? false : "this Node cannot strip TypeScript types" }, async () => {
  const stub = makeStubPi();
  const { calls, spawn } = cannedSpawn([{ code: 0, stdout: "the final answer" }]);
  adapter.default(stub.api, { spawn });
  const tool = stub.tools.find((entry) => entry.name === "dsh_task");
  let registeredAbortListener = null;
  let abortListenerRemoved = false;
  const signal = {
    aborted: false,
    addEventListener(event, listener, options) {
      assert.equal(event, "abort");
      assert.deepEqual(options, { once: true });
      registeredAbortListener = listener;
    },
    removeEventListener(event, listener) {
      assert.equal(event, "abort");
      assert.equal(listener, registeredAbortListener);
      abortListenerRemoved = true;
    }
  };
  const result = await tool.execute("call-1", { task: "fix it", session: "new" }, signal, undefined, { cwd: REPO_ROOT, hasUI: false, ui: {} });
  assert.equal(typeof registeredAbortListener, "function", "the pi abort signal reaches the child-process helper");
  assert.equal(abortListenerRemoved, true, "the abort listener is removed after the child exits");
  assert.equal(calls[0].args[0], COMPANION);
  assert.deepEqual(calls[0].args.slice(1), ["task", "--fresh", "--wait", "--cwd", REPO_ROOT, "--", "fix it"]);
  assert.equal(result.content[0].text, "the final answer");
});

test("dsh_task surfaces a failed run as an error", { skip: tsCapable ? false : "this Node cannot strip TypeScript types" }, async () => {
  const stub = makeStubPi();
  const { spawn } = cannedSpawn([{ code: 1, stdout: "", stderr: "dsh is not available (not found)" }]);
  adapter.default(stub.api, { spawn });
  const tool = stub.tools.find((entry) => entry.name === "dsh_task");
  await assert.rejects(
    () => tool.execute("call-1", { task: "fix it", session: "new" }, undefined, undefined, { cwd: REPO_ROOT, hasUI: false, ui: {} }),
    /dsh is not available/
  );
});

test("dsh_task auto asks once and continues when the user confirms", { skip: tsCapable ? false : "this Node cannot strip TypeScript types" }, async () => {
  const stub = makeStubPi();
  const { calls, spawn } = cannedSpawn([
    { code: 0, stdout: JSON.stringify({ available: true, candidate: { id: "task-7", status: "completed" } }) },
    { code: 0, stdout: "resumed answer" }
  ]);
  adapter.default(stub.api, { spawn });
  const tool = stub.tools.find((entry) => entry.name === "dsh_task");
  let asked = 0;
  const result = await tool.execute("call-1", { task: "more", session: "auto" }, undefined, undefined, {
    cwd: REPO_ROOT,
    hasUI: true,
    ui: { confirm: async () => { asked += 1; return true; } }
  });
  assert.equal(asked, 1, "the resume prompt is asked exactly once");
  assert.deepEqual(calls[0].args.slice(1), ["task-resume-candidate", "--json", "--cwd", REPO_ROOT]);
  assert.deepEqual(calls[1].args.slice(1), ["task", "--resume", "--wait", "--cwd", REPO_ROOT, "--", "more"]);
  assert.equal(result.content[0].text, "resumed answer");
});

test("dsh_task auto starts fresh without a UI", { skip: tsCapable ? false : "this Node cannot strip TypeScript types" }, async () => {
  const stub = makeStubPi();
  const { calls, spawn } = cannedSpawn([
    { code: 0, stdout: JSON.stringify({ available: true, candidate: { id: "task-7", status: "completed" } }) },
    { code: 0, stdout: "fresh answer" }
  ]);
  adapter.default(stub.api, { spawn });
  const tool = stub.tools.find((entry) => entry.name === "dsh_task");
  const result = await tool.execute("call-1", { task: "x", session: "auto" }, undefined, undefined, { cwd: REPO_ROOT, hasUI: false, ui: {} });
  assert.deepEqual(calls[1].args.slice(1), ["task", "--fresh", "--wait", "--cwd", REPO_ROOT, "--", "x"]);
  assert.equal(result.content[0].text, "fresh answer");
});

test("dsh_task analyze always starts fresh and rejects an explicit continuation", { skip: tsCapable ? false : "this Node cannot strip TypeScript types" }, async () => {
  const stub = makeStubPi();
  const { calls, spawn } = cannedSpawn([{ code: 0, stdout: "analyzed answer" }]);
  adapter.default(stub.api, { spawn });
  const tool = stub.tools.find((entry) => entry.name === "dsh_task");
  const result = await tool.execute("call-1", { task: "x", session: "auto", analyze: true }, undefined, undefined, {
    cwd: REPO_ROOT,
    hasUI: true,
    ui: { confirm: async () => { throw new Error("analyze must not ask to resume"); } }
  });
  assert.deepEqual(calls[0].args.slice(1), ["task", "--fresh", "--analyze", "--wait", "--cwd", REPO_ROOT, "--", "x"]);
  assert.equal(result.content[0].text, "analyzed answer");
  await assert.rejects(
    () => tool.execute("call-2", { task: "x", session: "continue", analyze: true }, undefined, undefined, { cwd: REPO_ROOT, hasUI: false, ui: {} }),
    /cannot be combined/
  );
});

test("dsh_setup spawns setup with the session cwd and models with --cwd", { skip: tsCapable ? false : "this Node cannot strip TypeScript types" }, async () => {
  const stub = makeStubPi();
  const { calls, spawn } = cannedSpawn([{ code: 0, stdout: "report" }, { code: 0, stdout: "catalog" }]);
  adapter.default(stub.api, { spawn });
  const tool = stub.tools.find((entry) => entry.name === "dsh_setup");
  await tool.execute("call-1", { action: "check" }, undefined, undefined, { cwd: REPO_ROOT, hasUI: false, ui: {} });
  assert.deepEqual(calls[0].args.slice(1), ["setup"]);
  assert.equal(calls[0].options.cwd, REPO_ROOT, "setup reads process.cwd(), so the spawn cwd is the session directory");
  await tool.execute("call-1", { action: "models" }, undefined, undefined, { cwd: REPO_ROOT, hasUI: false, ui: {} });
  assert.deepEqual(calls[1].args.slice(1), ["models", "--cwd", REPO_ROOT]);
  await tool.execute("call-1", { action: "enable-gate" }, undefined, undefined, { cwd: REPO_ROOT, hasUI: false, ui: {} });
  assert.deepEqual(calls[2].args.slice(1), ["setup", "--enable-review-gate"]);
});

test("dsh_jobs and dsh_review build their argv", { skip: tsCapable ? false : "this Node cannot strip TypeScript types" }, async () => {
  const stub = makeStubPi();
  const { calls, spawn } = cannedSpawn([{ code: 0, stdout: "a" }, { code: 0, stdout: "b" }]);
  adapter.default(stub.api, { spawn });
  const jobs = stub.tools.find((entry) => entry.name === "dsh_jobs");
  await assert.rejects(
    () => jobs.execute("call-0", { action: "cancel" }, undefined, undefined, { cwd: REPO_ROOT, hasUI: false, ui: {} }),
    /requires jobId/
  );
  await assert.rejects(
    () => jobs.execute("call-0b", { action: "status", wait: true }, undefined, undefined, { cwd: REPO_ROOT, hasUI: false, ui: {} }),
    /requires jobId/
  );
  assert.equal(calls.length, 0, "an invalid job action never spawns the companion");
  await jobs.execute("call-1", { action: "cancel", jobId: "task-3" }, undefined, undefined, { cwd: REPO_ROOT, hasUI: false, ui: {} });
  assert.deepEqual(calls[0].args.slice(1), ["cancel", "task-3", "--cwd", REPO_ROOT]);
  const review = stub.tools.find((entry) => entry.name === "dsh_review");
  await review.execute("call-1", { focus: "concurrency", adversarial: true }, undefined, undefined, { cwd: REPO_ROOT, hasUI: false, ui: {} });
  assert.deepEqual(calls[1].args.slice(1), ["review", "--adversarial", "--wait", "--cwd", REPO_ROOT, "--", "concurrency"]);
});

// ---------------------------------------------------------------------------
// 4. the review gate through the real hook and the fake ACP runtime
// ---------------------------------------------------------------------------

function makeSandbox(prefix) {
  const workspace = makeTempDir(prefix + "-ws-");
  const stateRoot = makeTempDir(prefix + "-state-");
  const sessionStore = path.join(makeTempDir(prefix + "-store-"), "sessions.json");
  return { workspace, stateRoot, sessionStore };
}

function enableGate(sandbox) {
  const result = spawnSync(process.execPath, [COMPANION, "setup", "--enable-review-gate"], {
    cwd: sandbox.workspace,
    encoding: "utf8",
    env: { ...process.env, DSH_CODEX_DSH_BIN: FAKE_RUNTIME, DSH_COMPANION_DATA: sandbox.stateRoot }
  });
  assert.equal(result.status, 0, result.stderr);
}

async function withFakeRuntime(fn) {
  const sandbox = makeSandbox("pi-host");
  const previous = {
    DSH_CODEX_DSH_BIN: process.env.DSH_CODEX_DSH_BIN,
    DSH_COMPANION_DATA: process.env.DSH_COMPANION_DATA,
    FAKE_ACP_SESSION_STORE: process.env.FAKE_ACP_SESSION_STORE,
    FAKE_ACP_REPLY: process.env.FAKE_ACP_REPLY
  };
  process.env.DSH_CODEX_DSH_BIN = FAKE_RUNTIME;
  process.env.DSH_COMPANION_DATA = sandbox.stateRoot;
  process.env.FAKE_ACP_SESSION_STORE = sandbox.sessionStore;
  delete process.env.FAKE_ACP_REPLY;
  try {
    await fn(sandbox);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("a real dsh_task run answers through the fake ACP runtime and records a job", { skip: tsCapable ? false : "this Node cannot strip TypeScript types" }, async () => {
  await withFakeRuntime(async (sandbox) => {
    const stub = makeStubPi();
    adapter.default(stub.api, {});
    const tool = stub.tools.find((entry) => entry.name === "dsh_task");
    const result = await tool.execute("call-1", { task: "paint the fence", session: "new" }, undefined, undefined, {
      cwd: sandbox.workspace,
      hasUI: false,
      ui: {}
    });
    assert.match(result.content[0].text, /paint the fence/);
    const stateFiles = fs.readdirSync(sandbox.stateRoot);
    assert.ok(stateFiles.length > 0, "the foreground task is recorded in the isolated state root");
  });
});

test("the gate blocks once per turn and is rearmed only by new user input", { skip: tsCapable ? false : "this Node cannot strip TypeScript types" }, async () => {
  await withFakeRuntime(async (sandbox) => {
    enableGate(sandbox);
    const stub = makeStubPi();
    adapter.default(stub.api, {});
    const ctx = { cwd: sandbox.workspace, hasUI: true, ui: { setStatus: () => {} } };

    await stub.emit("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [{ type: "text", text: "I shipped it." }], stopReason: "end_turn" } }, ctx);
    process.env.FAKE_ACP_REPLY = "BLOCK: the change has no tests";
    await stub.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(stub.sent.length, 1, "one block message is injected");
    assert.equal(stub.sent[0].options.triggerTurn, true);
    assert.equal(stub.sent[0].options.deliverAs, "followUp");
    assert.match(stub.sent[0].message.content, /the change has no tests/);

    // The follow-up turn settles again carrying stop_hook_active: the hook
    // allows and no second block is sent.
    await stub.emit("turn_end", { type: "turn_end", turnIndex: 1, message: { role: "assistant", content: [{ type: "text", text: "tests added" }], stopReason: "end_turn" } }, ctx);
    delete process.env.FAKE_ACP_REPLY;
    await stub.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(stub.sent.length, 1, "a second settle in the same turn does not block again");

    // Fresh user input rearms the gate.
    await stub.emit("input", { type: "input", text: "thanks", source: "interactive" }, ctx);
    await stub.emit("turn_end", { type: "turn_end", turnIndex: 2, message: { role: "assistant", content: [{ type: "text", text: "bye" }], stopReason: "end_turn" } }, ctx);
    process.env.FAKE_ACP_REPLY = "BLOCK: still unverified";
    await stub.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(stub.sent.length, 2);
    assert.match(stub.sent[1].message.content, /still unverified/);
  });
});

test("concurrent settle events start only one gate review", { skip: tsCapable ? false : "this Node cannot strip TypeScript types" }, async () => {
  const stub = makeStubPi();
  const { calls, spawn } = cannedSpawn([
    { code: 0, stdout: JSON.stringify({ decision: "block", reason: "fix the race" }) }
  ]);
  adapter.default(stub.api, { spawn });
  const ctx = { cwd: REPO_ROOT, hasUI: true, ui: { setStatus: () => {} } };
  await stub.emit("turn_end", { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end_turn" } }, ctx);

  await Promise.all([
    stub.emit("agent_settled", { type: "agent_settled" }, ctx),
    stub.emit("agent_settled", { type: "agent_settled" }, ctx)
  ]);

  assert.equal(calls.length, 1);
  assert.equal(stub.sent.length, 1);
});

test("an aborted turn never reaches the gate", { skip: tsCapable ? false : "this Node cannot strip TypeScript types" }, async () => {
  await withFakeRuntime(async (sandbox) => {
    enableGate(sandbox);
    const stub = makeStubPi();
    adapter.default(stub.api, {});
    const ctx = { cwd: sandbox.workspace, hasUI: true, ui: { setStatus: () => {} } };
    await stub.emit("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [{ type: "text", text: "..." }], stopReason: "aborted" } }, ctx);
    process.env.FAKE_ACP_REPLY = "BLOCK: must not be reached";
    await stub.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(stub.sent.length, 0, "a user-interrupted turn is not reviewed");
  });
});

// ---------------------------------------------------------------------------
// 5. documentation
// ---------------------------------------------------------------------------

test("both READMEs document the pi host", () => {
  for (const file of ["README.md", "README.en.md"]) {
    const source = readRepo(file);
    assert.match(source, /pi install/, file + " shows the pi install command");
    for (const tool of ["dsh_task", "dsh_review", "dsh_jobs", "dsh_setup"]) {
      assert.ok(source.includes(tool), file + " names the " + tool + " tool");
    }
  }
});
