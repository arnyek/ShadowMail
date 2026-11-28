#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The reader's drag handle, in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/reader-drag-e2e.mjs [--shots <dir>]      (E2E_LANG=en: the same in English)
//
// A POP3 account (fake POP3 server, its messages stored here) with six messages, the reader beside the list.
// Headless ozone has no OS drag (test/e2e/drag-env.mjs): the handle gets Chromium's own dragstart, the main process's
// startDrag is recorded, a drop back onto a folder is played with the files.
// 1. The handle: 24 x 24 or more, before the subject, its name (title and aria-label) from the dictionary.
// 2. Its dragstart goes the list's way with the one open message: the HTML drag cancelled, one file, the message's bytes,
//    the same file a list row's drag of that message gives; the main log counts one message.
// 3. Dropped on Drafts: the message moves (the list and Drafts counts), the reader opens the next one (below it).
// 4. The subject and the sender stay selectable with the mouse; no drag starts there (nothing is draggable outside the
//    handle).
// 5. Every pane (right, bottom, none) and every theme in an 860 px window with the list at its widest (the 360 px
//    reader): the handle is there, 24 x 24, inside the reader; a long subject wraps beside it, nothing out of the reader;
//    --shots: the window per theme.
// The page console has no error or warning.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { THEMES } from '../../app/renderer/src/themes.js'
import { t, seedLanguage } from './lang.mjs'
import { watchStartDrag, startedDrags, startRowDrag, dragMessageTo } from './drag-env.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-fogantyu'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null
if (shots) fs.mkdirSync(shots, { recursive: true })

