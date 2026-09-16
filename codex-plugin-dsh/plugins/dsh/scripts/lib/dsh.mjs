/**
 * The only DSH-specific module: launching 'dsh', speaking the ACP v1 JSON-RPC
 * stdio surface, and turning one prompt into a final answer plus a stop reason.
 *
 * Transport choice (evidence: docs/phase-0.1-resume-verification.md). The SDK
 * profile ('dsh --profile sdk') is an internal one-runtime-per-turn protocol:
 * its server creates a session for every id and refuses an id persisted by an
 * earlier process with 'session "<id>" already exists'. The ACP profile
 * ('dsh --profile acp') is the supported automation surface and does restore a
 * persisted session across processes through 'session/resume', so it is what
 * this plugin drives.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { terminateProcessTree } from "./process.mjs";

export const DEFAULT_PROFILE = "acp";
/**
 * Tie-breaker only, never an assumption. The model catalog is a property of the
 * DSH_HOME and profile: settings.yaml's llm-pi-ai.providers adds routes a
 * shipped default does not have, and an isolated DSH_HOME has fewer. Every
 * route is therefore read from what the runtime advertises for the session.
 */
export const PREFERRED_PROVIDER = "deepseek-official";
/** Reasoning efforts the runtime advertises, in ascending order. */
export const VALID_EFFORTS = ["off", "low", "high", "max"];
export const MODEL_ALIASES = new Map([
  ["flash", "deepseek-v4-flash"],
  ["pro", "deepseek-v4-pro"]
]);

export const ACP_PROTOCOL_VERSION = 1;
const AGENT_INFO_NAME = "deepseek-harness-acp";
const CREDENTIAL_KEY = "DEEPSEEK_API_KEY";
const STDERR_TAIL_LIMIT = 200;
const INITIALIZE_TIMEOUT_MS = 30000;
const SHUTDOWN_EOF_TIMEOUT_MS = 15000;

/** Raised for launch, protocol, and lifecycle failures. */
export class DshRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "DshRuntimeError";
  }
}

export function resolveDshCommand(env = process.env) {
  return String(env.DSH_CODEX_DSH_BIN || "").trim() || "dsh";
}

export function resolveDshHome(env = process.env) {
  const explicit = String(env.DSH_HOME || "").trim();
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), ".dsh");
}

export function resolveProfile(env = process.env) {
  return String(env.DSH_CODEX_PROFILE || "").trim() || DEFAULT_PROFILE;
}

/**
 * Resolve a requested model id.
 * @returns the alias-resolved id, or null when the caller asked for none. Null
 * means "leave the model the runtime selected alone" rather than a plugin
 * default, so a DSH_HOME that configures its own model is not overridden.
 */
export function normalizeModel(model, env = process.env) {
  const requested = String(model || env.DSH_CODEX_MODEL || "").trim();
  if (!requested || requested === "default") {
    return null;
  }
  return MODEL_ALIASES.get(requested.toLowerCase()) || requested;
}

/** Resolve a requested provider id, or null when the caller did not constrain one. */
export function normalizeProvider(provider, env = process.env) {
  return String(provider || env.DSH_CODEX_PROVIDER || "").trim() || null;
}

/**
 * Validate a requested reasoning effort.
 * @returns the effort, or null when the caller did not choose one.
 */
export function normalizeReasoningEffort(effort, env = process.env) {
  const requested = String(effort || env.DSH_CODEX_EFFORT || "").trim();
  if (!requested || requested === "default") {
    return null;
  }
  if (!VALID_EFFORTS.includes(requested)) {
    throw new Error('Unsupported reasoning effort "' + requested + '". Use one of: ' + VALID_EFFORTS.join(", ") + ".");
  }
  return requested;
}

/** A profile name reaches a shell on Windows, so it stays inside this alphabet. */
function assertSafeProfile(profile) {
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new Error('Unsupported dsh profile name "' + profile + '".');
  }
}

