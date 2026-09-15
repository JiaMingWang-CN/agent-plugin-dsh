import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, withStateLock, writeJobFile } from "./state.mjs";

/** Statuses that no later writer may overwrite. */
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      sessionId: typeof value.sessionId === "string" && value.sessionId.trim() ? value.sessionId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    sessionId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  return fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
}

/**
 * Apply one terminal record unless a terminal record already exists.
 *
 * A cancellation that lands while the worker is finishing must win: the worker
 * never rewrites an existing terminal status, so a cancelled job cannot come
 * back as completed.
 *
 * @returns `{ applied, job }` where `job` is the stored record either way.
 */
export function applyTerminalState(workspaceRoot, jobId, patch) {
  return withStateLock(workspaceRoot, () => {
    const existing = readStoredJobOrNull(workspaceRoot, jobId);
    if (existing && TERMINAL_STATUSES.has(existing.status)) {
      return { applied: false, job: existing };
    }
    const next = { ...(existing ?? {}), ...patch, updatedAt: nowIso() };
    writeJobFile(workspaceRoot, jobId, next);
    upsertJob(workspaceRoot, {
      id: jobId,
      status: next.status,
      phase: next.phase,
      pid: null,
      sessionId: next.sessionId ?? null,
      summary: next.summary ?? null,
      stopReason: next.stopReason ?? null,
      exitStatus: next.exitStatus ?? null,
      result: next.result ?? null,
      errorMessage: next.errorMessage ?? null,
      completedAt: next.completedAt ?? null
    });
    return { applied: true, job: next };
  });
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastSessionId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.sessionId && normalized.sessionId !== lastSessionId) {
      lastSessionId = normalized.sessionId;
      patch.sessionId = normalized.sessionId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    withStateLock(workspaceRoot, () => {
      const storedJob = readStoredJobOrNull(workspaceRoot, jobId);
      if (!storedJob || TERMINAL_STATUSES.has(storedJob.status)) {
        return;
      }
      const next = { ...storedJob, ...patch, updatedAt: nowIso() };
      writeJobFile(workspaceRoot, jobId, next);
      upsertJob(workspaceRoot, patch);
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[dsh] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

/**
 * Run one tracked job body through its running → terminal lifecycle.
 *
 * The job file is the record of truth: the worker writes `running` before the
 * body starts, then a guarded terminal state so a concurrent cancel wins.
 */
export async function runTrackedJob(job, runner, options = {}) {
  const logFile = options.logFile ?? job.logFile ?? null;
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile
  };
  withStateLock(job.workspaceRoot, () => {
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id);
    if (existing && TERMINAL_STATUSES.has(existing.status)) {
      throw new Error(`Job ${job.id} already finished as ${existing.status}.`);
    }
    writeJobFile(job.workspaceRoot, job.id, runningRecord);
    upsertJob(job.workspaceRoot, runningRecord);
  });

  let execution;
  try {
    execution = await runner();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const result = applyTerminalState(job.workspaceRoot, job.id, {
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      logFile,
      completedAt: nowIso()
    });
    appendLogBlock(logFile, "Failure", errorMessage);
    if (!result.applied) {
      appendLogLine(logFile, `Kept existing terminal status "${result.job.status}" instead of "failed".`);
    }
    throw error;
  }

  const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
  const completedAt = nowIso();
  const result = applyTerminalState(job.workspaceRoot, job.id, {
    status: completionStatus,
    phase: completionStatus === "completed" ? "done" : "failed",
    sessionId: execution.sessionId ?? null,
    summary: execution.summary,
    exitStatus: execution.exitStatus,
    stopReason: execution.stopReason ?? null,
    errorMessage: execution.errorMessage ?? null,
    pid: null,
    logFile,
    completedAt,
    result: { ...(execution.payload || {}), rendered: execution.rendered }
  });

  if (result.applied) {
    appendLogBlock(logFile, "Final output", execution.rendered);
  } else {
    appendLogLine(
      logFile,
      `Kept existing terminal status "${result.job.status}" instead of "${completionStatus}".`
    );
  }
  return { ...execution, job: result.job, applied: result.applied };
}
