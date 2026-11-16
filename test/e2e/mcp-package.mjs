#!/usr/bin/env node
// MCP ON THE PACKAGE, Windows only: the mcp-e2e round with the packaged exe, driven over
// CDP (the fuses forbid --inspect), plus the first measurements (startup, footprint). Run with the Windows Node
// in the build folder:
//
//   node test\e2e\mcp-package.mjs --zip <ShadowMail-x.y.z-win-x64.zip> --work <empty folder>
//
// PW=<path of a playwright package> (default: the repo's playwright-core devDependency). The connector is spawned as Claude does (child_process.spawn, pipes on all three).
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'

const { values } = parseArgs({ options: { zip: { type: 'string' }, work: { type: 'string' } } })
if (!values.zip || !values.work || process.platform !== 'win32') {
  console.error('usage (Windows): mcp-package.mjs --zip <zip> --work <empty folder>')
  process.exit(2)
}
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PW || 'playwright-core')
const MASTER = 'MCP-csomag-mesterjelszo'
const UNAVAILABLE_TEXT = 'A ShadowMail nem fut, zárolva van, vagy a Claude-hozzáférés ki van kapcsolva.'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const info = (name, data) => console.log(`INFO ${name}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
setTimeout(() => {
  console.log('FAIL watchdog: more than 6 minutes')
  process.exit(1)
}, 360_000).unref()

const work = path.resolve(values.work)
fs.rmSync(work, { recursive: true, force: true })
const appDir = path.join(work, 'app')
fs.mkdirSync(appDir, { recursive: true })
execFileSync('tar', ['-xf', path.resolve(values.zip), '-C', appDir])
const exe = path.join(appDir, 'ShadowMail.exe')
const dataDir = path.join(appDir, 'data')
{
  fs.mkdirSync(dataDir, { recursive: true })
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') }).save({
    ...newAccountDefaults('pop3'), name: 'MCP-csomag', email: 'm@example.invalid', in_host: '127.0.0.1', in_port: 1, in_security: 'none', in_user: 'm', in_password: 'nem-valodi',
    smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none',
  })
  db.close()
}
const endpoint = path.join(dataDir, 'mcp', 'endpoint.json')
const cleanEnv = () => {
  const env = { ...process.env }
  delete env.SHADOWMAIL_DATA
  delete env.SHADOWMAIL_SMOKE
  return env
}

function connector() {
  const t0 = performance.now()
  const proc = spawn(exe, ['--mcp'], { cwd: appDir, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  let raw = ''
  let buf = ''
  let firstAt = null
  const waiting = new Map()
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', d => {
    raw += d
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      if (firstAt === null) firstAt = performance.now() - t0
      const m = JSON.parse(line)
      // 0.11.1: the shape of every tools/call result the connector gave back
      if (m.result && Array.isArray(m.result.content)) (globalThis.__callShapes ??= []).push(Object.keys(m.result).sort().join(','))
      waiting.get(m.id)?.(m)
      waiting.delete(m.id)
    }
  })
  proc.stderr.resume()
  const exited = new Promise(r => proc.on('exit', code => r(code)))
  let id = 0
  const ask = (method, params, timeout = 15_000) =>
    new Promise(resolve => {
      const myId = ++id
      const timer = setTimeout(() => resolve(null), timeout)
      waiting.set(myId, m => (clearTimeout(timer), resolve(m)))
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, ...(params ? { params } : {}) })}\n`)
    })
  const notify = method => proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  return { proc, ask, notify, exited, raw: () => raw, firstMs: () => firstAt, close: () => proc.stdin.end() }
}
const unavailable = m => m && m.error && m.error.code === -32000 && m.error.message === UNAVAILABLE_TEXT
const INIT = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-package', version: '1' } }

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    let st = null
    try {
      st = fs.statSync(p)
    } catch {
      // vanished
    }
    out.push(`${p}|${e.isDirectory() ? 'dir' : st ? st.size : '?'}|${st ? Math.round(st.mtimeMs) : '?'}`)
    if (e.isDirectory()) walk(p, out)
  }
  return out
}
function footprint() {
  const top = []
  const ours = []
  for (const root of [process.env.APPDATA, process.env.LOCALAPPDATA, process.env.TEMP]) {
    for (const name of fs.readdirSync(root)) {
      top.push(path.join(root, name))
      if (/shadowmail|electron/i.test(name)) ours.push(...walk(path.join(root, name), [`${path.join(root, name)}|top`]))
    }
  }
  return { top: top.sort(), ours: ours.sort() }
}

const before = footprint()
info('footprint before: ShadowMail/Electron entries', before.ours.length ? before.ours : 'none')

// 1. no app: the Hungarian error over the Windows pipes (accents intact), no endpoint.json
{
  const c = connector()
  const answer = await c.ask('initialize', INIT)
  c.close()
  const code = await Promise.race([c.exited, sleep(10_000).then(() => 'running')])
  check('no app: the connector answers the Hungarian error (UTF-8 intact), quits on stdin close', unavailable(answer) && code === 0, JSON.stringify({ answer, code }))
  info('stdout starts with', JSON.stringify(c.raw().slice(0, 4)))
}

