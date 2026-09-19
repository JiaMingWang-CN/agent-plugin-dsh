import { spawnSync } from "node:child_process";
import process from "node:process";

/** Default bound for a terminator to observe the process actually going away. */
export const DEFAULT_TERMINATION_GRACE_MS = 5000;
/** Default bound for confirming exit after the last signal was delivered. */
export const DEFAULT_EXIT_CONFIRM_MS = 5000;

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? false,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && result.error.code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a pid still exists. `EPERM` means the process exists but belongs to
 * another user, so it counts as alive.
 */
export function isProcessAlive(pid, killImpl = process.kill.bind(process)) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Poll until the pid disappears or `timeoutMs` elapses.
 * @returns an exit observation, or null while the process is still alive.
 */
export async function waitForProcessExit(pid, timeoutMs, options = {}) {
  const alive = options.isAlive ?? (() => isProcessAlive(pid, options.killImpl));
  const pause = options.sleep ?? sleep;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!alive(pid)) {
      return { exited: true };
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await pause(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

function safeKill(killImpl, target, signal) {
  try {
    killImpl(target, signal);
    return { delivered: true };
  } catch (error) {
    if (error?.code === "ESRCH") {
      // ESRCH only proves this exact target is absent. The caller still has to
      // confirm the owned process itself is gone before reporting success.
      return { delivered: false };
    }
    throw error;
  }
}

/**
 * Terminate one owned process tree and confirm it actually exited.
 *
 * Never reports success from signal delivery alone: the process must be gone,
 * or the caller receives `exited: false` with the identity still to clean up.
 *
 * @param pid - the process the caller started (the shell shim on Windows, the
 * runtime itself on POSIX).
 * @param options - `pgid` (the POSIX process group the caller owns), `graceMs`,
 * `confirmMs`, and injectable `killImpl`/`runCommandImpl` for tests.
 * @returns the delivered/exited observation, never a claim of success.
 */
export async function terminateProcessTree(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const isAlive = () => isProcessAlive(pid, options.isAliveImpl ?? killImpl);
  const graceMs = options.graceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const confirmMs = options.confirmMs ?? DEFAULT_EXIT_CONFIRM_MS;
  const report = { attempted: false, delivered: false, exited: false, method: null, detail: null };

  if (!Number.isFinite(pid) || pid <= 0) {
    report.detail = "no pid recorded for this job";
    return report;
  }

  const group = platform === "win32" || !Number.isFinite(options.pgid) ? null : -options.pgid;

  if (platform === "win32") {
    report.attempted = true;
    report.method = "taskkill";
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });
    report.delivered = !result.error && result.status === 0;
    report.detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim() || null;
  } else {
    report.attempted = true;
    report.method = group === null ? "process" : "process-group";
    for (const target of group === null ? [pid] : [group, pid]) {
      if (safeKill(killImpl, target, "SIGTERM").delivered) {
        report.delivered = true;
      }
    }
  }

  if (await waitForProcessExit(pid, graceMs, { isAlive, sleep: options.sleep })) {
    report.exited = true;
    return report;
  }

  if (platform === "win32") {
    report.method = "taskkill-force";
    runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], { cwd: options.cwd, env: options.env });
  } else {
    for (const target of group === null ? [pid] : [group, pid]) {
      if (safeKill(killImpl, target, "SIGKILL").delivered) {
        report.delivered = true;
      }
    }
  }

  report.exited = Boolean(await waitForProcessExit(pid, confirmMs, { isAlive, sleep: options.sleep }));
  if (!report.exited) {
    report.detail = `process ${pid} was still running after termination` + (options.pgid ? ` (group ${options.pgid})` : "");
  }
  return report;
}