function shellQuote(token) {
  return /^[A-Za-z0-9._\\/:=-]+$/.test(token) ? token : '"' + token.replace(/"/g, '\\"') + '"';
}

/**
 * Resolve one executable argv.
 *
 * A '.mjs'/'.js'/'.ts' target runs through this Node binary, which is how tests
 * inject a fake runtime through DSH_CODEX_DSH_BIN. Windows npm shims are '.cmd'
 * files that only a shell can execute, so the argv is pre-quoted into a single
 * command line instead of passing arguments alongside "shell: true".
 */
export function buildLaunch(command, args, platform = process.platform) {
  if (/\.(mjs|cjs|js|ts)$/i.test(command)) {
    return { command: process.execPath, args: [command].concat(args), shell: false };
  }
  if (platform === "win32") {
    return { command: [command].concat(args).map(shellQuote).join(" "), args: [], shell: true };
  }
  return { command: command, args: args, shell: false };
}

/**
 * One 'dsh --profile <profile>' process speaking ACP over stdio.
 *
 * The runtime is owned by this instance: shutdown() ends stdin so the launcher
 * performs its bounded successful shutdown, and only falls back to terminating
 * the process tree when the process has not exited.
 */
export class DshRuntime {
  #child;
  #pending = new Map();
  #buffer = "";
  #exit = null;
  #exitSignal = null;
  #spawnError = null;
  #stderrTail = [];
  #stderrRest = "";
  #updateHandlers = new Map();
  #exitWaiters = [];
  #requestSerial = 0;

  constructor(child, options = {}) {
    this.#child = child;
    this.platform = options.platform || process.platform;
    this.cwd = options.cwd || process.cwd();
    this.command = options.command || "dsh";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.#onStderr(chunk));
    child.once("error", (error) => {
      this.#spawnError = error;
      this.#failAll(new DshRuntimeError("failed to start " + this.command + ": " + error.message));
    });
    child.once("exit", (code, signal) => {
      // A death by signal arrives as a null code plus the signal name. It is
      // not a clean shutdown, so it must never be recorded as exit code 0.
      this.#exitSignal = signal || null;
      this.#exit = code === null || code === undefined ? (signal ? 1 : 0) : code;
      for (const waiter of this.#exitWaiters.splice(0)) {
        waiter(this.#exit);
      }
      this.#failAll(this.#closedError("runtime exited"));
    });
  }

  /** Start one runtime process. */
  static start(options = {}) {
    const platform = options.platform || process.platform;
    const env = options.env || process.env;
    const profile = options.profile || resolveProfile(env);
    assertSafeProfile(profile);
    const command = options.dshBin || resolveDshCommand(env);
    const launch = buildLaunch(command, ["--profile", profile], platform);
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: launch.shell,
      detached: platform !== "win32",
      windowsHide: true
    });
    return new DshRuntime(child, { platform: platform, cwd: options.cwd, command: command });
  }

  /** The process identity a later cancel needs in order to terminate this runtime. */
  get identity() {
    const pid = this.#child.pid === undefined ? null : this.#child.pid;
    return { pid: pid, pgid: this.platform === "win32" ? null : pid };
  }

  get exitCode() {
    return this.#exit;
  }

  get stderrTail() {
    return this.#stderrTail.join("\n");
  }

  #onStderr(chunk) {
    this.#stderrRest += chunk;
    const lines = this.#stderrRest.split(/\r?\n/);
    this.#stderrRest = lines.pop() || "";
    this.#stderrTail.push.apply(this.#stderrTail, lines.filter(Boolean));
    if (this.#stderrTail.length > STDERR_TAIL_LIMIT) {
      this.#stderrTail.splice(0, this.#stderrTail.length - STDERR_TAIL_LIMIT);
    }
  }

  #closedError(reason) {
    const parts = [this.command + ": " + reason];
    if (this.#spawnError) {
      parts.push("spawn error: " + this.#spawnError.message);
    }
    if (this.#exit !== null) {
      parts.push("exit code: " + this.#exit + (this.#exitSignal ? " (signal " + this.#exitSignal + ")" : ""));
    }
    if (this.#stderrTail.length > 0) {
      parts.push("stderr tail:\n" + this.#stderrTail.join("\n"));
    }
    return new DshRuntimeError(parts.join("\n"));
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #onData(chunk) {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (error) {
        continue;
      }
      this.#dispatch(frame);
    }
  }

  #dispatch(frame) {
    if (frame.method === "session/update") {
      const handler = this.#updateHandlers.get(frame.params && frame.params.sessionId);
      if (handler) {
        handler(frame.params);
      }
      return;
    }
    if (typeof frame.method === "string" && frame.id !== undefined) {
      this.#answerClientRequest(frame);
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (!pending) {
      return;
    }
    this.#pending.delete(frame.id);
    if (frame.error) {
      const detail = frame.error.message === undefined ? JSON.stringify(frame.error) : frame.error.message;
      pending.reject(new DshRuntimeError(pending.method + " failed: " + detail));
      return;
    }
    pending.resolve(frame.result);
  }

  /**
   * Answer agent-to-client requests. Delegation is a trusted-controller
   * relationship, so the one channel the ACP bridge opens, a one-shot
   * permission prompt, is granted once. See the README for the enforcement
   * limits and for DSH_PERMISSION_MODE as the real sandbox switch.
   */
  #answerClientRequest(frame) {
    const result = frame.method === "session/request_permission"
      ? { outcome: { outcome: "selected", optionId: "allow-once" } }
      : {};
    this.#write({ jsonrpc: "2.0", id: frame.id, result: result });
  }

  #write(message) {
    if (this.#exit !== null || this.#child.stdin.destroyed) {
      throw this.#closedError("cannot write, the runtime is gone");
    }
    this.#child.stdin.write(JSON.stringify(message) + "\n");
  }

  request(method, params, timeoutMs) {
    const id = "req_" + (this.#requestSerial += 1) + "_" + Date.now().toString(36);
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined
        ? null
        : setTimeout(() => {
            this.#pending.delete(id);
            reject(new DshRuntimeError(method + " timed out after " + timeoutMs + "ms"));
          }, timeoutMs);
      this.#pending.set(id, {
        method: method,
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this.#write({ jsonrpc: "2.0", id: id, method: method, params: params });
      } catch (error) {
        this.#pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method: method, params: params });
  }

  /** Perform the ACP handshake and verify the peer is the DSH ACP bridge. */
  async initialize() {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
      },
      INITIALIZE_TIMEOUT_MS
    );
    const name = result && result.agentInfo ? result.agentInfo.name : undefined;
    if (name !== AGENT_INFO_NAME) {
      throw new DshRuntimeError(
        'unexpected ACP agent identity "' + String(name) + '"; expected "' + AGENT_INFO_NAME +
        '". The configured dsh profile is not the ACP automation profile.'
      );
    }
    return result;
  }

  newSession(cwd) {
    return this.request("session/new", { cwd: cwd, mcpServers: [] });
  }

  resumeSession(sessionId, cwd) {
    return this.request("session/resume", { sessionId: sessionId, cwd: cwd, mcpServers: [] });
  }

  listSessions(cwd) {
    return this.request("session/list", cwd === undefined ? {} : { cwd: cwd });
  }

  setConfigOption(sessionId, configId, value) {
    return this.request("session/set_config_option", { sessionId: sessionId, configId: configId, value: value });
  }

  closeSession(sessionId) {
    return this.request("session/close", { sessionId: sessionId }, SHUTDOWN_EOF_TIMEOUT_MS);
  }

  /**
   * Send one prompt and settle when the session returns to idle.
   *
   * @param options.onUpdate - receives every committed session/update payload.
   * @returns the ACP stop reason and the concatenated assistant text.
   */
  async prompt(sessionId, text, options = {}) {
    let assistantText = "";
    const handler = (params) => {
      const update = params.update || {};
      if (update.sessionUpdate === "agent_message_chunk" && update.content && update.content.type === "text") {
        assistantText += update.content.text;
      }
      if (options.onUpdate) {
        options.onUpdate(update);
      }
    };
    this.#updateHandlers.set(sessionId, handler);
    try {
      const result = await this.request("session/prompt", {
        sessionId: sessionId,
        prompt: [{ type: "text", text: text }]
      });
      return { stopReason: result && result.stopReason ? result.stopReason : null, assistantText: assistantText };
    } finally {
      this.#updateHandlers.delete(sessionId);
    }
  }

  cancel(sessionId) {
    this.notify("session/cancel", { sessionId: sessionId });
  }

  #waitForExit(timeoutMs) {
    if (this.#exit !== null) {
      return Promise.resolve(this.#exit);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.#exitWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  /**
   * Offer the runtime its bounded successful shutdown, then confirm the process
   * actually exited. Signal delivery alone is never reported as success.
   */
  async shutdown() {
    if (this.#exit !== null) {
      return { exited: true, code: this.#exit, method: this.#exitSignal ? "signal:" + this.#exitSignal : "already-exited" };
    }
    try {
      this.#child.stdin.end();
    } catch (error) {
      this.#stderrTail.push("stdin close failed: " + error.message);
    }
    const code = await this.#waitForExit(SHUTDOWN_EOF_TIMEOUT_MS);
    if (code !== null) {
      return { exited: true, code: code, method: this.#exitSignal ? "signal:" + this.#exitSignal : "stdin-eof" };
    }
    const terminated = await this.#terminate();
    return Object.assign({}, terminated, { method: "forced:" + terminated.method });
  }

  #terminate() {
    const identity = this.identity;
    return terminateProcessTree(identity.pid === null ? NaN : identity.pid, {
      platform: this.platform,
      pgid: identity.pgid === null ? undefined : identity.pgid,
      cwd: this.cwd
    });
  }

  /** Force-terminate the runtime process tree and confirm the exit. */
  async terminate() {
    const result = await this.#terminate();
    if (!result.exited) {
      await this.#waitForExit(5000);
    }
    return result;
  }
}

/** Whether dsh can be executed at all, plus its reported version. */
export function getDshAvailability(options = {}) {
  const platform = options.platform || process.platform;
  const command = options.dshBin || resolveDshCommand(options.env || process.env);
  const launch = buildLaunch(command, ["--version"], platform);
  const result = spawnSync(launch.command, launch.args, {
    cwd: options.cwd,
    encoding: "utf8",
    shell: launch.shell,
    windowsHide: true,
    timeout: 30000
  });
  if (result.error && result.error.code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || "").trim() || String(result.stdout || "").trim() || "exit " + result.status;
    return { available: false, detail: detail };
  }
  return {
    available: true,
    detail: String(result.stdout || "").trim() || String(result.stderr || "").trim() || "ok"
  };
}

/**
 * Locate where DEEPSEEK_API_KEY would be resolved from, in the documented
 * order: process environment, then $DSH_HOME/.credentials.yaml, then
 * <cwd>/.env, then $DSH_HOME/.env.
 *
 * Only key presence is reported; no value is ever read out of these files.
 */
export function getDshCredentialStatus(options = {}) {
  const env = options.env || process.env;
  const dshHome = options.dshHome || resolveDshHome(env);
  const cwd = options.cwd || process.cwd();
  const checked = ["process environment"];

  if (String(env[CREDENTIAL_KEY] || "").trim()) {
    return { found: true, source: "process environment", checked: checked };
  }

  const credentialsFile = path.join(dshHome, ".credentials.yaml");
  checked.push(credentialsFile);
  if (credentialRefPresent(credentialsFile)) {
    return { found: true, source: credentialsFile, checked: checked };
  }

  const projectEnvFile = path.join(cwd, ".env");
  checked.push(projectEnvFile);
  if (envFileDefines(projectEnvFile)) {
    return { found: true, source: projectEnvFile, checked: checked };
  }

  const homeEnvFile = path.join(dshHome, ".env");
  checked.push(homeEnvFile);
  if (envFileDefines(homeEnvFile)) {
    return { found: true, source: homeEnvFile, checked: checked };
  }

  return { found: false, source: null, checked: checked };
}

/** Key-name presence inside the refs: block of the credentials file. */
function credentialRefPresent(filePath) {
  const text = readTextIfPresent(filePath);
  if (text === null) {
    return false;
  }
  const refLine = new RegExp("^\\s+" + CREDENTIAL_KEY + "\\s*:");
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs\s*:/.test(line)) {
      inRefs = true;
      continue;
    }
    if (inRefs && /^\S/.test(line)) {
      return false;
    }
    if (inRefs && refLine.test(line)) {
      return true;
    }
  }
  return false;
}

