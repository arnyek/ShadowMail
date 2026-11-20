#!/usr/bin/env node
// The composer's own close button (the header's X) asks like the window frame's X, in the real app (headless Electron +
// Playwright). Not part of `npm test`.
//
//   node test/e2e/compose-close-e2e.mjs          (E2E_LANG=en: the same in English)
//
// Until this change the header button called window.close(), which never reached the main process's close guard: a
// typed, unsaved message closed without a question (measured). One POP3 account (fake POP3 server):
// 1. Text typed, the header's close button: the close question, the window stays; Cancel: the window and the text stay.
// 2. Again, then Discard: the window closes.
// 3. A new message with nothing changed: the header's button closes it at once, no question.
// 4. Text typed and saved as a draft: closes at once, no question.
// 5. Saved, then more text typed: the question again; Save as draft: the window closes, Drafts holds the new text.
// 6. The window frame's X (the main process closes it) with unsaved text: the question, as before.
// The renderer console has no error or warning, the main log no error line.
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
import { t, locale, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-bezaras'
const savedHint = (d => t.composeSavedAt(d).replace(d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }), '').trim())(new Date())

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

const pop = await new FakePop3Server().listen()
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-close-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({
    ...newAccountDefaults('pop3'), name: 'A-fiók', email: 'a@example.invalid', display_name: 'Anna', signature: 'Üdv',
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: 9, smtp_security: 'none',
  })
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`main ${m.type()}: ${m.text()}`))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.folder-tree .folder').first().waitFor()
  const newMessage = async () => {
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: t.newMessage, exact: true }).click()])
    win.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`composer ${m.type()}: ${m.text()}`))
    await win.setViewportSize({ width: 900, height: 700 })
    await win.locator('.editor').waitFor()
    await win.waitForFunction(() => document.querySelector('.editor')?.textContent)
    return win
  }
  const type = async (win, text) => {
    await win.locator('.editor').click()
    await win.keyboard.press('Control+Home')
    await win.keyboard.type(text)
  }
  const headerClose = win => win.locator('header').getByRole('button', { name: t.composeCloseWindow, exact: true })
  // the header's close button pressed: 'closed' (within 5 s) or the close question's text
  const pressClose = async win => {
    const closed = win.waitForEvent('close', { timeout: 5000 }).then(() => 'closed', () => null)
    await headerClose(win).click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    const question = win
      .getByRole('alertdialog')
      .waitFor({ timeout: 5000 })
      .then(() => win.getByRole('alertdialog').innerText(), () => null)
    return Promise.race([closed.then(r => r || question), question.then(q => q || closed)])
  }
  const dialogButton = (win, name) => win.getByRole('alertdialog').getByRole('button', { name, exact: true })
  const clickClosing = async (win, locator) => {
    const closed = win.waitForEvent('close', { timeout: 15_000 }).then(() => true, () => false)
    await locator.click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    return closed
  }

  // 1. unsaved text: the question; Cancel keeps it all
  let win = await newMessage()
  await type(win, 'Fontos, még nem mentett szöveg. ')
  let r = await pressClose(win)
  check('unsaved text + the header\'s close button: the close question, the window stays', typeof r === 'string' && r.includes(t.composeCloseTitle) && !win.isClosed(), String(r))
  await dialogButton(win, t.confirmCancel).click()
  await win.getByRole('alertdialog').waitFor({ state: 'detached' })
  await win.waitForTimeout(500)
  const kept = win.isClosed() ? null : await win.evaluate(() => document.querySelector('.editor').innerText)
  check('Cancel: the window and the text stay', kept && kept.includes('Fontos, még nem mentett szöveg.'), String(kept))

  // 2. Discard closes
  r = await pressClose(win)
  check('the question again', typeof r === 'string' && r.includes(t.composeCloseTitle), String(r))
  check('Discard: the window closes', await clickClosing(win, dialogButton(win, t.composeDiscard)))

  // 3. nothing changed: closes at once
  win = await newMessage()
  r = await pressClose(win)
  check('a new message with nothing changed: the header\'s button closes it, no question', r === 'closed', String(r))

  // 4. saved: closes at once
  win = await newMessage()
  await type(win, 'Mentett piszkozat. ')
  await win.getByRole('button', { name: t.composeSaveDraft, exact: true }).click()
  await win.locator('.hint[role="status"]').filter({ hasText: savedHint }).waitFor({ timeout: 15_000 })
  r = await pressClose(win)
  check('saved as a draft: closes at once, no question', r === 'closed', String(r))

  // 5. saved, then changed: the question; Save as draft closes and saves
  win = await newMessage()
  await win.locator('#compose-subject').fill('Bezárás-próba')
  await type(win, 'Első változat. ')
  await win.getByRole('button', { name: t.composeSaveDraft, exact: true }).click()
  await win.locator('.hint[role="status"]').filter({ hasText: savedHint }).waitFor({ timeout: 15_000 })
  await type(win, 'Második változat. ')
  r = await pressClose(win)
  check('saved, then more text: the question again', typeof r === 'string' && r.includes(t.composeCloseTitle), String(r))
  check('Save as draft: the window closes', await clickClosing(win, dialogButton(win, t.composeSaveAndClose)))
  const drafts = await page.evaluate(async () => {
    const { accounts } = await window.shadowMail.mail.folders()
    const a = accounts[0]
    const drafts = a.folders.find(f => /draft/i.test(f.path)) || a.folders.find(f => f.path === 'Drafts')
    const list = await window.shadowMail.mail.list({ accountId: a.id, folder: drafts.path })
    return list.rows.filter(m => m.subject === 'Bezárás-próba').map(m => m.preview || '')
  }).catch(e => [`error: ${e.message}`])
  check('Drafts holds the message once, with the second text', drafts.length === 1 && drafts[0].includes('Második változat.'), JSON.stringify(drafts))

  // 6. the frame's X: as before
  win = await newMessage()
  await type(win, 'Keret X. ')
  const sid = await win.evaluate(() => window.location.hash.replace('#compose=', ''))
  await app.evaluate(({ BrowserWindow }, sid) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes(`compose=${sid}`)).close(), sid)
  const q = await win.getByRole('alertdialog').waitFor({ timeout: 5000 }).then(() => win.getByRole('alertdialog').innerText(), () => null)
  check('the window frame\'s X with unsaved text: the question, as before', q && q.includes(t.composeCloseTitle) && !win.isClosed(), String(q))
  await dialogButton(win, t.confirmCancel).click()
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  await app.close().catch(() => {})
  await pop.close()
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
