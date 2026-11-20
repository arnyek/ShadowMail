#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The folder menu's "Move…", keyboard only, in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   E2E_LANG=hu|en node test/e2e/move-dialog-e2e.mjs [--shots <dir>]
//
// A POP3 account's local folders (the move is local): the folder focused, Shift+F10 opens its menu, the arrows reach
// "Move…", Enter opens the dialog with the focus on the target list; a refused target (its present parent) says why and
// Enter does nothing on it; Enter on an allowed one asks the same confirmation as a drop, Enter moves; the focus ends on
// the moved folder. The same to the top level (Home). Esc in the dialog: nothing moves, the focus back on the folder.
// A role folder's menu has "Move…" off. The page console stays clean, the main log names no folder.
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

const { values } = parseArgs({ options: { shots: { type: 'string' } } })
if (values.shots) fs.mkdirSync(values.shots, { recursive: true })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-athelyezes-menu'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const pop3 = await new FakePop3Server().listen()
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-move-dialog-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let popId
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  popId = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'POP3-fiók', email: 'p@example.invalid', in_port: pop3.port, in_user: pop3.user, in_password: pop3.pass }).account.id
  const index = new MailIndex(db)
  for (const p of ['Akta', 'Akta/Belső', 'Akta/Belső/xyz', 'Cél', 'Dolgok']) index.addFolder(popId, p, '/', true)
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const until = async (fn, what, ms = 8000) => {
  const t0 = performance.now()
  while (performance.now() - t0 < ms) {
    if (await fn()) return true
    await sleep(50)
  }
  throw new Error(`timed out: ${what}`)
}
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
const consoleLines = []