/** Whether a .env-style file assigns the key, without reading the value out. */
function envFileDefines(filePath) {
  const text = readTextIfPresent(filePath);
  if (text === null) {
    return false;
  }
  const assignLine = new RegExp("^\\s*(export\\s+)?" + CREDENTIAL_KEY + "\\s*=");
  return text.split(/\r?\n/).some((line) => assignLine.test(line));
}

function readTextIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return null;
  }
}

/** Whether a finished job recorded a DSH session this process can resume. */
export function isResumableSession(job, options = {}) {
  if (!job || typeof job.sessionId !== "string" || job.sessionId.length === 0) {
    return { available: false, reason: "the job did not record a DSH session" };
  }
  if (job.status === "cancelled") {
    return { available: false, reason: "the job was cancelled and its session log may be incomplete" };
  }
  if (job.status !== "completed") {
    return { available: false, reason: 'the job finished as "' + job.status + '"' };
  }
  if (options.dshHome && job.dshHome && path.resolve(options.dshHome) !== path.resolve(job.dshHome)) {
    return { available: false, reason: "the job ran against a different DSH_HOME" };
  }
  const profile = options.profile || resolveProfile(options.env || process.env);
  if (job.dshProfile && job.dshProfile !== profile) {
    return { available: false, reason: 'the job ran on profile "' + job.dshProfile + '"' };
  }
  return { available: true, reason: null };
}