const keys = []
const logFile = path.join(dataDir, 'electron', 'logs', 'main.log')
const port = 9700 + Math.floor(Math.random() * 200)
const app = spawn(exe, [`--remote-debugging-port=${port}`], { cwd: appDir, env: cleanEnv(), stdio: 'ignore' })
let browser = null
try {
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch {
      await sleep(500)
    }
  }
  const context = browser.contexts()[0]
  let page = context.pages().find(p => p.url().includes('index.html'))
  for (let i = 0; i < 40 && !page; i++) (await sleep(250), (page = context.pages().find(p => p.url().includes('index.html'))))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: 'Feloldás', exact: true }).click()
  await page.locator('.app-header').waitFor({ timeout: 20_000 })
  const status = () => page.evaluate(() => window.shadowMail.mcp.status())
  const setEnabled = on => page.evaluate(v => window.shadowMail.mcp.setEnabled(v), on)

  // 2. fresh data folder: OFF
  const s0 = await status()
  check('fresh data folder: OFF, no pipe, no endpoint.json', s0.ok && !s0.enabled && !s0.running && !fs.existsSync(endpoint), JSON.stringify(s0))

  // 3. ON: the round, and the startup of 5 connectors against the running app
  await setEnabled(true)
  const ep = JSON.parse(fs.readFileSync(endpoint, 'utf8'))
  keys.push(ep.key)
  check('ON: endpoint.json names a Windows named pipe and a 256-bit key', /^\\\\\.\\pipe\\shadowmail-[0-9a-f]{32}$/.test(ep.pipe) && /^[0-9a-f]{64}$/.test(ep.key), ep.pipe)
  const starts = []
  for (let i = 0; i < 5; i++) {
    const c = connector()
    const init = await c.ask('initialize', INIT)
    starts.push({ ok: Boolean(init && init.result && init.result.protocolVersion === '2025-11-25'), firstMs: Math.round(c.firstMs() ?? -1) })
    c.close()
    await Promise.race([c.exited, sleep(10_000)])
  }
  const firsts = starts.map(s => s.firstMs)
  info('startup spawn -> initialize answered by the app (ms)', { each: firsts, avg: Math.round(firsts.reduce((a, b) => a + b, 0) / 5), max: Math.max(...firsts) })
  check('5 connectors: each one initialized against the running app', starts.every(s => s.ok), JSON.stringify(starts))

  const c = connector()
  const init = await c.ask('initialize', INIT)
  c.notify('notifications/initialized')
  const list = await c.ask('tools/list')
  const call = await c.ask('tools/call', { name: 'status', arguments: {} })
  let pings = 0
  for (let i = 0; i < 20; i++) if ((await c.ask('ping'))?.result) pings++
  check('initialize -> tools/list -> tools/call status; 20 pings', init?.result?.serverInfo?.name === 'shadowmail' && list?.result?.tools?.map(t => t.name).join() === 'status,list_accounts_folders,search_contacts,open_message,list_messages,search_messages,show_search,read_message,get_thread,search_server,mark_messages,move_messages,trash_messages,create_folder,rename_folder,send_message,send_draft,delete_folder,update_account,delete_account,confirmation_status,create_draft,create_reply_draft,prepare_account,test_account,sync_account' && call?.result?._meta?.['shadowmail/data']?.accounts === 1 && pings === 20, JSON.stringify({ status: call?.result?._meta?.['shadowmail/data'], pings }))

  // 4. switched OFF, then ON and locked
  await setEnabled(false)
  await sleep(300)
  const off = await c.ask('ping')
  check('switched OFF: the next call errors, endpoint.json gone', unavailable(off) && !fs.existsSync(endpoint), JSON.stringify(off))
  await setEnabled(true)
  keys.push(JSON.parse(fs.readFileSync(endpoint, 'utf8')).key)
  const back = await c.ask('ping')
  await page.getByRole('button', { name: 'Zárolás', exact: true }).click()
  await page.locator('#vault-unlock').waitFor()
  await sleep(300)
  const locked = await c.ask('tools/call', { name: 'status' })
  check('ON again (new key) works; locked: the next call errors, endpoint.json gone', back?.result && keys[0] !== keys[1] && unavailable(locked) && !fs.existsSync(endpoint), JSON.stringify(locked))
  c.close()
  await Promise.race([c.exited, sleep(10_000)])
  await page.evaluate(() => window.close()).catch(() => {})
} catch (err) {
  check('run', false, err.stack)
} finally {
  for (let i = 0; i < 40 && app.exitCode === null; i++) await sleep(250)
  if (app.exitCode === null) app.kill()
  await browser?.close().catch(() => {})
}
await sleep(1500)
const after = footprint()
const added = after.ours.filter(x => !before.ours.includes(x))
const removed = before.ours.filter(x => !after.ours.includes(x))
check('footprint: the ShadowMail/Electron entries of %APPDATA%, %LOCALAPPDATA%, %TEMP% are the same before and after', added.length === 0 && removed.length === 0, JSON.stringify({ added, removed }))
info('new top-level entries in the three roots (any program)', after.top.filter(x => !before.top.includes(x)))
const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
check('main.log: no key of the round; mcp lines without content', keys.length === 2 && keys.every(k => !log.includes(k)) && /mcp tool=status result=ok items=1 ms=\d+/.test(log), `${log.split('\n').filter(l => l.includes('mcp')).length} mcp lines`)
check('endpoint.json gone after the quit', !fs.existsSync(endpoint))
{
  // 0.11.1: the model must get the text, so no structuredContent next to it; our data is in _meta
  const shapes = globalThis.__callShapes || []
  check('0.11.1: every tools/call result is exactly { content, _meta, isError }, no structuredContent', shapes.length > 0 && shapes.every(k => k === '_meta,content,isError'), `${shapes.length} results: ${[...new Set(shapes)].join(' | ')}`)
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
