#!/usr/bin/env node
// Message actions in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/actions-e2e.mjs [--shot <file.png>]
//
// A POP3 account on the TCP fake POP3 server (its actions are local, so every UI path can be driven
// end to end) and an IMAP account that cannot be reached (127.0.0.1:1, rows written directly): there
// an action must fail, show an error and leave the list as it was. The server side of the IMAP actions
// is measured in test/actions.test.js (fake IMAP) and live on the test account.
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
import { dragMessageTo } from './drag-env.mjs'

const { values } = parseArgs({ options: { shot: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-muveletek'
const now = Date.now()

const server = await new FakePop3Server().listen()
for (let i = 1; i <= 30; i++) {
  server.add(Buffer.from(`From: Feladó ${i} <f${i}@example.invalid>\r\nTo: p@example.invalid\r\nSubject: POP ${String(i).padStart(2, '0')}\r\nDate: ${new Date(now - i * 60_000).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nszöveg ${i}\r\n`))
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-k7-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let imapId
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER) // vault.json + the encrypted mail.sqlite
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  store.save({ ...newAccountDefaults('pop3'), ...base, name: 'POP3-fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass })
  const imap = store.save({ ...newAccountDefaults('imap'), ...base, name: 'IMAP elérhetetlen', email: 'i@example.invalid', in_port: 1, in_user: 'i', in_password: 'nem-valodi' }).account
  imapId = imap.id
  const index = new MailIndex(db)
  index.upsertFolder({ account_id: imap.id, path: 'INBOX', uidvalidity: '1', synced_at: now })
  index.upsertFolder({ account_id: imap.id, path: 'Trash', special_use: '\\Trash', uidvalidity: '1', synced_at: now })
  index.insertMany([{ account_id: imap.id, folder: 'INBOX', uid: 1, message_id: null, in_reply_to: null, refs: null, from_addr: 'x@example.invalid', from_name: 'IMAP feladó',
    to_addrs: '', cc_addrs: '', subject: 'IMAP levél', date: now, idate: now, flags: '', size: 1, has_attachments: 0, attachments: null, body_state: 3, sender_text: '', recipients_text: '' }])
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
  const row = subject => page.locator('.msg-row', { hasText: subject })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  const popInbox = page.locator('.folder-tree section', { hasText: 'POP3-fiók' }).locator('.folder[data-path="INBOX"]')
  await popInbox.waitFor({ timeout: 20000 })
  await popInbox.click()
  // the virtual list keeps only the visible rows + 15 in the DOM: wait for the header's count instead
  await page.waitForFunction(() => document.querySelector('.list-count')?.dataset.total === '30', null, { timeout: 20000 })
  await row('POP 10').waitFor()
  const unreadCount = () => page.locator('.msg-row.unread').count()
  const selectedCount = () => page.locator('.msg-row.selected').count()

  // a plain click opens and does not select; the checkbox, Ctrl+click, Shift+click select
  const box = subject => row(subject).locator('.col-check input')
  await box('POP 01').check()
  await row('POP 03').click({ modifiers: ['Control'] })
  check('checkbox + Ctrl+click: two selected, nothing opened', (await selectedCount()) === 2 && (await page.locator('.reader[data-message-id]').count()) === 0)
  await page.getByRole('button', { name: t.selectMenu, exact: true }).click()
  await page.getByRole('menuitem', { name: t.selectMenuItems.none, exact: true }).click()
  await box('POP 01').check()
  await row('POP 10').click({ modifiers: ['Shift'] })
  await page.waitForFunction(() => document.querySelectorAll('.msg-row.selected').length === 10, null, { timeout: 3000 }).catch(() => {})
  check('Shift+click selects the range', (await selectedCount()) === 10, String(await selectedCount()))

  // Ctrl+A -> 30, read on all
  await page.locator('.msg-viewport').focus()
  await page.keyboard.press('Control+a')
  await page.waitForFunction(text => document.querySelector('.selection-count')?.innerText.includes(text), t.selectedCount(30))
  check('Ctrl+A selects the whole folder', true)
  const tRead = Date.now()
  await page.getByRole('button', { name: t.actions.read, exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.msg-row.unread').length === 0)
  check('read on 30: the list updates at once', Date.now() - tRead < 1000, `${Date.now() - tRead} ms`)
  await page.waitForTimeout(600)
  check('read on 30: still read after the refresh (the database agrees)', (await unreadCount()) === 0)
  await page.getByRole('button', { name: t.actions.unread, exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.msg-row[data-id]').length === document.querySelectorAll('.msg-row.unread').length)
  check('unread on 30', true)

  // star from the context menu on one (the right click selects the row it is on)
  await page.locator('.select-all input').click()
  await page.locator('.list-tools').waitFor()
  await row('POP 05').click({ button: 'right' })
  await page.getByRole('menuitem', { name: t.actions.star, exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.msg-row')].some(r => r.innerText.includes('POP 05') && r.querySelector('.col-star [aria-pressed="true"]')))
  check('context menu: star', true)

  // the row's own star toggles it (the same action as the toolbar), and it stays after the refresh
  const rowStar = subject => row(subject).locator('.col-star button')
  await rowStar('POP 06').click()
  await page.waitForFunction(() => [...document.querySelectorAll('.msg-row')].some(r => r.innerText.includes('POP 06') && r.querySelector('.col-star [aria-pressed="true"]')))
  await page.waitForTimeout(600)
  const starredAfter = await rowStar('POP 06').getAttribute('aria-pressed')
  await rowStar('POP 06').click()
  await page.waitForFunction(() => [...document.querySelectorAll('.msg-row')].some(r => r.innerText.includes('POP 06') && r.querySelector('.col-star [aria-pressed="false"]')))
  await page.waitForTimeout(600)
  check('row star: on and off, kept by the database', starredAfter === 'true' && (await rowStar('POP 06').getAttribute('aria-pressed')) === 'false')

  // Delete deletes the message the user SEES
  await page.keyboard.press('Escape') // the context menu's selection stays; nothing open
  await page.locator('.select-all input').click()
  await page.locator('.list-tools').waitFor()
  const popInboxAgain = async () => {
    await popInbox.click()
    await page.waitForFunction(() => Number(document.querySelector('.list-count')?.dataset.total) > 0)
  }
  // right after a click on a row's checkbox (the focus is on it) Delete works
  await box('POP 13').check()
  await page.keyboard.press('Delete')
  await row('POP 13').waitFor({ state: 'detached' })
  check('Delete right after a checkbox click deletes the checked message', (await selectedCount()) === 0)
  // (a) open in the list's place + 2 selected: the open one goes, the 2 stay selected
  await box('POP 09').check()
  await box('POP 11').check()
  await row('POP 10').click()
  await page.locator('.reader[data-message-id]').waitFor()
  check('a plain click opens the message, the row is not selected, the list is hidden', (await row('POP 10').getAttribute('aria-selected')) === 'false' && (await selectedCount()) === 2 && !(await page.locator('.list-area').isVisible()))
  await page.keyboard.press('Delete')
  // in the list's place the list comes back at once (a webmail's way; beside the list the next one opens:
  // test/e2e/full-view-back-e2e.mjs)
  await page.locator('.list-area').waitFor({ state: 'visible' })
  await row('POP 10').waitFor({ state: 'detached' })
  check('(a) in the list\'s place: Delete takes the open message, the list comes back; the 2 selected stay', (await selectedCount()) === 2 && (await row('POP 09').count()) === 1 && (await row('POP 11').count()) === 1 && (await page.locator('.reader[data-message-id]').count()) === 0)
  // a search hit open, a hidden folder selection: Delete takes the hit, not the selection
  const search = page.getByRole('searchbox', { name: t.searchLabel })
  await search.fill('POP 06')
  await page.locator('.result', { hasText: 'POP 06' }).first().waitFor({ timeout: 10_000 })
  await page.locator('.result', { hasText: 'POP 06' }).first().locator('.result-open').click()
  await page.locator('.reader[data-message-id]').waitFor()
  await page.locator('.reader[data-message-id]').click({ position: { x: 5, y: 60 } }) // focus off the search field
  await page.keyboard.press('Delete')
  await page.locator('.reader[data-message-id]').waitFor({ state: 'detached' })
  await search.press('Escape')
  await page.locator('.list-header').waitFor()
  // the folder list loads AFTER its header: measured at once it had 0 rows, or only its empty `.msg-row.loading`
  // placeholders (an earlier build, run 8: 27 rows, no subject), now and then (POP 09, POP 11 and the 2 selected seemed gone);
  // 2 s later all four parts were right. So the step waits for the loaded rows (no placeholder left), not a time.
  await page.waitForFunction(() => document.querySelectorAll('.msg-row:not(.loading)').length > 0 && !document.querySelector('.msg-row.loading') && Number(document.querySelector('.list-count')?.dataset.total) > 0, null, { timeout: 10_000 })
  // the four parts measured and logged one by one
  const parts1 = async () => ({
    pop06Gone: (await row('POP 06').count()) === 0,
    pop09There: (await row('POP 09').count()) === 1,
    pop11There: (await row('POP 11').count()) === 1,
    selected: await selectedCount(),
    rows: await page.locator('.msg-row').count(),
    placeholders: await page.locator('.msg-row.loading').count(),
    total: await page.locator('.list-count').getAttribute('data-total').catch(() => null),
    pop06: await row('POP 06').evaluateAll(els => els.map(e => e.className)),
  })
  const p1 = await parts1()
  const ok1 = p1.pop06Gone && p1.pop09There && p1.pop11There && p1.selected === 2
  if (!ok1) {
    await page.waitForTimeout(2000)
    console.log(`DIAG #1 at once: ${JSON.stringify(p1)}; 2 s later: ${JSON.stringify(await parts1())}`)
  }
  check('during a search Delete takes the open hit, the hidden selection stays', ok1, JSON.stringify(p1))
  // (b) the reader on the right + 2 selected: the 2 go, the open one stays
  const setPane = async label => {
    await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
    await page.getByRole('button', { name: t.settingsNav.appearance, exact: true }).click()
    await page.getByRole('button', { name: t.readerPaneLabel, exact: true }).click()
    await page.getByRole('menuitemradio', { name: label, exact: true }).click()
    await page.getByRole('button', { name: t.backToMail, exact: true }).click()
    await popInboxAgain()
  }
  await setPane(t.readerPaneOptions.right)
  await box('POP 09').check()
  await box('POP 11').check()
  await row('POP 12').click()
  await page.locator('.reader[data-message-id]').waitFor()
  await page.keyboard.press('Delete')
  await row('POP 09').waitFor({ state: 'detached' })
  await row('POP 11').waitFor({ state: 'detached' })
  check('(b) on the right: Delete takes the 2 selected, the open message stays', (await row('POP 12').count()) === 1 && (await page.locator('.reader[data-message-id]').count()) === 1)
  await setPane(t.readerPaneOptions.none)
  // Del with nothing selected: the open message -> Trash (POP3 local Trash)
  await row('POP 07').click()
  await page.locator('.reader[data-message-id]').waitFor()
  await page.keyboard.press('Delete')
  await page.locator('.list-area').waitFor({ state: 'visible' })
  await row('POP 07').waitFor({ state: 'detached' })
  check('Del on the open message moves it to the Trash, the list comes back (no message open)', (await page.locator('.reader[data-message-id]').count()) === 0)

  // a double click on a row's hover trash moves it once, asks nothing; the hover
  // action of an unselected row keeps the selection
  await box('POP 02').check()
  const trashRowsBefore = await page.evaluate(() => window.shadowMail.mail.folders().then(r => r.accounts.find(a => a.name === 'POP3-fiók').folders.find(f => f.path === 'Trash').count))
  await row('POP 04').hover()
  await row('POP 04').locator(`.row-quick button[aria-label="${t.actions.delete}"]`).dblclick()
  await row('POP 04').waitFor({ state: 'detached' })
  await page.waitForTimeout(700)
  const trashRowsAfter = await page.evaluate(() => window.shadowMail.mail.folders().then(r => r.accounts.find(a => a.name === 'POP3-fiók').folders.find(f => f.path === 'Trash').count))
  check('double click on the hover trash: moved once to the Trash, no question', (await page.getByRole('alertdialog').count()) === 0 && trashRowsAfter === trashRowsBefore + 1, `${trashRowsBefore} -> ${trashRowsAfter}`)
  check('the hover action did not empty the selection', (await selectedCount()) === 1 && (await row('POP 02').getAttribute('aria-selected')) === 'true')
  await box('POP 02').uncheck()

  // drag and drop onto Drafts
  // out as files and back onto the folder (drag-env.mjs: headless has no OS drag)
  await dragMessageTo(app, page, row('POP 08'), page.locator('.folder-tree section', { hasText: 'POP3-fiók' }).locator('.folder[data-path="Drafts"]'))
  await row('POP 08').waitFor({ state: 'detached' })
  check('drag and drop onto a folder moves it', true)

  // the Trash: delete asks first, then it is gone for good
  await page.locator('.folder-tree section', { hasText: 'POP3-fiók' }).locator('.folder[data-path="Trash"]').click()
  await row('POP 07').click()
  await page.getByRole('button', { name: t.actions.delete, exact: true }).click()
  await page.getByRole('alertdialog').waitFor()
  const dialogText = await page.getByRole('alertdialog').innerText()
  await page.getByRole('button', { name: t.confirmCancel, exact: true }).click()
  check('in the Trash: delete asks for confirmation; "Mégse" keeps it', dialogText.includes(t.confirmDeleteTrash(1)) && (await row('POP 07').count()) === 1)
  await page.getByRole('button', { name: t.actions.delete, exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: t.confirmDeleteYes, exact: true }).click()
  await row('POP 07').waitFor({ state: 'detached' })
  check('confirmed: deleted for good', true)

  // the move list of the toolbar
  await page.locator('.folder-tree section', { hasText: 'POP3-fiók' }).locator('.folder[data-path="Drafts"]').click()
  await box('POP 08').check()
  // a menu instead of the native <select>; keyboard: ArrowDown opens, the arrows move, Esc closes
  // and gives the focus back, Enter picks
  const moveBtn = page.locator('.action-bar').getByRole('button', { name: t.actions.move, exact: true })
  await moveBtn.focus()
  await page.keyboard.press('ArrowDown')
  const moveMenu = page.getByRole('menu', { name: t.actions.move })
  await moveMenu.waitFor()
  const firstFocused = await page.evaluate(() => document.activeElement?.getAttribute('role'))
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await moveMenu.waitFor({ state: 'detached' })
  const backOnButton = await moveBtn.evaluate(el => el === document.activeElement)
  check('"Áthelyezés" menu: opens with ArrowDown on its first item, Esc closes it, the focus is back', firstFocused === 'menuitem' && backOnButton)
  await page.keyboard.press('Enter')
  await moveMenu.waitFor()
  for (let i = 0; i < 10; i++) {
    if ((await page.evaluate(() => document.activeElement?.dataset.key)) === 'INBOX') break
    await page.keyboard.press('ArrowDown')
  }
  await page.keyboard.press('Enter')
  await row('POP 08').waitFor({ state: 'detached' })
  check('toolbar "Áthelyezés": back to the INBOX, chosen with the keyboard', true)

  // an unreachable IMAP account: the action fails, the list goes back, an error shows
  await page.locator('.folder-tree section', { hasText: 'IMAP elérhetetlen' }).locator('.folder[data-path="INBOX"]').click()
  await box('IMAP levél').check()
  const wasUnread = await row('IMAP levél').evaluate(el => el.classList.contains('unread'))
  await page.getByRole('button', { name: t.actions.read, exact: true }).click()
  // the action error itself: another alert (the status bar's connection error) may be on the page too
  await page.locator('.action-error').waitFor({ timeout: 15000 })
  const err = await page.locator('.action-error').innerText()
  const stillUnread = await row('IMAP levél').evaluate(el => el.classList.contains('unread'))
  check('IMAP without a connection: error shown, the row back to unread', wasUnread && stillUnread && err.includes(t.actionError('read', 'connection_refused')), err)
  await page.getByRole('button', { name: t.actions.delete, exact: true }).click()
  await page.waitForFunction(text => (document.querySelector('.action-error')?.innerText || '').includes(text), t.actionError('delete', 'connection_refused').split(':')[0], { timeout: 15000 })
  check('IMAP delete without a connection: the row stays', (await row('IMAP levél').count()) === 1 && !(await row('IMAP levél').evaluate(el => el.classList.contains('leaving'))))
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
