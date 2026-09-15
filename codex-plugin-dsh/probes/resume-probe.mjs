#!/usr/bin/env node
/**
 * Phase 0.1 probe for codex-plugin-dsh.
 *
 * Question: after process A creates an SDK session and exits, does process B
 * asking for the SAME session id get the persisted history back, or a brand-new
 * session that merely reuses the name?
 *
 * Method (PLAN.md Phase 0.1 step 2): process A stores a random marker that is
 * never written to disk outside the session store, then exits. Process B sends
 * the same session id and only asks for the marker; it never restates it.
 *
 * Usage: node probes/resume-probe.mjs [--keep]
 *   DSH_CODEX_DSH_BIN  override the dsh executable (default: "dsh")
 *   PROBE_DSH_HOME     override the isolated DSH_HOME (default: temp dir seeded
 *                      with the real ~/.dsh credentials, removed at the end)
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const KEEP = process.argv.includes('--keep')
const DSH_BIN = process.env.DSH_CODEX_DSH_BIN ?? 'dsh'
const IS_WINDOWS = process.platform === 'win32'

/** One line-delimited JSON-RPC peer over a child process's stdio. */
class Runtime {
  constructor(child) {
    this.child = child
    this.pending = new Map()
    this.queue = []
    this.waiters = []
    this.stderr = ''
    this.exit = null
    this.buffer = ''
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
      if (frame.id !== undefined && frame.method === undefined) {
        const pending = this.pending.get(frame.id)
        if (!pending) continue
        this.pending.delete(frame.id)
        if (frame.error) pending.reject(new Error(JSON.stringify(frame.error)))
        else pending.resolve(frame.result)
        continue
      }
      if (frame.method !== undefined && frame.id === undefined) {
        const waiter = this.waiters.shift()
        if (waiter) waiter.resolve(frame)
        else this.queue.push(frame)
      }
    }
  }

  /** Send one request and await its result. */
  request(method, params) {
    const id = 'req_' + randomUUID().replaceAll('-', '')
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  /** Await the next notification. */
  next(timeoutMs) {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.exit !== null) return Promise.reject(new Error('runtime exited before the next notification'))
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('notification timeout')), timeoutMs)
      this.waiters.push({
        resolve: (value) => { clearTimeout(timer); resolvePromise(value) },
        reject: (error) => { clearTimeout(timer); rejectPromise(error) },
      })
    })
  }

  /** Run one prompt to the session's next idle, replicating the official SDK client algorithm. */
  async turn(sessionId, text, timeoutMs) {
    const events = []
    const messageId = (await this.request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    })).messageId
    let received = false
    for (;;) {
      const frame = await this.next(timeoutMs)
      if (!received) {
        if (frame.method !== 'session.event' || frame.params.sessionId !== sessionId) continue
        const inserted = frame.params.event?.data?.inserted
        if (frame.params.event?.type !== 'agent/inbox/spliced' || !Array.isArray(inserted)) continue
        if (!inserted.some((message) => message?.id === messageId)) continue
        received = true
      }
      if (frame.method === 'session.event' && frame.params.sessionId === sessionId) events.push(frame.params.event)
      if (frame.method === 'session.status' && frame.params.sessionId === sessionId && frame.params.status === 'idle') break
    }
    return { messageId, events, finalResponse: finalResponse(events), turnEnd: lastTurnEnd(events) }
  }

  /** Request protocol shutdown and wait for process exit. */
  async shutdown(timeoutMs) {
    try { await this.request('shutdown', {}) } catch { /* the exit edge below is authoritative */ }
    if (this.exit !== null) return this.exit
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise('timeout'), timeoutMs)
      this.child.on('exit', (code) => { clearTimeout(timer); resolvePromise(code) })
    })
  }
}

/** Concatenated text blocks of the last assistant/message event. */
function finalResponse(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    return (event.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  }
  return ''
}

/** The last turn/end reason, or null. */
function lastTurnEnd(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.type === 'turn/end') return events[index].data?.reason ?? null
  }
  return null
}