let app = null
try {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`${m.type()}: ${m.text()}`) })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  const sec = page.locator(`.folder-tree section[data-account="${popId}"]`)
  const folder = p => sec.locator(`.folder[data-path="${p}"]`)
  const focused = () => page.evaluate(() => ({ path: document.activeElement?.dataset?.path ?? null, role: document.activeElement?.getAttribute('role'), text: document.activeElement?.textContent?.trim() }))
  const listbox = page.locator('.move-folder-dialog [role="listbox"]')
  const activePath = () => page.evaluate(() => {
    const lb = document.querySelector('.move-folder-dialog [role="listbox"]')
    return document.getElementById(lb.getAttribute('aria-activedescendant'))?.dataset.path ?? null
  })
  const confirm = page.getByRole('alertdialog')
  await folder('Akta/Belső/xyz').waitFor({ timeout: 20000 })

  // the folder's menu from the keyboard: the focus on it, Shift+F10, the arrows to "Move…", Enter
  const openMove = async p => {
    await folder(p).focus()
    await page.keyboard.press('Shift+F10')
    await page.locator('.context-menu [role="menuitem"]').first().waitFor({ timeout: 3000 })
    for (let i = 0; i < 10 && (await focused()).text !== t.folderMenu.move; i++) await page.keyboard.press('ArrowDown')
    const on = (await focused()).text === t.folderMenu.move
    await page.keyboard.press('Enter')
    return on
  }
  const toTarget = async p => {
    for (let i = 0; i < 20 && (await activePath()) !== p; i++) await page.keyboard.press('ArrowDown')
    return (await activePath()) === p
  }

  // 1. Akta/Belső into Cél, keyboard only
  check('Shift+F10 opens the folder menu, the arrows reach "Move…"', await openMove('Akta/Belső'))
  await listbox.waitFor({ timeout: 3000 })
  check('the dialog: its title names the folder, the target list has the focus', (await page.locator('.move-folder-dialog').innerText()).includes(t.moveDialog.title('Belső')) && (await focused()).role === 'listbox')
  check('the first allowed target is active (the top level)', (await activePath()) === '')
  await toTarget('Akta')
  const why = await page.evaluate(() => {
    const lb = document.querySelector('.move-folder-dialog [role="listbox"]')
    const o = document.getElementById(lb.getAttribute('aria-activedescendant'))
    return { disabled: o.getAttribute('aria-disabled'), why: document.getElementById(o.getAttribute('aria-describedby'))?.textContent }
  })
  check('its present parent: disabled, the reason is the option\'s description', why.disabled === 'true' && why.why === t.moveDialog.reasons.parent, JSON.stringify(why))
  await page.keyboard.press('Enter')
  await sleep(200)
  check('Enter on a refused target: the dialog stays, no confirmation', (await listbox.count()) === 1 && (await confirm.count()) === 0)
  check('down to Cél', await toTarget('Cél'))
  if (values.shots) await page.screenshot({ path: path.join(values.shots, 'move-dialog.png') })
  await page.keyboard.press('Enter')
  await confirm.waitFor({ timeout: 3000 })
  const ask = await confirm.locator('.confirm-text').innerText()
  check('the drop\'s confirmation: the folder, the target, its subfolder', ask === t.confirmFolderMove('Belső', 'Cél', 1), ask)
  await page.keyboard.press('Enter')
  await folder('Cél/Belső').waitFor({ timeout: 5000 })
  await until(async () => (await focused()).path === 'Cél/Belső', 'the focus on the moved folder', 3000).catch(() => {})
  check('moved: Cél/Belső and Cél/Belső/xyz, Akta/Belső gone', (await folder('Cél/Belső/xyz').count()) === 1 && (await folder('Akta/Belső').count()) === 0)
  check('the focus ends on the moved folder', (await focused()).path === 'Cél/Belső', JSON.stringify(await focused()))

  // 2. Cél/Belső/xyz to the top level: Home is the top level
  check('the menu again from the keyboard', await openMove('Cél/Belső/xyz'))
  await listbox.waitFor({ timeout: 3000 })
  await page.keyboard.press('End')
  await page.keyboard.press('Home')
  check('Home: the top level', (await activePath()) === '')
  await page.keyboard.press('Enter')
  await confirm.waitFor({ timeout: 3000 })
  const askTop = await confirm.locator('.confirm-text').innerText()
  check('the top level asks with the account\'s name', askTop === t.confirmFolderMove('xyz', 'POP3-fiók', 0), askTop)
  await page.keyboard.press('Enter')
  await folder('xyz').waitFor({ timeout: 5000 })
  await until(async () => (await focused()).path === 'xyz', 'the focus on the moved folder', 3000).catch(() => {})
  check('at the top level, the focus on it', (await folder('Cél/Belső/xyz').count()) === 0 && (await focused()).path === 'xyz', JSON.stringify(await focused()))

  // 3. Esc: nothing moves, the focus back on the folder
  check('the menu on Dolgok', await openMove('Dolgok'))
  await listbox.waitFor({ timeout: 3000 })
  await toTarget('Cél')
  await page.keyboard.press('Escape')
  await listbox.waitFor({ state: 'detached', timeout: 3000 })
  await until(async () => (await focused()).path === 'Dolgok', 'the focus back', 3000).catch(() => {})
  check('Esc: closed, nothing moved, the focus back on the folder', (await folder('Dolgok').count()) === 1 && (await folder('Cél/Dolgok').count()) === 0 && (await focused()).path === 'Dolgok', JSON.stringify(await focused()))

  // 3b. a target chosen, then Esc in the CONFIRMATION: nothing moves, the focus back on the folder (not the page)
  check('the menu on Dolgok again', await openMove('Dolgok'))
  await listbox.waitFor({ timeout: 3000 })
  await toTarget('Cél')
  await page.keyboard.press('Enter')
  await confirm.waitFor({ timeout: 3000 })
  await page.keyboard.press('Escape')
  await confirm.waitFor({ state: 'detached', timeout: 3000 })
  await until(async () => (await focused()).path === 'Dolgok', 'the focus back after the confirmation', 3000).catch(() => {})
  check('Esc in the confirmation: nothing moved, the focus back on the folder', (await folder('Dolgok').count()) === 1 && (await folder('Cél/Dolgok').count()) === 0 && (await focused()).path === 'Dolgok', JSON.stringify(await focused()))
  // the same with the Cancel button (Tab to it, Enter)
  check('the menu on Dolgok, Cancel', await openMove('Dolgok'))
  await listbox.waitFor({ timeout: 3000 })
  await toTarget('Cél')
  await page.keyboard.press('Enter')
  await confirm.waitFor({ timeout: 3000 })
  await confirm.getByRole('button', { name: t.confirmCancel, exact: true }).focus()
  await page.keyboard.press('Enter')
  await confirm.waitFor({ state: 'detached', timeout: 3000 })
  await until(async () => (await focused()).path === 'Dolgok', 'the focus back after Cancel', 3000).catch(() => {})
  check('Cancel in the confirmation: the focus back on the folder', (await folder('Cél/Dolgok').count()) === 0 && (await focused()).path === 'Dolgok', JSON.stringify(await focused()))

  // 4. a role folder: "Move…" is off (the arrows skip it)
  await folder('Trash').focus()
  await page.keyboard.press('Shift+F10')
  await page.locator('.context-menu [role="menuitem"]').first().waitFor({ timeout: 3000 })
  const off = await page.locator('.context-menu [role="menuitem"]', { hasText: t.folderMenu.move }).isDisabled()
  check('a role folder: "Move…" off', off)
  await page.keyboard.press('Escape')

  const text = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8') : ''
  check('main.log: no folder name', !['Akta', 'Belső', 'Cél', 'Dolgok', 'xyz'].some(n => text.includes(n)))
  check('the page console: no error or warning', consoleLines.length === 0, consoleLines.join(' | '))
} catch (err) {
  console.error(err)
  results.push(false)
} finally {
  if (app) await app.close().catch(() => {})
  await pop3.close?.()
  fs.rmSync(work, { recursive: true, force: true })
}
const failed = results.filter(r => !r).length
console.log(`${results.length - failed}/${results.length} OK`)
process.exit(failed ? 1 : 0)
