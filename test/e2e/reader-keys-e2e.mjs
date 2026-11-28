#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The reader keys and the next message after a delete or an archive, in the real app (headless Electron + Playwright).
// Not part of `npm test`.
//
//   node test/e2e/reader-keys-e2e.mjs
//
// A POP3 account (fake POP3 server) with six messages and a local "Archívum", the reader on the right. Measured: Down /
// Up open the message below / above in the list's order (nothing at the top); Delete deletes the open message and the
// one below opens; End archives it and the one below opens; the reader's Archive button does the same; deleting the
// LAST open message with the row's button opens the one above; Up / Down / Delete / End typed inside the HTML message's
// frame (it runs no script) reach the app through the main process (its before-input-event raised with the frame
// focused: a real keyboard cannot type into the frame headless), PageDown there does not step; a focused divider keeps its arrows; in the
// Archive End only says why (the Archive button there disabled in its place); in the search hits Down steps in the hits' order. Two languages: E2E_LANG=en|hu.
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
const MASTER = 'Teszt-mesterjelszo-billentyuk'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const server = await new FakePop3Server().listen()
// the list (newest first): Hat, Öt, Négy, Három, Kettő, Egy; "Hat" is an HTML message (the reader shows it in a frame)
const plain = (subject, day) => `From: f@example.invalid\r\nSubject: ${subject}\r\nDate: ${new Date(2025, 3, day, 12).toUTCString()}\r\n\r\nszöveg ${subject}\r\n`
for (const [s, d] of [['Egy', 1], ['Kettő', 2], ['Három', 3], ['Négy', 4], ['Öt', 5]]) server.add(Buffer.from(plain(s, d)))
server.add(Buffer.from(`From: f@example.invalid\r\nSubject: Hat\r\nDate: ${new Date(2025, 3, 6, 12).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hat HTML</p>${'<p>sor</p>'.repeat(200)}\r\n`))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-reader-keys-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let pop
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  pop = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'Első fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass }).account.id
  new MailIndex(db).addFolder(pop, 'Archívum', '/', true)
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const problems = []
const quits = () => server.log.filter(l => l === 'QUIT').length
const folderSel = p => `.folder-tree section[data-account="${pop}"] .folder[data-path="${p}"]`
const subjectsIn = (page, folder) =>
  page.evaluate(async q => (await window.shadowMail.mail.list({ ...q, sort: 'date', dir: 'desc', offset: 0, limit: 50 })).rows.map(r => r.subject), { accountId: pop, folder })
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
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator(folderSel('INBOX')).waitFor({ timeout: 20_000 })
  await until(() => quits() > 0, 'the first POP3 fetch', 20_000)
  // the reader on the right: the list stays (its row buttons, its focus)
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.getByRole('button', { name: t.settingsNav.appearance, exact: true }).click()
  await page.getByRole('button', { name: t.readerPaneLabel, exact: true }).click()
  await page.getByRole('menuitemradio', { name: t.readerPaneOptions.right, exact: true }).click()
  await page.getByRole('button', { name: t.backToMail, exact: true }).click()
  await page.locator(folderSel('INBOX')).click()
  await page.locator('.msg-row', { hasText: 'Egy' }).waitFor()

  const open = () => page.locator('section.reader[data-message-id]').getAttribute('aria-label').catch(() => null)
  const openIs = async (subject, what) => {
    try {
      await until(async () => (await open()) === subject, what, 5000)
      return true
    } catch {
      return false
    }
  }
  const press = async key => {
    await page.keyboard.press(key)
    await sleep(250)
  }

  // 1. Down / Up step in the list's order; Up at the top does nothing
  await page.locator('.msg-row', { hasText: 'Öt' }).click()
  check('click opens Öt', await openIs('Öt', 'Öt open'))
  await press('ArrowDown')
  check('Down: the one below (Négy)', await openIs('Négy', 'Down'), await open())
  await press('ArrowUp')
  await press('ArrowUp')
  check('Up twice: Hat (the top)', await openIs('Hat', 'Up'), await open())
  await press('ArrowUp')
  check('Up at the top: Hat stays', (await open()) === 'Hat', await open())

  // 1b. the narrowest window (860 px): the reader's toolbar, now with Archive, stays inside the reader
  await page.setViewportSize({ width: 860, height: 900 })
  await sleep(400)
  const fit = await page.evaluate(() => {
    const r = document.querySelector('section.reader')
    const box = r.getBoundingClientRect()
    const buttons = [...r.querySelectorAll('.reader-toolbar button')]
    return { reader: Math.round(box.width), buttons: buttons.length, archive: Boolean(r.querySelector('.reader-archive')), outside: buttons.filter(b => b.getBoundingClientRect().right > box.right + 0.5).length }
  })
  check('860 px: the Archive button is there and every toolbar button stays inside the reader', fit.archive && fit.outside === 0, JSON.stringify(fit))
  await page.setViewportSize({ width: 1400, height: 900 })
  await sleep(300)

  // 2. inside the HTML message's frame: the main process passes the keys on; PageDown is the frame's own
  await page.locator('iframe.mail-frame').waitFor()
  await page.evaluate(() => document.querySelector('iframe.mail-frame').focus())
  check('the frame has the focus', await page.evaluate(() => document.activeElement && document.activeElement.tagName === 'IFRAME'))
  // a real keyboard cannot type into the frame headless (sendInputEvent goes to the page's own widget, and Playwright's
  // CDP keys never pass before-input-event): the main process's own event is raised instead, with the frame focused, so
  // the wiring is measured: focusedFrame, the four keys taken (preventDefault) and passed on, the page acting on them
  const frameKey = key =>
    app.evaluate(({ BrowserWindow }, key) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents
      let prevented = false
      const input = { type: 'keyDown', key, code: key, control: false, alt: false, meta: false, shift: false, isAutoRepeat: false }
      wc.emit('before-input-event', { preventDefault: () => { prevented = true } }, input)
      return { prevented, frame: wc.focusedFrame ? wc.focusedFrame.url.split('/')[0] : null }
    }, key)
  const pd = await frameKey('PageDown')
  await sleep(300)
  check('frame: PageDown is the frame\'s own (not taken), no step', !pd.prevented && pd.frame === 'mail-view:' && (await open()) === 'Hat', JSON.stringify(pd))
  const down = await frameKey('ArrowDown')
  check('frame: Down is taken in the main process and steps to Öt', down.prevented && (await openIs('Öt', 'frame Down')), `${JSON.stringify(down)} ${await open()}`)

  // 3. a focused divider keeps its arrows (it resizes, the message stays)
  const divider = page.locator('.splitter[aria-orientation="vertical"]').last()
  await divider.focus()
  await press('ArrowLeft')
  await press('ArrowDown')
  check('a focused divider: Down does not step', (await open()) === 'Öt', await open())

  // 4. Delete: the open message to the Trash, the one below opens
  await page.locator('.msg-row', { hasText: 'Négy' }).click()
  await openIs('Négy', 'Négy open')
  await press('Delete')
  check('Delete: Három opens', await openIs('Három', 'after Delete'), await open())
  await until(async () => (await subjectsIn(page, 'Trash')).includes('Négy'), 'Négy in the Trash')
  check('Delete: Négy in the Trash', true)

  // 5. End: archive, the one below opens
  await press('End')
  check('End: Kettő opens', await openIs('Kettő', 'after End'), await open())
  await until(async () => (await subjectsIn(page, 'Archívum')).includes('Három'), 'Három archived')
  check('End: Három in the Archive', true)

  // 6. the reader's Archive button: the same
  const archiveButton = page.locator('section.reader .reader-archive')
  check('the reader has an Archive button', (await archiveButton.count()) === 1)
  await archiveButton.click()
  check('Archive button: Egy opens', await openIs('Egy', 'after the button'), await open())
  check('Archive button: Kettő in the Archive', same(await subjectsIn(page, 'Archívum'), ['Három', 'Kettő']), JSON.stringify(await subjectsIn(page, 'Archívum')))

  // 7. the LAST message deleted with the row's own button: the one above opens
  const last = page.locator('.msg-row', { hasText: 'Egy' })
  await last.hover()
  await last.locator(`.row-quick button[aria-label="${t.actions.delete}"]`).click()
  check('row delete of the last open one: Öt (above) opens', await openIs('Öt', 'after the row delete'), await open())
  check('INBOX now Hat, Öt', same(await subjectsIn(page, 'INBOX'), ['Hat', 'Öt']), JSON.stringify(await subjectsIn(page, 'INBOX')))

  // 8. the frame's Delete: Öt is plain, open Hat (HTML) and delete it from inside its frame
  await page.locator('.msg-row', { hasText: 'Hat' }).click()
  await openIs('Hat', 'Hat open')
  await page.locator('iframe.mail-frame').waitFor()
  await page.evaluate(() => document.querySelector('iframe.mail-frame').focus())
  const del = await frameKey('Delete')
  check('frame: Delete (taken in the main process) deletes Hat, Öt opens', del.prevented && (await openIs('Öt', 'frame Delete')), `${JSON.stringify(del)} ${await open()}`)

  // 9. in the Archive: End only says why, nothing moves
  await page.locator(folderSel('Archívum')).click()
  await page.locator('.msg-row', { hasText: 'Kettő' }).click()
  await openIs('Kettő', 'Kettő open')
  check('in the Archive: the Archive button stays in its place, disabled, with the reason', (await archiveButton.count()) === 1 && (await archiveButton.isDisabled()) && (await archiveButton.getAttribute('title')) === t.readerKeys.in_archive)
  await press('End')
  await page.locator('.action-notice').waitFor({ timeout: 5000 })
  check('in the Archive: End says why', (await page.locator('.action-notice').innerText()).includes(t.readerKeys.in_archive))
  check('in the Archive: nothing moved', same(await subjectsIn(page, 'Archívum'), ['Három', 'Kettő']))

  // 10. the search hits: Down steps in the hits' order
  await page.getByRole('searchbox', { name: t.searchLabel }).fill('szöveg')
  await page.locator('.result').first().waitFor({ timeout: 8000 })
  const hits = await page.locator('.result .result-subject').allInnerTexts()
  await page.locator('.result').first().locator('.result-open').click()
  await openIs(hits[0], 'the first hit open')
  await page.locator('.result-list, .results').first().focus().catch(() => {})
  await press('ArrowDown')
  check('search: Down opens the second hit', hits.length > 1 && (await openIs(hits[1], 'the second hit')), `${JSON.stringify(hits)} -> ${await open()}`)

  // 11. a double delete of the open message runs ONCE (the runAction busy guard before its first await; a regression
  // asked for a final delete of the message already in the Trash, and one Enter took it). Counted at the main process.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__actions = []
    const orig = ipcMain._invokeHandlers.get('mail:action')
    ipcMain.removeHandler('mail:action')
    ipcMain.handle('mail:action', async (event, req) => {
      globalThis.__actions.push(req && req.action)
      return orig(event, req)
    })
  })
  const actions = () => app.evaluate(() => globalThis.__actions.splice(0))
  await page.getByRole('searchbox', { name: t.searchLabel }).fill('')
  await page.locator(folderSel('Archívum')).click()
  await page.locator('.msg-row', { hasText: 'Három' }).click()
  await openIs('Három', 'Három open')
  await actions()
  await page.evaluate(() => {
    for (let i = 0; i < 2; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true, repeat: i > 0 }))
  })
  await sleep(1500)
  const held = await actions()
  check('two Delete keydowns in one tick: one delete, no final-delete question', same(held, ['delete']) && (await page.getByRole('alertdialog').count()) === 0, JSON.stringify(held))
  await page.locator('.msg-row', { hasText: 'Kettő' }).click()
  await openIs('Kettő', 'Kettő open')
  await actions()
  const kettoRow = page.locator('.msg-row', { hasText: 'Kettő' })
  await kettoRow.hover()
  await kettoRow.locator(`.row-quick button[aria-label="${t.actions.delete}"]`).dblclick()
  await sleep(1500)
  const dbl = await actions()
  check('a double click on the open row\'s trash: one delete, no final-delete question', same(dbl, ['delete']) && (await page.getByRole('alertdialog').count()) === 0, JSON.stringify(dbl))
  check('both in the Trash, not gone', (await subjectsIn(page, 'Trash')).filter(x => x === 'Három' || x === 'Kettő').length === 2, JSON.stringify(await subjectsIn(page, 'Trash')))

  // 12. End with NO message open and a selection: nothing archived, the list keeps its own End; with a message open the
  // selection rule stays (above)
  await page.locator(folderSel('INBOX')).click()
  await page.locator('.msg-row', { hasText: 'Öt' }).waitFor()
  check('INBOX view: no message open', (await page.locator('section.reader[data-message-id]').count()) === 0)
  await page.locator('.msg-row', { hasText: 'Öt' }).locator('.col-check input').check()
  await page.locator('.msg-viewport').focus()
  await actions()
  await press('End')
  await sleep(800)
  const endNoOpen = await actions()
  check('End without an open message: nothing archived', endNoOpen.length === 0 && (await subjectsIn(page, 'INBOX')).includes('Öt'), JSON.stringify(endNoOpen))

  check('no console error', problems.length === 0, problems.join(' | '))
} catch (err) {
  check('the run', false, err.stack || String(err))
} finally {
  if (app) await app.close().catch(() => {})
  await server.close()
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} OK`)
process.exit(ok === results.length ? 0 : 1)
