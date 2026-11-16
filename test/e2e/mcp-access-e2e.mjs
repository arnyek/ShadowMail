#!/usr/bin/env node
// MCP in the real app: the "Claude-hozzáférés" settings page. A POP3 account on the fake
// POP3 server, the connector as Claude would start it. Not part of `npm test`.
//
//   node test/e2e/mcp-access-e2e.mjs [--shots docs/ui]
//
// Measures: OFF by default ("Kikapcsolva", no endpoint.json); the switch ON -> "Várakozik", one connector ->
// "Kapcsolódva: 1"; the Másolás buttons put exactly the shown text on the clipboard, with the program's absolute path;
// a search_messages call shows up in "Legutóbbi Claude-hívások" (tool, result, count) without its search word; a
// confirmation (rejected in the Modal) shows its result; OFF -> "Kikapcsolva", the connection drops, no endpoint.json;
// after a restart the list is empty; no console problem, the net-guard log is empty. With --shots: the page switched off and
// on (1280x800, test data).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
// the program's path as the process sees it (process.execPath is resolved: a symlinked node_modules shows its real place)
const exePath = fs.realpathSync(electronBin)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null
const MASTER = 'Teszt-mesterjelszo-hozzaferes'
const USER = 'm4@example.invalid'
const SECRET_WORD = 'Keresoszo-hozzaferes-77'

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

