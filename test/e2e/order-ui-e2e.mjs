#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The manual order of the accounts and folders in the sidebar, in the real app (headless Electron + Playwright). Not
// part of `npm test`.
//
//   node test/e2e/order-ui-e2e.mjs [--shots <folder>]
//
// A POP3 account (fake POP3 server, local folders) and two unreachable IMAP accounts. Measured: a folder moved by
// drag, by its menu (Up / Down) and by Alt+Up / Alt+Down; an account head the same three ways; a folder dropped on a
// folder under another parent changes nothing (no line while over it, no hierarchy change, no message moved); a
// message dragged onto a folder still moves; the composer's From list and the settings' account list show the new
// account order; everything stays after a restart; "Sort folders A-Z" gives the old order with the selected folder and
// the open message unchanged. --shots: the drag line of a folder and of an account head, and the two menus.
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

const { values } = parseArgs({ options: { shots: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-sorrend-ui'
const now = Date.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))
if (values.shots) fs.mkdirSync(values.shots, { recursive: true })

const server = await new FakePop3Server().listen()
for (let i = 1; i <= 3; i++) server.add(Buffer.from(`From: f${i}@example.invalid\r\nSubject: POP ${i}\r\nDate: ${new Date(now - i * 60_000).toUTCString()}\r\n\r\nszöveg ${i}\r\n`))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-order-ui-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let pop, imapB, imapC
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  pop = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'Első fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass }).account.id
  imapB = store.save({ ...newAccountDefaults('imap'), ...base, name: 'Második fiók', email: 'b@example.invalid', in_port: 1, in_user: 'b', in_password: 'nem-valodi' }).account.id
  imapC = store.save({ ...newAccountDefaults('imap'), ...base, name: 'Harmadik fiók', email: 'c@example.invalid', in_port: 1, in_user: 'c', in_password: 'nem-valodi' }).account.id
  const index = new MailIndex(db)
  for (const p of ['Számlák', 'Ügyek', 'Ügyek/2025', 'Ügyek/2026', 'Archív régi']) index.addFolder(pop, p, '/', true)
  for (const id of [imapB, imapC]) index.upsertFolder({ account_id: id, path: 'INBOX', delimiter: '/', uidvalidity: '1', synced_at: now })
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
const quits = () => server.log.filter(l => l === 'QUIT').length

async function start() {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  const before = quits()
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator(`.folder-tree section[data-account="${pop}"] .folder[data-path="INBOX"]`).waitFor({ timeout: 20000 })
  for (let i = 0; quits() === before; i++) {
    if (i > 400) throw new Error('the first POP3 fetch did not end')
    await sleep(50)
  }
  return { app, page }
}
// a context menu opened on <loc> at a point of the window (x, y; negative = from the right / bottom edge): its box
const menuAt = async (page, loc, x, y) => {
  await loc.evaluate((el, [px, py]) => {
    const cx = px < 0 ? innerWidth + px : px
    const cy = py < 0 ? innerHeight + py : py
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: cx, clientY: cy }))
  }, [x, y])
  const menu = page.getByRole('menu')
  await menu.waitFor()
  const r = await menu.evaluate(el => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, w: innerWidth, h: innerHeight } })
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
  return r
}
// at the bottom-right corner (2 px in): inside the window, its bottom-right corner at the point (opened up and left)
const cornerOk = r => r.left >= 0 && r.top >= 0 && r.right <= r.w && r.bottom <= r.h && Math.abs(r.right - (r.w - 2)) <= 1 && Math.abs(r.bottom - (r.h - 2)) <= 1
// at a point with room: its top-left corner at the point
const pointOk = (r, x, y) => Math.abs(r.left - x) <= 1 && Math.abs(r.top - y) <= 1
const section = (page, id) => page.locator(`.folder-tree section[data-account="${id}"]`)
const folder = (page, p, id = pop) => section(page, id).locator(`.folder[data-path="${p}"]`)
const shown = (page, id = pop) =>
  section(page, id).locator('.folder').evaluateAll(els => els.map(el => ({ path: el.dataset.path || `(${el.textContent})`, depth: Number(el.style.getPropertyValue('--depth') || 0) })))
