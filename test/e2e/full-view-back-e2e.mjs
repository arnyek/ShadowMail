#!/usr/bin/env node
// Back to the list after an action on a message open in the list's place, in the real app (headless Electron +
// Playwright). Not part of `npm test`.
//
//   node test/e2e/full-view-back-e2e.mjs        (E2E_LANG=en: the same in English)
//
// A POP3 account (fake POP3 server, 60 messages: a list of several screens; its actions are local) with a local
// Archive, Junk and a plain folder, and an unreachable IMAP account (its actions fail). In the full reader (no reader
// pane) a delete (button, Delete key), an archive (End, button), a move (to a folder, to Junk) and Mark as unread go
// back to the list at once: the list visible, the row gone (or unread), the list scrolled where it was, the focus on
// it, no message open; the list comes back BEFORE the main process answers (its action held back here); an error keeps
// the list and brings the row back with the error line, the message does not open again; a final delete in the Trash
// asks first (Cancel keeps the message open); a search hit goes back to the hits. Beside or below the list the next
// message opens, as before. No console warning, the main log clean.
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
const MASTER = 'Teszt-mesterjelszo-vissza'
const now = Date.now()
const N = 60

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 8 minutes')
  process.exit(1)
}, 480_000)
watchdog.unref()

const server = await new FakePop3Server().listen()
for (let i = 1; i <= N; i++) {
  server.add(Buffer.from(`From: Feladó ${i} <f${i}@example.invalid>\r\nTo: p@example.invalid\r\nSubject: VL ${String(i).padStart(2, '0')}\r\nDate: ${new Date(now - i * 60_000).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nszöveg ${i}\r\n`))
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-fullback-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  const pop = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'POP3-fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass }).account.id
  const imap = store.save({ ...newAccountDefaults('imap'), ...base, name: 'IMAP elérhetetlen', email: 'i@example.invalid', in_port: 1, in_user: 'i', in_password: 'nem-valodi' }).account.id
  const index = new MailIndex(db)
  for (const p of ['Archívum', 'Levélszemét', 'Ügyfelek']) index.addFolder(pop, p, '/', true)
  index.upsertFolder({ account_id: imap, path: 'INBOX', uidvalidity: '1', synced_at: now })
  index.upsertFolder({ account_id: imap, path: 'Trash', special_use: '\\Trash', uidvalidity: '1', synced_at: now })
  index.insertMany([{ account_id: imap, folder: 'INBOX', uid: 1, message_id: null, in_reply_to: null, refs: null, from_addr: 'x@example.invalid', from_name: 'IMAP feladó',
    to_addrs: '', cc_addrs: '', subject: 'IMAP levél', date: now, idate: now, flags: '\\Seen', size: 1, has_attachments: 0, attachments: null, body_state: 3, sender_text: '', recipients_text: '' }])
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
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e}`))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  const pane = name => page.locator('.folder-tree section', { hasText: name })
  const folder = (acc, p) => pane(acc).locator(`.folder[data-path="${p}"]`)
  const row = subject => page.locator('.msg-row', { hasText: subject })
  const reader = page.locator('.reader[data-message-id]')
  const inbox = async () => {
    await folder('POP3-fiók', 'INBOX').click()
    await page.waitForFunction(() => Number(document.querySelector('.list-count')?.dataset.total) > 0, null, { timeout: 20_000 })
  }
  await folder('POP3-fiók', 'INBOX').waitFor({ timeout: 20_000 })
  await inbox()
  await page.waitForFunction(n => document.querySelector('.list-count')?.dataset.total === String(n), N, { timeout: 20_000 })

  // the list's state: visible, its scroll, the focus on it, a message open
  const state = async () => ({ list: await page.locator('.list-area').isVisible(), ...(await page.evaluate(() => {
    const vp = document.querySelector('.msg-viewport')
    return {
      scroll: vp ? vp.scrollTop : null,
      focus: Boolean(vp && (vp === document.activeElement || vp.contains(document.activeElement))),
      open: document.querySelectorAll('.reader[data-message-id]').length,
    }
  })) })
  // a row far down the list (more than one screen scrolled), opened in the list's place; returns the scroll it had
  const openLow = async subject => {
    await page.locator('.msg-viewport').evaluate((vp, s) => {
      const i = Number(s.slice(3)) - 1
      const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 40
      vp.scrollTop = Math.max(0, i * rowH - vp.clientHeight / 2)
    }, subject)
    await row(subject).waitFor({ timeout: 5000 })
    const before = (await state()).scroll
    await row(subject).click()
    await reader.waitFor({ timeout: 10_000 })
    return before
  }
  const listBack = async (label, subject, before, { gone = true } = {}) => {
    await page.locator('.list-area').waitFor({ state: 'visible', timeout: 5000 })
    if (gone) await row(subject).waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(200)
    const s = await state()
    const rowOk = gone ? (await row(subject).count()) === 0 : (await row(subject).evaluate(r => r.classList.contains('unread')))
    check(`${label}: the list back, ${gone ? 'the row gone' : 'the row unread'}, the scroll kept, the focus on the list, no message open`, s.list && rowOk && s.open === 0 && Math.abs(s.scroll - before) <= 1 && s.focus, JSON.stringify({ ...s, before, rowOk }))
  }
  const toolbar = () => page.locator('.reader-tools')
  const menuPick = async (button, item) => {
    await toolbar().getByRole('button', { name: button, exact: true }).click()
    await page.getByRole('menuitem', { name: item, exact: true }).click()
  }

  // the main process's action held back (the server's answer slow): the list must come before it
  const holdActions = ms => app.evaluate(({ ipcMain }, wait) => {
    const map = ipcMain._invokeHandlers
    const real = map.get('mail:action')
    globalThis.__realAction ??= real
    map.set('mail:action', async (...a) => {
      await new Promise(r => setTimeout(r, wait))
      return globalThis.__realAction(...a)
    })
  }, ms)
  const releaseActions = () => app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.set('mail:action', globalThis.__realAction))

  // 1. the Delete button, the main process held back 1.5 s: the list is there long before the answer
  {
    const before = await openLow('VL 40')
    await holdActions(1500)
    const t0 = performance.now()
    await toolbar().getByRole('button', { name: t.actions.delete, exact: true }).click()
    await page.locator('.list-area').waitFor({ state: 'visible', timeout: 5000 })
    const early = performance.now() - t0
    const s = await state()
    check('1a Delete button: the list back before the main process answers (held back 1.5 s)', early < 1000 && s.list && s.open === 0, `${Math.round(early)} ms ${JSON.stringify(s)}`)
    await page.waitForTimeout(1700)
    await releaseActions()
    await listBack('1b Delete button', 'VL 40', before)
  }
  // 2. the Delete key; 3. End (archive); 4. the Archive button; 5. Move to a folder; 6. Move to Junk; 7. Mark as unread
  {
    let before = await openLow('VL 41')
    await reader.click({ position: { x: 5, y: 60 } })
    await page.keyboard.press('Delete')
    await listBack('2 Delete key', 'VL 41', before)
    before = await openLow('VL 42')
    await reader.click({ position: { x: 5, y: 60 } })
    await page.keyboard.press('End')
    await listBack('3 End (archive)', 'VL 42', before)
    before = await openLow('VL 43')
    await toolbar().locator('.reader-archive').click()
    await listBack('4 Archive button', 'VL 43', before)
    before = await openLow('VL 44')
    await menuPick(t.actions.move, 'Ügyfelek')
    await listBack('5 Move to a folder', 'VL 44', before)
    before = await openLow('VL 45')
    await menuPick(t.actions.move, `${t.folderRoles.junk} (Levélszemét)`)
    await listBack('6 Move to Junk', 'VL 45', before)
    before = await openLow('VL 46')
    await menuPick(t.readerMore, t.actions.unread)
    await listBack('7 Mark as unread', 'VL 46', before, { gone: false })
  }
  // 8. an error (the main process answers the delete with a lost connection, after 0.5 s): the list, the row back, the
  // error line, the message not opened again
  {
    const before = await openLow('VL 47')
    await app.evaluate(({ ipcMain }) => {
      globalThis.__realAction ??= ipcMain._invokeHandlers.get('mail:action')
      ipcMain._invokeHandlers.set('mail:action', async () => (await new Promise(r => setTimeout(r, 500)), { ok: false, error: 'connection_lost' }))
    })
    await toolbar().getByRole('button', { name: t.actions.delete, exact: true }).click()
    await page.locator('.action-error').waitFor({ timeout: 15_000 })
    await row('VL 47').waitFor({ timeout: 5000 })
    await page.waitForTimeout(500)
    await releaseActions()
    const s = await state()
    check('8 an error: the list, the row back, the error line shown, the message not opened again, the scroll kept', s.list && s.open === 0 && (await row('VL 47').count()) === 1 && Math.abs(s.scroll - before) <= 1, JSON.stringify({ ...s, before }))
    await page.locator('.action-error').getByRole('button', { name: t.close }).click().catch(() => {})
  }
  // 9. the Trash: a final delete asks first; Cancel keeps the message open, yes goes back to the list
  {
    await folder('POP3-fiók', 'Trash').click()
    await row('VL 40').click()
    await reader.waitFor({ timeout: 10_000 })
    await toolbar().getByRole('button', { name: t.actions.delete, exact: true }).click()
    const dialog = page.getByRole('alertdialog')
    await dialog.waitFor()
    await dialog.getByRole('button', { name: t.confirmCancel, exact: true }).click()
    const a = await state()
    check('9a Trash, delete, Cancel: the message stays open', a.open === 1 && !a.list, JSON.stringify(a))
    await toolbar().getByRole('button', { name: t.actions.delete, exact: true }).click()
    await dialog.getByRole('button', { name: t.confirmDeleteYes, exact: true }).click()
    await page.locator('.list-area').waitFor({ state: 'visible', timeout: 5000 })
    await row('VL 40').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    const b = await state()
    check('9b Trash, delete, yes: the list back, the row gone', b.list && b.open === 0 && (await row('VL 40').count()) === 0, JSON.stringify(b))
  }
  // 10. a search hit in the full reader: back to the hits
  {
    await inbox()
    const search = page.getByRole('searchbox', { name: t.searchLabel })
    await search.fill('VL 50')
    await page.locator('.result', { hasText: 'VL 50' }).first().waitFor({ timeout: 10_000 })
    await page.locator('.result', { hasText: 'VL 50' }).first().locator('.result-open').click()
    await reader.waitFor({ timeout: 10_000 })
    await toolbar().getByRole('button', { name: t.actions.delete, exact: true }).click()
    await page.locator('.result-list').waitFor({ state: 'visible', timeout: 5000 })
    const open = await reader.count()
    check('10 a search hit deleted in the full reader: the hits back, no message open', open === 0, `${open}`)
    await search.fill('')
    await search.press('Escape')
  }
  // 11. beside / below the list: the next message opens, as before
  {
    const setPane = async label => {
      await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
      await page.getByRole('button', { name: t.settingsNav.appearance, exact: true }).click()
      await page.getByRole('button', { name: t.readerPaneLabel, exact: true }).click()
      await page.getByRole('menuitemradio', { name: label, exact: true }).click()
      await page.getByRole('button', { name: t.backToMail, exact: true }).click()
      await inbox()
    }
    for (const [label, from, next, how] of [[t.readerPaneOptions.right, 'VL 20', 'VL 21', 'delete'], [t.readerPaneOptions.bottom, 'VL 22', 'VL 23', 'archive']]) {
      await setPane(label)
      await page.locator('.msg-viewport').evaluate(vp => (vp.scrollTop = 0))
      await row('VL 15').waitFor()
      await page.locator('.msg-viewport').evaluate(vp => (vp.scrollTop = 300))
      await row(from).click()
      await page.waitForFunction(s => document.querySelector('.reader[data-message-id]')?.getAttribute('aria-label') === s, from, { timeout: 10_000 })
      if (how === 'delete') await toolbar().getByRole('button', { name: t.actions.delete, exact: true }).click()
      else await toolbar().locator('.reader-archive').click()
      const ok = await page.waitForFunction(s => document.querySelector('.reader[data-message-id]')?.getAttribute('aria-label') === s, next, { timeout: 10_000 }).then(() => true).catch(() => false)
      check(`11 ${label}: after ${how} the next message (${next}) opens`, ok)
    }
  }
} finally {
  await app.close().catch(() => {})
  await server.close?.()
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
// the unreachable IMAP account's own lines (its sync and the refused delete) are expected
const logLines = mainLog.trim().split('\n').filter(l => /failed|error/i.test(l) && !/connect|ECONNREFUSED|sync|action/i.test(l))
check('the main log: no unexpected error line', logLines.length === 0, logLines.slice(0, 3).join(' | '))
check('no console warning or error, no page exception', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
