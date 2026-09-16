#!/usr/bin/env node
/**
 * dsh-companion: the Codex-side execution body for the dsh plugin.
 *
 * Every subcommand is a thin, scriptable wrapper around one of two things:
 * the DSH ACP runtime (lib/dsh.mjs) or the workspace-scoped job store
 * (lib/state.mjs). Human-readable text goes to stdout unless --json is given.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  findLatestResumableTaskJob,
  isActiveJobStatus,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { isProcessAlive, terminateProcessTree } from "./lib/process.mjs";
import {
  firstMeaningfulLine,
  renderCancelReport,
  renderJobStatusReport,
  renderQueuedTaskLaunch,
  renderResumeCandidate,
  renderRouteCatalog,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  renderTransferResult,
  shorten
} from "./lib/render.mjs";
import {
  MODEL_ALIASES,
  PREFERRED_PROVIDER,
  VALID_EFFORTS,
  discoverRoutes,
  getDshAvailability,
  getDshCredentialStatus,
  isResumableSession,
  normalizeModel,
  normalizeProvider,
  normalizeReasoningEffort,
  resolveDshHome,
  resolveProfile,
  runDshTurn
} from "./lib/dsh.mjs";
import {
  resolveStateDir,
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  withStateLock,
  writeJobFile
} from "./lib/state.mjs";
import {
  applyTerminalState,
  createJobLogFile,
  createJobProgressUpdater,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  appendLogLine,
  TERMINAL_STATUSES
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const DEFAULT_CONTINUE_PROMPT = "Continue the previous task.";
const MAX_TRANSFER_PROMPT_BYTES = 200 * 1024;
const ORPHANED_QUEUED_GRACE_MS = 30000;

function printUsage() {
  process.stdout.write(
    [
      "dsh-companion <command> [options]",
      "",
      "  setup [--json]",
      "  task [--background|--wait] [--resume|--resume-last|--fresh] [--write]",
      "       [--model <id|flash|pro>] [--provider <id>] [--effort <" + VALID_EFFORTS.join("|") + ">]",
      "       [--analyze] [--analyze-model <id|flash|pro>] [--analyze-provider <id>]",
      "       [--analyze-effort <" + VALID_EFFORTS.join("|") + ">]",
      "       [--prompt-file <path>] [--dsh-profile <name>] [--cwd <dir>] [--json] [prompt...]",
      "  review [--adversarial] [--background|--wait] [--base <ref>] [--scope auto|working-tree|branch]",
      "         [--model <id>] [--provider <id>] [--effort <" + VALID_EFFORTS.join("|") + ">] [--cwd <dir>] [--json] [focus...]",
      "  status [job-id] [--all] [--wait] [--timeout-ms N] [--poll-interval-ms N] [--cwd <dir>] [--json]",
      "  result [job-id] [--cwd <dir>] [--json]",
      "  cancel [job-id] [--cwd <dir>] [--json]",
      "  models [--cwd <dir>] [--dsh-profile <name>] [--json]",
      "  task-resume-candidate [--cwd <dir>] [--json]",
      "  transfer --source <codex-rollout.jsonl> [--cwd <dir>] [--json]",
      "  task-worker --cwd <dir> --job-id <id>",
      ""
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    const payload = value && typeof value === "object" && !Array.isArray(value) ? value : { value: value ?? null };
    const job = payload.job || payload.storedJob || null;
    const storedResult = payload.storedJob?.result || null;
    process.stdout.write(JSON.stringify({
      ...payload,
      jobId: payload.jobId ?? job?.id ?? null,
      status: payload.status ?? job?.status ?? null,
      sessionId: payload.sessionId ?? job?.sessionId ?? null,
      stopReason: payload.stopReason ?? job?.stopReason ?? null,
      finalResponse: payload.finalResponse ?? storedResult?.finalResponse ?? null,
      exitStatus: payload.exitStatus ?? job?.exitStatus ?? null
    }, null, 2) + "\n");
    return;
  }
  process.stdout.write(String(value === undefined || value === null ? "" : value));
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(argv, config);
}

function resolveCommandCwd(options) {
  if (options.cwd) {
    return path.resolve(String(options.cwd));
  }
  return process.cwd();
}

function resolveCommandWorkspace(options) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

function buildSetupReport(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const env = process.env;
  const dshHome = resolveDshHome(env);
  const profile = resolveProfile(env);
  return {
    dsh: getDshAvailability({ env: env, cwd: cwd }),
    credentials: getDshCredentialStatus({ env: env, dshHome: dshHome, cwd: workspaceRoot }),
    dshHome: dshHome,
    profile: profile,
    preferredProvider: PREFERRED_PROVIDER,
    model: normalizeModel(undefined, env) || "runtime default",
    effort: normalizeReasoningEffort(undefined, env) || "runtime default",
    stateRoot: resolveStateDir(workspaceRoot),
    stopReviewGate: Boolean(getConfig(workspaceRoot).stopReviewGate)
  };
}

function handleSetup(argv) {
  const { options } = parseCommandInput(argv, { booleanOptions: ["json", "enable-review-gate", "disable-review-gate"] });
  const cwd = process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const actions = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actions.push("Enabled the stop review gate for this workspace.");
  }
  if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actions.push("Disabled the stop review gate for this workspace.");
  }

  const report = { ...buildSetupReport(cwd), actionsTaken: actions };
  if (options.json) {
    outputResult(report, true);
    return;
  }
  process.stdout.write(renderSetupReport(report));
  for (const action of actions) {
    process.stdout.write(action + "\n");
  }
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

function loadTemplate(name) {
  return loadPromptTemplate(ROOT_DIR, name);
}

/**
 * The delegated-task preamble plus the caller's own prompt. The preamble is the
 * only place the write contract is expressed; DSH is not sandboxed by this
 * plugin (see README, "Read-only is a prompt contract").
 */
