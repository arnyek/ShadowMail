#!/usr/bin/env node
// The unread badge on the taskbar button in the real app. Not part of `npm test`.
//
//   node test/e2e/taskbar-unread-e2e.mjs
//
// The overlay calls are watched through SHADOWMAIL_TEST_OVERLAY_LOG (one JSON line a call: the number, or null for no
// badge, and the scale factors of the real nativeImage); on Linux nothing is drawn, the log still sees every call.
// Two POP3 accounts (fake servers): A with three messages, B with 5000 unread seeded rows. Measures: after the unlock the
// badge = the sidebar's inbox total; 5000 marked read at once -> at most 2 overlay calls, the right number at the end; the
// badge follows within 2 s: a new message by sync, opening a message, the list's read/unread buttons, the row menu, MCP
// mark_messages, a move out of the inbox, a delete, an account deleted; lock -> null within 1 s, unlock -> the right
// number. The switch (Beállítások / Megjelenés): on on a fresh data folder; off -> null within 1 s and no overlay call
// after a new message or a read; on -> the right number within 2 s; off stays off over lock + unlock; a damaged stored
// value ('x') is on. The main log holds no number of the badge and nothing of a message; no console problem.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { addMessage } from '../helpers/fixtures.js'
import { createVaultedDatabase, openVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { POP3_LOCAL_FOLDERS } from '../../core/pop3/fetcher.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-talca'
const BULK = 5000
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

const mail = (subject, minutesAgo) =>
  Buffer.from(`From: Anna <anna@example.invalid>\r\nTo: a@example.invalid\r\nSubject: ${subject}\r\nDate: ${new Date(Date.now() - minutesAgo * 60_000).toUTCString()}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@example.invalid>\r\n\r\nTALCA-TITKOS-TORZS ${subject}\r\n`)
const popA = await new FakePop3Server().listen()
for (const [i, s] of ['Talca egy', 'Talca ketto', 'Talca harom'].entries()) popA.add(mail(s, 10 - i))
const popB = await new FakePop3Server().listen()

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-taskbar-e2e-'))
const dataDir = path.join(work, 'data')
const overlayLog = path.join(work, 'overlay.jsonl')
fs.mkdirSync(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const ids = []
  for (const [name, email, pop] of [['A-fiók', 'a@example.invalid', popA], ['B-tömeg', 'b@example.invalid', popB]]) {
    ids.push(store.save({ ...newAccountDefaults('pop3'), name, email, in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass, smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none' }).account.id)
  }
  const index = new MailIndex(db)
  index.ensureLocalFolders(ids[1], POP3_LOCAL_FOLDERS)
  for (let i = 0; i < BULK; i++) addMessage(index, ids[1], { uid: i + 1, subject: `Tomeg ${i}`, date: Date.now() - 86_400_000 - i * 1000 })
  db.close()
}
seedLanguage(dataDir)

// the overlay log: every call so far
const calls = () => (fs.existsSync(overlayLog) ? fs.readFileSync(overlayLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
// waits for an overlay call (after the first `from` calls) showing `n` (null = no badge); -> ms from `t0`, or null
async function waitOverlay(n, from, t0, timeout = 2000) {
  for (;;) {
    const hit = calls().slice(from).find(c => c.n === n)
    if (hit) return hit.at - t0
    if (Date.now() - t0 > timeout + 500) return null
    await sleep(50)
  }
}

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
  const ask = (method, params, timeout = 60_000) =>
    new Promise(resolve => {
      const my = ++id
      const timer = setTimeout(() => resolve(null), timeout)
      waiting.set(my, m => (clearTimeout(timer), resolve(m)))
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, ...(params ? { params } : {}) })}\n`)
    })
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args }))?.result
  return { ask, tool, exited: new Promise(r => proc.on('exit', r)), close: () => proc.stdin.end() }
}

const consoleProblems = []
const launch = async () => {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir, SHADOWMAIL_TEST_OVERLAY_LOG: overlayLog } })
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleProblems.push(m.text()))
  await page.setViewportSize({ width: 1280, height: 800 })
  return { app, page }
}
const unlock = async page => {
  await page.locator('#vault-unlock').fill(MASTER)
  const t0 = Date.now()
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  return t0
}
// the sidebar's own numbers: the inbox row of every account (POP3: INBOX)
const sidebarTotal = page =>
  page.evaluate(async () => (await window.shadowMail.mail.folders()).accounts.reduce((s, a) => s + a.folders.filter(f => f.path === 'INBOX').reduce((x, f) => x + f.unread, 0), 0))
const listA = (page, accId) => page.evaluate(id => window.shadowMail.mail.list({ accountId: id, folder: 'INBOX', limit: 50 }).then(r => r.rows), accId)
const row = (page, subject) => page.locator('.msg-row', { hasText: subject })

// one step: do it, then the badge must show the sidebar's total within 2 s
async function follows(page, name, step, expected) {
  const from = calls().length
  const t0 = Date.now()
  await step()
  const ms = await waitOverlay(expected, from, t0)
  const side = await sidebarTotal(page)
  check(`${name}: the badge follows within 2 s, = the sidebar's total`, ms !== null && ms <= 2000 && side === (expected ?? 0), `badge ${expected} after ${ms} ms, sidebar ${side}`)
}

let { app, page } = await launch()
const c = connector()
let accA = null
let accB = null
try {
  // 1. the unlock: the badge = the sidebar's total, every taskbar scale
  const tUnlock = await unlock(page)
  await row(page, 'Talca harom').waitFor({ timeout: 30_000 })
  const accounts = (await page.evaluate(() => window.shadowMail.mail.folders())).accounts
  accA = accounts.find(a => a.name === 'A-fiók')
  accB = accounts.find(a => a.name === 'B-tömeg')
  const first = BULK + 3
  const msFirst = await waitOverlay(first, 0, tUnlock, 30_000)
  check('fresh data folder: the switch is on', (await page.evaluate(() => window.shadowMail.taskbar.status())).enabled === true)
  check('unlock: the badge shows every inbox (both accounts), = the sidebar', msFirst !== null && (await sidebarTotal(page)) === first, `${msFirst} ms`)
  const last = calls().at(-1)
  check('the badge image: a representation for every taskbar scale (real nativeImage)', JSON.stringify(last.scales) === '[1,1.25,1.5,2]', JSON.stringify(last))

  // 2. 5000 marked read at once: at most 2 overlay calls, the right number at the end
  {
    const from = calls().length
    const ids = (await page.evaluate(id => window.shadowMail.mail.ids({ accountId: id, folder: 'INBOX' }), accB.id)).ids
    const t0 = Date.now()
    const r = await page.evaluate(ids => window.shadowMail.mail.action({ ids, action: 'read' }), ids)
    const ms = await waitOverlay(3, from, t0, 5000)
    await sleep(1000)
    const after = calls().slice(from)
    check(`${BULK} marked read at once: at most 2 overlay calls, the last one 3`, r.ok !== false && ids.length === BULK && after.length <= 2 && after.at(-1).n === 3, `${after.length} call(s): ${JSON.stringify(after.map(x => x.n))}, ${ms} ms`)
  }

  // 3. a new message by sync
  await follows(page, 'new message (sync)', async () => {
    popA.add(mail('Talca negy', 1))
    await page.evaluate(id => window.shadowMail.mail.sync(id), accA.id)
  }, 4)

  // 4. opening a message (a click on the row) makes it read
  await follows(page, 'opening a message', () => row(page, 'Talca egy').click(), 3)
  await page.locator('.reader-back').click().catch(() => {})

  // 5. the list's buttons: read, then unread
  await row(page, 'Talca ketto').locator('.col-check input').check()
  await follows(page, 'list button "Olvasott"', () => page.getByRole('button', { name: t.actions.read, exact: true }).click(), 2)
  await follows(page, 'list button "Olvasatlan"', () => page.getByRole('button', { name: t.actions.unread, exact: true }).click(), 3)
  await row(page, 'Talca ketto').locator('.col-check input').uncheck()

  // 6. the row menu
  await follows(page, 'row menu "Olvasott"', async () => {
    await row(page, 'Talca ketto').click({ button: 'right' })
    await page.getByRole('menuitem', { name: t.actions.read, exact: true }).click()
  }, 2)

  // 7. MCP mark_messages
  await page.evaluate(() => window.shadowMail.mcp.setEnabled(true))
  await c.ask('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  const byName = async s => (await listA(page, accA.id)).find(r => r.subject === s)
  const harom = await byName('Talca harom')
  await follows(page, 'MCP mark_messages (read)', async () => {
    const r = await c.tool('mark_messages', { ids: [harom.id], action: 'read' })
    if (!r || r.isError) console.log(`     mark_messages: ${JSON.stringify(r)}`)
  }, 1)

  // 8. a move out of the inbox, a delete (both unread)
  const egy = await byName('Talca egy')
  const ketto = await byName('Talca ketto')
  await follows(page, 'marked unread again (material for the next steps)', () => page.evaluate(ids => window.shadowMail.mail.action({ ids, action: 'unread' }), [egy.id, ketto.id]), 3)
  await follows(page, 'move out of the inbox', () => page.evaluate(id => window.shadowMail.mail.action({ ids: [id], action: 'move', target: 'Drafts' }), egy.id), 2)
  await follows(page, 'delete (to the Trash)', () => page.evaluate(id => window.shadowMail.mail.action({ ids: [id], action: 'delete' }), ketto.id), 1)

  // 9. lock and unlock
  {
    const from = calls().length
    const t0 = Date.now()
    await page.evaluate(() => window.shadowMail.vault.lock())
    const ms = await waitOverlay(null, from, t0, 1000)
    check('lock: the badge goes within 1 s', ms !== null && ms <= 1000, `${ms} ms`)
    // the page learns of an API lock on its next load (as in lock-e2e)
    await page.reload()
    await page.locator('#vault-unlock').waitFor()
    const from2 = calls().length
    const t1 = await unlock(page)
    const ms2 = await waitOverlay(1, from2, t1, 15_000)
    await row(page, 'Talca negy').waitFor({ timeout: 30_000 })
    check('unlock: the right number again', ms2 !== null && (await sidebarTotal(page)) === 1, `${ms2} ms`)
  }

  // 10. the switch, on the settings page
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('.settings-tab', { hasText: t.settingsNav.appearance }).click()
  const sw = page.locator('#taskbar-unread-switch')
  await sw.waitFor()
  check('Megjelenés: the switch is there, its label from the dictionary, checked', (await sw.isChecked()) && (await page.locator('label', { has: sw }).innerText()).includes(t.taskbarUnreadLabel))
  // the preferences list: every control (three selects and the switch) starts at the same x, at 1280 and at 860 px
  const controlsLeft = () => page.evaluate(() => [...document.querySelectorAll('.settings-appearance .setting-control')].map(c => Math.round(c.firstElementChild.getBoundingClientRect().left)))
  const vp = page.viewportSize()
  for (const width of [1280, 860]) {
    await page.setViewportSize({ width, height: vp ? vp.height : 800 })
    await page.waitForTimeout(200)
    const xs = await controlsLeft()
    const hs = await page.evaluate(() => [document.scrollingElement, document.querySelector('section.settings')].map(e => e.scrollWidth - e.clientWidth))
    check(`Megjelenés at ${width} px: the four controls start at one x (<= 1 px), no horizontal scroll`, xs.length === 4 && Math.max(...xs) - Math.min(...xs) <= 1 && hs.every(h => h <= 0), JSON.stringify({ xs, hs }))
  }
  if (vp) await page.setViewportSize(vp)
  {
    const from = calls().length
    const t0 = Date.now()
    await page.locator('label', { has: sw }).click()
    const ms = await waitOverlay(null, from, t0, 1000)
    const unchecked = await page.waitForFunction(() => !document.querySelector('#taskbar-unread-switch').checked, null, { timeout: 2000 }).then(() => true, () => false)
    check('switched off: the badge goes within 1 s, the box unchecked', ms !== null && ms <= 1000 && unchecked, `${ms} ms`)
    const quiet = calls().length
    popA.add(mail('Talca ot', 0))
    await page.evaluate(id => window.shadowMail.mail.sync(id), accA.id)
    for (let i = 0; i < 60 && !(await byName('Talca ot')); i++) await sleep(250)
    const negy = await byName('Talca negy')
    await page.evaluate(id => window.shadowMail.mail.action({ ids: [id], action: 'read' }), negy.id)
    await sleep(1500)
    check('off: a new message and a read call no overlay', Boolean(await byName('Talca ot')) && calls().length === quiet, `${calls().length - quiet} call(s)`)
    const t1 = Date.now()
    await page.locator('label', { has: sw }).click()
    const ms2 = await waitOverlay(1, quiet, t1)
    check('switched on: the right number within 2 s', ms2 !== null && ms2 <= 2000 && (await sidebarTotal(page)) === 1, `${ms2} ms`)
    await page.locator('label', { has: sw }).click()
    await waitOverlay(null, calls().length - 1, Date.now() - 1000)
  }
  {
    await page.evaluate(() => window.shadowMail.vault.lock())
    // the page learns of an API lock on its next load (as in lock-e2e)
    await page.reload()
    await page.locator('#vault-unlock').waitFor()
    const from = calls().length
    await unlock(page)
    await page.locator('.msg-row').first().waitFor({ timeout: 30_000 })
    await sleep(1500)
    const st = await page.evaluate(() => window.shadowMail.taskbar.status())
    check('off stays off over lock + unlock: no overlay call', st.enabled === false && calls().slice(from).every(x => x.n === null), JSON.stringify(calls().slice(from)))
  }
} finally {
  c.close()
  await app.close()
}

// 11. a damaged stored value is on
{
  const { db } = await openVaultedDatabase(dataDir, MASTER)
  db.prepare("UPDATE settings SET value = 'x' WHERE key = 'taskbar_unread'").run()
  db.close()
}
;({ app, page } = await launch())
try {
  const from = calls().length
  const t0 = await unlock(page)
  const ms = await waitOverlay(1, from, t0, 15_000)
  check("a damaged stored value ('x'): on, the badge is back", ms !== null && (await page.evaluate(() => window.shadowMail.taskbar.status())).enabled === true, `${ms} ms`)
  // 12. an account deleted (cascade)
  await follows(page, 'account deleted', () => page.evaluate(id => window.shadowMail.accounts.remove(id), accA.id), null)
} finally {
  await app.close()
}

// 13. the logs
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
// the message part of every line (after "<time> [<pid>] "); the data folder's own name holds "taskbar"
const messages = mainLog.split('\n').map(l => l.replace(/^\S+ \[\d+\] /, '').replaceAll(dataDir, '<data>'))
const taskbarLines = messages.filter(l => /taskbar|badge/i.test(l))
check('main log: only the switch lines of the badge, no number', taskbarLines.length > 0 && taskbarLines.every(l => /^taskbar badge switch (on|off)$/.test(l)), JSON.stringify(taskbarLines))
check('main log: no subject, body or badge description', !/Talca|TALCA-TITKOS|olvasatlan lev|unread message/i.test(mainLog))
check('main log: no error line of the badge', !messages.some(l => /(taskbar|badge|unread).*(failed|error)/i.test(l)))
check('renderer console: no error or warning', consoleProblems.length === 0, consoleProblems.slice(0, 3).join(' | '))
const ng = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
check('net-guard log empty', !fs.existsSync(ng) || fs.readFileSync(ng, 'utf8').trim() === '')

await popA.close?.()
await popB.close?.()
fs.rmSync(work, { recursive: true, force: true })
const failed = results.filter(r => !r).length
console.log(`${results.length - failed} / ${results.length} ${failed ? "FAIL" : "OK"}`)
process.exit(failed ? 1 : 0)
