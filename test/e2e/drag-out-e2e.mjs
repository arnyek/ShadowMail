#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Messages dragged out of the list as .eml files, in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/drag-out-e2e.mjs           (E2E_LANG=en: the same in English)
//
// Headless ozone has no OS drag: the row gets Chromium's own dragstart, the main process's startDrag is recorded instead
// of run, and a drop back into the window is played with File objects that have their paths (test/e2e/drag-env.mjs).
// A POP3 account on the fake POP3 server (its messages are stored here, so the files can be compared byte for byte) with
// 55 messages, an IMAP account on the TCP mini-server (test/helpers/imap-wire.js, one message synced but not downloaded)
// and an IMAP account that cannot be reached (one message never downloaded):
// 1. one row: the HTML drag is cancelled, startDrag gets one file data\tmp\drag-*\<subject>.eml with the message's
//    bytes, and a 32 x 32 picture;
// 2. three selected rows, two subjects differing only in letter case: three files in one folder, the second -2; a
//    message without a subject: the dictionary's fallback name;
// 3. the same drag back onto the Drafts folder: the message moves (out of INBOX, into Drafts);
// 4. a foreign file (not this drag's) dropped on a folder during our drag: nothing moves; with no drag of ours on, a
//    Files drag is not taken at all;
// 5. an IMAP message not downloaded yet, dropped on a folder: the list's own drag, nothing downloaded, no notice (the
//    move does not wait); another one dragged and let go outside: the notice, a background download without \Seen,
//    and the second drag, without a reload, takes it out as a file with its bytes; on the unreachable server the
//    background download ends in an error line;
// 6. all 55 selected: no files, the internal drag; let go outside: a notice with the numbers; dropped on Drafts it
//    still moves all of them, without a notice;
// 7. the lock takes every drag folder; the main log has counts, no subject and no file name.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { startImapWire } from '../helpers/imap-wire.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'
import { watchStartDrag, startRowDrag, dropFiles, dragMessageTo, dropRowDrag, endRowDrag, startedDrags } from './drag-env.mjs'
const DRAG_TYPE = 'application/x-shadowmail-ids'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-kihuzas'
const now = Date.now()
const COUNT = 55

