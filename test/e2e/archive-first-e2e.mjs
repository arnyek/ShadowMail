#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The reader toolbar's first button is Archive, in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/archive-first-e2e.mjs [--shots <dir>]      (E2E_LANG=en: the same in English)
//
// Two POP3 accounts (fake POP3 servers): A has a local "Archívum", B has none. Measured:
// 1. A's INBOX: the toolbar's buttons in the DOM: Archive, star, Reply, Reply all, Forward, Delete, Move, Labels, More;
//    Archive enabled, its own name as the tooltip; Tab walks them in that order.
// 2. The Archive button archives (the message is in the Archívum after it).
// 3. In the Archívum and in B (no Archive): the button stays in its place, disabled (disabled + aria-disabled), its
//    tooltip and description the End key's notice text (in_archive / no_archive); every other button at the same x as
//    in INBOX (<= 1 px); Tab skips it.
// 4. The full reader (no reading pane): Back on the left, Archive right after it.
// 5. Every theme, an 860 px window with the list at its widest (the 360 px reader): no button out of the reader, no
//    toolbar overflow, every button >= 32 px wide; --shots: the window per theme, INBOX and Archívum.
// The page console has no error or warning.
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
import { THEMES } from '../../app/renderer/src/themes.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-archivalas'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null
if (shots) fs.mkdirSync(shots, { recursive: true })

const plain = (subject, day) => `From: f@example.invalid\r\nSubject: ${subject}\r\nDate: ${new Date(2025, 3, day, 12).toUTCString()}\r\n\r\nszöveg ${subject}\r\n`
const serverA = await new FakePop3Server().listen()
for (const [s, d] of [['Egy', 1], ['Kettő', 2], ['Három', 3], ['Négy', 4]]) serverA.add(Buffer.from(plain(s, d)))
const serverB = await new FakePop3Server().listen()
serverB.add(Buffer.from(plain('Bé levele', 5)))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-archive-first-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let accA
let accB
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  accA = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'A fiók', email: 'a@example.invalid', in_port: serverA.port, in_user: serverA.user, in_password: serverA.pass }).account.id
  accB = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'B fiók', email: 'b@example.invalid', in_port: serverB.port, in_user: serverB.user, in_password: serverB.pass }).account.id
  new MailIndex(db).addFolder(accA, 'Archívum', '/', true)
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []
const until = async (fn, what, ms = 8000) => {
  const t0 = performance.now()
  while (!(await fn())) {
    if (performance.now() - t0 > ms) throw new Error(`timed out: ${what}`)
    await sleep(50)
  }
}
const folderSel = (acc, p) => `.folder-tree section[data-account="${acc}"] .folder[data-path="${p}"]`
const subjectsIn = (page, accountId, folder) =>
  page.evaluate(async q => (await window.shadowMail.mail.list({ ...q, sort: 'date', dir: 'desc', offset: 0, limit: 50 })).rows.map(r => r.subject), { accountId, folder })
const ORDER = [t.actions.archive, t.actions.star, t.replyModes.reply, t.replyModes.replyAll, t.replyModes.forward, t.actions.delete, t.actions.move, t.labels.button, t.readerMore]

/** the toolbar as drawn: every button's name, its x from the toolbar's left, the Archive button's state */
const toolbar = page =>
  page.evaluate(() => {
    const tools = document.querySelector('section.reader .reader-tools')
    const left = tools.getBoundingClientRect().left
    const buttons = [...tools.querySelectorAll('button')]
    const a = tools.querySelector('.reader-archive')
    return {
      names: buttons.map(b => b.getAttribute('aria-label')),
      xs: buttons.map(b => Math.round((b.getBoundingClientRect().left - left) * 10) / 10),
      firstIsArchive: tools.firstElementChild === a,
      archive: a && { disabled: a.disabled, ariaDisabled: a.getAttribute('aria-disabled'), title: a.getAttribute('title'), description: a.getAttribute('aria-description'), label: a.getAttribute('aria-label') },
    }
  })
/** Tab from the toolbar's first focusable button through the toolbar: the names in focus order */
const tabOrder = async page => {
  await page.evaluate(() => [...document.querySelectorAll('section.reader .reader-tools button')].find(b => !b.disabled).focus())
  const names = []
  for (let i = 0; i < 12; i++) {
    const n = await page.evaluate(() => (document.activeElement.closest('.reader-tools') ? document.activeElement.getAttribute('aria-label') : null))
    if (!n) break
    names.push(n)
    await page.keyboard.press('Tab')
  }
  return names
}
const openMessage = async (page, acc, folder, subject) => {
  await page.locator(folderSel(acc, folder)).click()
  await page.locator('.msg-row', { hasText: subject }).click()
  await until(async () => (await page.locator('section.reader[data-message-id]').getAttribute('aria-label').catch(() => null)) === subject, `${subject} open`)
  await page.locator('section.reader .reader-tools .reader-archive').waitFor()
  await sleep(150)
}