const top = async page => (await shown(page)).filter(x => x.depth === 0).map(x => x.path)
const children = async page => (await shown(page)).filter(x => x.depth === 1).map(x => x.path)
const accounts = page => page.locator('.folder-tree section[data-account]').evaluateAll(els => els.map(el => Number(el.dataset.account)))
const lines = page => page.locator('.folder-tree .drop-before, .folder-tree .drop-after').count()
const depths = list => JSON.stringify(list.map(x => [x.path, x.depth]).sort((a, b) => (a[0] < b[0] ? -1 : 1)))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const until = async (fn, what, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true
  throw new Error(`timed out: ${what}`)
}
// a drag with the mouse to the upper (before) or lower (after) part of the target. Playwright's drag emulation
// delivers the drag at the mouse-up: the move is real, the state on the way is not observable (see `hovering`)
async function mouseDrag(page, from, to, { after = false } = {}) {
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 6, { steps: 3 })
  const y = after ? b.y + b.height * 0.8 : b.y + b.height * 0.2
  await page.mouse.move(b.x + b.width / 2, y, { steps: 8 })
  await page.mouse.up()
}
// the state during a drag: Chromium's own DragEvent and DataTransfer, dragstart on `from`, dragover on the upper or
// lower edge of `to`; -> { accepted (the dragover's preventDefault), lines, at (the class of the target's line holder) }
// once the line state has stayed the same for 3 frames (React renders a frame or two later; one frame was too early
// now and then); the drag stays until `endHover`
// (installed as a function literal through the debugger: the page's CSP has no unsafe-eval for a `new Function`)
const installSettle = page =>
  page.evaluate(() => {
    const lineState = to => ({ lines: document.querySelectorAll('.folder-tree .drop-before, .folder-tree .drop-after').length, at: to ? (to.closest('li') || to).className : '' })
    window.__orderSettle = to =>
      new Promise(res => {
        let last = null
        let same = 0
        let frames = 0
        const tick = () => {
          const s = lineState(to)
          const key = JSON.stringify(s)
          same = key === last ? same + 1 : 0
          last = key
          if (same >= 3 || ++frames > 60) res(s)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
  })
const hovering = async (page, from, to, after = false) => {
  await installSettle(page)
  return page.evaluate(
    ([fs, ts, after]) => {
      const settle = window.__orderSettle
      const from = document.querySelector(fs)
      const to = document.querySelector(ts)
      const dt = new DataTransfer()
      window.__orderDrag = { from, dt }
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      const r = to.getBoundingClientRect()
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: after ? r.bottom - 2 : r.top + 2 })
      to.dispatchEvent(over)
      return settle(to).then(s => ({ accepted: over.defaultPrevented, ...s }))
    },
    [from, to, after],
  )
}
// the drag moves on over `sel` (no new dragstart) -> the settled line state
const hoverOn = (page, sel) =>
  page.evaluate(ts => {
    const to = document.querySelector(ts)
    const r = to.getBoundingClientRect()
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__orderDrag.dt, clientX: r.left + 4, clientY: r.top + 2 })
    to.dispatchEvent(over)
    return window.__orderSettle(to).then(s => ({ accepted: over.defaultPrevented, ...s }))
  }, sel)
const endHover = page =>
  page.evaluate(() => {
    const d = window.__orderDrag
    d.from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: d.dt }))
    return window.__orderSettle(null).then(s => s.lines)
  })
const folderSel = (p, id = pop) => `.folder-tree section[data-account="${id}"] .folder[data-path="${p}"]`
const headSel = id => `.folder-tree section[data-account="${id}"] .account-head`

