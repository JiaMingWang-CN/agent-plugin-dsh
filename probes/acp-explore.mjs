#!/usr/bin/env node
/** Throwaway ACP handshake explorer: discover the exact wire shapes. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const IS_WINDOWS = process.platform === 'win32'
const DSH_BIN = process.env.DSH_CODEX_DSH_BIN ?? 'dsh'
const cwd = process.cwd()

const child = spawn(DSH_BIN, ['--profile', process.env.DSH_PROFILE ?? 'acp'], {
  cwd,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: IS_WINDOWS,
  windowsHide: true,
})

const pending = new Map()
const frames = []
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
    try { frame = JSON.parse(line) } catch { frames.push({ raw: line }); continue }
    frames.push(frame)
    if (frame.id !== undefined && frame.method === undefined) {
      const p = pending.get(frame.id)
      if (p) { pending.delete(frame.id); p(frame) }
    }
  }
})
let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (c) => { stderr += c })

function request(method, params) {
  const id = 'req_' + randomUUID().replaceAll('-', '')
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 30000)
    pending.set(id, (frame) => { clearTimeout(timer); resolve(frame) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

const out = { frames: [] }
try {
  out.init = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  out.newSession = await request('session/new', { cwd, mcpServers: [] })
  if (out.newSession?.result?.sessionId) {
    out.list = await request('session/list', {})
    out.setOption = await request('session/set_config_option', { sessionId: out.newSession.result.sessionId, configId: 'model', value: 'deepseek-v4-flash' })
    out.close = await request('session/close', { sessionId: out.newSession.result.sessionId })
  }
} catch (error) {
  out.error = String(error)
}
out.stderr = stderr.slice(-2000)
out.notifications = frames.filter((f) => f.method !== undefined && f.id === undefined).map((f) => f.method)
child.kill()
setTimeout(() => process.exit(0), 500)
console.log(JSON.stringify(out, null, 2))
