#!/usr/bin/env node
// MCP in the real app: headless Electron + Playwright,
// with a stdio client on the connector (`electron . --mcp`, pipes on stdin/stdout, as Claude starts it).
// Not part of `npm test`.
//
//   node test/e2e/mcp-e2e.mjs
//
// Measures: the switch is OFF on a fresh data folder (no pipe, no data/mcp/endpoint.json, the connector
// answers the Hungarian error); ON: initialize -> tools/list -> tools/call status; switched OFF: the next
// call errors, endpoint.json gone; ON again, then locked: the same; after the round main.log holds no key;
// the renderer console and the net-guard log are clean.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { hu } from '../../app/renderer/i18n/hu.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-MCP'
// the connector's answer goes to Claude: Hungarian in both interface languages
const UNAVAILABLE_TEXT = hu.mcpUnavailable
const sleep = ms => new Promise(r => setTimeout(r, ms))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-mcp-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') }).save({
    ...newAccountDefaults('pop3'), name: 'MCP-teszt', email: 'm@example.invalid', in_host: '127.0.0.1', in_port: 1, in_security: 'none', in_user: 'm', in_password: 'nem-valodi',
    smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none',
  })
  db.close()
}
seedLanguage(dataDir)
const endpoint = path.join(dataDir, 'mcp', 'endpoint.json')
const mcpDirEntries = () => (fs.existsSync(path.join(dataDir, 'mcp')) ? fs.readdirSync(path.join(dataDir, 'mcp')) : [])

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

/** The connector as Claude starts it; ask(msg) waits for the answer with that id. */
function connector() {
  const proc = spawn(electronBin, [repo, '--mcp', '--ozone-platform=headless'], { env: { ...process.env, SHADOWMAIL_DATA: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  const waiting = new Map()
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', d => {
    out += d
    let i
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i).trim()
      out = out.slice(i + 1)
      if (!line) continue
      const m = JSON.parse(line)
      // 0.11.1: the shape of every tools/call result the connector gave back
      if (m.result && Array.isArray(m.result.content)) (globalThis.__callShapes ??= []).push(Object.keys(m.result).sort().join(','))
      waiting.get(m.id)?.(m)
      waiting.delete(m.id)
    }
  })
  proc.stderr.resume()
  const exited = new Promise(r => proc.on('exit', code => r(code)))
  const ask = (message, timeout = 10_000) =>
    new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), timeout)
      waiting.set(message.id, m => (clearTimeout(timer), resolve(m)))
      proc.stdin.write(`${JSON.stringify(message)}\n`)
    })
  const notify = message => proc.stdin.write(`${JSON.stringify(message)}\n`)
  return { ask, notify, exited, close: () => proc.stdin.end() }
}
let nextId = 1
const req = (method, params) => ({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) })
const unavailable = m => m && m.error && m.error.code === -32000 && m.error.message === UNAVAILABLE_TEXT