const pop = await new FakePop3Server().listen()
const now = new Date().toUTCString()
for (const [i, subject] of [`Ajánlat ${SECRET_WORD}`, 'Második levél', 'Harmadik levél'].entries()) {
  pop.add(Buffer.from(`From: Feladó Ferenc <ferenc@example.invalid>\r\nTo: ${USER}\r\nSubject: ${subject}\r\nMessage-ID: <m4-${i}@example.invalid>\r\nDate: ${now}\r\n\r\nszöveg ${i}\r\n`))
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-m4-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
let accountId
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  accountId = store.save({
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: USER, in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none',
  }).account.id
  db.close()
}
seedLanguage(dataDir)
const endpoint = path.join(dataDir, 'mcp', 'endpoint.json')

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
      waiting.get(m.id)?.(m)
      waiting.delete(m.id)
    }
  })
  proc.stderr.resume()
  let id = 0
  const ask = (method, params, timeout = 90_000) =>
    new Promise(resolve => {
      const my = ++id
      const timer = setTimeout(() => resolve(null), timeout)
      waiting.set(my, m => (clearTimeout(timer), resolve(m)))
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, ...(params ? { params } : {}) })}\n`)
    })
  const tool = async (name, args = {}, timeout) => (await ask('tools/call', { name, arguments: args }, timeout))?.result
  const init = () => ask('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  return { ask, tool, init, close: () => proc.stdin.end() }
}

const consoleProblems = []
const launch = async () => {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleProblems.push(m.text()))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').nth(2).waitFor({ timeout: 30_000 })
  await page.locator('.app-header-end').getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.getByRole('button', { name: t.settingsNav.claude, exact: true }).click()
  await page.locator('.claude-access').waitFor()
  return { app, page }
}

let { app, page } = await launch()
let c = null
try {
  const state = () => page.locator('.claude-state strong').innerText()
  const waitState = async want => {
    for (let i = 0; i < 50; i++) {
      if ((await state()) === want) return true
      await sleep(100)
    }
    return false
  }
  const sw = page.locator('#claude-access-switch')
  check('OFF by default: "Kikapcsolva", the switch unchecked, no endpoint.json', (await waitState(t.claudeAccess.stateOff)) && !(await sw.isChecked()) && !fs.existsSync(endpoint))
  if (shots) {
    fs.mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: path.join(shots, 'claude-access-off.png') })
  }

  // ON -> Várakozik -> a connector -> Kapcsolódva: 1
  await sw.click()
  check('ON: "Várakozik", endpoint.json there', (await waitState(t.claudeAccess.stateWaiting)) && fs.existsSync(endpoint))
  c = connector()
  await c.init()
  check('a connector: "Kapcsolódva: 1"', await waitState(t.claudeAccess.stateConnected(1)))

  // Másolás: exactly the shown text, with the absolute path of the program
  const shownOf = id => page.locator(`.claude-snippet[data-snippet="${id}"] .claude-snippet-text`).innerText()
  const clip = () => app.evaluate(async ({ clipboard }) => clipboard.readText())
  for (const id of ['desktop', 'code']) {
    await page.locator(`.claude-snippet[data-snippet="${id}"] .claude-copy`).click()
    await page.locator(`.claude-snippet[data-snippet="${id}"] .claude-copy`, { hasText: t.claudeAccess.copied }).waitFor({ timeout: 5000 })
    const shown = await shownOf(id)
    const copied = await clip()
    check(`Másolás (${id}): the clipboard has exactly the shown text, with the program's absolute path`, copied === shown && copied.includes(exePath) && copied.includes(repo) && path.isAbsolute(exePath), copied.slice(0, 160))
  }
  const desktopEntry = JSON.parse(await shownOf('desktop')).mcpServers.shadowmail
  check('Claude Desktop entry: command = the program, args end with --mcp, env = this data folder', desktopEntry.command === exePath && desktopEntry.args.at(-1) === '--mcp' && desktopEntry.env.SHADOWMAIL_DATA === dataDir)
  check('the "moved folder" line is there', (await page.locator('.claude-moved').innerText()).includes(t.claudeAccess.moved))

  // a search: the row, without the search word
  const found = await c.tool('search_messages', { query: SECRET_WORD })
  await page.locator('.claude-recent tr[data-tool="search_messages"]').waitFor({ timeout: 5000 })
  const row = await page.locator('.claude-recent tr[data-tool="search_messages"]').first().innerText()
  check('search_messages: a new row (tool, result, count)', !found.isError && /search_messages/.test(row) && row.includes(t.claudeAccess.result('ok')) && /\b1\b/.test(row), row.replace(/\s+/g, ' '))
  check('the search word is not on the page', !(await page.locator('.claude-access').innerText()).includes(SECRET_WORD))

  // a confirmation's result
  await c.tool('create_folder', { account_id: accountId, name: 'hozzaferes-mappa' })
  const pending = c.tool('delete_folder', { account_id: accountId, path: 'hozzaferes-mappa' })
  await page.locator('.claude-confirm-modal').waitFor({ timeout: 10_000 })
  await page.locator('.claude-confirm-modal .confirm-reject').click()
  await pending
  await page.locator('.claude-recent tr[data-kind="confirm"][data-tool="delete_folder"]').waitFor({ timeout: 5000 })
  const confirmRow = await page.locator('.claude-recent tr[data-kind="confirm"]').first().innerText()
  check('a confirmation\'s result in the list: "megerősítés: elutasítva"', /delete_folder/.test(confirmRow) && confirmRow.includes(t.claudeAccess.confirmResult('rejected')), confirmRow.replace(/\s+/g, ' '))
  if (shots) {
    await page.evaluate(() => document.querySelector('.claude-access').scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: path.join(shots, 'claude-access-on.png') })
  }

  // OFF -> Kikapcsolva, the connection drops
  await sw.click()
  const after = await c.ask('ping', undefined, 10_000)
  check('OFF: "Kikapcsolva", no endpoint.json, the connection gives the error', (await waitState(t.claudeAccess.stateOff)) && !fs.existsSync(endpoint) && after && after.error && /nem fut, zárolva van, vagy a Claude-hozzáférés ki van kapcsolva/.test(after.error.message) /* the connector's text: Hungarian in both languages */, JSON.stringify(after))
  c.close()
  c = null

  // restart: the list is empty (memory only)
  await app.close()
  ;({ app, page } = await launch())
  await page.locator('.claude-recent-empty').waitFor({ timeout: 5000 })
  check('after a restart the list is empty', (await page.locator('.claude-recent tr').count()) === 0)

  check('no console error or warning in the renderer', consoleProblems.length === 0, consoleProblems.join(' | '))
  const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
  check('the net-guard log has no outgoing request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')
  const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
  check('main.log: the search word is not in it', fs.existsSync(mainLog) && !fs.readFileSync(mainLog, 'utf8').includes(SECRET_WORD))
} catch (err) {
  check('the run', false, err.stack)
} finally {
  if (c) c.close()
  await app.close().catch(() => {})
  await pop.close?.()
  fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