/** Translate an ACP stop reason into the exit code the companion reports. */
export function exitStatusForStopReason(stopReason) {
  return stopReason === "end_turn" ? 0 : 1;
}

/**
 * Run one delegated turn end to end: start the runtime, create or resume a
 * session, select the route, prompt, and shut the runtime down with a confirmed
 * exit.
 *
 * @param options.cwd - workspace the session is pinned to.
 * @param options.prompt - the user message text.
 * @param options.sessionId - resume this persisted session instead of creating one.
 * @param options.onProgress - receives { message, phase, sessionId, logTitle, logBody }.
 * @param options.onSession - receives { sessionId, resumed } once the session exists.
 * @param options.onRuntime - receives { pid, pgid } so a later cancel can find the tree.
 */
export async function runDshTurn(options) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const route = {
    model: normalizeModel(options.model, env),
    provider: normalizeProvider(options.provider, env),
    effort: options.reasoningEffort === undefined
      ? normalizeReasoningEffort(undefined, env)
      : options.reasoningEffort
  };
  const progress = options.onProgress || (() => {});
  const runtime = DshRuntime.start({
    cwd: cwd,
    env: env,
    dshBin: options.dshBin,
    profile: options.dshProfile || resolveProfile(env)
  });
  const identity = runtime.identity;
  if (options.onRuntime) {
    options.onRuntime(identity);
  }

  let sessionId = options.sessionId || null;
  let outcome = null;
  try {
    const handshake = await runtime.initialize();
    progress({
      message: "Connected to " + handshake.agentInfo.name + " " + handshake.agentInfo.version + ".",
      phase: "starting"
    });

    if (sessionId) {
      const resumed = await runtime.resumeSession(sessionId, cwd);
      progress({ message: "Resumed DSH session " + sessionId + ".", phase: "running", sessionId: sessionId });
      await applyRoute(runtime, sessionId, route, resumed && resumed.configOptions);
    } else {
      const created = await runtime.newSession(cwd);
      sessionId = created.sessionId;
      progress({ message: "Started DSH session " + sessionId + ".", phase: "running", sessionId: sessionId });
      await applyRoute(runtime, sessionId, route, created.configOptions);
    }
    if (options.onSession) {
      options.onSession({ sessionId: sessionId, resumed: Boolean(options.sessionId) });
    }

    const result = await runtime.prompt(sessionId, options.prompt, {
      onUpdate: (update) => {
        const event = progressEventFor(update);
        if (event) {
          progress(event);
        }
      }
    });

    outcome = {
      sessionId: sessionId,
      finalResponse: result.assistantText,
      stopReason: result.stopReason,
      exitStatus: exitStatusForStopReason(result.stopReason),
      errorMessage: null,
      runtime: identity
    };
  } catch (error) {
    outcome = {
      sessionId: sessionId,
      finalResponse: "",
      stopReason: null,
      exitStatus: 1,
      errorMessage: error instanceof Error ? error.message : String(error),
      runtime: identity
    };
  }

  if (sessionId !== null) {
    try {
      await runtime.closeSession(sessionId);
    } catch (error) {
      progress({ message: "session/close failed: " + error.message, phase: "finalizing" });
    }
  }
  const shutdown = await runtime.shutdown();
  if (!shutdown.exited) {
    throw new DshRuntimeError(
      "DSH runtime " + String(identity.pid) + " did not exit after termination; it is still running and must be cleaned up."
    );
  }
  progress({ message: "DSH runtime exited (" + shutdown.method + ").", phase: "done" });
  return outcome;
}

