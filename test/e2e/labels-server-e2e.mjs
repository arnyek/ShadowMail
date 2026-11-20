#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Labels on an IMAP account's server, in the real app: headless Electron + Playwright, the real imapflow on the TCP mini
// server (test/helpers/imap-wire.js). Not part of `npm test`.
//
//   E2E_LANG=hu|en node test/e2e/labels-server-e2e.mjs [--shots <dir>]
//
// An IMAP account on the mini server (INBOX with \* in its PERMANENTFLAGS, "Szigorú" without) with seeded rows, and an
// unreachable IMAP account with one seeded row. Measured: the picker puts a label on a message and takes it off, the
// keyword lands on the server as UID STORE +FLAGS / -FLAGS (never a FLAGS replace) and the row's chip follows; in the
// folder that does not allow keywords no STORE goes, the chip shows and the notice line says the label is kept on this
// computer only; on the unreachable account the label does not change, the chip goes back and the error line names
// the account. Seeded: a local label on a server row is uploaded by the first full run (the keyword on the server, the
// binding gone); a label on the server and on the unreachable account: Settings / Labels' delete takes it off the server,
// keeps the label and names the unreachable account in the dialog. main.log has no label name or keyword and no label
// failure, the page console stays clean.
// --shots <dir>: the label on, the notice line, the error line, the delete dialog and the account editor's connection
// test line, in the default and the dark theme (labels-server-<theme>-<screen>.png).
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { startImapWire } from '../helpers/imap-wire.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { Labels } from '../../core/db/labels.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-szerveres-cimke'
const now = Date.now()
// older than the account's index limit: the sync asks no body of the mini server (it has none)
const OLD = now - 4 * 365 * 86_400_000
const sleep = ms => new Promise(r => setTimeout(r, ms))
const STRICT = 'Szigorú'
const { values } = parseArgs({ options: { shots: { type: 'string' } } })
if (values.shots) fs.mkdirSync(values.shots, { recursive: true })

const wire = await startImapWire({
  folders: [
    { path: 'INBOX', mail: [{ uid: 1, flags: ['\\Seen', '$Forwarded', 'Idegen'] }, { uid: 2, flags: ['\\Seen', 'r=c3=a9gi'] }] },
    { path: STRICT, permanentFlags: ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft'], mail: [{ uid: 3, flags: ['\\Seen'] }] },
  ],
})
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-labels-server-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let wired, gone, old, upload
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  wired = store.save({ ...newAccountDefaults('imap'), ...base, name: 'IMAP szerverrel', email: 'w@example.invalid', in_port: wire.port, in_user: 'w', in_password: 'nem-valodi' }).account.id
  gone = store.save({ ...newAccountDefaults('imap'), ...base, name: 'IMAP elérhetetlen', email: 'i@example.invalid', in_port: 1, in_user: 'i', in_password: 'nem-valodi' }).account.id
  const index = new MailIndex(db)
  for (const [acc, p] of [[wired, 'INBOX'], [wired, STRICT], [gone, 'INBOX']]) index.upsertFolder({ account_id: acc, path: p, delimiter: '.', uidvalidity: '7', synced_at: now })
  const row = (account, folder, uid, subject, flags = '\\Seen') => ({ account_id: account, folder, uid, message_id: `<w${account}-${uid}@example.invalid>`, in_reply_to: null, refs: null,
    from_addr: 'k@example.invalid', from_name: 'Küldő', to_addrs: 'w@example.invalid', cc_addrs: '', subject, date: OLD - uid * 1000, idate: OLD - uid * 1000,
    flags, size: 500, has_attachments: 0, attachments: null, body_state: 3, sender_text: 'Küldő k@example.invalid', recipients_text: 'w@example.invalid' })
  // "Régi": its keyword on a server row and on the unreachable account's row (as synced before); "Feltöltendő": a local
  // binding on a server row (a data folder from before the server labels), uploaded by the first full run
  const labels = new Labels(db)
  old = labels.create('Régi', '#6d4c41')
  upload = labels.create('Feltöltendő', '#00897b')
  if (old.keyword !== 'r=c3=a9gi') throw new Error(`the seed's keyword: ${old.keyword}`)
  index.insertMany([
    row(wired, 'INBOX', 1, 'Szerveres első', '\\Seen $Forwarded Idegen'),
    row(wired, 'INBOX', 2, 'Szerveres második', `\\Seen ${old.keyword}`),
    row(wired, STRICT, 3, 'Szigorú mappa levele'),
    row(gone, 'INBOX', 1, 'Elérhetetlen levél', `\\Seen ${old.keyword}`),
  ])
  const second = db.prepare('SELECT id FROM messages WHERE account_id = ? AND uid = 2').get(wired).id
  labels.setLabels([second], { add: [upload.id] })
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
const consoleLines = []
const api = (page, group, method, ...args) => page.evaluate(([g, m, a]) => window.shadowMail[g][m](...a), [group, method, args])
const until = async (fn, what, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true
    await sleep(50)
  }
  throw new Error(`timed out: ${what}`)
}
// the screen in both themes, back to the default
const shoot = async (page, screen) => {
  if (!values.shots) return
  for (const theme of ['default', 'dark']) {
    await page.evaluate(th => (document.documentElement.dataset.theme = th), theme)
    await sleep(250)
    await page.screenshot({ path: path.join(values.shots, `labels-server-${theme}-${screen}.png`) })
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'default'))
}
const stores = () => wire.log.filter(l => /\bSTORE\b/i.test(l))
// the STOREs of one keyword (the first run also uploads a seeded label)
const storesOf = kw => stores().filter(l => l.endsWith(`(${kw})`))

