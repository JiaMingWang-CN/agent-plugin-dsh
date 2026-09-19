#!/usr/bin/env node
/** Dump every field of the raw model + reasoning_effort config options,
 *  to settle whether per-model reasoning-strength metadata exists on the wire. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const IS_WINDOWS = process.platform === 'win32'
const DSH_BIN = process.env.DSH_CODEX_DSH_BIN ?? 'dsh'
const cwd = process.cwd()

const child = spawn(DSH_BIN, ['--profile', process.env.DSH_PROFILE ?? 'acp'], {
  cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  shell: IS_WINDOWS, windowsHide: true,
})

const pending = new Map()
let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const nl = buffer.indexOf('\n')
    if (nl < 0) break
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let frame
    try { frame = JSON.parse(line) } catch { continue }
    if (frame.id !== undefined && frame.method === undefined) {
      const p = pending.get(frame.id)
      if (p) { pending.delete(frame.id); p(frame) }
    }
  }
})

function request(method, params) {
  const id = 'req_' + randomUUID().replaceAll('-', '')
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 30000)
    pending.set(id, (frame) => { clearTimeout(timer); resolve(frame) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

const out = {}
try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  const created = await request('session/new', { cwd, mcpServers: [] })
  const sessionId = created?.result?.sessionId
  const options = created?.result?.configOptions ?? []
  for (const option of options) {
    out[option.id] = option
  }
  if (sessionId) await request('session/close', { sessionId })
} catch (error) {
  out.error = String(error)
}
child.stdin.end()
setTimeout(() => process.exit(0), 800)
console.log(JSON.stringify(out, null, 2))