const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
/** the page under a theme and a reading pane, unlocked, both accounts fetched */
async function start(theme, pane, width = 1280) {
  const page = await app.firstWindow()
  await page.setViewportSize({ width, height: 900 })
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(
    ([id, p]) => {
      localStorage.setItem('shadowmail.ui.theme', JSON.stringify(id))
      localStorage.setItem('shadowmail.ui.readerPane', JSON.stringify(p))
    },
    [theme, pane],
  )
  await Promise.all([page.waitForEvent('load', { timeout: 20_000 }), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.webContents.reload()))])
  await page.waitForFunction(id => document.documentElement.dataset.theme === id, theme, { timeout: 20_000 })
  if (await page.locator('#vault-unlock').isVisible().catch(() => false)) {
    await page.locator('#vault-unlock').fill(MASTER)
    await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  }
  await page.locator(folderSel(accA, 'INBOX')).waitFor({ timeout: 20_000 })
  return page
}

try {
  const first = await app.firstWindow()
  first.on('console', m => (m.type() === 'error' || m.type() === 'warning') && !/ERR_CONNECTION_REFUSED|connect ECONNREFUSED/.test(m.text()) && consoleLines.push(`${m.type()}: ${m.text()}`))
  first.on('pageerror', e => consoleLines.push(`pageerror: ${e.message}`))
  await first.locator('#vault-unlock').waitFor({ timeout: 20_000 })
  let page = await start('default', 'right')
  await until(() => serverA.log.includes('QUIT') && serverB.log.includes('QUIT'), 'the first POP3 fetches', 20_000)
  await until(async () => (await subjectsIn(page, accA, 'INBOX')).length === 4 && (await subjectsIn(page, accB, 'INBOX')).length === 1, 'the messages listed', 20_000)

  // 1. INBOX of A: the order, Archive enabled, Tab
  await openMessage(page, accA, 'INBOX', 'Kettő')
  const inbox = await toolbar(page)
  check('1. INBOX: the buttons in the DOM, Archive first', JSON.stringify(inbox.names) === JSON.stringify(ORDER) && inbox.firstIsArchive, JSON.stringify(inbox.names))
  check('1. INBOX: Archive enabled, its name as the tooltip, no description', inbox.archive.disabled === false && inbox.archive.ariaDisabled === null && inbox.archive.title === t.actions.archive && inbox.archive.description === null, JSON.stringify(inbox.archive))
  const tabInbox = await tabOrder(page)
  check('1. INBOX: Tab walks the toolbar in the new order', JSON.stringify(tabInbox) === JSON.stringify(ORDER), JSON.stringify(tabInbox))

  // 2. the button archives
  await page.locator('section.reader .reader-archive').click()
  await until(async () => (await subjectsIn(page, accA, 'Archívum')).includes('Kettő'), 'Kettő archived')
  check('2. the Archive button: Kettő in the Archívum', true)

  // 3a. in the Archívum: disabled in its place, the in_archive text, the other buttons where they were
  await openMessage(page, accA, 'Archívum', 'Kettő')
  const inArch = await toolbar(page)
  const sameX = (a, b) => a.xs.length === b.xs.length && a.xs.every((x, i) => Math.abs(x - b.xs[i]) <= 1)
  check('3a. Archívum: the same buttons in the same order', JSON.stringify(inArch.names) === JSON.stringify(ORDER) && inArch.firstIsArchive, JSON.stringify(inArch.names))
  check('3a. Archívum: Archive disabled (disabled + aria-disabled), the in_archive text as tooltip and description', inArch.archive.disabled === true && inArch.archive.ariaDisabled === 'true' && inArch.archive.title === t.readerKeys.in_archive && inArch.archive.description === t.readerKeys.in_archive && inArch.archive.label === t.actions.archive, JSON.stringify(inArch.archive))
  check('3a. Archívum: every button at the same x as in INBOX (<= 1 px)', sameX(inArch, inbox), `${JSON.stringify(inArch.xs)} vs ${JSON.stringify(inbox.xs)}`)
  const tabArch = await tabOrder(page)
  check('3a. Archívum: Tab skips the disabled Archive', JSON.stringify(tabArch) === JSON.stringify(ORDER.slice(1)), JSON.stringify(tabArch))
  await page.locator('section.reader .reader-archive').click({ force: true })
  await sleep(400)
  check('3a. Archívum: a click on the disabled button moves nothing', (await subjectsIn(page, accA, 'Archívum')).includes('Kettő'))
  if (shots) await page.screenshot({ path: path.join(shots, 'default-1280-archive-folder.png') })

  // 3b. B has no Archive: disabled, the no_archive text, same places
  await openMessage(page, accB, 'INBOX', 'Bé levele')
  const noArch = await toolbar(page)
  check('3b. no Archive folder: the same buttons in the same order', JSON.stringify(noArch.names) === JSON.stringify(ORDER), JSON.stringify(noArch.names))
  check('3b. no Archive folder: Archive disabled, the no_archive text as tooltip and description', noArch.archive.disabled === true && noArch.archive.ariaDisabled === 'true' && noArch.archive.title === t.readerKeys.no_archive && noArch.archive.description === t.readerKeys.no_archive, JSON.stringify(noArch.archive))
  check('3b. no Archive folder: every button at the same x as in INBOX (<= 1 px)', sameX(noArch, inbox), `${JSON.stringify(noArch.xs)} vs ${JSON.stringify(inbox.xs)}`)
  // the End key says the same as before (the notice), nothing moves
  await page.keyboard.press('End')
  await page.locator('.action-notice').waitFor({ timeout: 5000 }).catch(() => {})
  check('3b. End in B: the no_archive notice', ((await page.locator('.action-notice').innerText().catch(() => '')) || '').includes(t.readerKeys.no_archive))

  // 4. the full reader: Back on the left, Archive right after it
  page = await start('default', 'none')
  await openMessage(page, accA, 'INBOX', 'Három')
  const full = await page.evaluate(() => {
    const bar = document.querySelector('section.reader .reader-toolbar')
    const back = bar.querySelector('.reader-back')
    const tools = bar.querySelector('.reader-tools')
    const arch = tools.querySelector('.reader-archive')
    const focusables = [...bar.querySelectorAll('button')].map(b => b.className)
    return { firstIsBack: bar.firstElementChild === back, toolsNext: back && back.nextElementSibling === tools, archiveFirst: tools.firstElementChild === arch, backRight: back.getBoundingClientRect().right, archLeft: arch.getBoundingClientRect().left, focusables: focusables.slice(0, 2) }
  })
  check('4. full reader: Back first, then the toolbar with Archive first, Back left of Archive', full.firstIsBack && full.toolsNext && full.archiveFirst && full.backRight <= full.archLeft, JSON.stringify(full))
  if (shots) await page.screenshot({ path: path.join(shots, 'default-1280-full-reader.png') })

  // 5. every theme, the 360 px reader
  for (const { id } of THEMES) {
    page = await start(id, 'right', 860)
    let widest = false
    for (const [acc, folder, subject] of [[accA, 'INBOX', 'Négy'], [accA, 'Archívum', 'Kettő']]) {
      await openMessage(page, acc, folder, subject)
      if (!widest) {
        // the list at its widest beside the open reader (the splitter shows with a reader)
        const split = page.locator('.splitter[data-split="list"]')
        await split.focus()
        for (let i = 0; i < 40; i++) await split.press('ArrowRight')
        await sleep(300)
        widest = true
      }
      const fit = await page.evaluate(() => {
        const reader = document.querySelector('section.reader').getBoundingClientRect()
        const tools = document.querySelector('section.reader .reader-tools')
        const box = tools.getBoundingClientRect()
        const buttons = [...tools.querySelectorAll('button')].map(b => b.getBoundingClientRect())
        return {
          reader: Math.round(reader.width),
          overflow: tools.scrollWidth - tools.clientWidth,
          outside: buttons.filter(b => b.right > box.right + 0.5 || b.right > reader.right + 0.5 || b.left < box.left - 0.5).length,
          minWidth: Math.round(Math.min(...buttons.map(b => b.width)) * 10) / 10,
          count: buttons.length,
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }
      })
      check(`5. ${id} ${folder}: the ${fit.reader} px reader holds every button, none narrower than 32 px`, fit.reader <= 362 && fit.overflow <= 1 && fit.outside === 0 && fit.minWidth >= 32 && fit.count === ORDER.length && fit.page <= 0, JSON.stringify(fit))
      if (shots) await page.screenshot({ path: path.join(shots, `${id}-860-${folder === 'INBOX' ? 'inbox' : 'archive-folder'}.png`) })
    }
  }

  check('the page console: no error or warning', consoleLines.length === 0, consoleLines.join(' | '))
} catch (err) {
  console.error(err)
  results.push(false)
} finally {
  await app.close().catch(() => {})
  await serverA.close()
  await serverB.close()
  fs.rmSync(work, { recursive: true, force: true })
}
const failed = results.filter(r => !r).length
console.log(`${results.length - failed} / ${results.length} OK`)
process.exit(failed ? 1 : 0)
