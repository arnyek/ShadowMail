#!/usr/bin/env node
// The new-mail notice in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/new-mail-notice-e2e.mjs          (E2E_LANG=en: the same in English)
//
// A POP3 account (fake POP3 server) with two messages; Notification.show of the main process is replaced and records
// what it was given (headless Linux has no notice server), its 'click' is played by emitting the event:
// 1. The switch is OFF; the first download gives no notice; a new message with the switch OFF gives none.
// 2. Turning it on asks first: Cancel leaves it OFF; Yes turns it ON (a run that is not the packaged Windows program
//    writes no shortcut: no shortcut line in the log).
// 3. A new message: one notice, the sender (cleaned of a direction mark) and the subject; the click brings the window
//    forward and opens the message.
// 4. Five at once: one summary with the account's name; the click shows the inbox, no message open.
// 5. Restarted: the switch is still ON. Turned OFF: a new message gives no notice.
// The main log: the notice lines with numbers only, no sender, subject or address; no error line; the console clean.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-ertesites'
const ME = 'teszt@example.invalid'
const RLO = String.fromCodePoint(0x202e)

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 5 minutes')
  process.exit(1)
}, 300_000)
watchdog.unref()

let seq = 0
const mail = (subject, { name = 'Feladó Ferenc', address = 'ferenc@example.invalid' } = {}) =>
  Buffer.from(
    `From: ${name} <${address}>\r\nTo: ${ME}\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nDate: ${new Date().toUTCString()}\r\n` +
      `Message-ID: <ertesites-${++seq}@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSzia ${seq}.\r\n`,
  )
const pop = await new FakePop3Server().listen()
pop.add(mail('Éjszakai egy'))
pop.add(mail('Éjszakai kettő'))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-n1-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({ ...newAccountDefaults('pop3'), name: 'Munkahelyi fiók', email: ME, display_name: 'Teszt Elek', in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass, smtp_host: '127.0.0.1', smtp_port: 25, smtp_security: 'none' })
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function launch() {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  // every notice the main process shows, and the object (its click is played on it)
  await app.evaluate(({ Notification }) => {
    globalThis.__e2eNotices = []
    Notification.prototype.show = function () {
      globalThis.__e2eNotices.push(this)
    }
  })
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  return { app, page }
}
const notices = app => app.evaluate(() => globalThis.__e2eNotices.map(n => ({ title: n.title, body: n.body })))
const clickNotice = (app, i) => app.evaluate((_e, k) => globalThis.__e2eNotices[k].emit('click'), i)
const accountId = page => page.evaluate(async () => (await window.shadowMail.mail.folders()).accounts[0].id)
const subjects = page => page.evaluate(async () => {
  const acc = (await window.shadowMail.mail.folders()).accounts[0]
  const r = await window.shadowMail.mail.list({ accountId: acc.id, folder: 'INBOX' })
  return r.ok ? r.rows.map(x => x.subject) : []
})
// a download, waited for until the subjects are in the list
const download = async (page, wanted) => {
  await page.evaluate(id => window.shadowMail.mail.sync(id), await accountId(page))
  for (let i = 0; i < 120; i++) {
    const have = await subjects(page)
    if (wanted.every(w => have.includes(w))) return true
    await sleep(250)
  }
  return false
}
const openSettings = async page => {
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('.settings-tab', { hasText: t.settingsNav.appearance }).click()
  await page.locator('#new-mail-notify-switch').waitFor()
}
const toMail = page => page.getByRole('button', { name: t.backToMail, exact: true }).click()

