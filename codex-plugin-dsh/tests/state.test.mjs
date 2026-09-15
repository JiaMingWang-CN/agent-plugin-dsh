/**
 * Unit tests for plugins/dsh/scripts/lib/state.mjs.
 *
 * DSH_COMPANION_DATA is repointed at a fresh temp root for every test, so no
 * test can read or write the real per-user state root.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import {
  getConfig,
  listJobs,
  loadState,
  resolveJobsDir,
  resolveStateDir,
  resolveStateFile,
  saveState,
  setConfig,
  upsertJob,
  writeJobFile
} from "../plugins/dsh/scripts/lib/state.mjs";
import { applyTerminalState, createJobProgressUpdater } from "../plugins/dsh/scripts/lib/tracked-jobs.mjs";
import { findLatestResumableTaskJob } from "../plugins/dsh/scripts/lib/job-control.mjs";
import { resolveWorkspaceRoot } from "../plugins/dsh/scripts/lib/workspace.mjs";
import { cleanup, libPath, makeTempDir, runCompanion } from "./helpers.mjs";

const originalDataRoot = process.env.DSH_COMPANION_DATA;
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    cleanup(dir);
  }
  if (originalDataRoot === undefined) {
    delete process.env.DSH_COMPANION_DATA;
  } else {
    process.env.DSH_COMPANION_DATA = originalDataRoot;
  }
});

function tempDir(prefix) {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

/** A fresh workspace plus a fresh state root, wired into DSH_COMPANION_DATA. */
function makeWorkspace() {
  const dataRoot = tempDir("dsh-state-data-");
  const cwd = tempDir("dsh-state-ws-");
  process.env.DSH_COMPANION_DATA = dataRoot;
  return { dataRoot, cwd };
}

/** <slug>-<sha256(realpath(workspaceRoot))[:16]>, spelled out independently. */
function expectedStateDirName(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const hash = createHash("sha256").update(fs.realpathSync.native(workspaceRoot)).digest("hex").slice(0, 16);
  const slug = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  return slug + "-" + hash;
}

const isoAt = (index) => new Date(Date.UTC(2024, 0, 1) + index * 1000).toISOString();

