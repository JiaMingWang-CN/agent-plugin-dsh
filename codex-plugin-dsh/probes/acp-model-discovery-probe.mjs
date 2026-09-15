#!/usr/bin/env node
/**
 * Does session/new + session/close leave a discoverable session behind?
 * Answers whether a model-catalog command can be side-effect free.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const IS_WINDOWS = process.platform === "win32";
const DSH_BIN = process.env.DSH_CODEX_DSH_BIN ?? "dsh";

class Runtime {
  constructor(child) {
    this.child = child; this.pending = new Map(); this.buffer = ""; this.exit = null;
    this.exitWaiters = []; this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => this.#onData(c));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { this.stderr += c; });
    child.on("exit", (code) => { this.exit = code; for (const w of this.exitWaiters.splice(0)) w(code); });
  }
  #onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let frame; try { frame = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(frame.id);
      if (pending) { this.pending.delete(frame.id); pending(frame.error ? { error: frame.error } : frame.result); }
    }
  }
  request(method, params) {
    const id = "req_" + randomUUID().replaceAll("-", "");
    return new Promise((res) => {
      this.pending.set(id, res);
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  waitExit(ms) {
    if (this.exit !== null) return Promise.resolve(this.exit);
    return new Promise((res) => { const t = setTimeout(() => res("timeout"), ms); this.exitWaiters.push((c) => { clearTimeout(t); res(c); }); });
  }
}

function start(cwd, dshHome) {
  return new Runtime(spawn(DSH_BIN, ["--profile", "acp"], {
    cwd, env: { ...process.env, DSH_HOME: dshHome }, stdio: ["pipe", "pipe", "pipe"],
    shell: IS_WINDOWS, windowsHide: true,
  }));
}

function tree(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full); else out.push(full.slice(root.length + 1) + " (" + statSync(full).size + "B)");
    }
  };
  walk(root);
  return out.sort();
}

const report = {};
const dshHome = mkdtempSync(join(tmpdir(), "dsh-discovery-home-"));
const workspace = mkdtempSync(join(tmpdir(), "dsh-discovery-ws-"));
mkdirSync(dshHome, { recursive: true });
const creds = join(homedir(), ".dsh", ".credentials.yaml");
if (existsSync(creds)) copyFileSync(creds, join(dshHome, ".credentials.yaml"));

// Process 1: create and close one session, touching no model.
const a = start(workspace, dshHome);
await a.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
report.listBefore = (await a.request("session/list", {})).sessions.map((s) => s.sessionId);
const created = await a.request("session/new", { cwd: workspace, mcpServers: [] });
report.createdSessionId = created.sessionId;
report.configOptionIds = (created.configOptions ?? []).map((o) => o.id);
report.modelGroups = (created.configOptions ?? []).find((o) => o.id === "model")?.options
  ?.map((g) => ({ group: g.group, models: (g.options ?? []).map((m) => m.value) }));
await a.request("session/close", { sessionId: created.sessionId });
a.child.stdin.end();
report.exit1 = await a.waitExit(15000);
report.storeAfterProcess1 = tree(join(dshHome, "sessions"));

// Process 2: a brand-new process lists sessions without creating anything.
const b = start(workspace, dshHome);
await b.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
report.listAfterProcess2 = (await b.request("session/list", {})).sessions.map((s) => s.sessionId);
b.child.stdin.end();
report.exit2 = await b.waitExit(15000);
report.leftBehind = report.listAfterProcess2.length;

console.log(JSON.stringify(report, null, 2));
setTimeout(() => {
  try { rmSync(workspace, { recursive: true, force: true }); } catch {}
  try { rmSync(dshHome, { recursive: true, force: true }); } catch {}
  process.exit(0);
}, 1500);