const consoleProblems = []
const keys = []
let app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
const c = connector()
try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleProblems.push(m.text()))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.app-header').waitFor({ timeout: 20_000 })
  const status = () => page.evaluate(() => window.shadowMail.mcp.status())
  const setEnabled = on => page.evaluate(v => window.shadowMail.mcp.setEnabled(v), on)

  // 1. fresh data folder: OFF, no pipe, no endpoint.json; the connector answers the error
  const s0 = await status()
  const off0 = await c.ask(req('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-e2e', version: '1' } }))
  check('fresh data folder: the switch is OFF, no pipe, no endpoint.json', s0.ok && s0.enabled === false && s0.running === false && !fs.existsSync(endpoint) && mcpDirEntries().length === 0, JSON.stringify({ s0, mcp: mcpDirEntries() }))
  check('OFF: the connector answers every request with the Hungarian error', unavailable(off0), JSON.stringify(off0))

  // 2. ON: initialize -> notifications/initialized -> tools/list -> tools/call status
  const s1 = await setEnabled(true)
  keys.push(JSON.parse(fs.readFileSync(endpoint, 'utf8')).key)
  const init = await c.ask(req('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-e2e', version: '1' } }))
  c.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const list = await c.ask(req('tools/list'))
  const call = await c.ask(req('tools/call', { name: 'status', arguments: {} }))
  const appVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version
  check('ON: endpoint.json, running; initialize answers protocol 2025-11-25 and the server name', s1.enabled && s1.running && init && init.result && init.result.protocolVersion === '2025-11-25' && init.result.serverInfo.name === 'shadowmail', JSON.stringify(init))
  check('tools/list: the 26 tools (read, write, confirmed, contacts, open, show); tools/call status: the version and 1 account', list && list.result.tools.map(t => t.name).join() === 'status,list_accounts_folders,search_contacts,open_message,list_messages,search_messages,show_search,read_message,get_thread,search_server,mark_messages,move_messages,trash_messages,create_folder,rename_folder,send_message,send_draft,delete_folder,update_account,delete_account,confirmation_status,create_draft,create_reply_draft,prepare_account,test_account,sync_account' && call && call.result && call.result._meta['shadowmail/data'].appVersion === appVersion && call.result._meta['shadowmail/data'].accounts === 1, JSON.stringify(call && call.result))
  const s1c = await status()
  check('the app counts the connector as 1 connection', s1c.connections === 1, JSON.stringify(s1c))

  // 3. switched OFF: the next call errors, endpoint.json gone
  await setEnabled(false)
  await sleep(200)
  const afterOff = await c.ask(req('tools/call', { name: 'status' }))
  check('switched OFF: the next call gets the error, endpoint.json is gone, no pipe', unavailable(afterOff) && !fs.existsSync(endpoint) && mcpDirEntries().length === 0, JSON.stringify({ afterOff, mcp: mcpDirEntries() }))

  // 4. ON again (a new key), then locked: the error again, endpoint.json gone
  await setEnabled(true)
  keys.push(JSON.parse(fs.readFileSync(endpoint, 'utf8')).key)
  const back = await c.ask(req('ping'))
  check('ON again: a new key, the connector reconnects by itself', back && back.result && keys[0] !== keys[1], JSON.stringify(back))
  await page.getByRole('button', { name: t.vaultLockButton, exact: true }).click()
  await page.locator('#vault-unlock').waitFor()
  await sleep(200)
  const locked = await c.ask(req('tools/call', { name: 'status' }))
  check('locked: the next call gets the error, endpoint.json is gone', unavailable(locked) && !fs.existsSync(endpoint), JSON.stringify(locked))

  // 5. unlocked again: the switch is still ON (same process), a third key
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.app-header').waitFor({ timeout: 20_000 })
  for (let i = 0; i < 40 && !fs.existsSync(endpoint); i++) await sleep(100)
  keys.push(JSON.parse(fs.readFileSync(endpoint, 'utf8')).key)
  const unlockedAgain = await c.ask(req('ping'))
  check('unlocked again: the pipe opens with a new key, the connector works', unlockedAgain && unlockedAgain.result && new Set(keys).size === 3, `${new Set(keys).size} different keys`)

  // 6. a restart: the switch (in the encrypted settings, schema v4) is still ON after the unlock
  await app.close()
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page2 = await app.firstWindow()
  page2.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleProblems.push(m.text()))
  await page2.setViewportSize({ width: 1280, height: 800 })
  const lockedStart = fs.existsSync(endpoint)
  await page2.locator('#vault-unlock').fill(MASTER)
  await page2.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page2.locator('.app-header').waitFor({ timeout: 20_000 })
  for (let i = 0; i < 40 && !fs.existsSync(endpoint); i++) await sleep(100)
  const s6 = await page2.evaluate(() => window.shadowMail.mcp.status())
  keys.push(JSON.parse(fs.readFileSync(endpoint, 'utf8')).key)
  const afterRestart = await c.ask(req('ping'))
  check('restart: no endpoint.json while locked; after the unlock the switch is still ON, the connector works again', !lockedStart && s6.enabled && s6.running && afterRestart && afterRestart.result, JSON.stringify({ lockedStart, s6 }))
  await page2.evaluate(() => window.shadowMail.mcp.setEnabled(false))
} catch (err) {
  check('run', false, err.stack)
} finally {
  c.close()
  const code = await Promise.race([c.exited, sleep(10_000).then(() => 'running')])
  check('the connector quits when stdin closes', code === 0, String(code))
  await app.close().catch(() => {})
}
const logFile = path.join(dataDir, 'electron', 'logs', 'main.log')
const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
check('main.log: no key of the round, mcp lines without content', keys.length > 0 && keys.every(k => !log.includes(k)) && /mcp tool=status result=ok items=1 ms=\d+/.test(log), `${keys.length} keys checked; ${log.split('\n').filter(l => l.includes('mcp')).length} mcp lines`)
const guard = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
check('renderer console clean, net-guard log empty', consoleProblems.length === 0 && (!fs.existsSync(guard) || fs.readFileSync(guard, 'utf8').trim() === ''), consoleProblems.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
{
  // 0.11.1: the model must get the text, so no structuredContent next to it; our data is in _meta
  const shapes = globalThis.__callShapes || []
  check('0.11.1: every tools/call result is exactly { content, _meta, isError }, no structuredContent', shapes.length > 0 && shapes.every(k => k === '_meta,content,isError'), `${shapes.length} results: ${[...new Set(shapes)].join(' | ')}`)
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
