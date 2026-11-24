#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The Archive action in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/archive-e2e.mjs
//
// A POP3 account (fake POP3 server) with a local "Archívum" and its year folder "Archívum/2024", and an unreachable
// IMAP account. Measured: the row's archive button files a 2024 message into Archívum/2024 (no folder created, no
// notice); the toolbar's archive button on the rest files them by year, creates the missing Archívum/2025, says so in
// a notice and shows the new folder in the tree; inside a year folder there is no archive button; the account editor
// offers the archive mode for IMAP only, and the IMAP choice is saved. The row's quick buttons are aria-hidden: they
// are found by their aria-label. Two languages: E2E_LANG=en|hu.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-archivum'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const noon = (y, m, d) => new Date(y, m, d, 12) // local noon: the year the user reads

const server = await new FakePop3Server().listen()
const MAILS = [['POP 1', noon(2024, 5, 15)], ['POP 2', noon(2025, 2, 10)], ['POP 3', noon(2025, 8, 1)], ['POP 4', noon(2024, 0, 20)]]
for (const [subject, date] of MAILS) server.add(Buffer.from(`From: f@example.invalid\r\nSubject: ${subject}\r\nDate: ${date.toUTCString()}\r\n\r\nszöveg\r\n`))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-archive-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let pop, imap
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  pop = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'Első fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass }).account.id
  imap = store.save({ ...newAccountDefaults('imap'), ...base, name: 'Második fiók', email: 'b@example.invalid', in_port: 1, in_user: 'b', in_password: 'nem-valodi' }).account.id
  const index = new MailIndex(db)
  for (const p of ['Archívum', 'Archívum/2024']) index.addFolder(pop, p, '/', true)
  index.upsertFolder({ account_id: imap, path: 'INBOX', delimiter: '/', uidvalidity: '1', synced_at: Date.now() })
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const problems = []
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
const quits = () => server.log.filter(l => l === 'QUIT').length
const folderSel = p => `.folder-tree section[data-account="${pop}"] .folder[data-path="${p}"]`
const subjectsIn = (page, folder) =>
  page.evaluate(async q => (await window.shadowMail.mail.list({ ...q, sort: 'date', dir: 'asc', offset: 0, limit: 50 })).rows.map(r => r.subject), { accountId: pop, folder })