function buildDelegatedTaskPrompt({ workspaceRoot, userPrompt, write }) {
  const preamble = interpolateTemplate(loadTemplate("delegated-task"), {
    WORKSPACE_ROOT: workspaceRoot,
    WRITE_MODE: write
      ? "You may modify files in the workspace when the task requires it."
      : "Do NOT create, modify, delete, or rename any file. This is a read-only delegation: investigate and report."
  });
  return userPrompt ? preamble.trimEnd() + "\n\n---\n\n" + userPrompt.trim() + "\n" : preamble;
}

/**
 * The research-layer prompt: the analysis model investigates and answers with a
 * fixed-section brief, and the brief is then handed to the executor. The
 * research pass is read-only regardless of --write, so the write contract is
 * not interpolated here.
 */
function buildAnalysisPrompt({ workspaceRoot, userPrompt }) {
  const preamble = interpolateTemplate(loadTemplate("analyze"), {
    WORKSPACE_ROOT: workspaceRoot
  });
  return preamble.trimEnd() + "\n\n---\n\n" + String(userPrompt || "").trim() + "\n";
}

/**
 * Resolve the analysis pass route. It is independent of the execution route:
 * flag first, then the ANALYZE-specific env var, then the layer default. An
 * empty value everywhere means "leave what the runtime selected alone" for
 * provider/effort, but the model defaults to "pro" because a stronger research
 * model is the point of the layer.
 */
function resolveAnalyzeRoute(options) {
  const modelRequested = String(options["analyze-model"] || process.env.DSH_CODEX_ANALYZE_MODEL || "").trim();
  const providerRequested = String(options["analyze-provider"] || process.env.DSH_CODEX_ANALYZE_PROVIDER || "").trim();
  const effortRequested = String(options["analyze-effort"] || process.env.DSH_CODEX_ANALYZE_EFFORT || "").trim();

  return {
    enabled: true,
    model: normalizeModel(modelRequested || MODEL_ALIASES.get("pro")),
    provider: providerRequested || null,
    // normalizeReasoningEffort/normalizeModel fall back to DSH_CODEX_* env vars
    // when given an empty string, so only call them with a real request here.
    effort: effortRequested ? normalizeReasoningEffort(effortRequested) : null
  };
}

function buildReviewPrompt({ adversarial, context, focusText }) {
  const template = loadTemplate(adversarial ? "adversarial-review" : "review");
  return interpolateTemplate(template, {
    REPO_ROOT: context.repoRoot,
    BRANCH: context.branch,
    TARGET_LABEL: context.target.label,
    REVIEW_TARGET: context.target.label,
    CHANGED_FILES: context.changedFiles.join("\n") || "(none)",
    REVIEW_CONTEXT: context.content,
    COLLECTION_GUIDANCE: context.collectionGuidance,
    FOCUS: focusText || "(none given)"
  });
}

// ---------------------------------------------------------------------------
// job plumbing
// ---------------------------------------------------------------------------

function createJob({ prefix, kind, title, workspaceRoot, summary, dshHome, dshProfile }) {
  return {
    id: generateJobId(prefix),
    kind: kind,
    title: title,
    workspaceRoot: workspaceRoot,
    summary: summary,
    dshHome: dshHome || resolveDshHome(),
    dshProfile: dshProfile || resolveProfile(),
    createdAt: nowIso()
  };
}

