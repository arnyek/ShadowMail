#!/usr/bin/env node
// Folder management in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/folders-e2e.mjs [--shot <file.png>]
//
// A POP3 account (local folders, fake POP3 server) drives every UI path; an unreachable IMAP account
// (127.0.0.1:1) shows the error path. The server side of IMAP folders is in test/folder-actions.test.js.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const { values } = parseArgs({ options: { shot: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-mappak'
const now = Date.now()

const server = await new FakePop3Server().listen()
for (let i = 1; i <= 3; i++) server.add(Buffer.from(`From: f${i}@example.invalid\r\nSubject: POP ${i}\r\nDate: ${new Date(now - i * 60_000).toUTCString()}\r\n\r\nszöveg ${i}\r\n`))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-k12-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER) // vault.json + the encrypted mail.sqlite
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  store.save({ ...newAccountDefaults('pop3'), ...base, name: 'POP3-fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass })
  const imap = store.save({ ...newAccountDefaults('imap'), ...base, name: 'IMAP elérhetetlen', email: 'i@example.invalid', in_port: 1, in_user: 'i', in_password: 'nem-valodi' }).account
  const index = new MailIndex(db)
  index.upsertFolder({ account_id: imap.id, path: 'INBOX', delimiter: '/', uidvalidity: '1', synced_at: now })
  index.upsertFolder({ account_id: imap.id, path: 'Projektek', delimiter: '/', uidvalidity: '1', synced_at: now })
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  const pop = page.locator('.folder-tree section', { hasText: 'POP3-fiók' })
  const imap = page.locator('.folder-tree section', { hasText: 'IMAP elérhetetlen' })
  const folder = (sec, p) => sec.locator(`.folder[data-path="${p}"]`)
  await folder(pop, 'INBOX').waitFor({ timeout: 20000 })
  const dialog = page.getByRole('dialog')
  const nameIt = async (name, ok) => {
    await dialog.getByLabel(t.folderNameLabel).fill(name)
    await dialog.getByRole('button', { name: ok, exact: true }).click()
  }

  // a role folder: rename and delete are not available
  await folder(pop, 'Trash').click({ button: 'right' })
  const menu = page.getByRole('menu')
  check('role folder: rename and delete disabled', (await menu.getByRole('menuitem', { name: t.folderMenu.rename }).isDisabled()) && (await menu.getByRole('menuitem', { name: t.folderMenu.delete }).isDisabled()) && !(await menu.getByRole('menuitem', { name: t.folderMenu.newSub }).isDisabled()))
  await page.keyboard.press('Escape')

  // new top-level folder with "+"
  await pop.getByRole('button', { name: t.newFolderTitle('POP3-fiók') }).click()
  await nameIt('Számlák', t.folderCreate)
  await folder(pop, 'Számlák').waitFor()
  check('"+": new top-level folder, selected', (await folder(pop, 'Számlák').getAttribute('aria-current')) === 'true')

  // a duplicate name: the error stays in the dialog
  await pop.getByRole('button', { name: t.newFolderTitle('POP3-fiók') }).click()
  await nameIt('számlák', t.folderCreate)
  await dialog.getByRole('alert').waitFor()
  check('duplicate name: error in the dialog', (await dialog.getByRole('alert').innerText()).includes(t.folderErrors.folder_exists))
  await dialog.getByRole('button', { name: t.confirmCancel, exact: true }).click()

  // a subfolder from the context menu
  await folder(pop, 'Számlák').click({ button: 'right' })
  await page.getByRole('menuitem', { name: t.folderMenu.newSub }).click()
  await nameIt('2026', t.folderCreate)
  await folder(pop, 'Számlák/2026').waitFor()
  // the depth is the --depth CSS variable of the folder button (it was the li's padding)
  const sub = await folder(pop, 'Számlák/2026').evaluate(el => ({ depth: el.style.getPropertyValue('--depth'), left: getComputedStyle(el).paddingLeft }))
  const top = await folder(pop, 'Számlák').evaluate(el => getComputedStyle(el).paddingLeft)
  check('subfolder created under its parent (indented)', sub.depth === '1' && parseFloat(sub.left) > parseFloat(top), `${JSON.stringify(sub)} vs ${top}`)

  // rename the parent: the subfolder follows, the selection follows
  await folder(pop, 'Számlák').click()
  await folder(pop, 'Számlák').click({ button: 'right' })
  await page.getByRole('menuitem', { name: t.folderMenu.rename }).click()
  await nameIt('Bejövő számlák', t.folderRename)
  await folder(pop, 'Bejövő számlák/2026').waitFor()
  check('rename: the subfolder follows, the selection stays on it', (await folder(pop, 'Számlák').count()) === 0 && (await folder(pop, 'Bejövő számlák').getAttribute('aria-current')) === 'true')

  // put a message into the subfolder, then delete it: the warning names the count
  await folder(pop, 'INBOX').click()
  await page.locator('.msg-row', { hasText: 'POP 1' }).dragTo(folder(pop, 'Bejövő számlák/2026'))
  await page.locator('.msg-row', { hasText: 'POP 1' }).waitFor({ state: 'detached' })
  await folder(pop, 'Bejövő számlák').click({ button: 'right' })
  await page.getByRole('menuitem', { name: t.folderMenu.delete }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: t.folderDelete }).click()
  await page.locator('.sidebar .error').waitFor()
  check('a folder with subfolders is not deleted', (await page.locator('.sidebar .error').innerText()).includes(t.folderErrors.has_children) && (await folder(pop, 'Bejövő számlák').count()) === 1)
  await folder(pop, 'Bejövő számlák/2026').click({ button: 'right' })
  await page.getByRole('menuitem', { name: t.folderMenu.delete }).click()
  const warn = await page.getByRole('alertdialog').innerText()
  check('non-empty folder: the warning names the messages', warn.includes(t.confirmFolderDelete('2026', 1)), warn)
  await page.getByRole('alertdialog').getByRole('button', { name: t.folderDelete }).click()
  await folder(pop, 'Bejövő számlák/2026').waitFor({ state: 'detached' })
  check('deleted after confirmation', true)

  // the unreachable IMAP account: the error is shown, nothing changes
  await folder(imap, 'Projektek').click({ button: 'right' })
  await page.getByRole('menuitem', { name: t.folderMenu.rename }).click()
  await nameIt('Ügyek', t.folderRename)
  await dialog.getByRole('alert').waitFor({ timeout: 15000 })
  const err = await dialog.getByRole('alert').innerText()
  check('IMAP without a connection: error, the folder keeps its name', err.includes(t.folderError('connection_refused')) && (await folder(imap, 'Projektek').count()) === 1, err)
  if (values.shot) await page.screenshot({ path: values.shot })
  await dialog.getByRole('button', { name: t.confirmCancel, exact: true }).click()
} catch (err) {
  check('run', false, err.stack)
} finally {
  await app.close().catch(() => {})
  await server.close()
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