let app = null
try {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`${m.type()}: ${m.text()}`) })
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  const folder = (acc, p) => page.locator(`.folder-tree section[data-account="${acc}"] .folder[data-path="${p}"]`)
  await folder(wired, 'INBOX').waitFor({ timeout: 20000 })
  // the first sync of the wired account has read the flags (UID FETCH ... FLAGS)
  await until(() => wire.log.some(l => /FETCH .*FLAGS/i.test(l)), 'the first sync')
  const label = (await api(page, 'labels', 'create', 'Ügyfél', '#2e7d32')).label
  check('the label has its keyword', /^[a-z0-9=._-]+$/.test(label.keyword), label.keyword)

  const row = subject => page.locator('.msg-row', { hasText: subject })
  const chip = subject => row(subject).locator(`.label-chip[data-label-id="${label.id}"]`)
  const pick = async subject => {
    await row(subject).locator('.col-check input').check()
    await page.locator('.action-bar .label-open').click()
    await page.locator('.label-picker').waitFor()
    await page.locator(`.label-picker-item[data-label-id="${label.id}"] input`).click()
  }
  const closePicker = async () => {
    await page.keyboard.press('Escape')
    await page.locator('.label-picker').waitFor({ state: 'detached' })
  }

  // 1. on: the server gets the keyword, one +FLAGS; the chip shows
  await folder(wired, 'INBOX').click()
  await until(async () => (await page.locator('.msg-row[data-id]').count()) === 2, 'two rows')
  await pick('Szerveres első')
  await until(() => wire.flagsOf('INBOX', 1).includes(label.keyword), 'the keyword on the server')
  await until(async () => (await chip('Szerveres első').count()) === 1, 'the chip')
  check('on: the keyword on the server, the other flags untouched', JSON.stringify(wire.flagsOf('INBOX', 1).sort()) === JSON.stringify(['$Forwarded', 'Idegen', '\\Seen', label.keyword].sort()), JSON.stringify(wire.flagsOf('INBOX', 1)))
  check('on: one UID STORE +FLAGS with the keyword', storesOf(label.keyword).length === 1 && /STORE 1 \+FLAGS(\.SILENT)? /.test(storesOf(label.keyword)[0]), stores().join(' | '))
  // 2. off: -FLAGS, the chip goes
  await page.locator(`.label-picker-item[data-label-id="${label.id}"] input`).click()
  await until(() => !wire.flagsOf('INBOX', 1).includes(label.keyword), 'off the server')
  await until(async () => (await chip('Szerveres első').count()) === 0, 'the chip gone')
  check('off: -FLAGS, the other flags still there', JSON.stringify(wire.flagsOf('INBOX', 1).sort()) === JSON.stringify(['$Forwarded', 'Idegen', '\\Seen']) && /-FLAGS/.test(storesOf(label.keyword)[1] || ''), stores().join(' | '))
  check('never a FLAGS replace', stores().every(l => /[+-]FLAGS/.test(l)))
  if (values.shots) {
    await page.locator(`.label-picker-item[data-label-id="${label.id}"] input`).click()
    await until(async () => (await chip('Szerveres első').count()) === 1, 'the chip again')
    await shoot(page, 'on')
    await page.locator(`.label-picker-item[data-label-id="${label.id}"] input`).click()
    await until(async () => (await chip('Szerveres első').count()) === 0, 'the chip gone again')
  }
  await closePicker()
  await row('Szerveres első').locator('.col-check input').uncheck()

  // 3. the folder that does not allow the keyword: no STORE, the chip shows, the notice line
  await folder(wired, STRICT).click()
  await until(async () => (await page.locator('.msg-row[data-id]').count()) === 1, 'the strict folder')
  const before = stores().length
  await pick('Szigorú mappa levele')
  await until(async () => (await page.locator('.action-notice').count()) === 1, 'the notice line')
  const notice = await page.locator('.action-notice').textContent()
  check('fallback: the notice line', notice.includes(t.labels.localOnly), notice)
  await until(async () => (await chip('Szigorú mappa levele').count()) === 1, 'the chip from the local binding')
  check('fallback: no STORE, the server unchanged', stores().length === before && JSON.stringify(wire.flagsOf(STRICT, 3)) === JSON.stringify(['\\Seen']), stores().slice(before).join(' | '))
  await shoot(page, 'local-only')
  await closePicker()
  await page.locator('.action-notice button').first().click()

  // 4. the unreachable account: nothing changes, the chip goes back, the error names the account
  await folder(gone, 'INBOX').click()
  await until(async () => (await page.locator('.msg-row[data-id]').count()) === 1, 'the unreachable folder')
  await pick('Elérhetetlen levél')
  await until(async () => (await page.locator('.action-error').count()) === 1, 'the error line', 600)
  const error = await page.locator('.action-error').textContent()
  const prefix = t.labels.serverError('IMAP elérhetetlen', 'connection_refused').split('IMAP elérhetetlen')[0]
  check('unreachable: the error line names the account', error.includes(prefix) && error.includes('IMAP elérhetetlen'), error)
  await until(async () => (await chip('Elérhetetlen levél').count()) === 0, 'the chip back')
  const listed = (await api(page, 'mail', 'list', { accountId: gone, folder: 'INBOX' })).rows[0]
  await shoot(page, 'error')
  check('unreachable: the row keeps only its old label, its flags unchanged', JSON.stringify(listed.labels) === JSON.stringify([old.id]) && listed.flags === `\\Seen ${old.keyword}`, JSON.stringify([listed.labels, listed.flags]))
  await closePicker()

  // 5. the upload of the first full run: the seeded local label is on the server now, the binding gone, the chip stays
  await until(() => wire.flagsOf('INBOX', 2).includes(upload.keyword), 'the upload')
  await folder(wired, 'INBOX').click()
  await until(async () => (await row('Szerveres második').locator(`.label-chip[data-label-id="${upload.id}"]`).count()) === 1, 'the uploaded chip')
  check('upload: the local label went to the server, the row still shows it', wire.flagsOf('INBOX', 2).includes(upload.keyword))
  check('upload: one +FLAGS for it', stores().filter(l => l.includes(upload.keyword)).length === 1, stores().join(' | '))

  // 6. Settings / Labels: delete "Régi" (on the server and on the unreachable account)
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.getByRole('button', { name: t.settingsNav.labels, exact: true }).click()
  await page.locator('.labels-settings').waitFor()
  await page.locator(`.labels-row[data-label-id="${old.id}"] .labels-delete`).click()
  await page.locator('.labels-delete-modal').waitFor()
  const ask = await page.locator('.labels-delete-modal .confirm-text').textContent()
  check('delete: the question says the server too', ask === t.labelsPage.deleteText('Régi', 2), ask)
  await page.locator('.labels-delete-yes').click()
  await until(async () => (await page.locator('.labels-delete-error').count()) === 1, 'the failure in the dialog', 600)
  const failText = await page.locator('.labels-delete-error').textContent()
  check('delete, one account out of reach: the dialog stays and names it', failText === t.labelsPage.deleteFailed('IMAP elérhetetlen'), failText)
  check('delete: the reachable server lost the keyword', !wire.flagsOf('INBOX', 2).includes(old.keyword), JSON.stringify(wire.flagsOf('INBOX', 2)))
  check('delete: one -FLAGS on the server', stores().filter(l => /-FLAGS/.test(l) && l.includes(old.keyword)).length === 1, stores().join(' | '))
  check('delete: the label stays (the list and the dialog)', (await page.locator(`.labels-row[data-label-id="${old.id}"]`).count()) === 1 && (await page.locator('.labels-delete-yes').isEnabled()))
  await shoot(page, 'delete')
  await page.locator('.labels-delete-cancel').click()
  await page.locator('.labels-delete-modal').waitFor({ state: 'detached' })
  if (values.shots) {
    // the account editor's connection test: the server allows keywords, so the labels are kept on it
    await page.getByRole('button', { name: t.settingsNav.accounts, exact: true }).click()
    await page.locator('.account-list li', { hasText: 'IMAP szerverrel' }).getByRole('button', { name: t.accountEdit, exact: true }).click()
    await page.getByRole('button', { name: t.accountTest, exact: true }).click()
    await page.locator('.probe-keywords').waitFor({ timeout: 20000 })
    check('shots: the connection test says the server allows labels', (await page.locator('.probe-keywords').textContent()) === t.probeKeywords(true), await page.locator('.probe-keywords').textContent())
    await page.locator('.probe-keywords').scrollIntoViewIfNeeded()
    await shoot(page, 'probe')
    await page.getByRole('button', { name: t.accountCancel, exact: true }).click()
  }

  const text = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8') : ''
  check('main.log: no label name or keyword', ![label.keyword, old.keyword, upload.keyword, 'Ügyfél', 'Régi', 'Feltöltendő'].some(x => text.includes(x)))
  check('main.log: no label failure', !/(labels:\w+|mail:label) failed/.test(text))
  check('the page console: no error or warning', consoleLines.length === 0, consoleLines.join(' | '))
} catch (err) {
  console.error(err)
  results.push(false)
} finally {
  if (app) await app.close().catch(() => {})
  await wire.close()
  fs.rmSync(work, { recursive: true, force: true })
}
const failed = results.filter(r => !r).length
console.log(`${results.length - failed}/${results.length} OK`)
process.exit(failed ? 1 : 0)
