/**
 * Host-neutral logic shared by the pi adapter (".pi/extensions/dsh.ts").
 *
 * Everything here is plain ESM with zero dependencies so the adapter can import
 * it directly (jiti runs the .ts adapter, and this .mjs is a plain relative
 * import) and so the unit tests can exercise it on any Node version. The
 * adapter layer is kept thin: argv construction, parsing, formatting, and the
 * one child-process helper live here.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";

import { terminateProcessTree } from "./process.mjs";

/** A tool result is capped the way pi caps its own tool output. */
export const MAX_RESULT_BYTES = 50 * 1024;
export const MAX_RESULT_LINES = 2000;

/** Progress lines are forwarded to the UI at most this often. */
const STDERR_THROTTLE_MS = 500;
/** Fallback resolution after a kill, in case the child never emits "close". */
const KILL_SETTLE_MS = 12000;
const TRUNCATION_NOTICE = "\n\n[truncated: the full output is in the DSH job record; use dsh_jobs to retrieve it, or run the companion CLI directly.]";

function appendFlag(args, flag, present) {
  if (present) {
    args.push(flag);
  }
}

function appendValue(args, flag, value) {
  if (value !== undefined && value !== null && String(value).trim() !== "") {
    args.push(flag, String(value).trim());
  }
}

/**
 * argv for "task". "auto" is resolved by the adapter (it may need a resume
 * candidate lookup and a user confirmation) before it reaches here, so this
 * builder only ever emits --resume or --fresh.
 */
export function taskArgs(params = {}, cwd) {
  const args = ["task"];
  const session = params.session === "continue" ? "continue" : "new";
  args.push(session === "continue" ? "--resume" : "--fresh");
  appendFlag(args, "--analyze", params.analyze);
  appendValue(args, "--model", params.model);
  appendValue(args, "--provider", params.provider);
  appendValue(args, "--effort", params.effort);
  appendFlag(args, params.background ? "--background" : "--wait", true);
  appendValue(args, "--cwd", cwd);
  args.push("--", String(params.task ?? ""));
  return args;
}

/** argv for "review". The focus text is optional and becomes the one positional. */
export function reviewArgs(params = {}, cwd) {
  const args = ["review"];
  appendFlag(args, "--adversarial", params.adversarial);
  appendValue(args, "--base", params.base);
  appendValue(args, "--scope", params.scope);
  appendValue(args, "--model", params.model);
  appendValue(args, "--provider", params.provider);
  appendValue(args, "--effort", params.effort);
  appendFlag(args, params.background ? "--background" : "--wait", true);
  appendValue(args, "--cwd", cwd);
  const focus = String(params.focus ?? "").trim();
  if (focus) {
    args.push("--", focus);
  }
  return args;
}

/** argv for the job commands. Every variant carries --cwd. */
export function jobsArgs(params = {}, cwd) {
  const action = params.action ?? "list";
  if (!["list", "status", "result", "cancel"].includes(action)) {
    throw new Error("Unsupported dsh_jobs action: " + action);
  }
  if ((action === "result" || action === "cancel") && !String(params.jobId || "").trim()) {
    throw new Error("dsh_jobs " + action + " requires jobId.");
  }
  if (action === "status" && params.wait && !String(params.jobId || "").trim()) {
    throw new Error("dsh_jobs status with wait requires jobId.");
  }
  if (action === "list") {
    return ["status", "--all", "--cwd", String(cwd ?? "")];
  }
  if (action === "status") {
    const args = ["status"];
    if (params.jobId) {
      args.push(String(params.jobId));
    }
    if (params.wait) {
      args.push("--wait");
      appendValue(args, "--timeout-ms", params.timeoutMs);
    }
    args.push("--cwd", String(cwd ?? ""));
    return args;
  }
  return [action, String(params.jobId ?? ""), "--cwd", String(cwd ?? "")];
}

/**
 * argv for "setup". The command reads no --cwd (it uses process.cwd()), so the
 * adapter spawns it with cwd set to the session directory instead.
 */
