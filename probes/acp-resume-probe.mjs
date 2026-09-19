#!/usr/bin/env node
/**
 * Phase 0.1 probe for agent-plugin-dsh, ACP transport.
 *
 * Question: does the ACP profile restore a persisted session's context in a
 * LATER process via session/resume, and does a prompt against it recall a
 * marker that was only ever sent in the first process?
 *
 * Round A: session/new -> prompt(marker) -> session/close -> process exits.
 * Round B: NEW process -> session/resume(same id) -> prompt("what was the
 *          token?") without restating it -> session/close.
 *
 * Usage: node probes/acp-resume-probe.mjs [--keep]
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const KEEP = process.argv.includes('--keep')
const IS_WINDOWS = process.platform === 'win32'
const DSH_BIN = process.env.DSH_CODEX_DSH_BIN ?? 'dsh'
const PROFILE = process.env.DSH_PROFILE ?? 'acp'
const PROMPT_TIMEOUT_MS = Number(process.env.PROBE_PROMPT_TIMEOUT_MS ?? 300000)

class AcpRuntime {
  constructor(child) {
    this.child = child
    this.pending = new Map()
    this.notifications = []
    this.waiters = []
    this.stderr = ''
    this.exit = null
    this.buffer = ''
    this.updates = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { this.stderr += chunk })
    child.on('exit', (code) => {
      this.exit = code
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('runtime exited'))
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
      if (frame.method === 'session/update') {
        this.updates.push(frame.params)
        this.#deliver(frame)
        continue
      }
      if (frame.method !== undefined) {
        // Agent-to-client request (session/request_permission): answer inline.
        this.#answerClientRequest(frame)
        continue
      }
      const pending = this.pending.get(frame.id)
      if (!pending) continue
      this.pending.delete(frame.id)
      pending(frame)
    }
  }

  #deliver(frame) {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(frame)
    else this.notifications.push(frame)
  }

  #answerClientRequest(frame) {
    const reply = frame.method === 'session/request_permission'
      ? { outcome: { outcome: 'selected', optionId: 'allow-once' } }
      : {}
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: reply }) + '\n')
  }

  request(method, params) {
    const id = 'req_' + randomUUID().replaceAll('-', '')
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new Error(method + ' timed out'))
      }, PROMPT_TIMEOUT_MS)
      this.pending.set(id, (frame) => {
        clearTimeout(timer)
        if (frame.error) rejectPromise(new Error(method + ' -> ' + JSON.stringify(frame.error)))
        else resolvePromise(frame.result)
      })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  nextNotification(timeoutMs) {
    const queued = this.notifications.shift()
    if (queued) return Promise.resolve(queued)
    if (this.exit !== null) return Promise.reject(new Error('runtime exited'))
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('notification timeout')), timeoutMs)
      this.waiters.push({
        resolve: (value) => { clearTimeout(timer); resolvePromise(value) },
        reject: (error) => { clearTimeout(timer); rejectPromise(error) },
      })
    })
  }

  /** Prompt and wait for the correlated response, keeping every streamed update. */
  async prompt(sessionId, text) {
    const before = this.updates.length
    const started = Date.now()
    const result = await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
    return { result, updates: this.updates.slice(before), elapsedMs: Date.now() - started }
  }

  async close() {
    try { await this.request('session/close', { sessionId: this.sessionId }) } catch { /* best effort */ }
    if (this.exit !== null) return this.exit
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => { this.child.kill(); resolvePromise('timeout') }, 15000)
      this.child.on('exit', (code) => { clearTimeout(timer); resolvePromise(code) })
    })
  }
}

function assistantText(updates) {
  return updates
    .filter((frame) => frame.update?.sessionUpdate === 'agent_message_chunk')
    .map((frame) => frame.update.content?.text ?? '')
    .join('')
}

function updateKinds(updates) {
  return [...new Set(updates.map((frame) => frame.update?.sessionUpdate))]
}

