#!/usr/bin/env node
/**
 * Phase 0.1 companion probe: ACP lifecycle semantics the plugin depends on.
 *  1. Does the runtime exit on stdin EOF after session/close (bounded shutdown)?
 *  2. Does session/cancel settle an in-flight prompt as stopReason "cancelled"?
 *  3. What do tool-call updates look like on the wire (progress rendering)?
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'
const DSH_BIN = process.env.DSH_CODEX_DSH_BIN ?? 'dsh'

class Runtime {
  constructor(child) {
    this.child = child
    this.pending = new Map()
    this.updates = []
    this.stderr = ''
    this.exit = null
    this.buffer = ''
    this.exitWaiters = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { this.stderr += chunk })
    child.on('exit', (code) => {
      this.exit = code
      for (const waiter of this.exitWaiters.splice(0)) waiter(code)
    })
  }
  #onData(chunk) {
    this.buffer += chunk
    for (;;) {
      const nl = this.buffer.indexOf('\n')
      if (nl < 0) break
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let frame
      try { frame = JSON.parse(line) } catch { continue }
      if (frame.method === 'session/update') { this.updates.push(frame.params); continue }
      if (frame.method !== undefined) {
        const result = frame.method === 'session/request_permission'
          ? { outcome: { outcome: 'selected', optionId: 'allow-once' } }
          : {}
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n')
        continue
      }
      const pending = this.pending.get(frame.id)
      if (!pending) continue
      this.pending.delete(frame.id)
      pending(frame)
    }
  }
  request(method, params) {
    const id = 'req_' + randomUUID().replaceAll('-', '')
    return new Promise((resolvePromise) => {
      this.pending.set(id, (frame) => resolvePromise(frame.error ? { error: frame.error } : frame.result))
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  waitExit(ms) {
    if (this.exit !== null) return Promise.resolve(this.exit)
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise('timeout'), ms)
      this.exitWaiters.push((code) => { clearTimeout(timer); resolvePromise(code) })
    })
  }
}

function start(cwd, dshHome, env) {
  return new Runtime(spawn(DSH_BIN, ['--profile', 'acp'], {
    cwd, env: { ...process.env, DSH_HOME: dshHome, ...env }, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WINDOWS, windowsHide: true,
  }))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-acp-life-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-acp-life-ws-'))
  mkdirSync(join(dshHome), { recursive: true })
  const creds = join(homedir(), '.dsh', '.credentials.yaml')
  if (existsSync(creds)) copyFileSync(creds, join(dshHome, '.credentials.yaml'))
  const report = {}

  // ---- 1 + 3: tool updates, then EOF shutdown ----
  const a = start(workspace, dshHome, {})
  await a.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  const created = await a.request('session/new', { cwd: workspace, mcpServers: [] })
  report.turn = await a.request('session/prompt', {
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'Use your shell tool to run exactly: echo hello-from-tool   Then reply with only the tool output.' }],
  })
  report.updateKinds = [...new Set(a.updates.map((u) => u.update?.sessionUpdate))]
  report.toolCallSample = a.updates.find((u) => u.update?.sessionUpdate === 'tool_call')?.update ?? null
  report.toolResultSample = a.updates.find((u) => u.update?.sessionUpdate === 'tool_call_update')?.update ?? null
  report.assistantText = a.updates.filter((u) => u.update?.sessionUpdate === 'agent_message_chunk').map((u) => u.update.content?.text ?? '').join('')
  await a.request('session/close', { sessionId: created.sessionId })
  a.child.stdin.end()
  report.exitAfterStdinEof = await a.waitExit(20000)
  if (report.exitAfterStdinEof === 'timeout') a.child.kill()

  // ---- 2: cancel an in-flight prompt ----
  const b = start(workspace, dshHome, {})
  await b.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  const created2 = await b.request('session/new', { cwd: workspace, mcpServers: [] })
  const inflight = b.request('session/prompt', {
    sessionId: created2.sessionId,
    prompt: [{ type: 'text', text: 'Write a detailed 3000-word essay about the history of computing. Do not use any tools.' }],
  })
  await sleep(1500)
  b.notify('session/cancel', { sessionId: created2.sessionId })
  const cancelled = await Promise.race([inflight, sleep(30000).then(() => ({ error: { message: 'cancel race timeout' } }))])
  report.cancelOutcome = cancelled
  report.cancelAssistantText = b.updates.filter((u) => u.update?.sessionUpdate === 'agent_message_chunk').map((u) => u.update.content?.text ?? '').join('').slice(0, 120)
  await b.request('session/close', { sessionId: created2.sessionId })
  b.child.stdin.end()
  report.exitAfterCancelEof = await b.waitExit(20000)
  if (report.exitAfterCancelEof === 'timeout') b.child.kill()
  report.stderrTail = (a.stderr + b.stderr).split('\n').filter(Boolean).slice(-6).join('\n')

  console.log(JSON.stringify(report, null, 2))
  setTimeout(() => {
    try { rmSync(workspace, { recursive: true, force: true }) } catch {}
    try { rmSync(dshHome, { recursive: true, force: true }) } catch {}
    process.exit(0)
  }, 1500)
}

main().catch((error) => { console.error('probe failed:', error); process.exitCode = 1 })
