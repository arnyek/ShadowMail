#!/usr/bin/env node
// POP3 account in the real app, headless Electron + Playwright, against the TCP fake POP3 server
// of the tests (127.0.0.1, random port; nothing leaves the machine). Not part of `npm test`.
//
//   node test/e2e/pop3-e2e.mjs [--shot <file.png>]
//
// Measures: the account's local folders in the tree, the downloaded messages in the list, a message
// opens from data/store, a second message arriving on the server shows up after "Frissítés".
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const { values } = parseArgs({ options: { shot: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-pop3'

const mail = (subject, body) =>
  Buffer.from(`From: POP3 Feladó <pop@example.invalid>\r\nTo: teszt@example.invalid\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`)

const server = await new FakePop3Server().listen()
server.add(mail('POP3 első levél', 'Első szöveg, ékezettel: árvíztűrő.'))
server.add(mail('POP3 második levél', '.pontos sor\r\nmásodik szöveg'))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-k10-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER) // vault.json + the encrypted mail.sqlite
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({
    ...newAccountDefaults('pop3'), name: 'POP3 mérőfiók', email: 'teszt@example.invalid', in_host: '127.0.0.1', in_port: server.port,
    in_security: 'none', in_user: server.user, in_password: server.pass, smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none',
  })
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').nth(1).waitFor({ timeout: 15000 })
  const folders = await page.locator('.folder-tree .folder-label').allInnerTexts()
  check('local folders in the tree', [t.folderRoles.inbox, t.folderRoles.drafts, t.folderRoles.sent, t.folderRoles.trash].every(f => folders.includes(f)), JSON.stringify(folders))
  const subjects = await page.locator('.msg-row .col-subject').allInnerTexts()
  check('both messages listed', subjects.includes('POP3 első levél') && subjects.includes('POP3 második levél'), JSON.stringify(subjects))
  await page.locator('.msg-row', { hasText: 'POP3 második levél' }).click()
  await page.locator('.reader .mail-text').waitFor()
  const text = await page.locator('.reader .mail-text').innerText()
  check('message opens from data/store (dot line intact)', text.includes('.pontos sor') && text.includes('második szöveg'), JSON.stringify(text))
  check('no "not marked read" warning (local flag)', (await page.locator('.reader .warn').count()) === 0)
  server.add(mail('POP3 harmadik levél', 'harmadik'))
  // the message is open in the list's place; Esc goes back to the list (and its Refresh)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: t.refresh, exact: true }).click()
  await page.locator('.msg-row', { hasText: 'POP3 harmadik levél' }).waitFor({ timeout: 15000 })
  check('a new message appears after "Frissítés"', true)
  const status = await page.locator('.status-bar').innerText()
  check('status bar without error', ![...Object.keys(t.syncErrors), ...Object.keys(t.probeErrors)].some(code => status.includes(t.syncError(code))) && !status.includes(t.syncStopped), status)
  check('three RETRs in total (nothing twice)', server.log.filter(l => l.startsWith('RETR')).length === 3, JSON.stringify(server.log.filter(l => /^(RETR|DELE)/.test(l))))
  // the POP3 "read on the server" help: for POP3 accounts only
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('.account-list li', { hasText: 'POP3' }).getByRole('button', { name: t.accountEdit, exact: true }).click()
  const help = page.locator('#acc-pop3-seen-help')
  await help.waitFor({ timeout: 5000 })
  check('account editor, POP3: the "read on the server" help shows', (await help.innerText()).includes(t.pop3SeenHelp), await help.innerText())
  await page.getByRole('button', { name: t.accountCancel, exact: true }).click()
  await page.getByRole('button', { name: t.accountNew, exact: true }).click()
  // the type is a menu (no native <select>)
  await page.locator('#acc-type').click()
  await page.getByRole('menuitemradio', { name: t.typeLabels.imap, exact: true }).click()
  check('account editor, IMAP: no POP3 help', (await page.locator('#acc-pop3-seen-help').count()) === 0)
  await page.locator('#acc-type').click()
  await page.getByRole('menuitemradio', { name: t.typeLabels.pop3, exact: true }).click()
  check('account editor, new POP3: the help shows', (await page.locator('#acc-pop3-seen-help').count()) === 1)
  if (values.shot) await page.screenshot({ path: values.shot })
} catch (err) {
  check('run', false, err.stack)
} finally {
  await app.close().catch(() => {})
  await server.close()
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