describe("lib/state.mjs", () => {
  it("names the state dir <slug>-<sha256(realpath)[:16]>", () => {
    const { dataRoot, cwd } = makeWorkspace();
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const name = expectedStateDirName(cwd);

    assert.equal(resolveStateDir(cwd), path.join(dataRoot, "state", name));
    assert.equal(resolveStateFile(cwd), path.join(dataRoot, "state", name, "state.json"));
    assert.equal(resolveJobsDir(cwd), path.join(dataRoot, "state", name, "jobs"));
    assert.match(path.basename(resolveStateDir(cwd)), /^[a-zA-Z0-9._-]+-[0-9a-f]{16}$/);
    assert.ok(name.startsWith(path.basename(workspaceRoot) + "-"));
  });

  it("gives two different workspaces two different state dirs", () => {
    makeWorkspace();
    const parentA = tempDir("dsh-state-parent-a-");
    const parentB = tempDir("dsh-state-parent-b-");
    const a = path.join(parentA, "ws");
    const b = path.join(parentB, "ws");
    fs.mkdirSync(a);
    fs.mkdirSync(b);

    assert.equal(path.basename(a), path.basename(b), "both workspaces share the slug source");
    assert.notEqual(resolveStateDir(a), resolveStateDir(b), "the realpath hash separates them");
  });

  it("loadState returns defaults when no state file exists", () => {
    const { cwd } = makeWorkspace();
    assert.deepEqual(loadState(cwd), { version: 1, config: { stopReviewGate: false }, jobs: [] });
    assert.equal(fs.existsSync(resolveStateFile(cwd)), false);
  });

  it("loadState falls back to defaults for an unreadable state file", () => {
    const { cwd } = makeWorkspace();
    writeJobFile(cwd, "seed", { id: "seed" });
    fs.writeFileSync(resolveStateFile(cwd), "{ not json", "utf8");
    assert.deepEqual(loadState(cwd), { version: 1, config: { stopReviewGate: false }, jobs: [] });
  });

  it("upsertJob persists a job that saveState/loadState round-trips", () => {
    const { cwd } = makeWorkspace();
    const pinned = "2024-01-01T00:00:00.000Z";
    upsertJob(cwd, { id: "job-1", kind: "task", status: "running", title: "Review", updatedAt: pinned });

    const [created] = listJobs(cwd);
    assert.equal(created.id, "job-1");
    assert.equal(created.kind, "task");
    assert.equal(created.status, "running");
    assert.equal(created.title, "Review");
    assert.equal(created.updatedAt, pinned);
    assert.equal(Number.isFinite(Date.parse(created.createdAt)), true, "createdAt is stamped");

    upsertJob(cwd, { id: "job-1", status: "completed" });
    const jobs = listJobs(cwd);
    assert.equal(jobs.length, 1, "the same id is updated, not duplicated");
    assert.equal(jobs[0].status, "completed");
    assert.equal(jobs[0].createdAt, created.createdAt, "createdAt survives the patch");
    assert.ok(jobs[0].updatedAt > pinned, "updatedAt is refreshed");

    const onDisk = JSON.parse(fs.readFileSync(resolveStateFile(cwd), "utf8"));
    assert.equal(onDisk.version, 1);
    assert.deepEqual(onDisk.config, { stopReviewGate: false });
    assert.deepEqual(onDisk.jobs.map((job) => job.id), ["job-1"]);
    assert.deepEqual(saveState(cwd, { jobs: [] }).jobs, []);
  });

  it("serializes concurrent cross-process state updates", async () => {
    const { dataRoot, cwd } = makeWorkspace();
    const moduleUrl = pathToFileURL(libPath("state.mjs")).href;
    const source = `import { upsertJob } from ${JSON.stringify(moduleUrl)}; upsertJob(process.argv[1], { id: process.argv[2], status: "running" });`;
    const ids = Array.from({ length: 16 }, (_, index) => "parallel-" + index);
    await Promise.all(ids.map((id) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", source, cwd, id], {
        env: { ...process.env, DSH_COMPANION_DATA: dataRoot },
        stdio: "ignore"
      });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("state writer exited " + code)));
    })));
    assert.deepEqual(listJobs(cwd).map((job) => job.id).sort(), ids.sort());
  });

  it("keeps terminal job files terminal and mirrors result fields into state", () => {
    const { cwd } = makeWorkspace();
    const base = { id: "terminal", kind: "task", status: "running", workspaceRoot: cwd };
    writeJobFile(cwd, base.id, base);
    upsertJob(cwd, base);
    applyTerminalState(cwd, base.id, {
      status: "completed",
      phase: "done",
      stopReason: "end_turn",
      exitStatus: 0,
      result: { finalResponse: "done" },
      completedAt: new Date().toISOString()
    });
    createJobProgressUpdater(cwd, base.id)({ phase: "running", sessionId: "late-session" });

    const stored = JSON.parse(fs.readFileSync(path.join(resolveJobsDir(cwd), base.id + ".json"), "utf8"));
    assert.equal(stored.status, "completed");
    assert.equal(stored.phase, "done");
    const summary = listJobs(cwd).find((job) => job.id === base.id);
    assert.equal(summary.stopReason, "end_turn");
    assert.equal(summary.exitStatus, 0);
    assert.deepEqual(summary.result, { finalResponse: "done" });
  });

  it("does not resume legacy stop-gate task records", () => {
    const userTask = { id: "user", kind: "task", status: "completed", sessionId: "user-session", summary: "real task" };
    const gateTask = {
      id: "gate",
      kind: "task",
      status: "completed",
      sessionId: "gate-session",
      title: "DSH Task",
      write: false,
      summary: "ALLOW: the implementation and tests are sound"
    };
    assert.equal(findLatestResumableTaskJob([gateTask, userTask]).id, userTask.id);

    const modernTask = {
      ...gateTask,
      id: "modern",
      sessionId: "modern-session",
      dshHome: "/home/user/.dsh",
      dshProfile: "acp"
    };
    assert.equal(findLatestResumableTaskJob([modernTask, userTask]).id, modernTask.id);
  });

  it("caps the job list at 50, dropping the oldest updatedAt first", () => {
    const { cwd } = makeWorkspace();
    // Insert newest-first, so insertion order is the reverse of updatedAt order:
    // "keep the first 50 inserted" cannot pass this test.
    for (let index = 50; index >= 0; index -= 1) {
      upsertJob(cwd, { id: "job-" + index, updatedAt: isoAt(index) });
    }

    const jobs = listJobs(cwd);
    assert.equal(jobs.length, 50);
    assert.equal(jobs.some((job) => job.id === "job-0"), false, "the oldest updatedAt is pruned");
    assert.equal(jobs.some((job) => job.id === "job-50"), true, "the newest updatedAt is retained");
    assert.equal(jobs[0].id, "job-50");
  });

  it("deletes the stored file and log of every pruned job", () => {
    const { cwd } = makeWorkspace();
    const jobsDir = resolveJobsDir(cwd);
    fs.mkdirSync(jobsDir, { recursive: true });

    const seed = (id, index) => {
      const logFile = path.join(jobsDir, id + ".log");
      fs.writeFileSync(path.join(jobsDir, id + ".json"), "{}\n", "utf8");
      fs.writeFileSync(logFile, "log line\n", "utf8");
      return { id, updatedAt: isoAt(index), logFile };
    };
    // The five oldest jobs are listed first, so a prune that kept the first 50
    // entries instead of sorting by updatedAt would retain them and drop new-*.
    const oldJobs = [0, 1, 2, 3, 4].map((index) => seed("old-" + index, index));
    const newJobs = Array.from({ length: 50 }, (_, index) => seed("new-" + index, index + 10));
    saveState(cwd, { jobs: oldJobs });
    for (const job of oldJobs) {
      assert.ok(fs.existsSync(path.join(jobsDir, job.id + ".json")), job.id + " is stored before the prune");
    }

    const saved = saveState(cwd, { jobs: [...oldJobs, ...newJobs] });

    assert.equal(saved.jobs.length, 50);
    assert.deepEqual(
      saved.jobs.map((job) => job.id).sort(),
      newJobs.map((job) => job.id).sort(),
      "only the 50 newest updatedAt survive"
    );
    for (const job of oldJobs) {
      assert.equal(fs.existsSync(path.join(jobsDir, job.id + ".json")), false, "pruned job file " + job.id);
      assert.equal(fs.existsSync(job.logFile), false, "pruned job log " + job.id);
    }
    assert.ok(fs.existsSync(path.join(jobsDir, "new-0.json")), "retained job files stay");
  });

  it("setConfig and getConfig round-trip through state.json", () => {
    const { cwd } = makeWorkspace();
    assert.deepEqual(getConfig(cwd), { stopReviewGate: false });

    setConfig(cwd, "stopReviewGate", true);
    assert.equal(getConfig(cwd).stopReviewGate, true);

    setConfig(cwd, "custom", "value");
    const config = getConfig(cwd);
    assert.equal(config.stopReviewGate, true, "the default key survives");
    assert.equal(config.custom, "value");

    const onDisk = JSON.parse(fs.readFileSync(resolveStateFile(cwd), "utf8"));
    assert.deepEqual(onDisk.config, { stopReviewGate: true, custom: "value" });
  });

  it("the companion honors DSH_COMPANION_DATA and resolves the same state dir name", (t) => {
    const { cwd } = makeWorkspace();
    assert.ok(fs.existsSync(libPath("state.mjs")));

    const result = runCompanion(["setup", "--json"], {
      cwd,
      env: { DSH_CODEX_DSH_BIN: "dsh-not-installed-for-this-test" }
    });
    t.after(() => cleanup(result.dataDir));

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.dsh.available, false, "the fake binary keeps this hermetic");
    assert.equal(report.stateRoot, path.join(result.dataDir, "state", path.basename(resolveStateDir(cwd))));
  });
});
