/** Human-readable renderers for the DSH companion. JSON output never passes through here. */

import { isActiveJobStatus } from "./job-control.mjs";

export function shorten(text, limit = 96) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

export function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ?? fallback;
}

/**
 * The delegated task's stdout body: the DSH final response byte-for-byte, so a
 * caller can consume it without stripping decoration. A failed turn produces no
 * body here; its diagnostic goes to stderr instead.
 */
export function renderTaskResult({ rawOutput }) {
  return typeof rawOutput === "string" ? rawOutput : "";
}

/** The review body: DSH's Markdown review, verbatim. Failures are reported on stderr. */
export function renderReviewResult({ text }) {
  return typeof text === "string" ? text : "";
}

export function renderSetupReport(report) {
  const lines = ["DSH companion setup", ""];
  lines.push(`dsh: ${report.dsh.available ? `available (${report.dsh.detail})` : `NOT available (${report.dsh.detail})`}`);
  lines.push(`profile: ${report.profile}`);
  lines.push(`preferred provider: ${report.preferredProvider} (a tie-breaker; the real catalog is read per session)`);
  lines.push(`default model: ${report.model}   default effort: ${report.effort}`);
  lines.push(
    report.credentials.found
      ? `credentials: DEEPSEEK_API_KEY found via ${report.credentials.source}`
      : `credentials: DEEPSEEK_API_KEY not found (checked ${report.credentials.checked.join(", ")})`
  );
  lines.push(`state root: ${report.stateRoot}`);
  lines.push(`stop review gate: ${report.stopReviewGate ? "enabled" : "disabled"}`);

  if (!report.dsh.available || !report.credentials.found) {
    lines.push("", "Fix:");
    if (!report.dsh.available) {
      lines.push("- Install DeepSeek Harness so \`dsh\` is on PATH, then re-run setup.");
    }
    if (!report.credentials.found) {
      lines.push(
        "- Set DEEPSEEK_API_KEY in the environment, in $DSH_HOME/.credentials.yaml (refs: section), in <workspace>/.env, or in $DSH_HOME/.env."
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The advertised model catalog, with the throwaway session it cost spelled out. */
export function renderRouteCatalog(payload) {
  const lines = ["DSH model catalog for this profile", ""];
  lines.push(
    payload.current
      ? `current: ${payload.current.provider} / ${payload.current.model}`
      : "current: (the profile advertises no model option)"
  );

  const byProvider = new Map();
  for (const route of payload.routes) {
    if (!byProvider.has(route.provider)) {
      byProvider.set(route.provider, []);
    }
    byProvider.get(route.provider).push(route.model);
  }
  for (const [provider, models] of byProvider) {
    lines.push("", provider + (provider === payload.preferredProvider ? "  (preferred on ambiguity)" : ""));
    for (const model of models) {
      lines.push("  " + model);
    }
  }

  if (payload.efforts.length > 0) {
    lines.push("", `reasoning effort: ${payload.efforts.join(", ")}   (current: ${payload.currentEffort})`);
  }
  lines.push("", "Select with: task --model <model> [--provider <provider>] [--effort <effort>]");
  lines.push(
    "",
    `Note: the catalog is only readable through a session and ACP has no session delete, so this created ` +
    `empty session ${payload.discoverySessionId} that stays in your DSH session store.`
  );
  return `${lines.join("\n")}\n`;
}

export function renderStatusReport(report) {
  const lines = [`DSH jobs for ${report.workspaceRoot}`];

  if (report.running.length === 0 && !report.latestFinished && report.recent.length === 0) {
    lines.push("", "No jobs recorded for this workspace yet.");
    return `${lines.join("\n")}\n`;
  }

  if (report.running.length > 0) {
    lines.push("", "Running:");
    for (const job of report.running) {
      lines.push(`  ${job.id}  ${job.kind}  ${job.phase}  ${job.elapsed ?? ""}`.trimEnd());
      lines.push(`    ${shorten(job.summary ?? job.title ?? "", 120)}`);
      for (const line of job.progressPreview ?? []) {
        lines.push(`    · ${shorten(line, 120)}`);
      }
    }
  }

  if (report.latestFinished) {
    lines.push("", "Latest finished:", ...statusLines(report.latestFinished));
  }

  if (report.recent.length > 0) {
    lines.push("", "Earlier:");
    for (const job of report.recent) {
      lines.push(`  ${job.id}  ${job.status}  ${job.kind}  ${shorten(job.summary ?? "", 80)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function statusLines(job) {
  const lines = [`  ${job.id}  ${job.status}  ${job.kind}`];
  if (job.sessionId) {
    lines.push(`    DSH session: ${job.sessionId}`);
  }
  if (job.stopReason) {
    lines.push(`    stop reason: ${job.stopReason}`);
  }
  if (job.errorMessage) {
    lines.push(`    error: ${shorten(job.errorMessage, 200)}`);
  }
  if (job.logFile) {
    lines.push(`    log: ${job.logFile}`);
  }
  return lines;
}

export function renderJobStatusReport(job) {
  const lines = [`${job.id}  ${job.status}  ${job.kind}`, `  summary: ${job.summary ?? job.title ?? ""}`, ...statusLines(job).slice(1)];
  if (isActiveJobStatus(job.status)) {
    lines.push(`  elapsed: ${job.elapsed ?? "unknown"}`);
    for (const line of job.progressPreview ?? []) {
      lines.push(`  · ${shorten(line, 120)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const lines = [`${job.id}  ${job.status}  ${job.kind}`];
  if (storedJob?.sessionId ?? job.sessionId) {
    lines.push(`DSH session: ${storedJob?.sessionId ?? job.sessionId}`);
  }
  if (storedJob?.result?.analysisSessionId) {
    lines.push("analysis session: " + storedJob.result.analysisSessionId);
  }
  if (storedJob?.stopReason ?? job.stopReason) {
    lines.push(`stop reason: ${storedJob?.stopReason ?? job.stopReason}`);
  }
  if (storedJob?.errorMessage ?? job.errorMessage) {
    lines.push(`error: ${storedJob?.errorMessage ?? job.errorMessage}`);
  }
  if (storedJob?.logFile ?? job.logFile) {
    lines.push(`log: ${storedJob?.logFile ?? job.logFile}`);
  }

  const body = typeof storedJob?.result?.rendered === "string" ? storedJob.result.rendered : "";
  lines.push("", body.trim() ? body.trimEnd() : "(no stored output)");
  return `${lines.join("\n")}\n`;
}

export function renderCancelReport(job) {
  const lines = [`Cancelled ${job.id} (${job.kind}).`];
  if (job.termination) {
    lines.push(`Termination: ${job.termination}`);
  }
  lines.push(
    "The runtime process tree was terminated; the DSH session log may be incomplete, so this session is not offered for resume."
  );
  return `${lines.join("\n")}\n`;
}

export function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Ask the dsh-jobs skill for progress.`;
}

export function renderResumeCandidate(payload) {
  if (!payload.available) {
    return `No resumable DSH session for this workspace${payload.reason ? `: ${payload.reason}` : "."}\n`;
  }
  return `Resumable DSH session from job ${payload.candidate.id} (${payload.candidate.sessionId}).\n`;
}

export function renderTransferResult(payload) {
  const lines = [
    "Transferred the Codex conversation into a new DSH session.",
    `DSH session: ${payload.sessionId}`,
    `Source: ${payload.sourcePath}`
  ];
  if (payload.truncated) {
    lines.push(`Note: the transcript was truncated to the ${payload.maxBytes}-byte prompt limit.`);
  }
  return `${lines.join("\n")}\n`;
}
