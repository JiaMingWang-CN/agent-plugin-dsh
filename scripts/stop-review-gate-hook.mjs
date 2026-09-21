#!/usr/bin/env node
/**
 * Stop-time review gate for the dsh plugin, shared by both of its hosts.
 *
 * Codex runs this as a Stop hook. The verified contract
 * (codex-rs/hooks/src/events/stop.rs, engine/output_parser.rs, engine/mod.rs):
 *
 * - stdin is one JSON object: session_id, turn_id, transcript_path, cwd, model,
 *   permission_mode, stop_hook_active, last_assistant_message.
 * - Anything non-empty on stdout must be valid stop-hook JSON, or the run is
 *   recorded as failed. Allowing therefore writes NOTHING to stdout.
 * - Blocking is exit 0 plus {"decision":"block","reason":"<non-empty>"}; a blank
 *   reason is rejected as "returned decision:block without a non-empty reason".
 * - Control effects require a synchronous handler, so hooks/hooks.json must not
 *   set "async": true.
 *
 * Claude Code reads the same hooks/hooks.json and drives the same contract: its
 * Stop payload carries session_id, transcript_path, cwd, hook_event_name,
 * stop_hook_active and last_assistant_message, and a block is the same
 * {"decision":"block","reason":"..."} object. Claude Code re-runs Stop after a
 * block (seen here as stop_hook_active === true, which is always allowed) and
 * caps consecutive blocks with CLAUDE_CODE_STOP_HOOK_BLOCK_CAP.
 *
 * This hook blocks ONLY on an explicit BLOCK: verdict. A gate that cannot run
 * (gate disabled, dsh missing, timeout, crash, unparseable answer) reports the
 * problem on stderr and allows, because trapping a session on a misconfigured
 * environment is worse than not gating.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { isActiveJobStatus, sortJobsNewestFirst } from "./lib/job-control.mjs";
import { getDshAvailability } from "./lib/dsh.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const COMPANION = path.join(SCRIPT_DIR, "dsh-companion.mjs");
const REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_RESPONSE_CHARS = 24000;
const CHANGE_CLAIM = /\b(?:add(?:ed|s|ing)?|chang(?:e|ed|es|ing)|creat(?:e|ed|es|ing)|delet(?:e|ed|es|ing)|edit(?:ed|s|ing)?|fix(?:ed|es|ing)?|implement(?:ed|s|ing)?|modif(?:y|ied|ies|ying)|mov(?:e|ed|es|ing)|patch(?:ed|es|ing)?|refactor(?:ed|s|ing)?|remov(?:e|ed|es|ing)|renam(?:e|ed|es|ing)|replac(?:e|ed|es|ing)|rewr(?:ite|ote|itten|iting)|updat(?:e|ed|es|ing)|writ(?:e|es|ing|ten|rote))\b|(?:新增|修改|更改|修复|实现|重构|删除|移除|重命名|替换|更新|写入|创建|移动)(?:了|完成|完毕)?/iu;
const NEGATED_CHANGE_CLAIM = /\b(?:did not|didn't|have not|haven't)\s+(?:change|modify|edit|write|update)\b|\bno (?:files?|code|changes?) (?:were )?(?:changed|modified|made)\b|(?:未|没有|并未)(?:对)?(?:文件|代码|仓库)?(?:进行)?(?:修改|更改|写入|更新)/iu;

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

/** Diagnostics go to stderr; stdout is reserved for the block decision. */
function note(message) {
  if (message) {
    process.stderr.write(message + "\n");
  }
}

function emitBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: reason }) + "\n");
}

/**
 * The gate is for repository changes, not every conversation turn. Hosts do not
 * provide a reliable cross-host list of files changed in the current turn, so
 * use the final response as a conservative local signal before spending a DSH
 * turn. Ambiguous status reports and questions are allowed without a review.
 */
function claimsRepositoryChange(input) {
  const response = String(input.last_assistant_message || "");
  return CHANGE_CLAIM.test(response) && !NEGATED_CHANGE_CLAIM.test(response);
}

function buildPrompt(input) {
  const response = String(input.last_assistant_message || "").trim();
  const clipped = response.length > MAX_RESPONSE_CHARS
    ? response.slice(0, MAX_RESPONSE_CHARS) + "\n\n[truncated]"
    : response;
  return interpolateTemplate(loadPromptTemplate(ROOT_DIR, "stop-review-gate"), {
    RESPONSE_BLOCK: clipped
      ? "What that agent said at the end of its turn:\n\n" + clipped
      : "The agent produced no final message for that turn."
  });
}

/** Run one DSH review of the previous turn. */
function runGateReview(cwd, input) {
  const result = spawnSync(process.execPath, [COMPANION, "stop-review-gate", "--json", buildPrompt(input)], {
    cwd: cwd,
    env: process.env,
    encoding: "utf8",
    timeout: REVIEW_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error?.code === "ETIMEDOUT") {
    return { verdict: "error", detail: "the review timed out after 15 minutes" };
  }
  if (result.error) {
    return { verdict: "error", detail: "the review could not start: " + result.error.message };
  }

  let payload = null;
  try {
    payload = JSON.parse(result.stdout || "null");
  } catch (error) {
    payload = null;
  }
  if (!payload) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return { verdict: "error", detail: detail || "the review produced no parsable result" };
  }

  const text = String(payload.finalResponse || "").trim();
  if (!text) {
    return { verdict: "error", detail: payload.errorMessage || "the review produced no answer" };
  }
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { verdict: "allow", detail: firstLine.slice("ALLOW:".length).trim() };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return { verdict: "block", detail: reason, full: text };
  }
  return { verdict: "error", detail: "the review answered neither ALLOW: nor BLOCK:" };
}

function main() {
  let input;
  try {
    input = readHookInput();
  } catch (error) {
    // A malformed payload is an infrastructure fault, never a reason to block.
    note("dsh review gate: ignored an unreadable Stop payload: " + error.message);
    return;
  }

  const cwd = input.cwd || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  // Both hosts re-run the Stop hook after a block. Blocking again would loop forever,
  // so the second pass always allows.
  if (input.stop_hook_active === true) {
    note("dsh review gate: skipped because a stop hook already ran for this turn.");
    return;
  }

  const runningJob = sortJobsNewestFirst(listJobs(workspaceRoot)).find((job) => isActiveJobStatus(job.status));
  const runningNote = runningJob
    ? "DSH job " + runningJob.id + " is still " + runningJob.status + "; check its status or cancel it before ending the session."
    : null;

  if (!getConfig(workspaceRoot).stopReviewGate) {
    note(runningNote);
    return;
  }

  if (!claimsRepositoryChange(input)) {
    note("dsh review gate: skipped because the final response did not report a repository change.");
    note(runningNote);
    return;
  }

  const availability = getDshAvailability({ cwd: cwd });
  if (!availability.available) {
    note("dsh review gate: dsh is not available (" + availability.detail + "). Run the dsh-setup skill. Allowing.");
    note(runningNote);
    return;
  }

  const review = runGateReview(cwd, input);
  if (review.verdict === "block") {
    note("dsh review gate: blocked.");
    emitBlock(runningNote ? runningNote + " " + review.detail : review.detail);
    return;
  }
  if (review.verdict === "error") {
    note("dsh review gate: " + review.detail + ". Allowing.");
  }
  note(runningNote);
}

try {
  main();
} catch (error) {
  note("dsh review gate: " + (error instanceof Error ? error.message : String(error)));
}
