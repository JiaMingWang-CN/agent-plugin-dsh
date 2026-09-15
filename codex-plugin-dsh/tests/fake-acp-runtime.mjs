#!/usr/bin/env node
/**
 * A fake 'dsh --profile acp' runtime for the companion's end-to-end tests.
 *
 * It speaks the same newline-delimited JSON-RPC wire as the real ACP bridge and
 * persists sessions to FAKE_ACP_SESSION_STORE so a second process can exercise
 * session/resume. Behaviour is switched entirely through environment variables
 * so a test can reproduce a failure without a real model or a real dsh.
 *
 * FAKE_ACP_SESSION_STORE   JSON file holding { sessions: { <id>: { cwd, turns, model, effort } } }
 * FAKE_ACP_REPLY           assistant text (default: "echo:" + prompt text)
 * FAKE_ACP_REPORT_TURNS=1  append " turns=<n>" to the assistant text
 * FAKE_ACP_STOP_REASON     end_turn (default) | max_tokens | cancelled
 * FAKE_ACP_FAIL=1          reject session/prompt with a JSON-RPC error
 * FAKE_ACP_DELAY_MS        delay before a prompt settles
 * FAKE_ACP_IGNORE_EOF=1    do not exit when stdin ends (exercises the kill ladder)
 * FAKE_ACP_SPAWN_CHILD=1   start a long-lived child process and record its pid
 * FAKE_ACP_CHILD_PID_FILE  where to write that pid
 * FAKE_ACP_WRITE_FILE      write this file just before answering (simulates a write)
 * FAKE_ACP_TOOL_CALL=1     emit tool_call/tool_call_update before the answer
 * FAKE_ACP_ASK_PERMISSION=1 send session/request_permission and report the choice
 * FAKE_ACP_LOG             append one line per received method
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const env = process.env;
const storeFile = env.FAKE_ACP_SESSION_STORE || null;
const logFile = env.FAKE_ACP_LOG || null;

function log(line) {
  if (logFile) {
    fs.appendFileSync(logFile, line + "\n", "utf8");
  }
}

function loadStore() {
  if (!storeFile || !fs.existsSync(storeFile)) {
    return { sessions: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(storeFile, "utf8"));
  } catch (error) {
    return { sessions: {} };
  }
}

function saveStore(store) {
  if (storeFile) {
    fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + "\n", "utf8");
  }
}

let serial = 0;
function write(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method: method, params: params });
}

function configOptions(state) {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: JSON.stringify(["deepseek-official", state.model]),
      options: [
        {
          group: "deepseek-official",
          name: "DeepSeek",
          options: [
            { value: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]), name: "DeepSeek-V4-Flash" },
            { value: JSON.stringify(["deepseek-official", "deepseek-v4-pro"]), name: "DeepSeek-V4-Pro" }
          ]
        },
        {
          group: "volcengine",
          name: "volcengine",
          options: [
            { value: JSON.stringify(["volcengine", "glm-5.3"]), name: "glm-5.3" },
            // Shares its model id with deepseek-official on purpose: resolving a
            // bare model id has to cope with a genuine ambiguity.
            { value: JSON.stringify(["volcengine", "deepseek-v4-pro"]), name: "deepseek-v4-pro" }
          ]
        },
        {
          group: "zai",
          name: "zai",
          options: [{ value: JSON.stringify(["zai", "glm-5.3-flash"]), name: "GLM-5.3-Flash" }]
        }
      ]
    },
    {
      id: "reasoning_effort",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: state.effort,
      options: [
        { value: "off", name: "Off" },
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
        { value: "max", name: "Max" }
      ]
    }
  ];
}

let child = null;
function ensureChild() {
  if (env.FAKE_ACP_SPAWN_CHILD !== "1" || child !== null) {
    return;
  }
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  if (env.FAKE_ACP_CHILD_PID_FILE) {
    fs.writeFileSync(env.FAKE_ACP_CHILD_PID_FILE, String(child.pid), "utf8");
  }
}

const pendingPermission = new Map();
const sessions = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleRequest(id, method, params) {
  log(method);
  if (method === "initialize") {
    return {
      protocolVersion: 1,
      agentInfo: { name: "deepseek-harness-acp", version: "fake-0" },
      agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } },
      authMethods: []
    };
  }
  if (method === "session/new") {
    const store = loadStore();
    const existing = Object.keys(store.sessions).length > 0;
    if (existing && env.FAKE_ACP_REQUIRE_RESUME === "1") {
      throw { code: -32603, message: 'session "' + Object.keys(store.sessions)[0] + '" already exists' };
    }
    const sessionId = "fake-" + Date.now().toString(36) + "-" + (serial += 1);
    const state = {
      cwd: params.cwd,
      turns: [],
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      effort: "high"
    };
    store.sessions[sessionId] = state;
    saveStore(store);
    sessions.set(sessionId, state);
    return { sessionId: sessionId, configOptions: configOptions(state) };
  }
  if (method === "session/resume") {
    const store = loadStore();
    const state = store.sessions[params.sessionId];
    if (!state) {
      throw { code: -32602, message: "session is not resumable: " + params.sessionId };
    }
    if (state.cwd !== params.cwd) {
      throw { code: -32602, message: "session cwd does not match: " + params.cwd };
    }
    sessions.set(params.sessionId, state);
    return { configOptions: configOptions(state) };
  }
  if (method === "session/list") {
    const store = loadStore();
    return {
      sessions: Object.keys(store.sessions).map((sessionId) => ({
        sessionId: sessionId,
        cwd: store.sessions[sessionId].cwd
      }))
    };
  }
  if (method === "session/set_config_option") {
    const state = sessions.get(params.sessionId);
    if (!state) {
      throw { code: -32602, message: "unknown session: " + params.sessionId };
    }
    if (params.configId === "model") {
      const allowed = configOptions(state)[0].options.flatMap((group) => group.options.map((entry) => entry.value));
      if (!allowed.includes(params.value)) {
        throw { code: -32602, message: "unknown model option: " + params.value };
      }
      state.model = JSON.parse(params.value)[1];
      state.provider = JSON.parse(params.value)[0];
      log("model:" + params.value);
    } else if (params.configId === "reasoning_effort") {
      state.effort = params.value;
    } else {
      throw { code: -32602, message: "unknown configuration option: " + params.configId };
    }
    const store = loadStore();
    if (store.sessions[params.sessionId]) {
      store.sessions[params.sessionId] = state;
      saveStore(store);
    }
    return { configOptions: configOptions(state) };
  }
  if (method === "session/close") {
    const state = sessions.get(params.sessionId);
    if (state) {
      const store = loadStore();
      if (store.sessions[params.sessionId]) {
        store.sessions[params.sessionId] = state;
        saveStore(store);
      }
      sessions.delete(params.sessionId);
    }
    return {};
  }
  if (method === "session/prompt") {
    const sessionId = params.sessionId;
    const state = sessions.get(sessionId);
    if (!state) {
      throw { code: -32602, message: "unknown session: " + sessionId };
    }
    const promptText = (params.prompt || []).map((block) => block.text || "").join("");
    ensureChild();

    if (env.FAKE_ACP_WRITE_FILE) {
      fs.writeFileSync(env.FAKE_ACP_WRITE_FILE, "rewritten by the fake runtime\n", "utf8");
    }
    if (env.FAKE_ACP_DELAY_MS) {
      await sleep(Number(env.FAKE_ACP_DELAY_MS));
    }
    if (env.FAKE_ACP_FAIL === "1") {
      throw { code: -32603, message: "turn failed: fake runtime refused the turn" };
    }
    if (env.FAKE_ACP_TOOL_CALL === "1") {
      notify("session/update", {
        sessionId: sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "pwsh",
          kind: "other",
          status: "in_progress",
          rawInput: { command: "echo fake" }
        }
      });
      notify("session/update", {
        sessionId: sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "fake" } }]
        }
      });
    }

    let permission = "";
    if (env.FAKE_ACP_ASK_PERMISSION === "1") {
      permission = await new Promise((resolve) => {
        const requestId = "perm_" + (serial += 1);
        pendingPermission.set(requestId, resolve);
        write({
          jsonrpc: "2.0",
          id: requestId,
          method: "session/request_permission",
          params: {
            sessionId: sessionId,
            toolCall: { toolCallId: "call-1" },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject-once", name: "Reject", kind: "reject_once" }
            ]
          }
        });
      });
    }

    state.turns.push(promptText);
    const store = loadStore();
    store.sessions[sessionId] = state;
    saveStore(store);

    let reply = env.FAKE_ACP_REPLY === undefined ? "echo:" + promptText : env.FAKE_ACP_REPLY;
    if (env.FAKE_ACP_REPORT_TURNS === "1") {
      reply += " turns=" + state.turns.length;
    }
    if (permission) {
      reply += " perm=" + permission;
    }
    notify("session/update", {
      sessionId: sessionId,
      update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: reply } }
    });
    return { stopReason: env.FAKE_ACP_STOP_REASON || "end_turn" };
  }
  throw { code: -32601, message: "method not found: " + method };
}

async function onLine(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch (error) {
    return;
  }
  if (frame.method === "session/cancel") {
    log("session/cancel");
    return;
  }
  if (frame.id !== undefined && pendingPermission.has(frame.id)) {
    const resolve = pendingPermission.get(frame.id);
    pendingPermission.delete(frame.id);
    resolve((frame.result && frame.result.outcome && frame.result.outcome.optionId) || "");
    return;
  }
  if (frame.method === undefined) {
    return;
  }
  try {
    const result = await handleRequest(frame.id, frame.method, frame.params || {});
    write({ jsonrpc: "2.0", id: frame.id, result: result });
  } catch (error) {
    write({
      jsonrpc: "2.0",
      id: frame.id,
      error: { code: error.code === undefined ? -32603 : error.code, message: error.message || String(error) }
    });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      void onLine(line);
    }
  }
});

process.stdin.on("end", () => {
  if (env.FAKE_ACP_IGNORE_EOF === "1") {
    log("ignored-eof");
    return;
  }
  if (child !== null) {
    child.kill();
  }
  process.exit(0);
});