function jobProgress(job, options = {}) {
  const logFile = options.logFile || createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile: logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile: logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

/** Persist the runtime identity as soon as it exists so cancel can find the tree. */
function makeRuntimeRecorder(workspaceRoot, jobId, logFile) {
  return (identity) => {
    withStateLock(workspaceRoot, () => {
      const stored = readStoredJob(workspaceRoot, jobId);
      if (!stored || TERMINAL_STATUSES.has(stored.status)) {
        return;
      }
      const patch = { runtimePid: identity.pid, runtimePgid: identity.pgid };
      writeJobFile(workspaceRoot, jobId, { ...stored, ...patch, updatedAt: nowIso() });
      upsertJob(workspaceRoot, { id: jobId, ...patch });
    });
    if (identity.pid) {
      appendLogLine(logFile, "DSH runtime started as pid " + identity.pid + ".");
    }
  };
}

function recordSession(workspaceRoot, jobId, sessionId) {
  withStateLock(workspaceRoot, () => {
    const stored = readStoredJob(workspaceRoot, jobId);
    if (!stored || TERMINAL_STATUSES.has(stored.status)) {
      return;
    }
    writeJobFile(workspaceRoot, jobId, { ...stored, sessionId: sessionId, updatedAt: nowIso() });
    upsertJob(workspaceRoot, { id: jobId, sessionId: sessionId });
  });
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

async function executeTaskRun(request, context) {
  const workspaceRoot = request.workspaceRoot;
  const result = await runDshTurn({
    cwd: request.cwd,
    prompt: buildDelegatedTaskPrompt({
      workspaceRoot: workspaceRoot,
      userPrompt: request.prompt,
      write: request.write
    }),
    sessionId: request.resumeSessionId || null,
    model: request.model,
    provider: request.provider,
    reasoningEffort: request.effort,
    dshProfile: request.dshProfile,
    onProgress: context.progress,
    onRuntime: context.onRuntime,
    onSession: context.onSession
  });

  const rendered = renderTaskResult(
    { rawOutput: result.finalResponse, failureMessage: result.errorMessage },
    { title: request.title, jobId: request.jobId }
  );

  return {
    exitStatus: result.exitStatus,
    sessionId: result.sessionId,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    rendered: rendered,
    summary: firstMeaningfulLine(result.finalResponse, result.errorMessage || "DSH task finished."),
    payload: {
      jobId: request.jobId,
      status: result.exitStatus === 0 ? "completed" : "failed",
      sessionId: result.sessionId,
      stopReason: result.stopReason,
      exitStatus: result.exitStatus,
      errorMessage: result.errorMessage,
      finalResponse: result.finalResponse,
      title: request.title
    }
  };
}

/**
 * The analysis layer: a read-only research pass answers with a task brief, then
 * a fresh execution session carries the brief out.
 *
 * Both turns are independent runDshTurn calls, so the route (model/effort) can
 * differ between them. The analysis session is recorded on the job only as
 * analysisSessionId; the job's sessionId is the execution session, which is the
 * only one a later --resume may continue.
 */
async function executeAnalyzedTaskRun(request, context) {
  const workspaceRoot = request.workspaceRoot;
  const progress = context.progress || (() => {});

  progress({ message: "Analysis pass: researching the task read-only before execution.", phase: "analyzing" });
  const analysis = await runDshTurn({
    cwd: request.cwd,
    prompt: buildAnalysisPrompt({ workspaceRoot: workspaceRoot, userPrompt: request.prompt }),
    sessionId: null,
    model: request.analyze.model,
    provider: request.analyze.provider,
    reasoningEffort: request.analyze.effort,
    dshProfile: request.dshProfile,
    onProgress: progress,
    onRuntime: context.onRuntime,
    onSession: context.onSession
  });

  const brief = analysis.finalResponse;
  const failureShape = {
    exitStatus: analysis.exitStatus,
    sessionId: null,
    analysisSessionId: analysis.sessionId,
    stopReason: analysis.stopReason,
    errorMessage: analysis.errorMessage,
    rendered: renderTaskResult({ rawOutput: "", failureMessage: analysis.errorMessage }),
    summary: "Analysis pass failed.",
    payload: {
      jobId: request.jobId,
      status: "failed",
      sessionId: null,
      analysisSessionId: analysis.sessionId,
      analysisBrief: brief,
      finalResponse: "",
      stopReason: analysis.stopReason,
      exitStatus: analysis.exitStatus,
      errorMessage: analysis.errorMessage,
      title: request.title
    }
  };

  if (analysis.exitStatus !== 0) {
    return failureShape;
  }
  if (!brief || !brief.trim()) {
    // The research turn ended cleanly but produced nothing executable, so the
    // job is a failure: runTrackedJob derives its terminal status from this
    // exit status, and the contract is that an empty brief fails the job.
    // stopReason is nulled because it describes only the research turn and
    // "end_turn" would imply exit 0 through exitStatusForStopReason, while no
    // execution turn ever ran to justify a stop reason of its own.
    const emptyBriefMessage =
      "The analysis pass produced an empty brief; refusing to execute an empty task specification.";
    return {
      ...failureShape,
      exitStatus: 1,
      stopReason: null,
      errorMessage: emptyBriefMessage,
      payload: {
        ...failureShape.payload,
        exitStatus: 1,
        stopReason: null,
        errorMessage: emptyBriefMessage
      }
    };
  }

  progress({
    message: "Analysis brief ready (" + String(brief).split(/\r?\n/).length + " lines). Executing on a fresh session.",
    phase: "running"
  });

  const execution = await runDshTurn({
    cwd: request.cwd,
    prompt: buildDelegatedTaskPrompt({ workspaceRoot: workspaceRoot, userPrompt: brief, write: request.write }),
    sessionId: null,
    model: request.model,
    provider: request.provider,
    reasoningEffort: request.effort,
    dshProfile: request.dshProfile,
    onProgress: progress,
    onRuntime: context.onRuntime,
    onSession: context.onSession
  });

  return {
    exitStatus: execution.exitStatus,
    sessionId: execution.sessionId,
    analysisSessionId: analysis.sessionId,
    stopReason: execution.stopReason,
    errorMessage: execution.errorMessage,
    rendered: renderTaskResult(
      { rawOutput: execution.finalResponse, failureMessage: execution.errorMessage },
      { title: request.title, jobId: request.jobId }
    ),
    summary: firstMeaningfulLine(execution.finalResponse, execution.errorMessage || "DSH analyzed task finished."),
    payload: {
      jobId: request.jobId,
      status: execution.exitStatus === 0 ? "completed" : "failed",
      sessionId: execution.sessionId,
      analysisSessionId: analysis.sessionId,
      analysisBrief: brief,
      finalResponse: execution.finalResponse,
      stopReason: execution.stopReason,
      exitStatus: execution.exitStatus,
      errorMessage: execution.errorMessage,
      title: request.title
    }
  };
}

async function executeReviewRun(request, context) {
  ensureGitRepository(request.cwd);
  const target = resolveReviewTarget(request.cwd, { base: request.base, scope: request.scope });
  context.progress({ message: "Collecting review context for " + target.label + ".", phase: "reviewing" });
  const reviewContext = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt({
    adversarial: request.kind === "adversarial-review",
    context: reviewContext,
    focusText: request.focusText
  });

  const result = await runDshTurn({
    cwd: reviewContext.repoRoot,
    prompt: prompt,
    sessionId: request.resumeSessionId || null,
    model: request.model,
    provider: request.provider,
    reasoningEffort: request.effort,
    dshProfile: request.dshProfile,
    onProgress: context.progress,
    onRuntime: context.onRuntime,
    onSession: context.onSession
  });

  const rendered = renderReviewResult({ text: result.finalResponse, failureMessage: result.errorMessage });
  return {
    exitStatus: result.exitStatus,
    sessionId: result.sessionId,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    rendered: rendered,
    summary: firstMeaningfulLine(result.finalResponse, result.errorMessage || request.title + " finished."),
    payload: {
      jobId: request.jobId,
      status: result.exitStatus === 0 ? "completed" : "failed",
      sessionId: result.sessionId,
      stopReason: result.stopReason,
      exitStatus: result.exitStatus,
      errorMessage: result.errorMessage,
      target: target,
      review: request.kind,
      finalResponse: result.finalResponse,
      title: request.title
    }
  };
}

async function executeRequest(request, context) {
  if (request.kind === "task" && request.analyze && request.analyze.enabled) {
    return executeAnalyzedTaskRun(request, context);
  }
  return request.kind === "task" || request.kind === "transfer"
    ? executeTaskRun(request, context)
    : executeReviewRun(request, context);
}

async function runForegroundJob(job, request, options = {}) {
  const { logFile, progress } = jobProgress(job, { stderr: Boolean(options.stderr) });
  const execution = await runTrackedJob(
    { ...job, logFile: logFile },
    () =>
      executeRequest(request, {
        progress: progress,
        onRuntime: makeRuntimeRecorder(job.workspaceRoot, job.id, logFile),
        onSession: (info) => recordSession(job.workspaceRoot, job.id, info.sessionId)
      }),
    { logFile: logFile }
  );

  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    // stdout carries only DSH's own output; the diagnostic belongs on stderr so
    // a caller piping stdout never has to strip an error out of the answer.
    process.stderr.write((execution.errorMessage || "DSH did not complete the turn.") + "\n");
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

async function runUntrackedTask(request, options = {}) {
  const execution = await executeTaskRun(request, {
    progress: createProgressReporter({ stderr: Boolean(options.stderr) }),
    onRuntime: null,
    onSession: null
  });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.stderr.write((execution.errorMessage || "DSH did not complete the turn.") + "\n");
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "dsh-companion.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
      cwd: cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child);
    });
  });
}

