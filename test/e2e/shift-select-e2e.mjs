#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The Shift selection of the message list in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   E2E_LANG=hu|en node test/e2e/shift-select-e2e.mjs [--perf <rows>] [--shots <dir>]
//
// A POP3 account with 30 messages (POP 01 the newest, at the top). Shift on a row's checkbox (the usual webmail way):
// the range from the anchor takes the state the clicked row turns to (on: added, off: taken out), the rest stays; the
// clicked row is the new anchor. Shift on a row replaces the selection with the range (as before), Ctrl+Shift adds it.
// A range over the whole list (the scroll in between), no text selection after a Shift click, no anchor after a
// sort change, and a Shift range dragged onto a folder moves all of it.
// --perf <rows>: a second account with that many rows (the encrypted file, seeded directly): Shift on a checkbox,
// from the click to the selection count, 9 times, the median printed.
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

const { values } = parseArgs({ options: { perf: { type: 'string' }, shots: { type: 'string' } } })
if (values.shots) fs.mkdirSync(values.shots, { recursive: true })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-shift-kijeloles'
const now = Date.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const server = await new FakePop3Server().listen()
for (let i = 1; i <= 30; i++) {
  server.add(Buffer.from(`From: Feladó ${i} <f${i}@example.invalid>\r\nTo: p@example.invalid\r\nSubject: POP ${String(i).padStart(2, '0')}\r\nDate: ${new Date(now - i * 60_000).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nszöveg ${i}\r\n`))
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-shift-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
const PERF = values.perf ? Number(values.perf) : 0
let perfId = null
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  store.save({ ...newAccountDefaults('pop3'), ...base, name: 'POP3-fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass })
  if (PERF) {
    perfId = store.save({ ...newAccountDefaults('imap'), ...base, name: 'Nagy fiók', email: 'n@example.invalid', in_port: 1, in_user: 'n', in_password: 'nem-valodi' }).account.id
    const index = new MailIndex(db)
    index.upsertFolder({ account_id: perfId, path: 'INBOX', delimiter: '/', uidvalidity: '1', synced_at: now })
    const rows = []
    for (let i = 1; i <= PERF; i++) {
      rows.push({ account_id: perfId, folder: 'INBOX', uid: i, message_id: `<n${i}@x>`, in_reply_to: null, refs: null, from_addr: 'n@example.invalid', from_name: 'Nagy', to_addrs: '', cc_addrs: '', bcc_addrs: '', subject: `Nagy ${i}`, date: now - i * 1000, idate: now - i * 1000, flags: '\\Seen', size: 10, has_attachments: 0, attachments: null, body_state: 3, sender_text: '', recipients_text: '' })
      if (rows.length === 5000) index.insertMany(rows.splice(0))
    }
    if (rows.length) index.insertMany(rows)
  }
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
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
  const pop = page.locator('.folder-tree section', { hasText: 'POP3-fiók' })
  await pop.locator('.folder[data-path="INBOX"]').waitFor({ timeout: 20000 })
  await pop.locator('.folder[data-path="INBOX"]').click()
  await page.waitForFunction(() => document.querySelector('.list-count')?.dataset.total === '30', null, { timeout: 20000 })
  const row = subject => page.locator('.msg-row', { hasText: subject })
  const box = subject => row(subject).locator('.col-check input')
  // the header's "N selected" (the rows off screen are not in the DOM)
  const selectedIs = async n => {
    const want = t.selectedCount(n)
    await page.waitForFunction(w => document.querySelector('.selection-count')?.innerText === w, want, { timeout: 4000 }).catch(() => {})
    return (await page.locator('.selection-count').innerText().catch(() => '')) === want
  }
  const none = async () => {
    await page.getByRole('button', { name: t.selectMenu, exact: true }).click()
    await page.getByRole('menuitem', { name: t.selectMenuItems.none, exact: true }).click()
    await page.locator('.list-tools').waitFor()
  }
  const scrollList = async y => {
    await page.locator('.msg-viewport').evaluate((el, v) => (el.scrollTop = v === 'end' ? el.scrollHeight : v), y)
    await sleep(250)
  }

  // 1. checkbox POP 03, Shift+checkbox POP 07: 03..07 (5); no text selection after it
  await box('POP 03').click()
  await box('POP 07').click({ modifiers: ['Shift'] })
  check('Shift on a checkbox: the range from the anchor (03..07, 5)', await selectedIs(5))
  if (values.shots) await page.screenshot({ path: path.join(values.shots, 'shift-range.png') })
  check('after a Shift click no text is selected', (await page.evaluate(() => window.getSelection().toString())) === '')
  // 2. checkbox POP 20, Shift+checkbox POP 22: 8 (the earlier range stays)
  await scrollList(400)
  await box('POP 20').click()
  await box('POP 22').click({ modifiers: ['Shift'] })
  check('a second range: added, the first stays (8)', await selectedIs(8))
  // 3. Shift on a selected checkbox (POP 05): 05..22 taken out, 03 and 04 stay
  await scrollList(0)
  await box('POP 05').click({ modifiers: ['Shift'] })
  check('Shift on a selected checkbox: the range 05..22 out, 03-04 stay (2)', await selectedIs(2))
  check('the two left are 03 and 04', (await row('POP 03').getAttribute('class')).includes('selected') && (await row('POP 04').getAttribute('class')).includes('selected') && !(await row('POP 05').getAttribute('class')).includes('selected'))

  // 4. rows: Shift replaces (the anchor stays), Ctrl+Shift adds
  await none()
  await box('POP 03').click()
  await row('POP 06').click({ modifiers: ['Control', 'Shift'] })
  check('Ctrl+Shift on a row: the range added (03..06, 4)', await selectedIs(4))
  await row('POP 10').click({ modifiers: ['Control'] })
  await row('POP 12').click({ modifiers: ['Control', 'Shift'] })
  check('Ctrl+Shift again from the new anchor: added (10..12 joins: 7)', await selectedIs(7))
  await row('POP 08').click({ modifiers: ['Shift'] })
  // the Ctrl+click on POP 10 made it the anchor (Ctrl+Shift keeps it): Shift on POP 08 -> 08..10
  check('Shift on a row: the selection replaced by the range from the anchor (08..10, 3)', await selectedIs(3))
  check('no message opened by a Shift / Ctrl+Shift click', (await page.locator('.reader[data-message-id]').count()) === 0)

  // 5. a range over the whole list, the scroll in between
  await none()
  await scrollList(0)
  await box('POP 01').click()
  await scrollList('end')
  await box('POP 30').click({ modifiers: ['Shift'] })
  check('top to bottom (scrolled): all 30', await selectedIs(30))

  // 6. a sort change drops the anchor: Shift then toggles one row
  // the anchor set (POP 02), the selection emptied again (the anchor stays), then the order changes
  await none()
  await scrollList(0)
  await box('POP 02').click()
  await none()
  await page.getByRole('button', { name: t.moreMenu, exact: true }).click()
  await page.getByRole('menuitemradio', { name: t.sortMenu.subject, exact: true }).click()
  await sleep(300)
  await page.locator('.msg-row', { hasText: 'POP 09' }).waitFor()
  await box('POP 09').click({ modifiers: ['Shift'] })
  check('after a sort change no anchor: Shift toggles one row (1 selected)', await selectedIs(1))
  await none()
  await page.getByRole('button', { name: t.moreMenu, exact: true }).click()
  await page.getByRole('menuitemradio', { name: t.sortMenu.date, exact: true }).click()
  await sleep(300)

  // 7. a Shift range dragged onto a folder: every selected message moves
  await scrollList(0)
  await box('POP 11').click()
  await box('POP 14').click({ modifiers: ['Shift'] })
  check('the range to drag (11..14, 4)', await selectedIs(4))
  // out as files and back onto the folder (drag-env.mjs: headless has no OS drag)
  await dragMessageTo(app, page, row('POP 12'), pop.locator('.folder[data-path="Trash"]'))
  await page.waitForFunction(() => document.querySelector('.list-count')?.dataset.total === '26', null, { timeout: 8000 }).catch(() => {})
  check('dragged onto a folder: all four moved (30 -> 26)', (await page.locator('.list-count').getAttribute('data-total')) === '26')

  // 8. Shift on a row with no anchor (another view drops it): the message opens, the browser selects no text
  await pop.locator('.folder[data-path="Trash"]').click()
  await pop.locator('.folder[data-path="INBOX"]').click()
  await page.waitForFunction(() => document.querySelector('.list-count')?.dataset.total === '26', null, { timeout: 8000 }).catch(() => {})
  await row('POP 20').click({ modifiers: ['Shift'] })
  await sleep(300)
  const stray = await page.evaluate(() => window.getSelection().toString())
  check('Shift on a row without an anchor: no text selected', stray === '', JSON.stringify(stray.slice(0, 80)))

  // --perf: Shift on a checkbox over many rows
  if (PERF) {
    const big = page.locator(`.folder-tree section[data-account="${perfId}"] .folder[data-path="INBOX"]`)
    await big.click()
    await page.waitForFunction(n => document.querySelector('.list-count')?.dataset.total === String(n), PERF, { timeout: 60000 })
    const times = []
    for (let k = 0; k < 9; k++) {
      await none().catch(() => {})
      await scrollList(0)
      // the exact subject ("Nagy 1" is also the start of "Nagy 10")
      const bigBox = n => page.locator('.msg-row').filter({ has: page.locator('.col-subject', { hasText: new RegExp(`^Nagy ${n}$`) }) }).locator('.col-check input')
      await bigBox(1).click()
      const want = t.selectedCount(10 + k)
      const t0 = performance.now()
      await bigBox(10 + k).click({ modifiers: ['Shift'] })
      const got = await page.waitForFunction(w => document.querySelector('.selection-count')?.innerText === w, want, { timeout: 10000, polling: 'raf' }).then(() => true, () => false)
      if (!got) {
        const seen = await page.locator('.selection-count').innerText().catch(() => '(none)')
        const top = await page.locator('.msg-row .col-subject').evaluateAll(els => els.slice(0, 4).map(e => e.textContent))
        throw new Error(`perf round ${k}: wanted "${want}", the header says "${seen}", top rows ${JSON.stringify(top)}`)
      }
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    console.log(`PERF ${PERF} rows: Shift+checkbox to the count, median ${times[4].toFixed(0)} ms, min ${times[0].toFixed(0)}, max ${times[8].toFixed(0)}`)
    check(`perf: median within the 300 ms budget (${times[4].toFixed(0)} ms)`, times[4] <= 300)
  }

  const text = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8') : ''
  check('main.log: no error line for the selection', !/selection|range/i.test(text.split('\n').filter(l => / failed| error/i.test(l)).join('\n')))
  check('the page console: no error or warning', consoleLines.length === 0, consoleLines.join(' | '))
} catch (err) {
  console.error(err)
  results.push(false)
} finally {
  if (app) await app.close().catch(() => {})
  await server.close?.()
  fs.rmSync(work, { recursive: true, force: true })
}
const failed = results.filter(r => !r).length
console.log(`${results.length - failed}/${results.length} OK`)
process.exit(failed ? 1 : 0)
