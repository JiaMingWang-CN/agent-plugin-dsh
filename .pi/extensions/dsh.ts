/**
 * pi host adapter for the dsh plugin.
 *
 * pi (@earendil-works/pi-coding-agent) is the third host alongside Codex and
 * Claude Code. This file is deliberately thin: path derivation, argv
 * construction, parsing, formatting, and the child-process helper all live in
 * scripts/lib/pi-host.mjs, and every capability is one call into the shared
 * scripts/dsh-companion.mjs entry point — the host-neutral layer is untouched.
 *
 * Load constraints: the extension is run by jiti as .ts, so only import type
 * (erased at load), node: built-ins, and this repository's own relative imports
 * are used. Tool parameters are hand-written plain JSON Schema: pi-ai's
 * validateToolArguments takes the coerceWithJsonSchema branch for any schema
 * without a TypeBox Kind symbol, which keeps typebox out of the runtime path.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
} from "../../scripts/lib/pi-host.mjs";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(EXT_DIR, "..", "..");
const COMPANION = path.join(PACKAGE_ROOT, "scripts", "dsh-companion.mjs");
const GATE = path.join(PACKAGE_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SKILLS = path.join(PACKAGE_ROOT, "skills");

/** The gate's own review bound is 15 minutes; allow margin for startup. */
const GATE_TIMEOUT_MS = 20 * 60 * 1000;

interface JsonSchema {
  [key: string]: unknown;
}

const TASK_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description:
        "The task to hand to DSH, stated as intent. DSH reads the workspace itself, so describe the outcome you want, not the files or steps."
    },
    session: {
      type: "string",
      enum: ["auto", "new", "continue"],
      description:
        "auto (default) continues the previous DSH session for this workspace when one can be resumed and you confirm, otherwise starts fresh. new and continue force one or the other."
    },
    analyze: {
      type: "boolean",
      description:
        "Run a read-only research pass first that answers with a task brief, then execute the brief on a fresh session. Cannot be combined with session continue."
    },
    model: { type: "string", description: "Model id or the aliases flash / pro. Omit to keep the DSH default." },
    provider: { type: "string", description: "Provider id for the model, when the model id is ambiguous." },
    effort: { type: "string", description: "Reasoning effort; must be a value the selected route advertises." },
    background: {
      type: "boolean",
      description:
        "Fire and forget: queue the task as a background job and return at once. Default false runs it in the foreground and returns the final output."
    }
  },
  required: ["task"],
  additionalProperties: false
};

const REVIEW_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    focus: { type: "string", description: "What the review should concentrate on. Omit for the whole change set." },
    adversarial: {
      type: "boolean",
      description: "Request the harsher second opinion instead of the standard review."
    },
    base: { type: "string", description: "Git ref to diff against." },
    scope: {
      type: "string",
      enum: ["auto", "working-tree", "branch"],
      description: "auto (default) picks from the change set; working-tree or branch narrows it."
    },
    model: { type: "string", description: "Model id or the aliases flash / pro. Omit to keep the DSH default." },
    provider: { type: "string", description: "Provider id for the model." },
    effort: { type: "string", description: "Reasoning effort; must be a value the selected route advertises." },
    background: {
      type: "boolean",
      description: "Fire and forget as a background job. Default false runs in the foreground and returns the review."
    }
  },
  additionalProperties: false
};

const JOBS_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "status", "result", "cancel"],
      description: "list every recorded job; status (with a job id) polls one job; result fetches the stored output; cancel terminates the job."
    },
    jobId: { type: "string", description: "The job id. Required for result and cancel, optional for status." },
    wait: { type: "boolean", description: "For status: block until the job finishes." },
    timeoutMs: { type: "number", description: "For status --wait: how long to wait in milliseconds." }
  },
  required: ["action"],
  additionalProperties: false
};

const SETUP_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["check", "models", "enable-gate", "disable-gate"],
      description:
        "check reports DSH availability, credentials, and the workspace state directory; models lists the routes this environment offers; enable-gate / disable-gate turn the stop review gate on or off for this workspace."
    }
  },
  required: ["action"],
  additionalProperties: false
};

interface DshDeps {
  spawn?: unknown;
}