const subjectOf = i => (i === 2 ? 'Ugyanaz a tárgy' : i === 3 ? 'UGYANAZ A TÁRGY' : i === 4 ? '' : `POP ${String(i).padStart(2, '0')}`)
const sources = new Map()
const server = await new FakePop3Server().listen()
for (let i = 1; i <= COUNT; i++) {
  const src = Buffer.from(`From: Feladó ${i} <f${i}@example.invalid>\r\nTo: p@example.invalid\r\nSubject: ${subjectOf(i)}\r\nDate: ${new Date(now - i * 60_000).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nszöveg ${i} ékezettel\r\n`)
  sources.set(i, src)
  server.add(src)
}
const wireSource = Buffer.from(`From: Wire <w@example.invalid>\r\nTo: p@example.invalid\r\nSubject: Szerveren levo\r\nDate: ${new Date(now).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nszerveren ${'x'.repeat(50)}\r\n`)
const wireOther = Buffer.from(`From: Wire <w@example.invalid>\r\nTo: p@example.invalid\r\nSubject: Masik szerveren\r\nDate: ${new Date(now).toUTCString()}\r\n\r\n${'y'.repeat(4000)}\r\n`)
const wire = await startImapWire({ folders: [{ path: 'INBOX', mail: [{ uid: 1, flags: [], source: wireSource }, { uid: 2, flags: [], source: wireOther }] }, { path: 'Archív' }] })
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-dragout-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  store.save({ ...newAccountDefaults('pop3'), ...base, name: 'POP3-fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass })
  const imap = store.save({ ...newAccountDefaults('imap'), ...base, name: 'IMAP elérhetetlen', email: 'i@example.invalid', in_port: 1, in_user: 'i', in_password: 'nem-valodi' }).account
  const live = store.save({ ...newAccountDefaults('imap'), ...base, name: 'IMAP élő', email: 'l@example.invalid', in_port: wire.port, in_user: 'l', in_password: 'nem-valodi' }).account
  const index = new MailIndex(db)
  index.upsertFolder({ account_id: live.id, path: 'INBOX', uidvalidity: '7', synced_at: now })
  index.insertMany([{ account_id: live.id, folder: 'INBOX', uid: 1, message_id: null, in_reply_to: null, refs: null, from_addr: 'w@example.invalid', from_name: 'Wire',
    to_addrs: '', cc_addrs: '', subject: 'Szerveren levo', date: now, idate: now, flags: '', size: wireSource.length, has_attachments: 0, attachments: null, body_state: 3, sender_text: '', recipients_text: '' },
  { account_id: live.id, folder: 'INBOX', uid: 2, message_id: null, in_reply_to: null, refs: null, from_addr: 'w@example.invalid', from_name: 'Wire',
    to_addrs: '', cc_addrs: '', subject: 'Masik szerveren', date: now - 1000, idate: now - 1000, flags: '', size: wireOther.length, has_attachments: 0, attachments: null, body_state: 3, sender_text: '', recipients_text: '' }])
  index.upsertFolder({ account_id: live.id, path: 'Archív', uidvalidity: '7', synced_at: now })
  index.upsertFolder({ account_id: imap.id, path: 'INBOX', uidvalidity: '1', synced_at: now })
  index.insertMany([{ account_id: imap.id, folder: 'INBOX', uid: 1, message_id: null, in_reply_to: null, refs: null, from_addr: 'x@example.invalid', from_name: 'IMAP feladó',
    to_addrs: '', cc_addrs: '', subject: 'Soha nem töltött', date: now, idate: now, flags: '', size: 1, has_attachments: 0, attachments: null, body_state: 3, sender_text: '', recipients_text: '' }])
  db.close()
}
const tmpDir = path.join(dataDir, 'tmp')
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
const dragDirs = () => (fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).filter(n => n.startsWith('drag-')) : [])
const foreign = path.join(work, 'idegen.eml')
fs.writeFileSync(foreign, sources.get(1))

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleErrors = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleErrors.push(m.text()))
  await page.setViewportSize({ width: 1280, height: 900 })
  await watchStartDrag(app)
  const row = subject => page.locator('.msg-row', { hasText: subject })
  const pop = page.locator('.folder-tree section', { hasText: 'POP3-fiók' })
  const popFolder = p => pop.locator(`.folder[data-path="${p}"]`)
  const total = () => page.evaluate(() => Number(document.querySelector('.list-count')?.dataset.total))
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await popFolder('INBOX').waitFor({ timeout: 20000 })
  await popFolder('INBOX').click()
  await page.waitForFunction(n => document.querySelector('.list-count')?.dataset.total === String(n), COUNT, { timeout: 30000 })
  await row('POP 05').waitFor()

  // 1. one row
  const one = await startRowDrag(app, row('POP 05'))
  const f1 = one.drag ? one.drag.files : []
  check('one row: the HTML drag is cancelled, the native drag gets one file', one.cancelled && f1.length === 1, JSON.stringify(one))
  check('the file: data\\tmp\\drag-*\\<subject>.eml with the message byte for byte', f1.length === 1 && path.dirname(path.dirname(f1[0])) === tmpDir && /^drag-[0-9a-f]{16}$/.test(path.basename(path.dirname(f1[0]))) && path.basename(f1[0]) === 'POP 05.eml' && fs.readFileSync(f1[0]).equals(sources.get(5)), f1.join())
  check('the drag picture: a 32 x 32 image', one.drag && one.drag.icon && one.drag.size.width === 32 && one.drag.size.height === 32, JSON.stringify(one.drag && one.drag.size))
  const click = () => page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown'))) // the native drag is over
  await click()

  // 2. three selected, two subjects in different letter case; no subject
  // a RegExp: Playwright's text filter ignores letter case
  for (const s of [/Ugyanaz a tárgy/, /UGYANAZ A TÁRGY/, 'POP 06']) await row(s).locator('.col-check input').check()
  const three = await startRowDrag(app, row('POP 06'))
  const names = three.drag ? three.drag.files.map(f => path.basename(f)) : []
  check('three selected: three files in one folder, the same name in another letter case gets -2', three.drag && new Set(three.drag.files.map(f => path.dirname(f))).size === 1 && names.length === 3 && names.includes('Ugyanaz a tárgy.eml') && names.includes('UGYANAZ A TÁRGY-2.eml') && names.includes('POP 06.eml'), names.join(' | '))
  await click()
  await page.getByRole('button', { name: t.selectMenu, exact: true }).click()
  await page.getByRole('menuitem', { name: t.selectMenuItems.none, exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.msg-row.selected').length === 0)
  const none = await startRowDrag(app, row(/Feladó 4(?!\d)/))
  check('no subject: the dictionary\'s name', none.drag && path.basename(none.drag.files[0]) === `${t.sourceFileFallback}.eml` && fs.readFileSync(none.drag.files[0]).equals(sources.get(4)), JSON.stringify(none))
  await click()

  // 3. the same drag back onto Drafts: a move
  const before = await total()
  const moved = await dragMessageTo(app, page, row('POP 07'), popFolder('Drafts'))
  await page.waitForFunction(n => Number(document.querySelector('.list-count')?.dataset.total) === n, before - 1, { timeout: 5000 }).catch(() => {})
  check('our own files dropped on a folder: taken, the message moves out of INBOX', moved.accepted && (await total()) === before - 1 && (await row('POP 07').count()) === 0, JSON.stringify({ moved, before, after: await total(), console: consoleErrors.slice(-5) }))

  // 4. a foreign file
  const own = await startRowDrag(app, row('POP 08'))
  const foreignDrop = await dropFiles(page, [foreign], popFolder('Drafts'))
  await page.waitForTimeout(500)
  check('during our drag a foreign file: taken as a target, but nothing moves', own.drag && foreignDrop.accepted && (await total()) === before - 1 && (await row('POP 08').count()) === 1, JSON.stringify({ foreignDrop, total: await total() }))
  await click()
  const noDrag = await dropFiles(page, [foreign], popFolder('Drafts'))
  check('no drag of ours: a Files drag is not taken', noDrag.accepted === false)

  // 3b. Drafts has the moved message
  await popFolder('Drafts').click()
  await row('POP 07').waitFor({ timeout: 5000 }).catch(() => {})
  check('Drafts has the moved message', (await row('POP 07').count()) === 1)

  // 5. IMAP, not downloaded yet: the first drag is the list's own, the second goes out
  const liveInbox = page.locator('.folder-tree section', { hasText: 'IMAP élő' }).locator('.folder[data-path="INBOX"]')
  await liveInbox.click()
  await row('Szerveren levo').waitFor({ timeout: 10000 })
  let dragsBefore = (await startedDrags(app)).length
  const bodyFetches = uid => wire.log.filter(l => new RegExp(`UID FETCH ${uid} .*BODY`, 'i').test(l)).length
  // dropped on a folder: exactly the old move, nothing downloaded first
  const toArchive = await dragMessageTo(app, page, row('Masik szerveren'), page.locator('.folder-tree section', { hasText: 'IMAP élő' }).locator('.folder[data-path="Archív"]'))
  await page.waitForTimeout(800)
  const noticeAfterMove = await page.locator('.action-notice').count()
  check('not downloaded, dropped on a folder: the list\'s own drag, no download, no notice (the move does not wait for one)', !toArchive.cancelled && toArchive.accepted && toArchive.dropEffect === 'move' && bodyFetches(2) === 0 && noticeAfterMove === 0, JSON.stringify({ toArchive, body: bodyFetches(2), noticeAfterMove }))
  const first = await startRowDrag(app, row('Szerveren levo'))
  const noticeDuring = await page.locator('.action-notice').count()
  await endRowDrag(page)
  const firstNotice = await page.locator('.action-notice').innerText({ timeout: 3000 }).catch(() => '')
  check('not downloaded, let go outside: the list\'s own drag, no file, the notice only after it', !first.cancelled && first.types.includes(DRAG_TYPE) && (await startedDrags(app)).length === dragsBefore && noticeDuring === 0 && firstNotice === t.dragOut.notice('notYet'), JSON.stringify({ first, noticeDuring, firstNotice }))
  let second = null
  for (let i = 0; i < 40 && !(second && second.cancelled); i++) {
    await page.waitForTimeout(250)
    second = await startRowDrag(app, row('Szerveren levo'))
    if (!second.cancelled) await endRowDrag(page)
  }
  check('downloaded in the background: the second drag, without a reload, takes it out with its bytes', second && second.cancelled && second.drag && fs.readFileSync(second.drag.files[0]).equals(wireSource) && path.basename(second.drag.files[0]) === 'Szerveren levo.eml', JSON.stringify(second))
  check('the background download set no \\Seen on the server', !wire.flagsOf('INBOX', 1).includes('\\Seen'), wire.flagsOf('INBOX', 1).join(' '))
  await click()
  await page.locator('.action-notice').getByRole('button').first().click().catch(() => {})

  // 5b. the unreachable server: the background download ends in an error line
  const imap = page.locator('.folder-tree section', { hasText: 'IMAP elérhetetlen' }).locator('.folder[data-path="INBOX"]')
  await imap.click()
  await row('Soha nem töltött').waitFor({ timeout: 10000 })
  dragsBefore = (await startedDrags(app)).length
  const failed = await startRowDrag(app, row('Soha nem töltött'))
  await endRowDrag(page)
  const errText = await page.locator('.action-error').innerText({ timeout: 5000 }).catch(() => '')
  check('a message that cannot be fetched: the list\'s own drag, then an error line, no file', !failed.cancelled && (await startedDrags(app)).length === dragsBefore && errText === t.dragOut.error('connection_refused'), errText)
  if (errText) await page.locator('.action-error').getByRole('button').first().click().catch(() => {})
  await page.locator('.action-notice').getByRole('button').first().click().catch(() => {})

  // 6. all 55 (54 left in INBOX): the internal drag with a notice
  await popFolder('INBOX').click()
  await page.waitForFunction(n => document.querySelector('.list-count')?.dataset.total === String(n), COUNT - 1, { timeout: 10000 })
  await page.locator('.msg-viewport').focus()
  await page.keyboard.press('Control+a')
  await page.waitForFunction(text => document.querySelector('.selection-count')?.innerText.includes(text), t.selectedCount(COUNT - 1))
  const nDrags = (await startedDrags(app)).length
  const big = await startRowDrag(app, row('POP 10'))
  await endRowDrag(page)
  const notice = await page.locator('.action-notice').innerText({ timeout: 3000 }).catch(() => '')
  await page.waitForTimeout(300)
  check('over 50: no files, the internal drag, let go outside: a notice with the numbers', !big.cancelled && big.types.includes('application/x-shadowmail-ids') && (await startedDrags(app)).length === nDrags && notice === t.dragOut.tooMany(COUNT - 1, 50), JSON.stringify({ big, notice }))
  await page.locator('.action-notice').getByRole('button').first().click().catch(() => {})
  await startRowDrag(app, row('POP 10'))
  const bigDrop = (await dropRowDrag(popFolder('Drafts'))).accepted
  check('dropped on a folder: no notice', (await page.locator('.action-notice').count()) === 0)
  await page.waitForFunction(() => Number(document.querySelector('.list-count')?.dataset.total) === 0, null, { timeout: 10000 }).catch(() => {})
  check('the internal drag over 50 still moves all of them onto a folder', bigDrop && (await total()) === 0, String(await total()))

  // 7. lock: every drag folder goes; the log
  check('before the lock: the drag folders are there', dragDirs().length >= 4, String(dragDirs().length))
  const lockRes = await page.evaluate(() => window.shadowMail.vault.lock())
  check('the lock takes every drag folder', lockRes && lockRes.ok !== false && dragDirs().length === 0, JSON.stringify({ lockRes, left: dragDirs() }))
  const log = fs.readFileSync(mainLog, 'utf8')
  check('main.log: the counts', log.includes('drag out: 1 message(s), ') && log.includes('drag out: 3 message(s), '))
  check('main.log: no subject, no file name', !['POP 05', 'POP 06', 'Ugyanaz', 'UGYANAZ', 'Soha nem', '.eml'].some(s => log.split('\n').filter(l => /drag/i.test(l)).join('\n').includes(s)))
  check('the page console is clean', consoleErrors.length === 0, consoleErrors.join(' | '))
} catch (err) {
  console.log(`FAIL exception: ${err && err.stack}`)
  results.push(false)
} finally {
  await app.close().catch(() => {})
  await server.close()
  await wire.close()
  fs.rmSync(work, { recursive: true, force: true })
}
const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed} / ${results.length} OK`)
process.exit(failed ? 1 : 0)