/**
 * Queue one background job: the record (including its replayable request) is
 * written before the worker starts, so the worker can never read a missing job.
 */
async function enqueueBackgroundJob(cwd, job, request) {
  const logFile = createJobLogFile(job.workspaceRoot, job.id, job.title);
  appendLogLine(logFile, "Queued for background execution.");

  const queuedRecord = { ...job, status: "queued", phase: "queued", pid: null, logFile: logFile, request: request };
  withStateLock(job.workspaceRoot, () => {
    writeJobFile(job.workspaceRoot, job.id, queuedRecord);
    upsertJob(job.workspaceRoot, queuedRecord);
  });

  let child;
  try {
    child = await spawnDetachedWorker(cwd, job.id);
  } catch (error) {
    const errorMessage = "Failed to start the background worker: " + error.message;
    applyTerminalState(job.workspaceRoot, job.id, {
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      logFile,
      completedAt: nowIso()
    });
    appendLogLine(logFile, errorMessage);
    throw error;
  }

  const pid = child.pid === undefined ? null : child.pid;
  withStateLock(job.workspaceRoot, () => {
    const stored = readStoredJob(job.workspaceRoot, job.id);
    if (!stored || TERMINAL_STATUSES.has(stored.status)) {
      return;
    }
    writeJobFile(job.workspaceRoot, job.id, { ...stored, pid: pid, updatedAt: nowIso() });
    upsertJob(job.workspaceRoot, { id: job.id, pid: pid });
  });

  return { logFile: logFile, payload: { jobId: job.id, status: "queued", title: job.title, summary: job.summary, logFile: logFile } };
}

// ---------------------------------------------------------------------------
// command request builders
// ---------------------------------------------------------------------------

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    const promptPath = path.resolve(cwd, String(options["prompt-file"]));
    try {
      return fs.readFileSync(promptPath, "utf8");
    } catch (error) {
      throw new Error("Cannot read the prompt file " + promptPath + ": " + error.message);
    }
  }
  const positional = positionals.join(" ").trim();
  return positional || readStdinIfPiped().trim();
}