function tree(root) {
  if (!existsSync(root)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full.slice(root.length + 1) + ' (' + statSync(full).size + 'B)')
    }
  }
  walk(root)
  return out.sort()
}

function startRuntime({ cwd, dshHome }) {
  const child = spawn(DSH_BIN, ['--profile', PROFILE], {
    cwd,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: IS_WINDOWS,
    windowsHide: true,
  })
  return new AcpRuntime(child)
}

async function main() {
  const dshHome = process.env.PROBE_DSH_HOME ?? mkdtempSync(join(tmpdir(), 'dsh-acp-probe-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-acp-probe-ws-'))
  const marker = 'MG-' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()
  const report = { dshBin: DSH_BIN, profile: PROFILE, dshHome, workspace, marker, rounds: [], verdict: null }

  mkdirSync(dshHome, { recursive: true })
  const realCredentials = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(join(dshHome, '.credentials.yaml')) && existsSync(realCredentials)) {
    copyFileSync(realCredentials, join(dshHome, '.credentials.yaml'))
  }

  // ---- Round A: create + remember, then exit the process entirely. ----
  const a = startRuntime({ cwd: workspace, dshHome })
  const roundA = { label: 'A' }
  try {
    roundA.initialize = await a.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    const created = await a.request('session/new', { cwd: workspace, mcpServers: [] })
    roundA.sessionId = created.sessionId
    roundA.configOptions = (created.configOptions ?? []).map((option) => option.id)
    a.sessionId = created.sessionId
    const prompted = await a.prompt(created.sessionId, 'Remember this token for later: ' + marker + '. Reply with just: ACK')
    roundA.stopReason = prompted.result.stopReason
    roundA.assistantText = assistantText(prompted.updates)
    roundA.updateKinds = updateKinds(prompted.updates)
    roundA.elapsedMs = prompted.elapsedMs
  } catch (error) {
    roundA.error = String(error && error.message || error)
  } finally {
    roundA.exitCode = await a.close()
    roundA.stderrTail = a.stderr.split('\n').filter(Boolean).slice(-6).join('\n')
  }
  report.rounds.push(roundA)
  report.sessionStoreAfterA = tree(join(dshHome, 'sessions'))

  // ---- Round B: brand-new process, resume the same session id. ----
  const b = startRuntime({ cwd: workspace, dshHome })
  const roundB = { label: 'B' }
  try {
    await b.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    const resumed = await b.request('session/resume', { sessionId: roundA.sessionId, cwd: workspace, mcpServers: [] })
    roundB.resumeResult = resumed
    b.sessionId = roundA.sessionId
    const prompted = await b.prompt(roundA.sessionId, 'What was the exact token I asked you to remember a moment ago? Reply with the token alone, or NOTHING if you do not have it.')
    roundB.stopReason = prompted.result.stopReason
    roundB.assistantText = assistantText(prompted.updates)
    roundB.updateKinds = updateKinds(prompted.updates)
    roundB.elapsedMs = prompted.elapsedMs
  } catch (error) {
    roundB.error = String(error && error.message || error)
  } finally {
    roundB.exitCode = await b.close()
    roundB.stderrTail = b.stderr.split('\n').filter(Boolean).slice(-6).join('\n')
  }
  report.rounds.push(roundB)
  report.sessionStoreAfterB = tree(join(dshHome, 'sessions'))
  report.markerEchoedInPromptB = String(roundB.assistantText ?? '').length > 0

  const recalled = typeof roundB.assistantText === 'string' && roundB.assistantText.includes(marker)
  report.recalledMarker = recalled
  report.verdict = recalled ? 'RESUMED' : 'NOT-RESUMED'
  console.log(JSON.stringify(report, null, 2))

  if (!KEEP) {
    rmSync(workspace, { recursive: true, force: true })
    if (process.env.PROBE_DSH_HOME === undefined) rmSync(dshHome, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error('probe failed:', error); process.exitCode = 1 })
