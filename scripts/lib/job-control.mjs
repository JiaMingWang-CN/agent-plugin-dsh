import fs from "node:fs";

import { getConfig, listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { TERMINAL_STATUSES } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
const LEGACY_STOP_REVIEW_PREFIX = "You are the stop-time review gate for another coding agent's turn";
const STOP_REVIEW_VERDICT = /^(?:ALLOW|BLOCK):/;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

export function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return ["Final output", "Failure", "Assistant message", "Review output"].includes(line);
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

export function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const finished = TERMINAL_STATUSES.has(job.status);
  return {
    ...job,
    progressPreview: finished ? [] : readJobProgressPreview(job.logFile, maxProgressLines),
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration: finished ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt) : null
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run the dsh-jobs skill to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs.filter((job) => isActiveJobStatus(job.status)).map((job) => enrichJob(job, { maxProgressLines }));
  const latestFinishedRaw = jobs.find((job) => !isActiveJobStatus(job.status)) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;
  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => !isActiveJobStatus(job.status) && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run the dsh-jobs skill to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  let selected = null;
  try {
    selected = matchJobReference(jobs, reference, (job) => TERMINAL_STATUSES.has(job.status));
  } catch (error) {
    selected = null;
  }
  if (selected) {
    return { workspaceRoot, job: selected };
  }

  if (reference) {
    const active = jobs.find((job) => job.id === reference || job.id.startsWith(reference));
    if (active && isActiveJobStatus(active.status)) {
      throw new Error(`Job ${active.id} is still ${active.status}. Check its status and try again once it finishes.`);
    }
    throw new Error(`No finished job found for "${reference}".`);
  }

  throw new Error("No finished DSH jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => isActiveJobStatus(job.status));

  if (reference) {
    try {
      return { workspaceRoot, job: matchJobReference(activeJobs, reference) };
    } catch (error) {
      throw new Error(`No active job found for "${reference}". It may have already finished.`);
    }
  }

  if (activeJobs.length === 1) {
    return { workspaceRoot, job: activeJobs[0] };
  }
  if (activeJobs.length > 1) {
    throw new Error("Multiple DSH jobs are active. Pass a job id to cancel.");
  }

  throw new Error("No active DSH jobs to cancel.");
}

function isLegacyStopReviewJob(job) {
  const preservedPrompt = String(job.summary ?? "").startsWith(LEGACY_STOP_REVIEW_PREFIX);
  // Old terminal writes replaced the prompt summary with the required verdict.
  // They also predate persisted runtime identity, which keeps this migration
  // heuristic from excluding a current task that legitimately returns ALLOW/BLOCK.
  const overwrittenSummary = job.title === "DSH Task" &&
    job.write === false &&
    !job.dshHome &&
    !job.dshProfile &&
    STOP_REVIEW_VERDICT.test(String(job.summary ?? "").trim());
  return preservedPrompt || overwrittenSummary;
}

/** The newest finished task job that recorded a resumable DSH session. */
export function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.kind === "task" &&
        job.status === "completed" &&
        job.resumable !== false &&
        !isLegacyStopReviewJob(job) &&
        typeof job.sessionId === "string" &&
        job.sessionId.length > 0
    ) ?? null
  );
}