function buildTaskRequest({ cwd, workspaceRoot, jobId, options, prompt }) {
  return {
    kind: "task",
    jobId: jobId,
    cwd: cwd,
    workspaceRoot: workspaceRoot,
    prompt: prompt,
    title: "DSH Task",
    model: normalizeModel(options.model),
    provider: normalizeProvider(options.provider),
    effort: normalizeReasoningEffort(options.effort),
    dshProfile: String(options["dsh-profile"] || "").trim() || resolveProfile(),
    write: Boolean(options.write),
    analyze: options.analyze
      ? resolveAnalyzeRoute(options)
      : { enabled: false, model: null, provider: null, effort: null },
    resumeSessionId: null
  };
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "model", "provider", "effort", "cwd", "prompt-file", "dsh-profile",
      "analyze-model", "analyze-provider", "analyze-effort"
    ],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "wait", "analyze"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const resumeRequested = Boolean(options["resume-last"] || options.resume);
  // --resume-last continues the previous session even with no follow-up, so the
  // default continuation prompt is sent rather than an empty user message.
  const effectivePrompt = resumeRequested && !prompt ? DEFAULT_CONTINUE_PROMPT : prompt;

  if (resumeRequested && options.fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  if (options.background && options.wait) {
    throw new Error("Choose either --background or --wait.");
  }
  if (options.analyze && resumeRequested) {
    // The analysis layer runs its own fresh pipeline (research session + new
    // execution session), so there is nothing previous to continue.
    throw new Error("The analysis layer runs a fresh pipeline; do not combine --analyze with --resume/--resume-last.");
  }
  if (!prompt && !resumeRequested) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
  ensureDshReady(cwd);

  const dshProfile = String(options["dsh-profile"] || "").trim() || resolveProfile();

  let resumeSessionId = null;
  if (resumeRequested) {
    const candidate = await resolveResumeCandidate(workspaceRoot);
    resumeSessionId = candidate.sessionId;
  }

  const job = createJob({
    prefix: "task",
    kind: "task",
    title: options.analyze ? "DSH Analyzed Task" : resumeRequested ? "DSH Resume" : "DSH Task",
    workspaceRoot: workspaceRoot,
    summary: shorten(effectivePrompt),
    dshHome: resolveDshHome(),
    dshProfile: dshProfile
  });
  const request = buildTaskRequest({ cwd: cwd, workspaceRoot: workspaceRoot, jobId: job.id, options: options, prompt: effectivePrompt });
  request.resumeSessionId = resumeSessionId;
  request.title = job.title;
  request.summary = job.summary;

  if (options.background) {
    const { payload } = await enqueueBackgroundJob(cwd, job, request);
    outputResult(options.json ? payload : renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundJob(job, request, { json: options.json, stderr: !options.json });
}

async function handleStopReviewGate(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "provider", "effort", "cwd", "prompt-file", "dsh-profile"],
    booleanOptions: ["json"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const prompt = readTaskPrompt(cwd, options, positionals);
  if (!prompt) {
    throw new Error("The internal stop-review gate requires a prompt.");
  }
  ensureDshReady(cwd);

  const request = buildTaskRequest({ cwd: cwd, workspaceRoot: workspaceRoot, jobId: null, options: options, prompt: prompt });
  request.title = "DSH Stop Review";
  await runUntrackedTask(request, { json: options.json, stderr: !options.json });
}

async function handleReview(argv, adversarial) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "provider", "effort", "cwd", "dsh-profile"],
    booleanOptions: ["json", "background", "wait", "adversarial"],
    aliasMap: { m: "model" }
  });

  const isAdversarial = adversarial || Boolean(options.adversarial);
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  ensureDshReady(cwd);

  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const reviewName = isAdversarial ? "Adversarial Review" : "Review";
  const dshProfile = String(options["dsh-profile"] || "").trim() || resolveProfile();
  const job = createJob({
    prefix: "review",
    kind: isAdversarial ? "adversarial-review" : "review",
    title: "DSH " + reviewName,
    workspaceRoot: workspaceRoot,
    summary: reviewName + " of " + target.label,
    dshHome: resolveDshHome(),
    dshProfile: dshProfile
  });
  const request = {
    kind: isAdversarial ? "adversarial-review" : "review",
    jobId: job.id,
    cwd: cwd,
    workspaceRoot: workspaceRoot,
    title: job.title,
    summary: job.summary,
    focusText: focusText,
    base: options.base === undefined ? null : options.base,
    scope: options.scope === undefined ? "auto" : options.scope,
    model: normalizeModel(options.model),
    provider: normalizeProvider(options.provider),
    effort: normalizeReasoningEffort(options.effort),
    dshProfile: dshProfile,
    write: false,
    resumeSessionId: null
  };

  if (options.background) {
    const { payload } = await enqueueBackgroundJob(cwd, job, request);
    outputResult(options.json ? payload : renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundJob(job, request, { json: options.json, stderr: !options.json });
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

/**
 * Print the model catalog this DSH_HOME and profile actually advertise.
 *
 * The catalog is a property of the environment, not of the plugin: the same
 * install can offer different providers under a different DSH_HOME.
 */
async function handleModels(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "dsh-profile"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  ensureDshReady(cwd);

  const discovered = await discoverRoutes({
    cwd: cwd,
    dshProfile: String(options["dsh-profile"] || "").trim() || resolveProfile()
  });
  const payload = {
    preferredProvider: discovered.preferredProvider,
    current: discovered.current,
    routes: discovered.routes.map((route) => ({
      provider: route.provider,
      model: route.model,
      name: route.name,
      value: route.value,
      description: route.description
    })),
    efforts: discovered.efforts,
    currentEffort: discovered.currentEffort,
    discoverySessionId: discovered.sessionId
  };
  outputResult(options.json ? payload : renderRouteCatalog(payload), options.json);
}

// ---------------------------------------------------------------------------
// resume candidate
// ---------------------------------------------------------------------------

function findActiveTaskJob(jobs) {
  return jobs.find((job) => job.kind === "task" && isActiveJobStatus(job.status)) || null;
}

async function resolveResumeCandidate(workspaceRoot) {
  await reconcileStaleJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const active = findActiveTaskJob(jobs);
  if (active) {
    throw new Error("Cannot resume while a task job is still " + active.status + " (" + active.id + ").");
  }
  const candidate = findLatestResumableTaskJob(jobs);
  if (!candidate) {
    throw new Error("No previous DSH session was found for this workspace. Start a new one.");
  }
  const resumable = isResumableSession(candidate, { dshHome: resolveDshHome(), profile: resolveProfile() });
  if (!resumable.available) {
    throw new Error("The latest DSH session cannot be resumed: " + resumable.reason + ".");
  }
  return candidate;
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  await reconcileStaleJobs(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const active = findActiveTaskJob(jobs);
  const candidate = findLatestResumableTaskJob(jobs);
  const resumable = active
    ? { available: false, reason: "a task job is still " + active.status + " (" + active.id + ")" }
    : candidate
    ? isResumableSession(candidate, { dshHome: resolveDshHome(), profile: resolveProfile() })
    : { available: false, reason: "no finished DSH task job in this workspace" };

  const payload = {
    available: resumable.available,
    reason: resumable.reason,
    candidate: candidate && resumable.available
      ? {
          id: candidate.id,
          status: candidate.status,
          title: candidate.title || null,
          summary: candidate.summary || null,
          sessionId: candidate.sessionId,
          completedAt: candidate.completedAt || null
        }
      : null
  };
  outputResult(options.json ? payload : renderResumeCandidate(payload), options.json);
}

// ---------------------------------------------------------------------------
// status / result / cancel
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Detect background workers that died without recording a terminal state, clean
 * up the runtime they left behind, and mark the job failed. A job whose worker
 * is gone must never be reported as still running.
 *
 * @returns the ids that were reconciled.
 */
async function reconcileStaleJobs(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const reconciled = [];

  for (const job of sortJobsNewestFirst(listJobs(workspaceRoot)).filter((entry) => isActiveJobStatus(entry.status))) {
    const stored = readStoredJob(workspaceRoot, job.id) || job;
    if (TERMINAL_STATUSES.has(stored.status)) {
      upsertJob(workspaceRoot, {
        id: job.id,
        status: stored.status,
        phase: stored.phase,
        pid: null,
        sessionId: stored.sessionId ?? null,
        summary: stored.summary ?? null,
        stopReason: stored.stopReason ?? null,
        exitStatus: stored.exitStatus ?? null,
        result: stored.result ?? null,
        errorMessage: stored.errorMessage ?? null,
        completedAt: stored.completedAt ?? null
      });
      reconciled.push(job.id);
      continue;
    }

    const timestamp = Date.parse(stored.updatedAt || stored.createdAt || "");
    const missingQueuedWorker = stored.status === "queued" && !Number.isFinite(stored.pid) &&
      (!Number.isFinite(timestamp) || Date.now() - timestamp >= ORPHANED_QUEUED_GRACE_MS);
    const deadWorker = Number.isFinite(stored.pid) && !isProcessAlive(stored.pid);
    if (!missingQueuedWorker && !deadWorker) {
      continue;
    }

    const logFile = stored.logFile || job.logFile || null;
    const runtimePid = stored.runtimePid;
    let cleanupFailure = null;

    if (Number.isFinite(runtimePid) && isProcessAlive(runtimePid)) {
      const killed = await terminateProcessTree(runtimePid, {
        pgid: stored.runtimePgid === null || stored.runtimePgid === undefined ? undefined : stored.runtimePgid,
        cwd: cwd
      });
      if (!killed.exited) {
        cleanupFailure = "dsh runtime pid " + runtimePid + " is still running";
      }
    }

    const errorMessage = cleanupFailure
      ? "The background worker exited without recording a result, and cleanup failed for " + cleanupFailure + "."
      : missingQueuedWorker
        ? "The background worker never started and did not record a pid."
        : "The background worker exited without recording a result.";
    appendLogLine(logFile, errorMessage);
    applyTerminalState(workspaceRoot, job.id, {
      status: "failed",
      phase: "failed",
      errorMessage: errorMessage,
      pid: null,
      logFile: logFile,
      completedAt: nowIso()
    });
    reconciled.push(job.id);
  }
  return reconciled;
}

async function waitForJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Number(options.pollIntervalMs || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await reconcileStaleJobs(cwd);
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    if (!isActiveJobStatus(snapshot.job.status)) {
      return snapshot;
    }
    if (Date.now() >= deadline) {
      return snapshot;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] || "";
  await reconcileStaleJobs(cwd);

  if (reference) {
    const snapshot = options.wait
      ? await waitForJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputResult(options.json ? snapshot : renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("status --wait requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

async function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  await reconcileStaleJobs(cwd);
  const reference = positionals[0] || "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const resumable = isResumableSession(storedJob || job, { dshHome: resolveDshHome(), profile: resolveProfile() });
  const payload = {
    job: job,
    storedJob: storedJob,
    sessionId: storedJob ? storedJob.sessionId || null : null,
    resumable: resumable.available,
    resumeUnavailableReason: resumable.reason,
    resumeCommand: resumable.available
      ? 'node "' + path.join(ROOT_DIR, "scripts", "dsh-companion.mjs") + '" task --resume --wait "<follow-up>"'
      : null
  };
  outputResult(options.json ? payload : renderStoredJobResult(job, storedJob), options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  await reconcileStaleJobs(cwd);
  const reference = positionals[0] || "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);
  const stored = withStateLock(workspaceRoot, () => {
    const current = readStoredJob(workspaceRoot, job.id) || job;
    if (TERMINAL_STATUSES.has(current.status)) {
      throw new Error("Job " + job.id + " already finished as " + current.status + ".");
    }
    const next = { ...current, phase: "cancelling", cancelRequestedAt: nowIso(), updatedAt: nowIso() };
    writeJobFile(workspaceRoot, job.id, next);
    upsertJob(workspaceRoot, { id: job.id, phase: "cancelling" });
    return next;
  });
  const logFile = stored.logFile || job.logFile || null;

  // Publish the cancellation phase before tearing down the process tree.
  appendLogLine(logFile, "Cancellation requested.");

  const cleanup = [];
  const runtimePid = stored.runtimePid;
  if (Number.isFinite(runtimePid)) {
    const killed = await terminateProcessTree(runtimePid, {
      pgid: stored.runtimePgid === null || stored.runtimePgid === undefined ? undefined : stored.runtimePgid,
      cwd: cwd
    });
    cleanup.push({ target: "dsh runtime pid " + runtimePid, ...killed });
    appendLogLine(logFile, killed.exited
      ? "Terminated the DSH runtime process tree (pid " + runtimePid + ")."
      : "Failed to terminate the DSH runtime (pid " + runtimePid + ").");
  }

  const workerPid = stored.pid;
  if (Number.isFinite(workerPid) && workerPid !== process.pid) {
    const killed = await terminateProcessTree(workerPid, { cwd: cwd });
    cleanup.push({ target: "worker pid " + workerPid, ...killed });
  }

  const failures = cleanup.filter((entry) => !entry.exited);
  const pending = [];
  if (Number.isFinite(runtimePid) && isProcessAlive(runtimePid)) {
    pending.push("dsh runtime pid " + runtimePid + (stored.runtimePgid ? " (group " + stored.runtimePgid + ")" : ""));
  }
  if (Number.isFinite(workerPid) && workerPid !== process.pid && isProcessAlive(workerPid)) {
    pending.push("worker pid " + workerPid);
  }

  if (pending.length > 0) {
    const completedAt = nowIso();
    withStateLock(workspaceRoot, () => {
      const current = readStoredJob(workspaceRoot, job.id);
      if (!current || TERMINAL_STATUSES.has(current.status)) {
        return;
      }
      writeJobFile(workspaceRoot, job.id, {
        ...current,
        phase: "cancel-failed",
        cleanupPending: pending,
        cleanupFailures: failures,
        updatedAt: completedAt
      });
      upsertJob(workspaceRoot, { id: job.id, phase: "cancel-failed" });
    });
    appendLogLine(logFile, "Cancellation could not confirm the exit of: " + pending.join(", ") + ".");
    throw new Error(
      "Cancellation did not complete: still running after termination: " + pending.join(", ") +
      ". The job was left as " + stored.status + " so it is not reported as cancelled."
    );
  }

  const completedAt = nowIso();
  const result = applyTerminalState(workspaceRoot, job.id, {
    status: "cancelled",
    phase: "cancelled",
    termination: "forced",
    errorMessage: "Cancelled by user.",
    pid: null,
    logFile: logFile,
    completedAt: completedAt
  });
  appendLogLine(logFile, "Cancelled by user; the process tree has exited.");

  const payload = {
    jobId: job.id,
    status: result.job.status,
    title: job.title,
    termination: result.job.termination || null,
    alreadyTerminal: !result.applied,
    cleanup: cleanup
  };
  outputResult(options.json ? payload : renderCancelReport(result.job), options.json);
}

// ---------------------------------------------------------------------------
// transfer (Phase 2)
// ---------------------------------------------------------------------------

function extractRolloutText(sourcePath) {
  if (sourcePath.endsWith(".zst") || sourcePath.endsWith(".jsonl.zst")) {
    throw new Error("Compressed Codex transcripts are not supported. Decompress the .jsonl.zst file first.");
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error("No such transcript: " + sourcePath);
  }
  const text = fs.readFileSync(sourcePath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    throw new Error("The transcript is empty: " + sourcePath);
  }
  let meta = null;
  const turns = [];
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error("The transcript is not newline-delimited JSON: " + sourcePath);
    }
    if (meta === null) {
      meta = record;
      continue;
    }
    const role = record.role || (record.payload && record.payload.role);
    const content = record.content || (record.payload && record.payload.content);
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const body = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((block) => (typeof block === "string" ? block : block && block.text ? block.text : "")).join("")
        : "";
    if (body.trim()) {
      turns.push(role.toUpperCase() + ": " + body.trim());
    }
  }
  if (meta === null || (meta.type !== "session_meta" && !meta.session_id && !meta.sessionId)) {
    throw new Error("The transcript does not start with Codex session metadata: " + sourcePath);
  }
  return { meta: meta, transcript: turns.join("\n\n") };
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["source", "cwd", "model", "provider", "effort"],
    booleanOptions: ["json"]
  });
  if (!options.source) {
    throw new Error("transfer requires --source <codex-rollout.jsonl>; the plugin never guesses the current conversation.");
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sourcePath = path.resolve(cwd, String(options.source));
  const { meta, transcript } = extractRolloutText(sourcePath);
  ensureDshReady(cwd);

  const budget = MAX_TRANSFER_PROMPT_BYTES;
  const encoded = Buffer.from(transcript, "utf8");
  const truncated = encoded.length > budget;
  let body = transcript;
  if (truncated) {
    const tail = encoded.subarray(encoded.length - budget);
    // A byte budget can split a multi-byte UTF-8 sequence at the leading
    // edge; drop the leading continuation bytes so the body decodes cleanly.
    let start = 0;
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) {
      start += 1;
    }
    body = tail.subarray(start).toString("utf8");
  }
  const sourceCwd = meta.cwd || meta.payload?.cwd || null;
  const prompt = [
    "The following Codex conversation is being handed over to you. Continue the work from here.",
    "",
    "Source transcript: " + sourcePath,
    sourceCwd ? "Codex working directory: " + sourceCwd : null,
    truncated ? "Note: the transcript was truncated to its last " + budget + " bytes." : null,
    "",
    "---",
    "",
    body
  ].filter((line) => line !== null).join("\n");

  const job = createJob({
    prefix: "transfer",
    kind: "task",
    title: "DSH Transfer",
    workspaceRoot: workspaceRoot,
    summary: shorten("Transferred Codex conversation from " + sourcePath)
  });
  const request = {
    kind: "task",
    jobId: job.id,
    cwd: cwd,
    workspaceRoot: workspaceRoot,
    title: job.title,
    summary: job.summary,
    prompt: prompt,
    model: normalizeModel(options.model),
    provider: normalizeProvider(options.provider),
    effort: normalizeReasoningEffort(options.effort),
    dshProfile: resolveProfile(),
    write: true,
    resumeSessionId: null
  };

  const { logFile, progress } = jobProgress(job, { stderr: !options.json });
  const execution = await runTrackedJob(
    { ...job, logFile: logFile },
    () =>
      executeRequest(request, {
        progress: progress,
        onRuntime: makeRuntimeRecorder(workspaceRoot, job.id, logFile),
        onSession: (info) => recordSession(workspaceRoot, job.id, info.sessionId)
      }),
    { logFile: logFile }
  );

  if (options.json) {
    // execution.payload already carries the stable keys (status, stopReason,
    // exitStatus, finalResponse); adding the transfer-specific ones keeps the
    // documented contract that every --json response shares them.
    outputResult(
      { ...execution.payload, jobId: job.id, sourcePath: sourcePath, truncated: truncated },
      true
    );
  } else {
    outputResult(
      renderTransferResult({ sessionId: execution.sessionId, sourcePath: sourcePath, truncated: truncated, maxBytes: budget }),
      false
    );
  }
  if (execution.exitStatus !== 0) {
    process.stderr.write((execution.errorMessage || "DSH did not complete the turn.") + "\n");
    process.exitCode = execution.exitStatus;
  }
}

// ---------------------------------------------------------------------------
// background worker
// ---------------------------------------------------------------------------

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"],
    booleanOptions: []
  });
  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, String(options["job-id"]));
  if (!storedJob) {
    throw new Error("No stored job found for " + options["job-id"] + ".");
  }
  if (!storedJob.request || typeof storedJob.request !== "object") {
    throw new Error("Stored job " + options["job-id"] + " is missing its request payload.");
  }
  if (!isActiveJobStatus(storedJob.status)) {
    return;
  }

  const logFile = storedJob.logFile || createJobLogFile(workspaceRoot, storedJob.id, storedJob.title);
  const progress = createProgressReporter({
    stderr: false,
    logFile: logFile,
    onEvent: createJobProgressUpdater(workspaceRoot, storedJob.id)
  });

  await runTrackedJob(
    { ...storedJob, workspaceRoot: workspaceRoot, logFile: logFile },
    () =>
      executeRequest(storedJob.request, {
        progress: progress,
        onRuntime: makeRuntimeRecorder(workspaceRoot, storedJob.id, logFile),
        onSession: (info) => recordSession(workspaceRoot, storedJob.id, info.sessionId)
      }),
    { logFile: logFile }
  );
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/** Every job-producing command fails before creating a job when dsh is missing. */
function ensureDshReady(cwd) {
  const availability = getDshAvailability({ cwd: cwd });
  if (!availability.available) {
    throw new Error(
      "dsh is not available (" + availability.detail + "). Run the dsh-setup skill first."
    );
  }
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  switch (subcommand) {
    case undefined:
    case "help":
    case "--help":
      printUsage();
      return;
    case "setup":
      handleSetup(argv);
      return;
    case "task":
      await handleTask(argv);
      return;
    case "stop-review-gate":
      await handleStopReviewGate(argv);
      return;
    case "models":
      await handleModels(argv);
      return;
    case "review":
      await handleReview(argv, false);
      return;
    case "adversarial-review":
      await handleReview(argv, true);
      return;
    case "status":
      await handleStatus(argv);
      return;
    case "result":
      await handleResult(argv);
      return;
    case "cancel":
      await handleCancel(argv);
      return;
    case "task-resume-candidate":
      await handleTaskResumeCandidate(argv);
      return;
    case "transfer":
      await handleTransfer(argv);
      return;
    case "task-worker":
      await handleTaskWorker(argv);
      return;
    default:
      throw new Error("Unknown subcommand: " + subcommand);
  }
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