let app = null
try {
  let page
  ;({ app, page } = await start())
  const original = await shown(page)
  const originalTop = await top(page)
  check('the seeded tree: the old rule', same(originalTop, ['INBOX', 'Drafts', 'Sent', 'Trash', 'Archív régi', 'Számlák', 'Ügyek']), JSON.stringify(originalTop))
  // the message count of a POP3 folder, from the main process
  const countIn = p => page.evaluate(([id, f]) => window.shadowMail.mail.folders().then(r => r.accounts.find(a => a.id === id).folders.find(x => x.path === f).count), [pop, p])
  const logAt = server.log.length
  const inboxCount = await countIn('INBOX')

  // 1. drag: Ügyek before Drafts; on the way, one line, before Drafts
  const on = await hovering(page, folderSel('Ügyek'), folderSel('Drafts'))
  if (values.shots) await page.screenshot({ path: path.join(values.shots, 'SO2-folder-drag.png') })
  const gone = await endHover(page)
  check('during a folder drag over a sibling: accepted, one line, before the target; gone at the drag end', on.accepted && on.lines === 1 && on.at === 'drop-before' && gone === 0, JSON.stringify({ on, gone }))
  const onLower = await hovering(page, folderSel('Ügyek'), folderSel('Drafts'), true)
  await endHover(page)
  check('the lower half of the target: the line after it', onLower.lines === 1 && onLower.at === 'drop-after', JSON.stringify(onLower))
  // the drag moves on from a line to a place that takes no folder: the line goes at once (not only at the drag end)
  for (const [what, sel] of [
    ['an account head', headSel(imapB)],
    ['the tree background', '.folder-tree'],
    ['a message row', '.msg-row'],
    ['a folder under another parent', folderSel('Ügyek/2025')],
  ]) {
    const there = await hovering(page, folderSel('Ügyek'), folderSel('Drafts'))
    const moved = await hoverOn(page, sel)
    await endHover(page)
    check(`a folder drag moving on to ${what}: not accepted, no line left`, there.lines === 1 && !moved.accepted && moved.lines === 0, JSON.stringify({ there, moved }))
  }
  await mouseDrag(page, folder(page, 'Ügyek'), folder(page, 'Drafts'))
  await until(async () => same(await top(page), ['INBOX', 'Ügyek', 'Drafts', 'Sent', 'Trash', 'Archív régi', 'Számlák']), 'the dragged order')
  check('drag with the mouse: a folder among its siblings', true)
  await mouseDrag(page, folder(page, 'Ügyek/2026'), folder(page, 'Ügyek/2025'))
  await until(async () => same(await children(page), ['Ügyek/2026', 'Ügyek/2025']), 'the dragged child order')
  check('drag: a child list', true)

  // 2. another parent: no order line; it is a move INTO that folder (framed), which asks first; another account takes
  // nothing. Cancel: no change, no message moved
  const before = await shown(page)
  const other = await hovering(page, folderSel('Ügyek/2025'), folderSel('Számlák'))
  await endHover(page)
  const otherAccount = await hovering(page, folderSel('Számlák'), folderSel('INBOX', imapB))
  await endHover(page)
  check('during a drag over another parent: no order line, the "into" frame; another account: not accepted', other.accepted && other.lines === 0 && other.at === 'drop-into' && !otherAccount.accepted && otherAccount.lines === 0, JSON.stringify([other, otherAccount]))
  await mouseDrag(page, folder(page, 'Ügyek/2025'), folder(page, 'Számlák'))
  const moveAsk = page.getByRole('alertdialog')
  await moveAsk.waitFor()
  const askText = await moveAsk.locator('.confirm-text').innerText()
  await moveAsk.getByRole('button', { name: t.confirmCancel, exact: true }).click()
  await moveAsk.waitFor({ state: 'detached' })
  await sleep(300)
  check('drag with the mouse under another parent: the move question; Cancel leaves the tree unchanged (order and depths)', askText === t.confirmFolderMove('2025', 'Számlák', 0) && same(await shown(page), before), askText)
  // a folder on a folder of its own list is an order change only: no message moved
  await mouseDrag(page, folder(page, 'Számlák'), folder(page, 'INBOX'), { after: true })
  await until(async () => same(await top(page), ['INBOX', 'Számlák', 'Ügyek', 'Drafts', 'Sent', 'Trash', 'Archív régi']), 'Számlák after INBOX')
  check('a folder dropped on INBOX: only the order, the INBOX count unchanged, Számlák still empty', (await countIn('INBOX')) === inboxCount && (await countIn('Számlák')) === 0)

  // 3. a message drag still moves
  // out as files and back onto the folder (drag-env.mjs: headless has no OS drag)
  await dragMessageTo(app, page, page.locator('.msg-row', { hasText: 'POP 1' }), folder(page, 'Számlák'))
  await page.locator('.msg-row', { hasText: 'POP 1' }).waitFor({ state: 'detached' })
  await until(async () => (await countIn('Számlák')) === 1, 'the message in Számlák')
  check('a message dragged onto a folder still moves (and no order line for it)', (await countIn('INBOX')) === inboxCount - 1 && (await lines(page)) === 0)

  // 4. the menu: Up on Archív régi; the top edge disabled
  await folder(page, 'Archív régi').click({ button: 'right' })
  if (values.shots) await page.screenshot({ path: path.join(values.shots, 'SO2-folder-menu.png') })
  const names = await page.getByRole('menu').getByRole('menuitem').allInnerTexts()
  check('the folder menu: every item named, Up and Down among them', names.every(n => n.trim()) && names.includes(t.folderMenu.moveUp) && names.includes(t.folderMenu.moveDown), JSON.stringify(names))
  await page.getByRole('menuitem', { name: t.folderMenu.moveUp, exact: true }).click()
  await until(async () => same(await top(page), ['INBOX', 'Számlák', 'Ügyek', 'Drafts', 'Sent', 'Archív régi', 'Trash']), 'the menu step')
  check('menu: Up', true)
  await folder(page, 'INBOX').click({ button: 'right' })
  const upOff = await page.getByRole('menuitem', { name: t.folderMenu.moveUp, exact: true }).isDisabled()
  const downOn = !(await page.getByRole('menuitem', { name: t.folderMenu.moveDown, exact: true }).isDisabled())
  await page.keyboard.press('Escape')
  check('menu: Up disabled on the first folder, Down enabled', upOff && downOn)
  await folder(page, 'Ügyek/2025').click({ button: 'right' })
  const childDownOff = await page.getByRole('menuitem', { name: t.folderMenu.moveDown, exact: true }).isDisabled()
  await page.keyboard.press('Escape')
  check('menu: Down disabled on the last child', childDownOff)
  // the folder and the account menu stay inside the window (the bottom-right corner: up and left)
  const folderCorner = await menuAt(page, folder(page, 'Számlák'), -2, -2)
  const folderLow = await menuAt(page, folder(page, 'Számlák'), 100, -2)
  const accountCorner = await menuAt(page, section(page, pop).locator('.account-head'), -2, -2)
  const folderPoint = await menuAt(page, folder(page, 'Számlák'), 100, 150)
  check('the folder and the account menu: inside the window at its corner, up from a low point, at the point with room', cornerOk(folderCorner) && cornerOk(accountCorner) && folderLow.bottom <= folderLow.h && Math.abs(folderLow.left - 100) <= 1 && pointOk(folderPoint, 100, 150), JSON.stringify({ folderCorner, folderLow, accountCorner, folderPoint }))

  // 5. the keyboard: Alt+Down on Számlák, the focus stays on it
  await folder(page, 'Számlák').focus()
  await page.keyboard.press('Alt+ArrowDown')
  await until(async () => same(await top(page), ['INBOX', 'Ügyek', 'Számlák', 'Drafts', 'Sent', 'Archív régi', 'Trash']), 'the key step')
  await sleep(100)
  check('Alt+Down: a step, the focus on the moved folder', (await page.evaluate(() => document.activeElement?.dataset?.path)) === 'Számlák')
  await page.keyboard.press('Alt+ArrowUp')
  await page.keyboard.press('Alt+ArrowUp')
  await until(async () => same(await top(page), ['Számlák', 'INBOX', 'Ügyek', 'Drafts', 'Sent', 'Archív régi', 'Trash']), 'two key steps up')
  await page.keyboard.press('Alt+ArrowUp') // at the top: nothing
  await sleep(300)
  check('Alt+Up twice to the top, a third does nothing', same(await top(page), ['Számlák', 'INBOX', 'Ügyek', 'Drafts', 'Sent', 'Archív régi', 'Trash']))
  check('the hierarchy (every depth) unchanged after all of it', depths(await shown(page)) === depths(original))

  // 6. accounts: drag Harmadik before Első, menu Down on Harmadik, Alt+Up on Második
  check('the seeded account order', same(await accounts(page), [pop, imapB, imapC]))
  const head = await hovering(page, headSel(imapC), headSel(pop))
  if (values.shots) await page.screenshot({ path: path.join(values.shots, 'SO2-account-drag.png') })
  // on from the line to a folder (no target for an account): the line goes
  const headMoved = await hoverOn(page, folderSel('Sent'))
  await endHover(page)
  const headOnFolder = await hovering(page, headSel(imapC), folderSel('Sent'))
  await endHover(page)
  check('during an account drag: one line before the target head; on over a folder it goes; a folder is no target', head.accepted && head.lines === 1 && /drop-before/.test(head.at) && !headMoved.accepted && headMoved.lines === 0 && !headOnFolder.accepted && headOnFolder.lines === 0, JSON.stringify({ head, headMoved, headOnFolder }))
  await mouseDrag(page, section(page, imapC).locator('.account-head'), section(page, pop).locator('.account-head'))
  await until(async () => same(await accounts(page), [imapC, pop, imapB]), 'the dragged account order')
  check('drag with the mouse: an account head before another', true)
  await section(page, imapC).locator('.account-head').click({ button: 'right' })
  if (values.shots) await page.screenshot({ path: path.join(values.shots, 'SO2-account-menu.png') })
  const accNames = await page.getByRole('menu').getByRole('menuitem').allInnerTexts()
  // an IMAP account head: the subscriptions dialog too
  check('the account menu: Up, Down, Sort folders A-Z, Folder subscriptions', same(accNames.map(s => s.trim()), [t.accountMenu.moveUp, t.accountMenu.moveDown, t.accountMenu.sortFolders, t.accountMenu.subscriptions]), JSON.stringify(accNames))
  const accUpOff = await page.getByRole('menuitem', { name: t.accountMenu.moveUp, exact: true }).isDisabled()
  await page.getByRole('menuitem', { name: t.accountMenu.moveDown, exact: true }).click()
  await until(async () => same(await accounts(page), [pop, imapC, imapB]), 'the account menu step')
  check('account menu: Up disabled on the first, Down moves', accUpOff)
  await section(page, imapB).locator('.account-toggle').focus()
  await page.keyboard.press('Alt+ArrowUp')
  await until(async () => same(await accounts(page), [pop, imapB, imapC]), 'the account key step')
  await page.keyboard.press('Alt+ArrowUp')
  await until(async () => same(await accounts(page), [imapB, pop, imapC]), 'the account key step 2')
  check('Alt+Up on an account head, the focus stays on it', (await page.evaluate(() => document.activeElement?.closest('section')?.dataset.account)) === String(imapB))

  // 7. the composer's From list and the settings' account list
  const ordered = await shown(page)
  check('the folder order before the restart', same(ordered.map(x => x.path), ['Számlák', 'INBOX', 'Ügyek', 'Ügyek/2026', 'Ügyek/2025', 'Drafts', 'Sent', 'Archív régi', 'Trash']), JSON.stringify(ordered.map(x => x.path)))
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: t.newMessage, exact: true }).click()])
  await win.setViewportSize({ width: 900, height: 700 })
  await win.waitForFunction(() => document.querySelector('#compose-from')?.textContent.trim())
  await win.locator('#compose-from').click()
  const fromList = await win.getByRole('menuitemradio').allInnerTexts()
  check('the From list in the new account order', same(fromList.map(s => s.trim()), ['b@example.invalid', 'p@example.invalid', 'c@example.invalid']), JSON.stringify(fromList))
  await win.keyboard.press('Escape')
  await win.close().catch(() => {})
  await page.bringToFront()
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('.account-list .account-title').first().waitFor()
  const listed = await page.locator('.account-list .account-title').allInnerTexts()
  check('the settings account list in the new order', same(listed, ['Második fiók', 'Első fiók', 'Harmadik fiók']), JSON.stringify(listed))
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await folder(page, 'INBOX').waitFor()
  // the POP3 message move is local too, so the server hears nothing after the first fetch
  check('no command reached the POP3 server meanwhile', server.log.length === logAt, JSON.stringify(server.log.slice(logAt)))
  await app.close()
  app = null

  // 8. a restart
  ;({ app, page } = await start())
  await until(async () => same(await accounts(page), [imapB, pop, imapC]), 'the account order after a restart').catch(() => {})
  check('after a restart: the account order', same(await accounts(page), [imapB, pop, imapC]))
  check('after a restart: the folder order', same(await shown(page), ordered), JSON.stringify((await shown(page)).map(x => x.path)))

  // 9. "Sort folders A-Z": the old order; the selected folder and the open message stay
  await folder(page, 'Számlák').click()
  await page.locator('.msg-row', { hasText: 'POP 1' }).click()
  await page.locator('.reader-subject', { hasText: 'POP 1' }).waitFor()
  await section(page, pop).locator('.account-head').click({ button: 'right' })
  await page.getByRole('menuitem', { name: t.accountMenu.sortFolders, exact: true }).click()
  await until(async () => same(await shown(page), original), 'the old tree')
  check('Sort folders A-Z: the old tree byte for byte (order and depths)', true)
  check('the selected folder and the open message stay', (await folder(page, 'Számlák').getAttribute('aria-current')) === 'true' && (await page.locator('.reader-subject').innerText()).includes('POP 1'))
  check('the account order stays after the folder sort', same(await accounts(page), [imapB, pop, imapC]))

  check('the net-guard log has no request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')
  const failed = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8').split('\n').filter(l => /(folders|accounts):(reorder|resetOrder) failed/.test(l)) : []
  check('main.log: no reorder failure', failed.length === 0, failed.join(' | '))
} catch (err) {
  check('run', false, err.stack)
} finally {
  if (app) await app.close().catch(() => {})
  await server.close()
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