export function setupArgs(params = {}) {
  const args = ["setup"];
  appendFlag(args, "--enable-review-gate", params.action === "enable-gate");
  appendFlag(args, "--disable-review-gate", params.action === "disable-gate");
  return args;
}

/** argv for "models"; unlike setup it accepts --cwd. */
export function modelsArgs(cwd) {
  return ["models", "--cwd", String(cwd ?? "")];
}

/** argv for the internal resume-candidate lookup, always --json. */
export function resumeCandidateArgs(cwd) {
  return ["task-resume-candidate", "--json", "--cwd", String(cwd ?? "")];
}

/**
 * Parse "task-resume-candidate --json". Fail-safe: a non-zero exit or an
 * unparseable body means "no candidate", never a thrown error, because the
 * adapter falls back to a fresh session rather than failing the tool.
 */
export function parseResumeCandidate(stdout, exitCode) {
  if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
    return { available: false, reason: null, candidate: null };
  }
  let payload = null;
  try {
    payload = JSON.parse(String(stdout || ""));
  } catch (error) {
    return { available: false, reason: null, candidate: null };
  }
  if (!payload || typeof payload !== "object") {
    return { available: false, reason: null, candidate: null };
  }
  return {
    available: Boolean(payload.available),
    reason: payload.reason || null,
    candidate: payload.candidate || null
  };
}

/** The stdin payload the shared Stop-gate hook expects. */
export function buildGatePayload({ cwd, lastAssistantText, stopHookActive } = {}) {
  return {
    cwd: String(cwd ?? ""),
    stop_hook_active: Boolean(stopHookActive),
    last_assistant_message: String(lastAssistantText ?? "")
  };
}

/**
 * Parse the gate hook's stdout. It writes {"decision":"block","reason":"..."}
 * only when it blocks; an empty stdout or anything unparsable allows the turn,
 * matching the hook's own fail-open contract.
 */
export function parseGateDecision(stdout) {
  const text = String(stdout || "").trim();
  if (!text) {
    return { block: false, reason: null };
  }
  try {
    const payload = JSON.parse(text);
    if (payload && payload.decision === "block" && String(payload.reason || "").trim()) {
      return { block: true, reason: String(payload.reason).trim() };
    }
  } catch (error) {
    // An unparseable decision allows the turn; the hook's stderr already said why.
  }
  return { block: false, reason: null };
}

/**
 * The text of the last assistant message plus its stop reason.
 *
 * pi's assistant message content is a list of blocks; only text blocks carry
 * prose, and toolCall/thinking blocks must not be glued into it. The stop
 * reason is read here because "aborted" (the user hit Esc) must skip the gate.
 */
