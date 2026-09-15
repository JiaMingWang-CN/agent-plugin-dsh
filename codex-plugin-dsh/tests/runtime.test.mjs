/**
 * End-to-end tests for dsh-companion against a fake 'dsh --profile acp' runtime.
 *
 * The fake is injected through DSH_CODEX_DSH_BIN, so nothing here needs a real
 * dsh, a real model, or a network. Every test owns its workspace, its state
 * root, and its fake session store.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STABLE_JSON_KEYS = ["jobId", "status", "sessionId", "stopReason", "finalResponse", "exitStatus"];

function assertStableJsonKeys(payload) {
  for (const key of STABLE_JSON_KEYS) {
    assert.ok(Object.hasOwn(payload, key), "missing stable JSON key " + key);
  }
}

/** A per-test sandbox: own workspace, own state root, own fake session store. */
function makeSandbox(prefix) {
  const workspace = makeTempDir(prefix + "-ws-");
  const stateRoot = makeTempDir(prefix + "-state-");
  const sessionStore = path.join(makeTempDir(prefix + "-store-"), "sessions.json");
  return {
    workspace,
    stateRoot,
    sessionStore,
    run(args, options = {}) {
      const result = spawnSync(process.execPath, [COMPANION, ...args], {
        cwd: options.cwd || workspace,
        encoding: "utf8",
        input: options.input,
        timeout: options.timeoutMs || 120000,
        env: {
          ...process.env,
          DSH_CODEX_DSH_BIN: FAKE_RUNTIME,
          DSH_COMPANION_DATA: stateRoot,
          FAKE_ACP_SESSION_STORE: sessionStore,
          ...(options.env || {})
        }
      });
      return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
    }
  };
}

function hasGit() {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function initRepo(root) {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "dsh@example.invalid"]);
  git(root, ["config", "user.name", "dsh test"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "original\n", "utf8");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-q", "-m", "initial"]);
}

/** Content snapshot of every file under root, plus the git index state. */
function snapshotTree(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") {
        continue;
      }
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const content = fs.readFileSync(full);
      files.set(relative, {
        type: entry.isSymbolicLink() ? "symlink" : "file",
        sha256: createHash("sha256").update(content).digest("hex"),
        size: content.length
      });
    }
  };
  walk(root);
  const index = git(root, ["ls-files", "--stage"]).stdout;
  return { files: [...files.entries()].sort(), index };
}