let app
try {
  let page
  ;({ app, page } = await launch())
  await page.locator('.msg-row', { hasText: 'Éjszakai kettő' }).waitFor({ timeout: 30_000 })
  await sleep(1000)

  // 1. OFF by default, and nothing from the first download nor from a new message while OFF
  check('the first download (the switch OFF): no notice', (await notices(app)).length === 0)
  await openSettings(page)
  const sw = page.locator('#new-mail-notify-switch')
  const label = await page.locator('.setting-new-mail-notice').innerText()
  check('Megjelenés: the switch, OFF, its label and the line about the Start menu shortcut', !(await sw.isChecked()) && label.includes(t.newMailNotice.label) && label.includes(t.newMailNotice.why), label.replace(/\n/g, ' | '))
  await toMail(page)
  pop.add(mail('Kikapcsolva jött'))
  const offDownloaded = await download(page, ['Kikapcsolva jött'])
  await sleep(500)
  check('a new message with the switch OFF: downloaded, no notice', offDownloaded && (await notices(app)).length === 0)

  // 2. ON asks first
  await openSettings(page)
  await page.locator('label', { has: sw }).click()
  const ask = page.locator('.new-mail-notice-ask')
  await ask.waitFor({ timeout: 5000 })
  const askText = await ask.innerText()
  check('turning it on asks about the Start menu shortcut, Yes focused', askText.includes(t.newMailNotice.ask) && (await page.evaluate(() => document.activeElement && document.activeElement.textContent)) === t.newMailNotice.askYes, askText.replace(/\n/g, ' | '))
  await ask.getByRole('button', { name: t.confirmCancel, exact: true }).click()
  await page.waitForTimeout(300)
  const afterCancel = await page.evaluate(() => window.shadowMail.notify.status())
  check('Cancel: the switch stays OFF', !(await sw.isChecked()) && afterCancel.enabled === false && (await ask.count()) === 0, JSON.stringify(afterCancel))
  await page.locator('label', { has: sw }).click()
  await ask.getByRole('button', { name: t.newMailNotice.askYes, exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#new-mail-notify-switch').checked, null, { timeout: 5000 })
  const afterYes = await page.evaluate(() => window.shadowMail.notify.status())
  check('Yes: the switch ON, no error', afterYes.enabled === true && (await page.locator('.setting-new-mail-notice .error').count()) === 0, JSON.stringify(afterYes))
  await toMail(page)

  // 3. one new message: one notice; its click opens the message
  pop.add(mail('Árajánlat kérés', { name: `Kovács${RLO} Anna`, address: 'anna@example.invalid' }))
  await download(page, ['Árajánlat kérés'])
  for (let i = 0; i < 20 && (await notices(app)).length < 1; i++) await sleep(250)
  const one = await notices(app)
  check('a new message: one notice, the sender cleaned of the direction mark, the subject', one.length === 1 && one[0].title === 'Kovács Anna <anna@example.invalid>' && one[0].body === 'Árajánlat kérés', JSON.stringify(one))
  await page.locator('.msg-row', { hasText: 'Éjszakai egy' }).click()
  await page.locator('.reader-subject').waitFor()
  await clickNotice(app, 0)
  await page.waitForFunction(() => document.querySelector('.reader-subject')?.textContent === 'Árajánlat kérés', null, { timeout: 5000 }).catch(() => {})
  const opened = await page.evaluate(() => document.querySelector('.reader-subject')?.textContent || null)
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.isVisible() && !w.isMinimized()))
  check('the notice clicked: the window is shown and the message is open', opened === 'Árajánlat kérés' && visible, JSON.stringify({ opened, visible }))

  // 4. five at once: one summary; its click shows the inbox
  const five = ['Öt 1', 'Öt 2', 'Öt 3', 'Öt 4', 'Öt 5']
  for (const s of five) pop.add(mail(s))
  await download(page, five)
  for (let i = 0; i < 20 && (await notices(app)).length < 2; i++) await sleep(250)
  const all = await notices(app)
  check('five new messages at once: one summary with the account name', all.length === 2 && all[1].title === t.newMailNotice.summary(5, 'Munkahelyi fiók') && all[1].body === '', JSON.stringify(all.slice(1)))
  await clickNotice(app, 1)
  await page.waitForTimeout(800)
  const summaryView = await page.evaluate(() => ({ reader: Boolean(document.querySelector('.reader-subject')), rows: document.querySelectorAll('.msg-row').length, folder: document.querySelector('.folder.selected')?.dataset.path || null }))
  check('the summary clicked: the inbox, no message open', !summaryView.reader && summaryView.rows === 9 && summaryView.folder === 'INBOX', JSON.stringify(summaryView))

  // 5. restarted: still ON; then OFF: no notice
  await app.close()
  ;({ app, page } = await launch())
  await page.locator('.msg-row', { hasText: 'Öt 5' }).waitFor({ timeout: 30_000 })
  await sleep(1000)
  check('restarted: nothing told of the stored mail', (await notices(app)).length === 0)
  await openSettings(page)
  check('restarted: the switch still ON', await page.locator('#new-mail-notify-switch').isChecked())
  await page.locator('label', { has: page.locator('#new-mail-notify-switch') }).click()
  await page.waitForFunction(() => !document.querySelector('#new-mail-notify-switch').checked, null, { timeout: 5000 })
  check('turning it off asks nothing', (await page.locator('.new-mail-notice-ask').count()) === 0)
  await toMail(page)
  pop.add(mail('Kikapcsolás után'))
  await download(page, ['Kikapcsolás után'])
  await sleep(1000)
  check('OFF: a new message gives no notice', (await notices(app)).length === 0)
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  if (app) await app.close().catch(() => {})
  await pop.close()
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
const lines = mainLog.split('\n').filter(l => /new mail notice|notify shortcut/.test(l)).map(l => l.replace(/^\S+ \[\d+\] /, ''))
check('the main log: the notice lines (switch, numbers), no shortcut line in a run that is not the packaged program', JSON.stringify(lines) === JSON.stringify(['new mail notice switch on', 'new mail notice: 1', 'new mail notice: 1', 'new mail notice switch off']), JSON.stringify(lines))
const leaks = ['Kovács', 'anna@', 'ferenc@', 'Feladó', 'Árajánlat', 'Öt 1', 'Munkahelyi'].filter(s => mainLog.includes(s))
check('the main log: no sender, subject, address or account name', leaks.length === 0, leaks.join(', '))
const errLines = mainLog.trim().split('\n').filter(l => /failed|error/i.test(l))
check('the main log: no error or failure line', errLines.length === 0, errLines.join(' | '))
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
