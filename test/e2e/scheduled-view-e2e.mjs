#!/usr/bin/env node
// "Küldés később", the "Időzített" list in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/scheduled-view-e2e.mjs          (E2E_LANG=en: the same in English)
//
// A POP3 account (local Drafts and Sent) and a local SMTP server; nothing in the product is a test switch.
// 1. No scheduled message: no entry at the top of the sidebar. One scheduled ("Holnap 8:00"): the entry "Időzített (1)"
//    shows; it opens the list: the time, the subject, the recipient, the account; no folder is selected.
// 2. Megnyitás: a composer with the message; a second Megnyitás brings the same window (one window); its save updates
//    the row (the new subject), not Drafts; while open the row says so and offers nothing else; closed: everything.
// 3. Időpont módosítása (a custom date and time): the row's new time.
// 4. Küldés most: it goes out once (Sent holds it), the row goes.
// 5. Another one, Időzítés törlése: back in Drafts, nothing went out, the list empty; a folder leaves the view and the
//    entry is gone.
// The main log has no subject or address and no error line, the renderer console no error or warning.
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
import { t, locale, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-idozitett-lista'
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-schedview-e2e-'))
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

  const savedHint = (d => t.composeSavedAt(d).replace(d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }), '').trim())(new Date())
  const clickClosing = async (win, name, timeout) => {
    const closed = win.waitForEvent('close', { timeout })
    await win.getByRole('button', { name, exact: true }).click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
  }
  const ts = t.scheduledList
  const entry = page.locator('.scheduled-entry')
  const row = subject => page.locator('.scheduled-row', { hasText: subject })
  const listed = () => page.evaluate(async () => (await window.shadowMail.scheduled.list()).rows)

  // 1
  await page.waitForTimeout(500)
  check('1: no scheduled message, no entry', (await entry.count()) === 0)
  const a = await scheduleOne('Lista A')
  check('1: the entry shows with the count', await waitFor(async () => (await entry.count()) === 1 && (await entry.innerText()).trim() === ts.entry(1), 5000), await entry.innerText().catch(() => ''))
  await entry.click()
  await page.locator('.scheduled-list .page-title').waitFor({ timeout: 5000 })
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(a.at))
  const r1 = row('Lista A')
  const shown = { when: await r1.locator('.scheduled-when').innerText(), to: await r1.locator('.scheduled-recipients').innerText(), account: await r1.locator('.scheduled-account').innerText(), state: await r1.locator('.scheduled-state').innerText() }
  check('1: the row: time, recipient, account, waiting', shown.when === when && shown.to === 'anna@example.invalid' && shown.account === 'POP3-fiók' && shown.state === ts.states.waiting, JSON.stringify(shown))
  check('1: the entry is current, no folder selected', (await entry.getAttribute('aria-current')) === 'page' && (await page.locator('.folder-tree .folder.selected').count()) === 0)

  // 2
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), r1.locator('.scheduled-open').click()])
  await win.setViewportSize({ width: 900, height: 700 })
  await win.locator('#compose-subject').waitFor()
  await waitFor(async () => (await win.locator('#compose-subject').inputValue()) === 'Lista A', 10_000)
  const opened = { subject: await win.locator('#compose-subject').inputValue(), text: await win.locator('.editor').innerText() }
  check('2: Megnyitás: the composer holds the message', opened.subject === 'Lista A' && opened.text.includes('Időzített szöveg.'), JSON.stringify(opened))
  await page.waitForTimeout(500)
  check('2: while open the row says so; only Megnyitás is enabled', (await r1.locator('.scheduled-state').innerText()) === ts.states.held && (await r1.locator('.scheduled-open').isEnabled()) && !(await r1.locator('.scheduled-send-now').isEnabled()) && !(await r1.locator('.scheduled-cancel').isEnabled()) && !(await r1.locator('.scheduled-reschedule').isEnabled()))
  const windowsBefore = app.windows().length
  await r1.locator('.scheduled-open').click()
  await page.waitForTimeout(1500)
  check('2: a second Megnyitás opens no second window', app.windows().length === windowsBefore, `${windowsBefore} -> ${app.windows().length}`)
  await win.locator('#compose-subject').fill('Lista A2')
  await win.getByRole('button', { name: t.composeSaveDraft, exact: true }).click()
  await win.locator('.hint[role="status"]').filter({ hasText: savedHint }).waitFor({ timeout: 15_000 })
  check('2: the save updated the row, not Drafts', await waitFor(async () => (await row('Lista A2').count()) === 1, 5000) && (await rows('Drafts')).length === 0 && received.length === 0, (await rows('Drafts')).join(','))
  await clickClosing(win, t.composeCloseWindow, 15_000)
  const r2 = row('Lista A2')
  check('2: closed: the row stays, waiting, every action enabled', await waitFor(async () => (await r2.locator('.scheduled-state').innerText()) === ts.states.waiting && (await r2.locator('.scheduled-send-now').isEnabled()), 5000) && (await listed()).length === 1)

  // 3
  await r2.locator('.scheduled-reschedule').click()
  const move = page.locator('.scheduled-move-modal')
  await move.waitFor()
  await move.locator('input[value="custom"]').check()
  const target = new Date(Date.now() + 3 * 24 * 60 * MIN)
  const pad = n => String(n).padStart(2, '0')
  await move.locator('.compose-schedule-date').fill(`${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`)
  await move.locator('.compose-schedule-time').fill('09:30')
  await move.locator('.compose-schedule-ok').click()
  const wanted = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 9, 30).getTime()
  const wantedText = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(wanted))
  const movedOk = await waitFor(async () => (await listed())[0]?.sendAt === wanted && (await r2.locator('.scheduled-when').innerText()) === wantedText, 5000)
  check('3: Időpont módosítása: the new time, shown', movedOk && (await move.count()) === 0, `${await r2.locator('.scheduled-when').innerText()} / ${wantedText}`)

  // 4
  await r2.locator('.scheduled-send-now').click()
  check('4: Küldés most: out once', await waitFor(() => received.length === 1, 20_000) && /Subject: .*A2/.test(received[0] || ''))
  await sleep(1500)
  check('4: Sent holds it, the row went', (await rows('Sent')).includes('Lista A2') && (await listed()).length === 0 && received.length === 1 && (await page.locator('.scheduled-empty').count()) === 1)

  // 5
  await scheduleOne('Lista B')
  const rb = row('Lista B')
  await rb.waitFor({ timeout: 5000 })
  check('5: the entry counts it', (await entry.innerText()).trim() === ts.entry(1))
  await rb.locator('.scheduled-cancel').click()
  check('5: Időzítés törlése: back in Drafts, nothing went out, the list empty', await waitFor(async () => (await rows('Drafts')).includes('Lista B') && (await listed()).length === 0, 10_000) && received.length === 1)
  check('5: a notice says where it went', await waitFor(async () => (await page.locator('.action-notice').innerText().catch(() => '')).includes(ts.cancelled('Lista B')), 5000))
  await page.locator('.folder-tree .folder[data-path="Drafts"]').click()
  await page.waitForTimeout(500)
  check('5: a folder leaves the view; no rows: the entry is gone', (await page.locator('.scheduled-list').count()) === 0 && (await entry.count()) === 0 && (await page.locator('.msg-row', { hasText: 'Lista B' }).count()) === 1)

  const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
  check('main.log: the list\'s lines without content, no error line', /scheduled \d+ rescheduled/.test(mainLog) && /scheduled \d+ send now/.test(mainLog) && /scheduled \d+ back to drafts/.test(mainLog) && !/Lista|anna@/.test(mainLog) && !/\bERROR\b|Uncaught/i.test(mainLog))
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