/** Start one runtime process. */
function startRuntime({ cwd, dshHome, profile }) {
  const args = ['--profile', profile]
  const child = spawn(DSH_BIN, args, {
    cwd,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: IS_WINDOWS,
    windowsHide: true,
  })
  return new Runtime(child)
}

/** The list of files under a directory, recursively (relative paths, size-tagged). */
function tree(root) {
  if (!existsSync(root)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(relative(root, full) + ' (' + statSync(full).size + 'B)')
    }
  }
  walk(root)
  return out.sort()
}

function relative(from, to) {
  const a = resolve(from).split(/[\\/]/)
  const b = resolve(to).split(/[\\/]/)
  let index = 0
  while (index < a.length && a[index] === b[index]) index++
  return b.slice(index).join('/')
}

async function main() {
  const dshHome = process.env.PROBE_DSH_HOME ?? mkdtempSync(join(tmpdir(), 'dsh-resume-probe-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-resume-probe-ws-'))
  const sessionId = 'probe-' + randomUUID().replaceAll('-', '').slice(0, 12)
  const marker = 'MG-' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()
  const report = { dshBin: DSH_BIN, dshHome, workspace, sessionId, marker, rounds: [], verdict: null }

  mkdirSync(dshHome, { recursive: true })
  const realCredentials = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(join(dshHome, '.credentials.yaml')) && existsSync(realCredentials)) {
    copyFileSync(realCredentials, join(dshHome, '.credentials.yaml'))
  }

  const runRound = async (label, prompt) => {
    const runtime = startRuntime({ cwd: workspace, dshHome, profile: process.env.DSH_PROFILE ?? 'sdk' })
    const round = { label, prompt, serverInfo: null, sessionId, finalResponse: '', turnEnd: null, eventTypes: [], sessionIds: [], exitCode: null, stderrTail: '' }
    try {
      const init = await runtime.request('initialize', {
        cwd: workspace,
        provider: 'deepseek-official',
        model: process.env.DSH_MODEL ?? 'deepseek-v4-flash',
      })
      round.serverInfo = init.serverInfo
      const result = await runtime.turn(sessionId, prompt, Number(process.env.PROBE_TURN_TIMEOUT_MS ?? 180000))
      round.finalResponse = result.finalResponse
      round.turnEnd = result.turnEnd
      round.eventTypes = result.events.map((event) => event.type)
      round.sessionIds = [...new Set(result.events.map((event) => String(event.sessionId ?? '')))]
    } catch (error) {
      round.error = String(error && error.message ? error.message : error)
    } finally {
      round.exitCode = await runtime.shutdown(10000)
      round.stderrTail = runtime.stderr.split('\n').filter(Boolean).slice(-8).join('\n')
    }
    report.rounds.push(round)
    return round
  }

  await runRound('A', 'Remember this token for later: ' + marker + '. Reply with just: ACK')
  const storeAfterA = tree(join(dshHome, 'sessions'))
  report.sessionStoreAfterA = storeAfterA

  await runRound('B', 'What was the exact token I asked you to remember a moment ago? Reply with the token alone, or NOTHING if you do not have it.')
  report.sessionStoreAfterB = tree(join(dshHome, 'sessions'))
  report.sessionStoreGrew = storeAfterA.length !== report.sessionStoreAfterB.length

  const roundB = report.rounds[1]
  const recalled = typeof roundB?.finalResponse === 'string' && roundB.finalResponse.includes(marker)
  report.verdict = recalled ? 'RESUMED' : 'NOT-RESUMED'
  report.markerEchoedInPromptB = String(roundB?.prompt ?? '').includes(marker)
  console.log(JSON.stringify(report, null, 2))

  if (!KEEP) {
    rmSync(workspace, { recursive: true, force: true })
    if (process.env.PROBE_DSH_HOME === undefined) rmSync(dshHome, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('probe failed:', error)
  process.exitCode = 1
})