/** The provider/model pairs a session's "model" option advertises, in wire order. */
export function modelRoutes(configOptions) {
  const option = (Array.isArray(configOptions) ? configOptions : []).find((entry) => entry.id === "model");
  const routes = [];
  for (const entry of (option && option.options) || []) {
    const group = Array.isArray(entry.options) ? entry.options : [entry];
    for (const candidate of group) {
      const parsed = parseRouteValue(candidate.value);
      if (parsed) {
        routes.push({
          provider: parsed[0],
          model: parsed[1],
          value: candidate.value,
          name: candidate.name || parsed[1],
          // The strength blurb the runtime advertises for this route, when it
          // advertises one. Reasoning effort itself is a single session-level
          // option, so this description is the only per-model strength signal.
          description: typeof candidate.description === "string" && candidate.description.trim()
            ? candidate.description.trim()
            : null
        });
      }
    }
  }
  return routes;
}

/** Parse one ACP "model" option value, which is the JSON string ["provider","model"]. */
function parseRouteValue(value) {
  if (typeof value !== "string") {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    return null;
  }
  const isPair = Array.isArray(parsed) && parsed.length === 2 && parsed.every((part) => typeof part === "string");
  return isPair ? parsed : null;
}

/** The advertised catalog as one "provider: a, b, c" line per provider. */
export function formatRoutes(configOptions) {
  const byProvider = new Map();
  for (const route of modelRoutes(configOptions)) {
    if (!byProvider.has(route.provider)) {
      byProvider.set(route.provider, []);
    }
    byProvider.get(route.provider).push(route.model);
  }
  return [...byProvider.entries()].map(([provider, models]) => provider + ": " + models.join(", ")).join("\n");
}