const LONG = `Hosszú tárgy ${'nagyonhosszúszóközöknélküliszó'.repeat(4)} és még néhány szó a végén is`
const SUBJECTS = ['Egy', 'Kettő', 'Három', 'Négy', 'Öt', LONG]
const sources = new Map()
const server = await new FakePop3Server().listen()
SUBJECTS.forEach((s, i) => {
  const src = Buffer.from(`From: Feladó Ferenc <ff@example.invalid>\r\nTo: p@example.invalid\r\nSubject: ${s}\r\nDate: ${new Date(2025, 3, i + 1, 12).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nszöveg ${i}\r\n`)
  sources.set(s, src)
  server.add(src)
})
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-reader-drag-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  store.save({ ...newAccountDefaults('pop3'), ...base, name: 'POP3-fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass })
  db.close()
}
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && !/ERR_CONNECTION_REFUSED|connect ECONNREFUSED/.test(m.text()) && consoleLines.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e.message}`))
  await page.setViewportSize({ width: 1280, height: 900 })
  await watchStartDrag(app)
  const pop = page.locator('.folder-tree section', { hasText: 'POP3-fiók' })
  const popFolder = p => pop.locator(`.folder[data-path="${p}"]`)
  const row = s => page.locator('.msg-row', { hasText: s })
  const total = () => page.evaluate(() => Number(document.querySelector('.list-count')?.dataset.total))
  const openName = () => page.locator('section.reader[data-message-id]').getAttribute('aria-label').catch(() => null)
  const handle = page.locator('section.reader .reader-drag-handle')
  const openMessage = async s => {
    await row(s).click()
    for (const end = performance.now() + 8000; performance.now() < end; await sleep(50)) if ((await openName()) === s) break
    await handle.waitFor({ timeout: 5000 })
  }
  // the reading pane by the pref and a reload (the vault stays open)
  const pane = async (p, theme = 'default', width = 1280) => {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(([x, th]) => {
      localStorage.setItem('shadowmail.ui.readerPane', JSON.stringify(x))
      localStorage.setItem('shadowmail.ui.theme', JSON.stringify(th))
    }, [p, theme])
    await Promise.all([page.waitForEvent('load', { timeout: 20_000 }), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.webContents.reload()))])
    await page.waitForFunction(th => document.documentElement.dataset.theme === th, theme, { timeout: 20_000 })
    await popFolder('INBOX').waitFor({ timeout: 20_000 })
    await popFolder('INBOX').click()
    await row('Egy').waitFor({ timeout: 10_000 })
  }
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await popFolder('INBOX').waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => document.querySelectorAll('.folder-tree .folder').length > 0)
  await pane('right')
  await page.waitForFunction(n => document.querySelector('.list-count')?.dataset.total === String(n), SUBJECTS.length, { timeout: 30_000 })

  // 1. the handle
  await openMessage('Három')
  const h = await page.evaluate(() => {
    const el = document.querySelector('section.reader .reader-drag-handle')
    const r = el.getBoundingClientRect()
    const subject = document.querySelector('section.reader .reader-subject').getBoundingClientRect()
    return { w: r.width, h: r.height, title: el.getAttribute('title'), label: el.getAttribute('aria-label'), draggable: el.draggable, beforeSubject: r.right <= subject.left + 0.5, sameRow: Math.abs(r.top - subject.top) < 12 }
  })
  check('1. the handle: >= 24 x 24, draggable, before the subject on its line, its name from the dictionary', h.w >= 24 && h.h >= 24 && h.draggable && h.beforeSubject && h.sameRow && h.title === t.readerDragHandle && h.label === t.readerDragHandle, JSON.stringify(h))

  // 2. the list's way: one file with the message's bytes, as the row's own drag gives it
  const fromHandle = await startRowDrag(app, handle)
  const f = fromHandle.drag ? fromHandle.drag.files : []
  check('2. the handle\'s dragstart: the HTML drag cancelled, one file, the open message byte for byte', fromHandle.cancelled && f.length === 1 && path.basename(f[0]) === 'Három.eml' && fs.readFileSync(f[0]).equals(sources.get('Három')), JSON.stringify(fromHandle))
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown'))) // the native drag is over
  const fromRow = await startRowDrag(app, row('Három'))
  check('2. the same as the list row\'s drag of that message (file name and bytes)', f.length === 1 && fromRow.drag && fromRow.drag.files.length === 1 && path.basename(fromRow.drag.files[0]) === path.basename(f[0]) && fs.readFileSync(fromRow.drag.files[0]).equals(fs.readFileSync(f[0])), JSON.stringify(fromRow))
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown')))
  const log = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8') : ''
  check('2. the main log: two drags of one message each', (log.match(/drag out: 1 message\(s\), /g) || []).length === 2, log.split('\n').filter(l => /drag/.test(l)).join(' | '))

  // 3. onto Drafts: a move, the reader opens the one below
  const before = await total()
  const moved = await dragMessageTo(app, page, handle, popFolder('Drafts'))
  await page.waitForFunction(n => Number(document.querySelector('.list-count')?.dataset.total) === n, before - 1, { timeout: 5000 }).catch(() => {})
  for (const end = performance.now() + 5000; performance.now() < end && (await openName()) !== 'Kettő'; await sleep(50));
  check('3. dropped on Drafts: taken, out of INBOX', moved.accepted && (await total()) === before - 1 && (await row('Három').count()) === 0, JSON.stringify({ moved, before, after: await total() }))
  check('3. the reader opens the next one (below it in the list)', (await openName()) === 'Kettő', String(await openName()))
  const draftsHas = await page.evaluate(async () => {
    const r = await window.shadowMail.mail.list({ accountId: Number(document.querySelector('.folder-tree section[data-account]').dataset.account), folder: 'Drafts', sort: 'date', dir: 'desc', offset: 0, limit: 50 })
    return r.rows.map(x => x.subject)
  })
  check('3. Drafts has it', draftsHas.includes('Három'), JSON.stringify(draftsHas))

  // 4. the subject and the sender stay selectable; no drag there
  const dragsBefore = (await startedDrags(app)).length
  const sel = async selector => {
    const box = await page.locator(`section.reader ${selector}`).first().boundingBox()
    await page.mouse.move(box.x + 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    return page.evaluate(() => String(window.getSelection()))
  }
  const subjectSel = await sel('.reader-subject')
  const senderSel = await sel('.reader-from-name')
  const noDraggable = await page.evaluate(() => {
    const header = document.querySelector('section.reader .reader-header')
    return [...header.querySelectorAll('[draggable="true"]')].map(e => e.className)
  })
  check('4. the subject selects with the mouse', subjectSel.length >= 3 && 'Kettő'.startsWith(subjectSel.trim().slice(0, 3)), JSON.stringify(subjectSel))
  check('4. the sender selects with the mouse', senderSel.trim().length >= 3, JSON.stringify(senderSel))
  check('4. nothing draggable in the header but the handle; no drag started', JSON.stringify(noDraggable) === JSON.stringify(['reader-drag-handle']) && (await startedDrags(app)).length === dragsBefore, JSON.stringify(noDraggable))

  // 5. every pane, every theme at 360 px
  const fit = () =>
    page.evaluate(() => {
      const reader = document.querySelector('section.reader').getBoundingClientRect()
      const hd = document.querySelector('section.reader .reader-drag-handle').getBoundingClientRect()
      const subjectEl = document.querySelector('section.reader .reader-subject')
      const s = subjectEl.getBoundingClientRect()
      const header = document.querySelector('section.reader .reader-header')
      return {
        reader: Math.round(reader.width),
        handle: [Math.round(hd.width), Math.round(hd.height)],
        handleInside: hd.left >= reader.left - 0.5 && hd.right <= reader.right + 0.5,
        subjectInside: s.left >= hd.right - 0.5 && s.right <= reader.right + 0.5 && s.width > 40,
        headerOverflow: header.scrollWidth - header.clientWidth,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
  for (const p of ['bottom', 'none']) {
    await pane(p)
    await openMessage('Egy')
    const r = await fit()
    check(`5. pane ${p}: the handle there, 24 x 24, inside the reader`, r.handle[0] >= 24 && r.handle[1] >= 24 && r.handleInside && r.subjectInside, JSON.stringify(r))
  }
  for (const { id } of THEMES) {
    await pane('right', id, 860)
    await openMessage(LONG.slice(0, 14))
    const split = page.locator('.splitter[data-split="list"]')
    await split.focus()
    for (let i = 0; i < 40; i++) await split.press('ArrowRight')
    await sleep(300)
    const r = await fit()
    check(`5. ${id}, ${r.reader} px reader, a long subject: the handle 24 x 24 inside, the subject wraps beside it, nothing out`, r.reader <= 362 && r.handle[0] >= 24 && r.handle[1] >= 24 && r.handleInside && r.subjectInside && r.headerOverflow <= 1 && r.page <= 0, JSON.stringify(r))
    if (shots) await page.screenshot({ path: path.join(shots, `${id}-860.png`) })
  }

  check('the page console: no error or warning', consoleLines.length === 0, consoleLines.join(' | '))
} catch (err) {
  console.log(`FAIL exception: ${err && err.stack}`)
  results.push(false)
} finally {
  await app.close().catch(() => {})
  await server.close()
  fs.rmSync(work, { recursive: true, force: true })
}
const failed = results.filter(r => !r).length
console.log(`${results.length - failed} / ${results.length} OK`)
process.exit(failed ? 1 : 0)