export default function dshExtension(pi: ExtensionAPI, deps: DshDeps = {}): void {
  const spawn = deps.spawn;

  pi.on("resources_discover", () => ({
    skillPaths: [SKILLS]
  }));

  // ---- review gate -------------------------------------------------------
  // pi's "the agent will not continue on its own" moment is agent_settled, the
  // Stop equivalent. The shared gate hook owns every decision; this wiring only
  // feeds it and never traps the session on an infrastructure fault.
  let lastAssistant = { text: "", stopReason: null as string | null };
  let gateBlockedThisRun = false;
  let gateRunning = false;

  pi.on("turn_end", (event) => {
    lastAssistant = lastAssistantText(event.message);
  });
  pi.on("session_start", () => {
    gateBlockedThisRun = false;
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      gateBlockedThisRun = false;
    }
  });

  async function runGate(ctx: { cwd: string; hasUI: boolean; ui: { setStatus: (key: string, text: string | undefined) => void } }): Promise<void> {
    // A turn the user interrupted is not a finished answer worth reviewing.
    if (lastAssistant.stopReason === "aborted" || gateRunning) {
      return;
    }
    gateRunning = true;
    try {
      const payload = buildGatePayload({
        cwd: ctx.cwd,
        lastAssistantText: lastAssistant.text,
        stopHookActive: gateBlockedThisRun
      });
      if (ctx.hasUI) {
        ctx.ui.setStatus("dsh-review-gate", "DSH review gate running");
      }
      const result = await runNodeScript({
        scriptPath: GATE,
        args: [],
        cwd: ctx.cwd,
        stdin: JSON.stringify(payload),
        timeoutMs: GATE_TIMEOUT_MS,
        spawn
      });
      const decision = parseGateDecision(result.stdout);
      if (decision.block) {
        // The next agent_settled carries stop_hook_active: true and is allowed,
        // so only a fresh user input can arm another block.
        gateBlockedThisRun = true;
        pi.sendMessage(
          {
            customType: "dsh-review-gate",
            content: decision.reason + " (resolve this before finishing)",
            display: true
          },
          { deliverAs: "followUp", triggerTurn: true }
        );
      }
    } catch (error) {
      // Fail open, exactly like the hook does with Codex and Claude Code.
      process.stderr.write("dsh review gate: " + (error instanceof Error ? error.message : String(error)) + "\n");
    } finally {
      gateRunning = false;
      if (ctx.hasUI) {
        ctx.ui.setStatus("dsh-review-gate", undefined);
      }
    }
  }

  pi.on("agent_settled", async (_event, ctx) => {
    await runGate(ctx);
  });

  // ---- tools -------------------------------------------------------------
  async function runCompanion(
    args: string[],
    cwd: string,
    onUpdate?: (message: string) => void,
    signal?: AbortSignal
  ) {
    return runNodeScript({
      scriptPath: COMPANION,
      args,
      cwd,
      signal,
      onUpdate,
      spawn
    });
  }

  function asToolResult(result: { code: number | null; stdout: string; stderr: string; killed: boolean }) {
    const text = formatToolResult({
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      aborted: result.killed
    });
    if (result.code !== 0 || result.killed) {
      throw new Error(text);
    }
    return {
      content: [{ type: "text", text }],
      details: { exitStatus: result.code }
    };
  }

  function progress(onUpdate: ((update: unknown) => void) | undefined) {
    if (!onUpdate) {
      return undefined;
    }
    return (message: string) => {
      onUpdate({ content: [{ type: "text", text: message }] });
    };
  }

  /** session "auto": ask once whether to continue the resumable DSH session. */
  async function resolveAutoSession(
    cwd: string,
    hasUI: boolean,
    confirm: (title: string, message: string) => Promise<boolean>,
    signal?: AbortSignal
  ) {
    const result = await runCompanion(resumeCandidateArgs(cwd), cwd, undefined, signal);
    const candidate = parseResumeCandidate(result.stdout, result.code);
    if (!candidate.available || !candidate.candidate) {
      return "new" as const;
    }
    if (!hasUI) {
      return "new" as const;
    }
    const ok = await confirm(
      "Continue the DSH session?",
      "Continue the DSH session from job " + candidate.candidate.id + ", or start a new one?"
    );
    return ok ? ("continue" as const) : ("new" as const);
  }

  pi.registerTool({
    name: "dsh_task",
    label: "DSH Task",
    description:
      "Delegate a read-only task to DeepSeek Harness (DSH), or continue a previous DSH session in this workspace. DSH runs as its own agent: hand it the intent and it reads the repository itself. The final output comes back verbatim.",
    promptSnippet: "Delegate implementation or investigation to DSH, or continue a DSH session",
    promptGuidelines: [
      "Pass intent to dsh_task, not context: DSH reads the workspace itself, so describe the outcome rather than the files and steps.",
      "dsh_task analyze and session continue are mutually exclusive; the analysis layer always runs a fresh research-then-execute pipeline.",
      "Use dsh_task background only for fire-and-forget work, and manage it afterwards with dsh_jobs."
    ],
    parameters: TASK_PARAMS as any,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let session = params.session === "continue" || params.session === "new" ? params.session : "auto";
      if (params.analyze && session === "continue") {
        throw new Error("dsh_task analyze cannot be combined with session continue.");
      }
      if (params.analyze) {
        session = "new";
      } else if (session === "auto") {
        session = await resolveAutoSession(
          ctx.cwd,
          ctx.hasUI,
          (title, message) => ctx.ui.confirm(title, message),
          signal
        );
      }
      const args = taskArgs(
        {
          task: params.task,
          session,
          analyze: params.analyze,
          model: params.model,
          provider: params.provider,
          effort: params.effort,
          background: params.background
        },
        ctx.cwd
      );
      const result = await runCompanion(args, ctx.cwd, progress(onUpdate), signal);
      return asToolResult(result);
    }
  });

  pi.registerTool({
    name: "dsh_review",
    label: "DSH Review",
    description:
      "Ask DSH for an independent code review of the current workspace changes. The adversarial option requests a harsher second opinion; base and scope narrow the diff. Reviews are read-only: DSH reports findings, it does not fix them.",
    promptSnippet: "Get an independent DSH review of the current changes",
    promptGuidelines: [
      "Use dsh_review for an independent second opinion on the current changes; it reports findings and does not fix them.",
      "Prefer dsh_review adversarial when the change is risky or security-sensitive, and narrow it with base or scope."
    ],
    parameters: REVIEW_PARAMS as any,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const args = reviewArgs(
        {
          focus: params.focus,
          adversarial: params.adversarial,
          base: params.base,
          scope: params.scope,
          model: params.model,
          provider: params.provider,
          effort: params.effort,
          background: params.background
        },
        ctx.cwd
      );
      const result = await runCompanion(args, ctx.cwd, progress(onUpdate), signal);
      return asToolResult(result);
    }
  });

  pi.registerTool({
    name: "dsh_jobs",
    label: "DSH Jobs",
    description:
      "Inspect, retrieve, or cancel DSH background jobs recorded for this workspace. list shows them all, status polls one (and can wait), result fetches the stored final output, cancel terminates the job.",
    promptSnippet: "Check, retrieve, or cancel DSH background jobs",
    promptGuidelines: [
      "Use dsh_jobs to follow up on work started with dsh_task background; result fetches the final output and cancel stops it.",
      "A cancelled job may not have flushed its session log, so offer resume only when dsh_jobs result reports it resumable."
    ],
    parameters: JOBS_PARAMS as any,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if ((params.action === "result" || params.action === "cancel") && !String(params.jobId || "").trim()) {
        throw new Error("dsh_jobs " + params.action + " requires jobId.");
      }
      if (params.action === "status" && params.wait && !String(params.jobId || "").trim()) {
        throw new Error("dsh_jobs status with wait requires jobId.");
      }
      const args = jobsArgs(
        {
          action: params.action,
          jobId: params.jobId,
          wait: params.wait,
          timeoutMs: params.timeoutMs
        },
        ctx.cwd
      );
      const result = await runCompanion(args, ctx.cwd, undefined, signal);
      return asToolResult(result);
    }
  });

  pi.registerTool({
    name: "dsh_setup",
    label: "DSH Setup",
    description:
      "Diagnose the DSH environment (availability, credentials, workspace state directory), list the models this environment offers, or enable / disable the stop review gate for this workspace.",
    promptSnippet: "Diagnose DSH, list models, or toggle the review gate",
    promptGuidelines: [
      "Use dsh_setup check first when a DSH call fails; it reports availability and credentials, and dsh_setup models lists what the environment offers."
    ],
    parameters: SETUP_PARAMS as any,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // setup reads no --cwd (it uses its own process.cwd()), so it is spawned
      // with the session directory; models takes --cwd explicitly.
      const args = params.action === "models" ? modelsArgs(ctx.cwd) : setupArgs({ action: params.action });
      const result = await runCompanion(args, ctx.cwd, undefined, signal);
      return asToolResult(result);
    }
  });
}