/**
 * Resolve one requested model against the catalog this session advertises.
 *
 * @param requested - { model, provider } where either may be null.
 * @returns the ACP option value to send, or null when no model was requested.
 */
export function resolveModelRoute(configOptions, requested) {
  if (!requested.model) {
    if (requested.provider) {
      throw new Error("--provider only chooses among models; it also needs --model (or DSH_CODEX_MODEL).");
    }
    return null;
  }

  const candidates = modelRoutes(configOptions).filter((route) => route.model === requested.model);
  if (candidates.length === 0) {
    throw new Error(
      'Model "' + requested.model + '" is not offered by this dsh profile. Available:\n' + formatRoutes(configOptions)
    );
  }

  if (requested.provider) {
    const exact = candidates.find((route) => route.provider === requested.provider);
    if (!exact) {
      throw new Error(
        'Model "' + requested.model + '" is not offered by provider "' + requested.provider +
        '". Available:\n' + formatRoutes(configOptions)
      );
    }
    return exact.value;
  }

  if (candidates.length === 1) {
    return candidates[0].value;
  }

  const preferred = candidates.find((route) => route.provider === PREFERRED_PROVIDER);
  if (preferred) {
    return preferred.value;
  }
  throw new Error(
    'Model "' + requested.model + '" is offered by several providers (' +
    candidates.map((route) => route.provider).join(", ") + "). Pass --provider to choose one."
  );
}

