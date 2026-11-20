#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Moving a folder by dragging it in the tree, in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   E2E_LANG=hu|en node test/e2e/folder-move-e2e.mjs [--shots <dir>]
//
// A POP3 account's local folders (the move is local) drive the UI path: the middle of a folder + the confirmation ->
// the folder under it; Cancel changes nothing; a selected subfolder stays selected under its new path and its messages
// stay in the list; a folded folder stays folded; the account head = the top level; a sibling's bottom edge is still
// the manual order (no dialog); a name clash says folder_exists. An IMAP account on the TCP mini server
// (test/helpers/imap-wire.js, which like the measured live server does not carry a subscription along): one RENAME,
// the moved folders subscribed under their new names, and a target name only the server has: server_refused.
// --shots <dir>: the "into" frame and the dialog, in the default and the dark theme.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { startImapWire } from '../helpers/imap-wire.js'
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
const MASTER = 'Teszt-mesterjelszo-mappa-athelyezes'
const now = Date.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))

const pop3 = await new FakePop3Server().listen()
// S.Q is on the server, unsubscribed (not in the tree): moving a Q under S is refused by the server
const wire = await startImapWire({
  folders: [{ path: 'INBOX' }, { path: 'P' }, { path: 'P.Q' }, { path: 'P.Q.r' }, { path: 'R' }, { path: 'S' }, { path: 'S.Q' }],
  subscribed: ['INBOX', 'P', 'P.Q', 'P.Q.r', 'R', 'S'],
})
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-folder-move-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let popId, wireId
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  popId = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'POP3-fiók', email: 'p@example.invalid', in_port: pop3.port, in_user: pop3.user, in_password: pop3.pass }).account.id
  wireId = store.save({ ...newAccountDefaults('imap'), ...base, name: 'IMAP szerverrel', email: 'w@example.invalid', in_port: wire.port, in_user: 'w', in_password: 'nem-valodi' }).account.id
  const index = new MailIndex(db)
  for (const p of ['A', 'A/B', 'A/B/x', 'C', 'D', 'E', 'E/b']) index.addFolder(popId, p, '/', true)
  const row = uid => ({ account_id: popId, folder: 'A/B/x', uid, message_id: `<mv${uid}@x>`, in_reply_to: null, refs: null, from_addr: 'a@example.invalid', from_name: 'Feladó', to_addrs: '', cc_addrs: '', bcc_addrs: '', subject: `Áthelyezett levél ${uid}`, date: now - uid * 60_000, idate: now - uid * 60_000, flags: '\\Seen', size: 10, has_attachments: 0, attachments: null, body_state: 3, sender_text: '', recipients_text: '' })
  index.insertMany([row(1), row(2)])
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
  const sec = id => page.locator(`.folder-tree section[data-account="${id}"]`)
  const folder = (id, p) => sec(id).locator(`.folder[data-path="${p}"]`)
  const fold = (id, p) => sec(id).locator(`li:has(> .folder[data-path="${p}"]) > .folder-fold`)
  const dialog = page.getByRole('alertdialog')
  const errorLine = page.locator('.folder-tree ~ .error[role="alert"], .error.pad[role="alert"]')
  // a drag with the mouse to a point of the target: `at` 0.5 = the middle ("into"), 0.85 = the bottom edge
  const mouseDrag = async (from, to, at = 0.5) => {
    const a = await from.boundingBox()
    const b = await to.boundingBox()
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 6, { steps: 3 })
    await page.mouse.move(b.x + b.width / 2, b.y + b.height * at, { steps: 8 })
    await page.mouse.up()
  }
  await folder(popId, 'A/B/x').waitFor({ timeout: 20000 })

  // 1. the selected subfolder, the folded parent; drag A/B into C, Cancel: nothing changes
  await folder(popId, 'A/B/x').click()
  await until(async () => (await page.locator('.msg-row[data-id]').count()) === 2, 'the two messages of A/B/x')
  await fold(popId, 'A/B').click()
  await mouseDrag(folder(popId, 'A/B'), folder(popId, 'C'))
  await dialog.waitFor()
  const ask = await dialog.locator('.confirm-text').innerText()
  check('the drop asks first: the name, the target and the subfolder count', ask === t.confirmFolderMove('B', 'C', 1), ask)
  check('the dialog\'s buttons: Cancel and Move', (await dialog.getByRole('button', { name: t.folderMoveYes, exact: true }).count()) === 1)
  if (values.shots) {
    for (const theme of ['default', 'dark']) {
      await page.evaluate(th => (document.documentElement.dataset.theme = th), theme)
      await sleep(250)
      await page.screenshot({ path: path.join(values.shots, `folder-move-${theme}-dialog.png`) })
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'default'))
  }
  await dialog.getByRole('button', { name: t.confirmCancel, exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await sleep(300)
  check('Cancel: nothing moved', (await folder(popId, 'A/B').count()) === 1 && (await folder(popId, 'C/B').count()) === 0)

  // 2. again, Move: the subtree under C; the selection follows (still the two messages); the fold follows
  await mouseDrag(folder(popId, 'A/B'), folder(popId, 'C'))
  await dialog.waitFor()
  await dialog.getByRole('button', { name: t.folderMoveYes, exact: true }).click()
  await until(async () => (await folder(popId, 'C/B').count()) === 1, 'C/B in the tree')
  check('Move: the folder is under C, A/B is gone', (await folder(popId, 'A/B').count()) === 0)
  check('the folded folder stays folded (its subfolder hidden)', (await fold(popId, 'C/B').getAttribute('aria-expanded')) === 'false' && (await folder(popId, 'C/B/x').count()) === 0)
  check('the selected subfolder stays selected under its new path (the folded parent shows it), the list keeps its messages', (await folder(popId, 'C/B').evaluate(el => el.classList.contains('holds-selected'))) && (await page.locator('.msg-row[data-id]').count()) === 2)
  check('the focus is on the moved folder', await folder(popId, 'C/B').evaluate(el => document.activeElement === el))
  await fold(popId, 'C/B').click()
  await folder(popId, 'C/B/x').waitFor()
  check('unfolded: C/B/x is the selected one', (await folder(popId, 'C/B/x').getAttribute('aria-current')) === 'true')

  // 3. onto the account head: the top level, the account's name in the question
  await mouseDrag(folder(popId, 'C/B'), sec(popId).locator('.account-head'))
  await dialog.waitFor()
  const askTop = await dialog.locator('.confirm-text').innerText()
  check('onto the account head: the question names the account', askTop === t.confirmFolderMove('B', 'POP3-fiók', 1), askTop)
  await dialog.getByRole('button', { name: t.folderMoveYes, exact: true }).click()
  await until(async () => (await folder(popId, 'B').count()) === 1, 'B on the top level')
  check('onto the account head: on the top level, its subfolder with it, still selected', (await folder(popId, 'B/x').getAttribute('aria-current')) === 'true')

  // 4. a sibling's bottom edge: the manual order, no dialog
  await mouseDrag(folder(popId, 'D'), folder(popId, 'C'), 0.85)
  await sleep(400)
  check('a sibling\'s bottom edge: no move question (the manual order)', (await dialog.count()) === 0 && (await folder(popId, 'D').count()) === 1)

  // 5. a name clash (E/b against B): folder_exists in the folder error line
  await mouseDrag(folder(popId, 'B'), folder(popId, 'E'))
  await dialog.waitFor()
  await dialog.getByRole('button', { name: t.folderMoveYes, exact: true }).click()
  await until(async () => (await page.locator('.error.pad[role="alert"]').count()) === 1, 'the error line')
  const clash = await page.locator('.error.pad[role="alert"]').innerText()
  check('a name clash: the folder_exists text, nothing moved', clash === t.folderError('folder_exists') && (await folder(popId, 'B').count()) === 1, clash)

  // 6. not taken: into the Trash (no frame, so no question)
  await mouseDrag(folder(popId, 'B'), folder(popId, 'Trash'))
  await sleep(400)
  check('into the Trash: no question, nothing moved', (await dialog.count()) === 0 && (await folder(popId, 'B').count()) === 1)

  // 7. IMAP: one RENAME on the server, the moved folders subscribed under their new names
  await folder(wireId, 'P.Q').waitFor({ timeout: 20000 })
  const before = wire.log.length
  await mouseDrag(folder(wireId, 'P.Q'), folder(wireId, 'R'))
  await dialog.waitFor()
  check('IMAP: the question', (await dialog.locator('.confirm-text').innerText()) === t.confirmFolderMove('Q', 'R', 1))
  await dialog.getByRole('button', { name: t.folderMoveYes, exact: true }).click()
  await until(async () => (await folder(wireId, 'R.Q').count()) === 1, 'R.Q in the tree')
  const sent = wire.log.slice(before)
  check('IMAP: one RENAME P.Q -> R.Q', sent.filter(l => /^RENAME/i.test(l)).length === 1 && sent.some(l => /^RENAME "?P\.Q"? "?R\.Q"?/i.test(l)), sent.filter(l => /RENAME|SUBSCRIBE/i.test(l)).join(' | '))
  check('IMAP: the moved folders subscribed under the new names, not under the old', wire.subscribed.has('R.Q') && wire.subscribed.has('R.Q.r') && !wire.subscribed.has('P.Q') && !wire.subscribed.has('P.Q.r'), [...wire.subscribed].join(', '))
  await until(async () => (await folder(wireId, 'R.Q.r').count()) === 1, 'R.Q.r after the full sync', 15000)
  check('IMAP: after the full sync the subtree is still in the tree', (await folder(wireId, 'P.Q').count()) === 0)

  // 8. IMAP: a target name the server has (S.Q, unsubscribed, not in the tree): server_refused
  await mouseDrag(folder(wireId, 'R.Q'), folder(wireId, 'S'))
  await dialog.waitFor()
  await dialog.getByRole('button', { name: t.folderMoveYes, exact: true }).click()
  await until(async () => (await page.locator('.error.pad[role="alert"]').innerText().catch(() => '')) === t.folderError('server_refused'), 'the server_refused line')
  check('IMAP: the server refuses (NO): the server_refused text, the folder stays', (await folder(wireId, 'R.Q').count()) === 1)

  if (values.shots) {
    // the "into" frame during a drag (Chromium's own DragEvent: the mouse drag delivers the state only at the drop)
    for (const theme of ['default', 'dark']) {
      await page.evaluate(th => (document.documentElement.dataset.theme = th), theme)
      await page.evaluate(([fs, ts]) => {
        const from = document.querySelector(fs)
        const to = document.querySelector(ts)
        const dt = new DataTransfer()
        window.__mv = { from, dt }
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
        const r = to.getBoundingClientRect()
        to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
      }, [`.folder-tree section[data-account="${popId}"] .folder[data-path="D"]`, `.folder-tree section[data-account="${popId}"] .folder[data-path="C"]`])
      await sleep(300)
      check(`shots (${theme}): the target is framed`, (await page.locator('.folder-tree li.drop-into').count()) === 1)
      await page.locator('nav.folder-tree').screenshot({ path: path.join(values.shots, `folder-move-${theme}-into.png`) })
      await page.evaluate(() => window.__mv.from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__mv.dt })))
      await sleep(200)
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'default'))
  }

  const text = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8') : ''
  check('main.log: no folder name', !['P.Q', 'R.Q', 'A/B', 'C/B'].some(n => text.includes(n)))
  check('the page console: no error or warning', consoleLines.length === 0, consoleLines.join(' | '))
} catch (err) {
  console.error(err)
  results.push(false)
} finally {
  if (app) await app.close().catch(() => {})
  await wire.close()
  await pop3.close?.()
  fs.rmSync(work, { recursive: true, force: true })
}
const failed = results.filter(r => !r).length
console.log(`${results.length - failed}/${results.length} OK`)
process.exit(failed ? 1 : 0)