export function lastAssistantText(message) {
  if (!message || typeof message !== "object") {
    return { text: "", stopReason: null };
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .map((block) => (block && typeof block === "object" && block.type === "text" ? block.text : ""))
    .filter((value) => typeof value === "string")
    .join("");
  return {
    text: String(text || ""),
    stopReason: message.stopReason === undefined ? null : message.stopReason
  };
}

function clipUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function truncate(text) {
  const lines = text.split(/\r?\n/);
  const contentLineLimit = Math.max(1, MAX_RESULT_LINES - 2);
  let clipped = lines.length > MAX_RESULT_LINES
    ? lines.slice(0, contentLineLimit).join("\n")
    : text;
  const contentByteLimit = MAX_RESULT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
  clipped = clipUtf8(clipped, contentByteLimit);

  if (clipped === text) {
    return text;
  }
  return clipped + TRUNCATION_NOTICE;
}

/**
 * Render a companion run for a tool result. Success hands back stdout as-is;
 * failure (non-zero exit, or a run that was aborted/timed out) becomes a text
 * the adapter throws so pi marks the tool call as an error.
 */
export function formatToolResult({ code, stdout, stderr, aborted } = {}) {
  const out = String(stdout ?? "");
  const err = String(stderr ?? "").trim();
  if (aborted) {
    return truncate([
      "The DSH command was aborted before it finished.",
      err
    ].filter(Boolean).join("\n").trim());
  }
  if (code !== 0) {
    return truncate([
      "The DSH command exited with code " + code + ".",
      err
    ].filter(Boolean).join("\n").trim());
  }
  return truncate(out.trim());
}

/**
 * Run one node script (the companion or the gate hook) as a child process.
 *
 * stdout is accumulated and returned whole; stderr is accumulated too and
 * additionally forwarded line-by-line to onUpdate, throttled, so a long DSH
 * turn can report progress to the user. Abortion (the caller's AbortSignal) and
 * the timeout both terminate the process tree through the same helper cancel
 * uses, so a killed run cannot leave a DSH runtime behind on Windows.
 *
 * spawn is injectable so the adapter tests never start a real process.
 */
export async function runNodeScript({
  scriptPath,
  args = [],
  cwd,
  stdin,
  signal,
  timeoutMs,
  onUpdate,
  spawn
} = {}) {
  const spawnImpl = spawn || defaultSpawn;
  const runner = spawnImpl(process.execPath, [scriptPath, ...args], {
    cwd: cwd || undefined,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let decodersEnded = false;
  let killed = false;
  let settled = false;
  let partialLine = "";
  let pendingLines = [];
  let lastFlush = Date.now();
  let abortHandler = null;

  const finish = (value) => {
    if (settled) {
      return;
    }
    settled = true;
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
      abortHandler = null;
    }
    if (timer) {
      clearTimeout(timer);
    }
    if (fallback) {
      clearTimeout(fallback);
    }
    resolve(value);
  };

  let resolve = null;
  const done = new Promise((res) => {
    resolve = res;
  });

  const flush = () => {
    if (pendingLines.length > 0 && onUpdate) {
      onUpdate(pendingLines.join("\n"));
      pendingLines = [];
      lastFlush = Date.now();
    }
  };

  const collectStderr = (text) => {
    if (!text) {
      return;
    }
    stderr += text;
    const lines = (partialLine + text).split(/\r?\n/);
    partialLine = lines.pop() ?? "";
    pendingLines.push(...lines.filter((line) => line.trim()));
    if (Date.now() - lastFlush >= STDERR_THROTTLE_MS) {
      flush();
    }
  };

  const endDecoders = () => {
    if (decodersEnded) {
      return;
    }
    decodersEnded = true;
    stdout += stdoutDecoder.end();
    collectStderr(stderrDecoder.end());
  };

  const terminate = () => {
    if (killed || !runner.pid) {
      return;
    }
    killed = true;
    // The tree is torn down the same way cancel does it; the "close" event
    // settles the promise, and a fallback guards a child that never exits.
    terminateProcessTree(runner.pid, { cwd: cwd || undefined }).catch(() => {});
    fallback = setTimeout(() => {
      endDecoders();
      flush();
      finish({ code: null, stdout, stderr, killed: true });
    }, KILL_SETTLE_MS);
  };

  let timer = Number(timeoutMs) > 0 ? setTimeout(terminate, Number(timeoutMs)) : null;
  let fallback = null;

  if (runner.stdout) {
    runner.stdout.on("data", (chunk) => {
      stdout += stdoutDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
  }
  if (runner.stderr) {
    runner.stderr.on("data", (chunk) => {
      collectStderr(stderrDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    });
  }
  if (runner.stdin) {
    runner.stdin.on?.("error", (error) => {
      collectStderr(String(error?.message || error));
    });
    try {
      if (stdin !== undefined && stdin !== null) {
        runner.stdin.write(stdin);
      }
      runner.stdin.end();
    } catch (error) {
      collectStderr(String(error?.message || error));
    }
  }
  if (signal) {
    if (signal.aborted) {
      terminate();
    } else {
      abortHandler = terminate;
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  runner.on("error", (error) => {
    endDecoders();
    collectStderr(String(error?.message || error));
    finish({ code: null, stdout, stderr, killed });
  });
  runner.on("close", (code) => {
    endDecoders();
    if (partialLine.trim()) {
      pendingLines.push(partialLine);
      partialLine = "";
    }
    flush();
    finish({ code, stdout, stderr, killed });
  });

  return done;
}

function defaultSpawn(command, args, options) {
  return spawn(command, args, options);
}