/** Apply the requested route to the session through its advertised configuration options. */
async function applyRoute(runtime, sessionId, requested, configOptions) {
  const options = Array.isArray(configOptions) ? configOptions : [];
  const wantedModel = resolveModelRoute(configOptions, requested);
  if (wantedModel !== null) {
    const modelOption = options.find((option) => option.id === "model");
    if (!modelOption) {
      throw new Error("This dsh profile advertises no model option, so --model cannot be honored.");
    }
    if (modelOption.currentValue !== wantedModel) {
      await runtime.setConfigOption(sessionId, "model", wantedModel);
    }
  }

  if (requested.effort === null) {
    return;
  }
  const effortOption = options.find((option) => option.id === "reasoning_effort");
  if (!effortOption) {
    throw new Error("This dsh profile advertises no reasoning_effort option, so --effort cannot be honored.");
  }
  const available = flattenOptionValues(effortOption).map((entry) => entry.value);
  if (!available.includes(requested.effort)) {
    throw new Error('Reasoning effort "' + requested.effort + '" is not offered. Available: ' + available.join(", ") + ".");
  }
  if (effortOption.currentValue !== requested.effort) {
    await runtime.setConfigOption(sessionId, "reasoning_effort", requested.effort);
  }
}

function flattenOptionValues(option) {
  const flat = [];
  for (const entry of option.options || []) {
    if (Array.isArray(entry.options)) {
      flat.push.apply(flat, entry.options);
    } else {
      flat.push(entry);
    }
  }
  return flat;
}

/**
 * Read the model catalog this DSH_HOME and profile actually advertise.
 *
 * The ACP surface exposes routes only through a session and offers no session
 * delete, so this creates one throwaway session that stays in the store; its id
 * is returned rather than hidden.
 *
 * @returns the advertised routes, the session's current selections, and the id
 * of the session that had to be created to read them.
 */
export async function discoverRoutes(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const runtime = DshRuntime.start({
    cwd: cwd,
    env: env,
    dshBin: options.dshBin,
    profile: options.dshProfile || resolveProfile(env)
  });
  let sessionId = null;
  const outcome = {
    sessionId: null,
    routes: [],
    current: null,
    currentModel: null,
    efforts: [],
    currentEffort: null,
    preferredProvider: PREFERRED_PROVIDER
  };

  try {
    await runtime.initialize();
    const created = await runtime.newSession(cwd);
    sessionId = created.sessionId;
    const configOptions = Array.isArray(created.configOptions) ? created.configOptions : [];
    const modelOption = configOptions.find((option) => option.id === "model");
    const effortOption = configOptions.find((option) => option.id === "reasoning_effort");

    const currentParsed = parseRouteValue(modelOption ? modelOption.currentValue : null);
    outcome.sessionId = sessionId;
    outcome.routes = modelRoutes(configOptions);
    outcome.currentModel = modelOption ? modelOption.currentValue : null;
    outcome.current = currentParsed ? { provider: currentParsed[0], model: currentParsed[1] } : null;
    outcome.efforts = effortOption ? flattenOptionValues(effortOption).map((entry) => entry.value) : [];
    outcome.currentEffort = effortOption ? effortOption.currentValue : null;
    return outcome;
  } finally {
    if (sessionId !== null) {
      try {
        await runtime.closeSession(sessionId);
      } catch (error) {
        // The shutdown below is the authoritative teardown.
      }
    }
    const shutdown = await runtime.shutdown();
    if (!shutdown.exited) {
      throw new DshRuntimeError(
        "DSH runtime " + String(runtime.identity.pid) + " did not exit after termination; it is still running and must be cleaned up."
      );
    }
  }
}

/** Turn one committed ACP update into a progress event, or null when it is not progress. */
function progressEventFor(update) {
  if (update.sessionUpdate === "tool_call") {
    const command = update.rawInput && update.rawInput.command;
    const detail = typeof command === "string" ? command : update.title || "tool";
    const firstLine = String(detail).split(/\r?\n/)[0];
    return { message: "Running " + (update.title || "tool") + ": " + firstLine, phase: "running" };
  }
  if (update.sessionUpdate === "tool_call_update") {
    return { message: "Tool " + (update.status || "updated") + ".", phase: "running" };
  }
  return null;
}
