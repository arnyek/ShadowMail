#!/usr/bin/env node
// "Küldés később" in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/scheduled-e2e.mjs          (E2E_LANG=en: the same in English)
//
// A POP3 account (local Drafts and Sent) and a local SMTP server. The main process's clock is moved with app.evaluate
// (Date.now), as the mcp-confirm e2e does; nothing in the product is a test switch.
// A. The composer's "Küldés később…" -> "Holnap 8:00": the window closes, the main window says it is scheduled, nothing
//    goes out; the clock 5 minutes past the time: within the scheduler's 30 s it goes out once, through the composer's
//    path (Sent holds it), the notice says how late.
// B. Scheduled, then the app locked and the clock past the time: nothing goes out while locked; after the unlock it goes
//    out at once, with the notice.
// C. Scheduled, locked, the clock more than a day past the time: after the unlock it does NOT go out, the notice says
//    it is late.
// The main log has no error line, the renderer console no error or warning.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { SMTPServer } from 'smtp-server'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { quickTimes } from '../../app/renderer/src/schedule-times.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-idozites'
const ME = 'teszt@example.invalid'
const MIN = 60_000

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 5 minutes')
  process.exit(1)
}, 300_000)
watchdog.unref()

const received = []
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN', 'LOGIN'], logger: false,
  onAuth: (a, _s, cb) => cb(null, { user: a.username }),
  onData(stream, session, cb) {
    const chunks = []
    stream.on('data', c => chunks.push(c))
    stream.on('end', () => (received.push(Buffer.concat(chunks).toString('utf8')), cb()))
  },
})
smtp.on('error', () => {})
await new Promise(r => smtp.listen(0, '127.0.0.1', r))
const pop = await new FakePop3Server().listen()

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-sched-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: ME, display_name: 'Teszt Elek',
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none',
  })
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const waitFor = async (fn, ms) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await fn()) return true
    await sleep(250)
  }
  return false
}
const consoleLines = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  await page.setViewportSize({ width: 1280, height: 900 })
  const unlock = async () => {
    await page.locator('#vault-unlock').fill(MASTER)
    await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
    await page.locator('.folder-tree').waitFor({ timeout: 20_000 })
  }
  await unlock()
  // the main process's clock: Date.now + offset (the renderer keeps the real time)
  await app.evaluate(() => {
    const real = Date.now.bind(Date)
    globalThis.__smOffset = 0
    Date.now = () => real() + globalThis.__smOffset
  })
  const setOffset = ms => app.evaluate((_e, v) => (globalThis.__smOffset = v), ms)
  const rows = folderPath =>
    page.evaluate(async f => {
      const acc = (await window.shadowMail.mail.folders()).accounts[0]
      const res = await window.shadowMail.mail.list({ accountId: acc.id, folder: f })
      return res.ok ? res.rows.map(r => r.subject) : ['(error)']
    }, folderPath)
  const notices = () => page.locator('.scheduled-notice').allInnerTexts()

  // writes and schedules "Holnap 8:00"; -> that time (as the composer's dialog computes it)
  const scheduleOne = async subject => {
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: t.newMessage, exact: true }).click()])
    await win.setViewportSize({ width: 900, height: 700 })
    await win.locator('#compose-to').waitFor()
    await win.locator('#compose-to').fill('Címzett Anna <anna@example.invalid>')
    await win.locator('#compose-subject').fill(subject)
    await win.locator('.editor').click()
    await win.keyboard.type('Időzített szöveg.')
    await win.locator('.compose-send-later').click()
    await win.locator('.compose-schedule-modal').waitFor()
    const note = await win.locator('.compose-schedule-note').innerText()
    await win.locator('input[value="tomorrow8"]').check()
    const at = quickTimes(Date.now()).find(x => x.key === 'tomorrow8').at
    const closed = win.waitForEvent('close', { timeout: 15_000 })
    await win.locator('.compose-schedule-ok').click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
    return { at, note }
  }

  // A
  const a = await scheduleOne('Időzített A')
  check('the dialog says it goes out only while the app runs', a.note === t.schedule.note, a.note)
  check('A scheduled: the main window says so, nothing went out, Drafts empty', (await waitFor(async () => (await notices()).some(n => n.includes('Időzített A')), 5000)) && received.length === 0 && (await rows('Drafts')).length === 0, (await notices()).join(' | '))
  await setOffset(a.at - Date.now() + 5 * MIN)
  const sentA = await waitFor(() => received.length === 1, 40_000)
  check('A: within the scheduler\'s 30 s after its time it goes out once', sentA && received.length === 1 && /Subject: .*A/.test(received[0]))
  await sleep(1500)
  check('A: Sent holds it, it went out once', (await rows('Sent')).includes('Időzített A') && received.length === 1, (await rows('Sent')).join(','))
  const late = t.scheduledNotice('sent', 'Időzített A', { lateMin: 5 })
  check('A: the notice says how late (5 minutes)', (await waitFor(async () => (await notices()).some(n => n.includes(late)), 5000)), (await notices()).join(' | '))

  // B
  await setOffset(0)
  const b = await scheduleOne('Időzített B')
  await page.getByRole('button', { name: t.vaultLockButton, exact: true }).click()
  await page.locator('#vault-unlock').waitFor({ timeout: 15_000 })
  await setOffset(b.at - Date.now() + 10 * MIN)
  await sleep(35_000)
  check('B: locked, past its time: nothing went out', received.length === 1)
  await unlock()
  const sentB = await waitFor(() => received.length === 2, 20_000)
  check('B: after the unlock it goes out at once', sentB && /Subject: .*B/.test(received[1] || ''))
  const sentB10 = [10, 11].map(m => t.scheduledNotice('sent', 'Időzített B', { lateMin: m }))
  check('B: with the "went out, late" notice', await waitFor(async () => (await notices()).some(n => sentB10.some(x => n.includes(x))), 5000), (await notices()).join(' | '))

  // C
  await setOffset(0)
  const c = await scheduleOne('Időzített C')
  await page.getByRole('button', { name: t.vaultLockButton, exact: true }).click()
  await page.locator('#vault-unlock').waitFor({ timeout: 15_000 })
  await setOffset(c.at - Date.now() + 25 * 60 * MIN)
  await unlock()
  const lateText = t.scheduledNotice('late', 'Időzített C')
  check('C: more than a day late: the notice says so', await waitFor(async () => (await notices()).some(n => n.includes(lateText)), 10_000), (await notices()).join(' | '))
  await sleep(3000)
  check('C: it did NOT go out', received.length === 2, String(received.length))

  const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
  check('main.log: scheduled lines without content, no error line', /scheduled \d+ sent late_s=\d+/.test(mainLog) && /scheduled \d+ late/.test(mainLog) && !/Időzített/.test(mainLog) && !/\bERROR\b|Uncaught/i.test(mainLog))
  check('renderer console: no error or warning', consoleLines.length === 0, consoleLines.join(' | '))
} catch (err) {
  check('the run', false, err && err.message)
} finally {
  await app.close().catch(() => {})
  smtp.close()
  await pop.close().catch(() => {})
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