function isAlive(pid) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitUntil(predicate, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------

test("setup reports dsh availability and the credential source", () => {
  const sandbox = makeSandbox("setup");
  const result = sandbox.run(["setup", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assertStableJsonKeys(report);
  assert.equal(report.jobId, null);
  assert.equal(report.status, null);
  assert.equal(report.dsh.available, true);
  assert.equal(report.profile, "acp");
  assert.equal(report.preferredProvider, "deepseek-official");
  assert.equal(report.model, "runtime default");
  assert.ok(report.credentials.source, "a credential source is reported");
  assert.ok(!/sk-/.test(result.stdout), "no credential value is printed");
});

test("task --wait writes the DSH final answer to stdout byte-for-byte", () => {
  const sandbox = makeSandbox("task");
  const result = sandbox.run(["task", "--wait", "say hello"], { env: { FAKE_ACP_REPLY: "FIXED-ANSWER" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "FIXED-ANSWER", "stdout is the runtime's answer, byte for byte");

  const json = sandbox.run(["task", "--wait", "--json", "say hello"], { env: { FAKE_ACP_REPLY: "FIXED-ANSWER" } });
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assertStableJsonKeys(payload);
  assert.equal(payload.status, "completed");
  assert.equal(payload.finalResponse, "FIXED-ANSWER");
  assert.equal(payload.stopReason, "end_turn");
  assert.equal(payload.exitStatus, 0);
  assert.match(payload.sessionId, /^fake-/);
});

test("a failed turn exits non-zero and reports the reason on stderr", () => {
  const sandbox = makeSandbox("task-fail");
  const result = sandbox.run(["task", "--wait", "go"], { env: { FAKE_ACP_FAIL: "1" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /turn failed/);
});

test("a non-completed stop reason exits non-zero", () => {
  const sandbox = makeSandbox("task-stop");
  const result = sandbox.run(["task", "--wait", "go"], { env: { FAKE_ACP_STOP_REASON: "max_tokens" } });
  assert.equal(result.status, 1);
});

test("--model and --effort reach the runtime as configuration updates", () => {
  const sandbox = makeSandbox("task-route");
  const logFile = path.join(sandbox.workspace, "..", "route-" + Date.now() + ".log");
  const result = sandbox.run(["task", "--wait", "--model", "pro", "--effort", "low", "go"], {
    env: { FAKE_ACP_LOG: logFile }
  });
  assert.equal(result.status, 0, result.stderr);
  const methods = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  assert.equal(methods.filter((entry) => entry === "session/set_config_option").length, 2);
});

test("an unsupported model fails before any session is created", () => {
  const sandbox = makeSandbox("task-badmodel");
  const logFile = path.join(sandbox.workspace, "..", "badmodel-" + Date.now() + ".log");
  const result = sandbox.run(["task", "--wait", "--model", "no-such-model", "go"], {
    env: { FAKE_ACP_LOG: logFile }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not offered/);
  assert.ok(!fs.existsSync(logFile) || !fs.readFileSync(logFile, "utf8").includes("session/prompt"));
});

test("background task: status --wait then result returns the stored output", async () => {
  const sandbox = makeSandbox("bg");
  const started = sandbox.run(["task", "--background", "--json", "background work"], {
    env: { FAKE_ACP_REPLY: "FIXED-ANSWER" }
  });
  assert.equal(started.status, 0, started.stderr);
  const queued = JSON.parse(started.stdout);
  assert.equal(queued.status, "queued");

  const waited = sandbox.run(["status", queued.jobId, "--wait", "--timeout-ms", "60000", "--json"]);
  assert.equal(waited.status, 0, waited.stderr);
  const snapshot = JSON.parse(waited.stdout);
  assertStableJsonKeys(snapshot);
  assert.equal(snapshot.job.status, "completed", JSON.stringify(snapshot.job));
  assert.equal(snapshot.job.dshProfile, "acp");
  assert.ok(path.isAbsolute(snapshot.job.dshHome));
  assert.equal(snapshot.job.stopReason, "end_turn");
  assert.equal(snapshot.job.exitStatus, 0);
  assert.equal(snapshot.job.result.finalResponse, "FIXED-ANSWER");

  const result = sandbox.run(["result", queued.jobId, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assertStableJsonKeys(payload);
  assert.equal(payload.storedJob.result.rendered, "FIXED-ANSWER");
  assert.equal(payload.resumable, true);
  assert.equal(payload.storedJob.status, "completed");
});

test("--resume restores the previous session in a later process", async () => {
  const sandbox = makeSandbox("resume");
  const first = sandbox.run(["task", "--wait", "remember the marker"]);
  assert.equal(first.status, 0, first.stderr);

  const candidate = sandbox.run(["task-resume-candidate", "--json"]);
  assert.equal(candidate.status, 0, candidate.stderr);
  const discovery = JSON.parse(candidate.stdout);
  assert.equal(discovery.available, true);
  assert.match(discovery.candidate.sessionId, /^fake-/);

  const second = sandbox.run(["task", "--resume", "--wait", "what did I say?"], {
    env: { FAKE_ACP_REPORT_TURNS: "1" }
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /turns=2\b/, "the resumed session carries the earlier turn");
});

test("resume candidate rejects a different DSH_HOME", () => {
  const sandbox = makeSandbox("resume-home");
  const firstHome = makeTempDir("resume-home-a-");
  const secondHome = makeTempDir("resume-home-b-");
  const first = sandbox.run(["task", "--wait", "remember the marker"], { env: { DSH_HOME: firstHome } });
  assert.equal(first.status, 0, first.stderr);

  const candidate = sandbox.run(["task-resume-candidate", "--json"], { env: { DSH_HOME: secondHome } });
  assert.equal(candidate.status, 0, candidate.stderr);
  const payload = JSON.parse(candidate.stdout);
  assert.equal(payload.available, false);
  assert.match(payload.reason, /different DSH_HOME/);

  const resumed = sandbox.run(["task", "--resume", "--wait", "continue"], { env: { DSH_HOME: secondHome } });
  assert.equal(resumed.status, 1);
  assert.match(resumed.stderr, /different DSH_HOME/);
});

test("resume candidate agrees with --resume while a task is active", () => {
  const sandbox = makeSandbox("resume-active");
  assert.equal(sandbox.run(["task", "--wait", "first task"]).status, 0);
  const started = sandbox.run(["task", "--background", "--json", "long task"], {
    env: { FAKE_ACP_DELAY_MS: "120000" }
  });
  const jobId = JSON.parse(started.stdout).jobId;

  const candidate = JSON.parse(sandbox.run(["task-resume-candidate", "--json"]).stdout);
  assert.equal(candidate.available, false);
  assert.match(candidate.reason, /still (queued|running)/);
  sandbox.run(["cancel", jobId, "--json"]);
});

test("task-resume-candidate reports unavailability instead of inventing a session", () => {
  const sandbox = makeSandbox("no-resume");
  const result = sandbox.run(["task-resume-candidate", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, false);
  assert.ok(payload.reason);
  assert.equal(payload.candidate, null);
});

test("--resume fails before creating a job when there is nothing to resume", () => {
  const sandbox = makeSandbox("resume-empty");
  const result = sandbox.run(["task", "--resume", "--wait", "continue"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No previous DSH session/);
  const status = sandbox.run(["status", "--json"]);
  assert.equal(JSON.parse(status.stdout).running.length, 0);
});

test("cancel terminates the runtime tree, including its children", async () => {
  const sandbox = makeSandbox("cancel");
  const childPidFile = path.join(makeTempDir("cancel-pid-"), "child.pid");
  const started = sandbox.run(["task", "--background", "--json", "long work"], {
    env: { FAKE_ACP_DELAY_MS: "120000", FAKE_ACP_SPAWN_CHILD: "1", FAKE_ACP_CHILD_PID_FILE: childPidFile }
  });
  assert.equal(started.status, 0, started.stderr);
  const jobId = JSON.parse(started.stdout).jobId;

  const running = await waitUntil(() => {
    const snapshot = sandbox.run(["status", jobId, "--json"]);
    if (snapshot.status !== 0) {
      return false;
    }
    const stored = JSON.parse(snapshot.stdout).job;
    return Number.isFinite(stored.runtimePid) && fs.existsSync(childPidFile);
  }, 30000);
  assert.ok(running, "the job recorded a runtime and the fake spawned its child");

  const childPid = Number(fs.readFileSync(childPidFile, "utf8").trim());
  assert.ok(isAlive(childPid), "the runtime child is running before the cancel");

  const cancelled = sandbox.run(["cancel", jobId, "--json"]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.termination, "forced");

  const gone = await waitUntil(() => !isAlive(childPid), 15000);
  assert.ok(gone, "the runtime child process is gone after the cancel");

  const after = JSON.parse(sandbox.run(["status", jobId, "--json"]).stdout).job;
  assert.equal(after.status, "cancelled");
  assert.equal(after.phase, "cancelled");

  const result = sandbox.run(["result", jobId, "--json"]);
  const resultPayload = JSON.parse(result.stdout);
  assert.equal(resultPayload.resumable, false);
  assert.match(resultPayload.resumeUnavailableReason, /cancelled/);
});

test("cancel never rewrites an already completed job", async () => {
  const sandbox = makeSandbox("cancel-done");
  const started = sandbox.run(["task", "--background", "--json", "quick work"]);
  const jobId = JSON.parse(started.stdout).jobId;
  const waited = sandbox.run(["status", jobId, "--wait", "--timeout-ms", "60000", "--json"]);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");

  const cancelled = sandbox.run(["cancel", jobId, "--json"]);
  assert.equal(cancelled.status, 1);
  assert.match(cancelled.stderr, /No active job/);

  const after = JSON.parse(sandbox.run(["status", jobId, "--json"]).stdout).job;
  assert.equal(after.status, "completed", "the completed terminal state survived");
});

test("a crashed worker is detected and its orphaned runtime is cleaned up", async () => {
  const sandbox = makeSandbox("crash");
  const started = sandbox.run(["task", "--background", "--json", "crashed work"], {
    env: { FAKE_ACP_DELAY_MS: "120000" }
  });
  const jobId = JSON.parse(started.stdout).jobId;

  const observed = await waitUntil(() => {
    const snapshot = sandbox.run(["status", jobId, "--json"]);
    if (snapshot.status !== 0) {
      return false;
    }
    const stored = JSON.parse(snapshot.stdout).job;
    return Number.isFinite(stored.runtimePid);
  }, 30000);
  assert.ok(observed, "the runtime pid was recorded");

  const before = JSON.parse(sandbox.run(["status", jobId, "--json"]).stdout).job;
  const runtimePid = before.runtimePid;
  const workerPid = before.pid;
  process.kill(workerPid, "SIGKILL");

  const settled = await waitUntil(() => {
    const snapshot = sandbox.run(["status", jobId, "--json"]);
    if (snapshot.status !== 0) {
      return false;
    }
    return JSON.parse(snapshot.stdout).job.status === "failed";
  }, 30000);
  assert.ok(settled, "status marked the orphaned job failed");

  const after = JSON.parse(sandbox.run(["status", jobId, "--json"]).stdout).job;
  assert.match(after.errorMessage, /background worker exited/);
  const cleaned = await waitUntil(() => !isAlive(runtimePid), 15000);
  assert.ok(cleaned, "the orphaned runtime was terminated");
});

test("status reconciles an old queued job that never recorded a pid", () => {
  const sandbox = makeSandbox("queued-no-pid");
  const canonical = fs.realpathSync.native(sandbox.workspace);
  const slug = path.basename(canonical).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const stateDir = path.join(sandbox.stateRoot, "state", slug + "-" + hash);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const old = "2020-01-01T00:00:00.000Z";
  const job = { id: "task-orphan", kind: "task", status: "queued", phase: "queued", pid: null, createdAt: old, updatedAt: old };
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, config: {}, jobs: [job] }) + "\n");
  fs.writeFileSync(path.join(jobsDir, job.id + ".json"), JSON.stringify(job) + "\n");

  const candidate = sandbox.run(["task-resume-candidate", "--json"]);
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.doesNotMatch(JSON.parse(candidate.stdout).reason, /still queued/);

  const result = sandbox.run(["status", job.id, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const reconciled = JSON.parse(result.stdout).job;
  assert.equal(reconciled.status, "failed");
  assert.match(reconciled.errorMessage, /never started/);
});

test("a runtime that ignores stdin EOF is still cleaned up with a confirmed exit", () => {
  const sandbox = makeSandbox("no-eof");
  const result = sandbox.run(["task", "--wait", "stubborn"], {
    env: { FAKE_ACP_IGNORE_EOF: "1", FAKE_ACP_REPLY: "FIXED-ANSWER" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "FIXED-ANSWER", "the answer survives the forced cleanup");
});

const gitAvailable = hasGit();

test("review is read-only: the workspace snapshot is identical before and after", { skip: !gitAvailable }, () => {
  const sandbox = makeSandbox("review");
  initRepo(sandbox.workspace);
  fs.writeFileSync(path.join(sandbox.workspace, "dirty.txt"), "work in progress\n", "utf8");
  fs.writeFileSync(path.join(sandbox.workspace, "tracked.txt"), "modified\n", "utf8");

  const before = snapshotTree(sandbox.workspace);
  const result = sandbox.run(["review", "--wait", "check the parser"], { cwd: sandbox.workspace });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith("echo:"), "the review body is returned verbatim");
  const after = snapshotTree(sandbox.workspace);

  assert.deepEqual(after, before, "review must not change any file or the git index");
  assert.match(result.stdout, /read-only review/i, "the review prompt carries the read-only contract");
});

test("the review snapshot comparison detects a runtime that writes", { skip: !gitAvailable }, () => {
  const sandbox = makeSandbox("review-write");
  initRepo(sandbox.workspace);
  const dirty = path.join(sandbox.workspace, "tracked.txt");
  fs.writeFileSync(dirty, "modified\n", "utf8");

  const before = snapshotTree(sandbox.workspace);
  const result = sandbox.run(["review", "--wait"], {
    cwd: sandbox.workspace,
    env: { FAKE_ACP_WRITE_FILE: dirty }
  });
  assert.equal(result.status, 0, result.stderr);
  const after = snapshotTree(sandbox.workspace);

  assert.notDeepEqual(after, before, "a runtime that rewrites a dirty file must change the snapshot");
});

test("review --json reports the resolved target and the session", { skip: !gitAvailable }, () => {
  const sandbox = makeSandbox("review-json");
  initRepo(sandbox.workspace);
  fs.writeFileSync(path.join(sandbox.workspace, "new.txt"), "new\n", "utf8");

  const result = sandbox.run(["review", "--adversarial", "--json"], { cwd: sandbox.workspace });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "adversarial-review");
  assert.equal(payload.target.mode, "working-tree");
  assert.match(payload.sessionId, /^fake-/);
  assert.match(payload.finalResponse, /adversarial reviewer/i);
});

test("review --background runs through the worker and is retrievable", async () => {
  const sandbox = makeSandbox("review-bg");
  initRepo(sandbox.workspace);
  fs.writeFileSync(path.join(sandbox.workspace, "new.txt"), "new\n", "utf8");

  const started = sandbox.run(["review", "--background", "--json"], { cwd: sandbox.workspace });
  assert.equal(started.status, 0, started.stderr);
  const jobId = JSON.parse(started.stdout).jobId;

  const waited = sandbox.run(["status", jobId, "--wait", "--timeout-ms", "60000", "--json"]);
  const snapshot = JSON.parse(waited.stdout);
  assert.equal(snapshot.job.status, "completed", JSON.stringify(snapshot.job));
  assert.equal(snapshot.job.kind, "review");

  const result = sandbox.run(["result", jobId, "--json"]);
  assert.match(JSON.parse(result.stdout).storedJob.result.rendered, /## Summary/);
});

test("the permission channel is answered so a turn cannot stall", () => {
  const sandbox = makeSandbox("permission");
  const result = sandbox.run(["task", "--wait", "ask me"], {
    env: { FAKE_ACP_ASK_PERMISSION: "1", FAKE_ACP_REPLY: "PERM" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "PERM perm=allow-once");
});

test("transfer refuses to guess a source", () => {
  const sandbox = makeSandbox("transfer");
  const result = sandbox.run(["transfer"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --source/);
  const status = sandbox.run(["status", "--json"]);
  assert.equal(JSON.parse(status.stdout).running.length, 0);
});

test("transfer sends the named transcript and reports the new session", () => {
  const sandbox = makeSandbox("transfer-ok");
  const transcript = path.join(sandbox.workspace, "rollout.jsonl");
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "session_meta", cwd: sandbox.workspace }),
      JSON.stringify({ role: "user", content: "please fix the bug" }),
      JSON.stringify({ role: "assistant", content: "which bug?" })
    ].join("\n") + "\n",
    "utf8"
  );

  const result = sandbox.run(["transfer", "--source", transcript, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.sessionId, /^fake-/);
  assert.equal(payload.truncated, false);

  const stored = sandbox.run(["result", payload.jobId, "--json"]);
  const rendered = JSON.parse(stored.stdout).storedJob.result.rendered;
  assert.match(rendered, /please fix the bug/);
  assert.match(rendered, /which bug\?/);
});

test("transfer rejects a compressed transcript with a clear message", () => {
  const sandbox = makeSandbox("transfer-zst");
  const transcript = path.join(sandbox.workspace, "rollout.jsonl.zst");
  fs.writeFileSync(transcript, "not really compressed", "utf8");
  const result = sandbox.run(["transfer", "--source", transcript]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Compressed Codex transcripts are not supported/);
});

test("status --all lists every job for the workspace", async () => {
  const sandbox = makeSandbox("status-all");
  await sandbox.run(["task", "--wait", "one"]);
  sandbox.run(["task", "--wait", "two"]);
  const listed = sandbox.run(["status", "--all", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  const report = JSON.parse(listed.stdout);
  assertStableJsonKeys(report);
  assert.equal(report.status, null, "a multi-job snapshot has no single status");
  assert.equal(report.latestFinished.status, "completed");
  assert.equal(report.recent.length, 1);
  assert.equal(report.running.length, 0);
});

test("an unknown job reference is an error, not a silent success", () => {
  const sandbox = makeSandbox("unknown-job");
  const result = sandbox.run(["status", "task-does-not-exist", "--json"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No job found/);
});

// ---------------------------------------------------------------------------
// Route resolution: the provider comes from the runtime, never from a constant
// ---------------------------------------------------------------------------

/** The provider/model pairs the fake recorded as set_config_option values. */
function recordedModels(logFile) {
  if (!fs.existsSync(logFile)) {
    return [];
  }
  return fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("model:"))
    .map((line) => JSON.parse(line.slice("model:".length)));
}

function routeLog(sandbox, name) {
  return path.join(makeTempDir("route-log-"), name + ".log");
}

test("no --model means the runtime's own selection is left alone", () => {
  const sandbox = makeSandbox("route-default");
  const logFile = routeLog(sandbox, "default");
  const result = sandbox.run(["task", "--wait", "go"], { env: { FAKE_ACP_LOG: logFile } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(recordedModels(logFile), [], "the plugin must not override a model it was not asked to change");

  const setup = sandbox.run(["setup", "--json"]);
  const report = JSON.parse(setup.stdout);
  assert.equal(report.model, "runtime default");
  assert.equal(report.effort, "runtime default");
  assert.equal(report.preferredProvider, "deepseek-official");
});

test("a bare model id resolves to the provider that actually offers it", () => {
  const sandbox = makeSandbox("route-bare");
  const logFile = routeLog(sandbox, "bare");
  const result = sandbox.run(["task", "--wait", "--model", "glm-5.3", "go"], { env: { FAKE_ACP_LOG: logFile } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(recordedModels(logFile), [["volcengine", "glm-5.3"]]);
});

test("an ambiguous model id prefers the preferred provider", () => {
  const sandbox = makeSandbox("route-ambiguous");
  const logFile = routeLog(sandbox, "ambiguous");
  const result = sandbox.run(["task", "--wait", "--model", "deepseek-v4-pro", "go"], {
    env: { FAKE_ACP_LOG: logFile }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(recordedModels(logFile), [["deepseek-official", "deepseek-v4-pro"]]);
});

test("--provider overrides the preference for an ambiguous model", () => {
  const sandbox = makeSandbox("route-provider");
  const logFile = routeLog(sandbox, "provider");
  const result = sandbox.run(
    ["task", "--wait", "--model", "deepseek-v4-pro", "--provider", "volcengine", "go"],
    { env: { FAKE_ACP_LOG: logFile } }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(recordedModels(logFile), [["volcengine", "deepseek-v4-pro"]]);
});

test("DSH_CODEX_PROVIDER is honored as the default provider", () => {
  const sandbox = makeSandbox("route-env");
  const logFile = routeLog(sandbox, "env");
  const result = sandbox.run(["task", "--wait", "--model", "deepseek-v4-pro", "go"], {
    env: { FAKE_ACP_LOG: logFile, DSH_CODEX_PROVIDER: "volcengine" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(recordedModels(logFile), [["volcengine", "deepseek-v4-pro"]]);
});

test("a provider that does not offer the model is rejected with the catalog", () => {
  const sandbox = makeSandbox("route-wrongprovider");
  const result = sandbox.run(["task", "--wait", "--model", "glm-5.3", "--provider", "zai", "go"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not offered by provider "zai"/);
  assert.match(result.stderr, /volcengine: glm-5\.3, deepseek-v4-pro/, "the error lists what is really available");
});

test("--provider without a model is rejected instead of being ignored", () => {
  const sandbox = makeSandbox("route-nomodel");
  const result = sandbox.run(["task", "--wait", "--provider", "volcengine", "go"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--provider only chooses among models/);
});

test("models reports the catalog the runtime advertises", () => {
  const sandbox = makeSandbox("route-models");
  const result = sandbox.run(["models", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  const providers = [...new Set(payload.routes.map((route) => route.provider))].sort();
  assert.deepEqual(providers, ["deepseek-official", "volcengine", "zai"]);
  assert.deepEqual(
    payload.routes.filter((route) => route.provider === "volcengine").map((route) => route.model),
    ["glm-5.3", "deepseek-v4-pro"]
  );
  assert.deepEqual(payload.current, { provider: "deepseek-official", model: "deepseek-v4-flash" });
  assert.deepEqual(payload.efforts, ["off", "low", "high", "max"]);
  assert.equal(payload.currentEffort, "high");
  assert.ok(payload.discoverySessionId, "the throwaway session id is reported, not hidden");

  const text = sandbox.run(["models"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /volcengine/);
  assert.match(text.stdout, /stays in your DSH session store/, "the discovery cost is disclosed");
});

test("models fails before doing anything when dsh is missing", () => {
  const sandbox = makeSandbox("route-models-nodsh");
  const result = sandbox.run(["models", "--json"], { env: { DSH_CODEX_DSH_BIN: path.join(sandbox.workspace, "nope.mjs") } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dsh is not available/);
});