const until = async (fn, what, ms = 8000) => {
  const t0 = performance.now()
  while (!(await fn())) {
    if (performance.now() - t0 > ms) throw new Error(`timed out: ${what}`)
    await sleep(50)
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

let app
try {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => m.type() === 'error' && !/ERR_CONNECTION_REFUSED|connect ECONNREFUSED/.test(m.text()) && problems.push(m.text()))
  page.on('pageerror', e => problems.push(e.message))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator(folderSel('INBOX')).waitFor({ timeout: 20_000 })
  await until(() => quits() > 0, 'the first POP3 fetch', 20_000)
  await page.locator(folderSel('INBOX')).click()
  await page.locator('.msg-row', { hasText: 'POP 4' }).waitFor()

  // 1. the row's archive button: a 2024 message into the existing year folder, nothing created
  const row = page.locator('.msg-row', { hasText: 'POP 1' })
  await row.hover()
  await row.locator(`.row-quick button[aria-label="${t.actions.archive}"]`).click()
  await until(async () => (await subjectsIn(page, 'Archívum/2024')).includes('POP 1'), 'POP 1 in Archívum/2024')
  check('row button: POP 1 (2024) in Archívum/2024', true)
  await sleep(300)
  check('row button: no notice (no folder created)', (await page.locator('.action-notice').count()) === 0)
  check('row button: the Archive itself stays empty', same(await subjectsIn(page, 'Archívum'), []))

  // 2. the toolbar on the rest: by year, Archívum/2025 created and reported
  await page.locator('.msg-viewport').focus()
  await page.keyboard.press('Control+a')
  await page.waitForFunction(text => document.querySelector('.selection-count')?.innerText.includes(text), t.selectedCount(3))
  await page.locator('.action-bar').getByRole('button', { name: t.actions.archive, exact: true }).click()
  await page.locator('.action-notice').waitFor({ timeout: 8000 })
  const notice = (await page.locator('.action-notice').innerText()).trim()
  check('toolbar: the notice names the created folder', notice.includes(t.archiveCreated(['Archívum/2025'])), notice)
  await until(async () => (await subjectsIn(page, 'INBOX')).length === 0, 'INBOX empty')
  check('toolbar: INBOX empty', true)
  check('toolbar: Archívum/2024 = POP 4, POP 1', same(await subjectsIn(page, 'Archívum/2024'), ['POP 4', 'POP 1']), JSON.stringify(await subjectsIn(page, 'Archívum/2024')))
  check('toolbar: Archívum/2025 = POP 2, POP 3', same(await subjectsIn(page, 'Archívum/2025'), ['POP 2', 'POP 3']), JSON.stringify(await subjectsIn(page, 'Archívum/2025')))
  await page.locator(folderSel('Archívum/2025')).waitFor({ timeout: 5000 })
  check('the new year folder is in the tree', true)

  // 3. no archive button inside a year folder (the Archive itself: test/archive-yearly.test.js and the same inArchive)
  await page.locator(folderSel('Archívum/2025')).click()
  const inYear = page.locator('.msg-row', { hasText: 'POP 2' })
  await inYear.waitFor()
  await inYear.hover()
  check('year folder: the row quick buttons are there (delete)', (await inYear.locator(`.row-quick button[aria-label="${t.actions.delete}"]`).count()) === 1)
  check('year folder: no row archive button', (await inYear.locator(`.row-quick button[aria-label="${t.actions.archive}"]`).count()) === 0)
  await page.locator('.msg-viewport').focus()
  await page.keyboard.press('Control+a')
  await page.waitForFunction(text => document.querySelector('.selection-count')?.innerText.includes(text), t.selectedCount(2))
  check('year folder: the toolbar is there (delete)', (await page.locator('.action-bar').getByRole('button', { name: t.actions.delete, exact: true }).count()) === 1)
  check('year folder: no toolbar archive button', (await page.locator('.action-bar').getByRole('button', { name: t.actions.archive, exact: true }).count()) === 0)
  const direct = await page.evaluate(async q => window.shadowMail.mail.action(q), { ids: [1], action: 'archive', target: 'Archívum' })
  check('IPC: archive with a target is a bad request', same(direct, { ok: false, error: 'bad_request' }), JSON.stringify(direct))

  // 4. the account editor: the archive mode for IMAP only; the choice is saved
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('.settings-tab', { hasText: t.settingsNav.accounts }).click()
  const edit = page.getByRole('button', { name: t.accountEdit, exact: true })
  await edit.first().waitFor()
  const editors = await edit.count()
  const seen = {}
  for (let i = 0; i < editors; i++) {
    await page.getByRole('button', { name: t.accountEdit, exact: true }).nth(i).click()
    await page.locator('form.account-editor').waitFor()
    const type = (await page.locator('#acc-archive_mode').count()) ? 'with' : 'without'
    const isImap = (await page.locator('form.account-editor fieldset.folder-roles').count()) > 0 || (await page.locator('#acc-save_sent_to_server').count()) > 0
    seen[isImap ? 'imap' : 'pop3'] = type
    if (isImap) {
      check('IMAP editor: the select shows Automatic', (await page.locator('#acc-archive_mode').innerText()).includes(t.archiveModes['']))
      await page.locator('#acc-archive_mode').click()
      await page.locator('.menu [role^="menuitem"], .menu [role="option"]', { hasText: t.archiveModes.single }).first().click()
      await page.locator('form.account-editor button[type="submit"]').click()
      await until(async () => (await page.locator('form.account-editor').count()) === 0, 'the editor closed after the save')
      const saved = await page.evaluate(async id => (await window.shadowMail.accounts.list()).accounts.find(a => a.id === id).archive_mode, imap)
      check('IMAP: the archive mode is saved (single)', saved === 'single', String(saved))
    } else {
      await page.getByRole('button', { name: t.accountCancel, exact: true }).click()
      await until(async () => (await page.locator('form.account-editor').count()) === 0, 'the editor closed')
    }
  }
  check('the archive mode: IMAP has it, POP3 does not', seen.imap === 'with' && seen.pop3 === 'without', JSON.stringify(seen))

  const log = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8') : ''
  check('main.log: the year folder created, by year only', /archive: a year folder created \(2025\)/.test(log) && !log.includes('Archívum/2025'))
  check('no console error', problems.length === 0, problems.join(' | '))
} catch (err) {
  check('run', false, err.stack)
} finally {
  if (app) await app.close().catch(() => {})
  await server.close()
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
