#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The right-click menu in the reader, on screen (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/link-menu-e2e.mjs        (E2E_LANG=en: the same in English; E2E_THEME=<id>: under that theme)
//
// A POP3 account with an HTML message of links and a plain-text message with a line longer than one drawn block.
// Measured: a right click in the message frame opens the app's own menu at the pointer with the items in the interface
// language (a web link: Copy link, Open in browser; mailto: Copy email address, New message to this address; a
// selection: Copy; an empty place: Select all); "Copy link" on a link whose text shows another domain puts the REAL
// href on the clipboard; "Copy email address" the address; "Open in browser" one shell.openExternal; "New message to
// this address" a composer with the address; Shift+F10 on a focused link opens the menu with the first item focused,
// Esc closes it writing nothing; "Select all" then "Copy" on the plain-text body copies the long line whole; the menu
// stays inside the window at its bottom-right corner and has the list menu's look; a right click elsewhere (the list:
// its own menu; the header: nothing) is as before; no console error.
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
import { t, seedLanguage } from './lang.mjs'
import { useTheme, e2eTheme } from './theme-env.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-link-menu'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const L = t.readerContextMenu

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

const OTHER = 'https://otpbank-login.example.com/belepes?u=1'
const html = `<div><p><a id="other" href="${OTHER}">otpbank.hu</a> &nbsp; szöveg utána</p><p><a id="mail" href="mailto:anna%40example.org?subject=Hi">Írjon nekünk</a></p><p id="words">Kérem az árajánlatot holnapig.</p>${'<p>.</p>'.repeat(30)}<p id="empty">.</p></div>`
const LONG = `${'A'.repeat(1500)}${'B'.repeat(2000)}`
const server = await new FakePop3Server().listen()
server.add(Buffer.from(`From: f@example.invalid\r\nSubject: Linkes level\r\nDate: ${new Date(2025, 3, 6, 12).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html}\r\n`))
server.add(Buffer.from(`From: f@example.invalid\r\nSubject: Sima szoveg\r\nDate: ${new Date(2025, 3, 5, 12).toUTCString()}\r\n\r\nElso sor\r\n${LONG}\r\nutolso sor\r\n`))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-link-menu-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  store.save({ ...newAccountDefaults('pop3'), ...base, name: 'Fiok', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass })
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const problems = []
let app
try {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => m.type() === 'error' && !/ERR_CONNECTION_REFUSED|connect ECONNREFUSED|^Blocked script execution in 'mail-view:/.test(m.text()) && problems.push(m.text()))
  page.on('pageerror', e => problems.push(e.message))
  await page.setViewportSize({ width: 1280, height: 800 })
  await useTheme(app, page)
  if (e2eTheme) console.log(`THEME ${await page.evaluate(() => document.documentElement.dataset.theme)}`)
  await app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async url => {
      globalThis.__opened.push(url)
    }
  })
  const opened = () => app.evaluate(() => globalThis.__opened.slice())
  const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText())
  const setClipboard = text => app.evaluate(({ clipboard }, s) => clipboard.writeText(s), text)
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row', { hasText: 'Linkes level' }).waitFor({ timeout: 20_000 })
  await page.locator('.reader-pane-switch').click() // the reader beside the list
  await page.locator('.msg-row', { hasText: 'Linkes level' }).click()
  const frameEl = page.locator('iframe.mail-frame')
  await frameEl.waitFor()
  const frame = await (await frameEl.elementHandle()).contentFrame()
  await frame.locator('#empty').waitFor()

  const menu = page.locator('.reader-context-menu')
  const itemsShown = () => menu.locator('[role="menuitem"]').allInnerTexts().then(a => a.map(s => s.trim()))
  const openOn = async (locator, opts = {}) => {
    await locator.click({ button: 'right', ...opts })
    await menu.waitFor({ timeout: 3000 }).catch(() => {})
  }
  const pick = async label => {
    await menu.getByRole('menuitem', { name: label, exact: true }).click()
    await menu.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  }

  // 1. a link whose text shows another domain
  await setClipboard('elotte')
  await openOn(frame.locator('#other'))
  check('a web link: Copy link, Open in browser', JSON.stringify(await itemsShown()) === JSON.stringify([L.copyLink, L.openLink]), JSON.stringify(await itemsShown()))
  const at = await menu.boundingBox()
  const link = await frameEl.boundingBox()
  check('the menu at the pointer (inside the frame\'s area)', at && link && at.x >= link.x && at.y >= link.y && at.x < link.x + link.width, JSON.stringify({ at, link }))
  await pick(L.copyLink)
  check('Copy link: the REAL href on the clipboard, not the link text', (await clipboardText()) === OTHER, await clipboardText())
  check('Copy link: nothing opened', (await opened()).length === 0)

  // 2. open
  await openOn(frame.locator('#other'))
  await pick(L.openLink)
  await sleep(200)
  check('Open in browser: one shell.openExternal with the href', JSON.stringify(await opened()) === JSON.stringify([OTHER]), JSON.stringify(await opened()))

  // 3. mailto
  await openOn(frame.locator('#mail'))
  check('a mailto link: Copy email address, New message to this address', JSON.stringify(await itemsShown()) === JSON.stringify([L.copyAddress, L.newMail]), JSON.stringify(await itemsShown()))
  await pick(L.copyAddress)
  check('Copy email address: the address (no mailto:, no ?subject)', (await clipboardText()) === 'anna@example.org', await clipboardText())
  await openOn(frame.locator('#mail'))
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), pick(L.newMail)])
  await win.waitForFunction(() => document.querySelector('#compose-to')?.value, null, { timeout: 15_000 }).catch(() => {})
  const toValue = await win.evaluate(() => document.querySelector('#compose-to')?.value ?? null).catch(e => `error: ${e.message.split('\n')[0]}`)
  check('New message to this address: a composer with the address', typeof toValue === 'string' && toValue.includes('anna@example.org'), String(toValue))
  await win.close().catch(() => {})

  // 4. the keyboard: Shift+F10 on a focused link, the first item focused; Esc closes, nothing written
  await setClipboard('marad')
  await frame.locator('#other').focus()
  await page.keyboard.press('Shift+F10')
  await menu.waitFor({ timeout: 3000 }).catch(() => {})
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.textContent.trim())
  check('Shift+F10 on a focused link: the menu, the first item focused', (await menu.count()) === 1 && focused === L.copyLink, focused)
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  check('Esc: the menu closed, nothing on the clipboard', (await menu.count()) === 0 && (await clipboardText()) === 'marad')
  // the arrows and Enter (the focus went back to the frame, not to the link inside it: the link focused again)
  await frame.locator('#other').focus()
  await page.keyboard.press('Shift+F10')
  await menu.waitFor({ timeout: 3000 }).catch(() => {})
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await menu.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  check('the arrows and Enter: Copy link chosen with the keyboard', (await clipboardText()) === OTHER)

  // 5. a selection in the frame: Copy; an empty place: Select all
  await frame.locator('#words').click({ clickCount: 3 })
  await openOn(frame.locator('#words'))
  check('a selection: Copy', (await itemsShown()).includes(L.copy), JSON.stringify(await itemsShown()))
  await pick(L.copy)
  check('Copy: the selected text', (await clipboardText()).trim() === 'Kérem az árajánlatot holnapig.', JSON.stringify(await clipboardText()))
  await frame.locator('#empty').click()
  await openOn(frame.locator('#empty'), { position: { x: 400, y: 2 } })
  check('an empty place: Select all', JSON.stringify(await itemsShown()) === JSON.stringify([L.selectAll]), JSON.stringify(await itemsShown()))
  await pick(L.selectAll)
  await sleep(200)
  const selected = await frame.evaluate(() => String(window.getSelection())).catch(() => null)
  check('Select all: the message selected', selected !== null && selected.includes('Kérem az árajánlatot') && selected.includes('szöveg utána'), JSON.stringify((selected || '').slice(0, 60)))

  // 6. the corner: the menu stays inside the window
  const box = await frameEl.boundingBox()
  await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4, { button: 'right' })
  await menu.waitFor({ timeout: 3000 }).catch(() => {})
  const corner = await menu.boundingBox()
  const vp = page.viewportSize()
  check('at the window\'s bottom-right corner the menu stays inside', corner && corner.x >= 0 && corner.y >= 0 && corner.x + corner.width <= vp.width && corner.y + corner.height <= vp.height, JSON.stringify({ corner, vp }))
  await page.keyboard.press('Escape')

  // 7. the list menu's look
  const look = sel => page.evaluate(s => {
    const el = document.querySelector(s)
    const c = getComputedStyle(el)
    return [c.backgroundColor, c.borderRadius, c.boxShadow, c.fontSize, c.color].join(' | ')
  }, sel)
  await openOn(frame.locator('#other'))
  const readerLook = await look('.reader-context-menu')
  await page.keyboard.press('Escape')
  await page.locator('.msg-row', { hasText: 'Linkes level' }).click({ button: 'right' })
  await page.locator('.context-menu').first().waitFor({ timeout: 3000 })
  const listLook = await look('.context-menu')
  check('a right click on the list: its own menu (not the reader\'s)', (await page.locator('.reader-context-menu').count()) === 0 && (await page.locator('.context-menu').count()) === 1)
  check('the reader menu looks as the list menu', readerLook === listLook, `${readerLook} / ${listLook}`)
  await page.keyboard.press('Escape')
  await page.locator('[role="menu"]').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  const bar = await page.locator('.reader-toolbar').boundingBox()
  await page.mouse.click(bar.x + 4, bar.y + 4, { button: 'right' })
  await sleep(300)
  check('a right click on the reader toolbar: no menu', (await page.locator('[role="menu"]').count()) === 0)

  // 8. the plain-text message: Select all, then Copy: the long line whole across the drawn blocks
  await page.locator('.msg-row', { hasText: 'Sima szoveg' }).click()
  const pre = page.locator('pre.mail-text')
  await pre.waitFor()
  await pre.click({ button: 'right', position: { x: 20, y: 8 } })
  await menu.waitFor({ timeout: 3000 }).catch(() => {})
  check('a plain-text body: the menu opens over it', (await menu.count()) === 1, JSON.stringify(await itemsShown().catch(() => [])))
  await pick(L.selectAll)
  await pre.click({ button: 'right', position: { x: 20, y: 8 } })
  await menu.waitFor({ timeout: 3000 }).catch(() => {})
  check('with the text selected: Copy', (await itemsShown()).includes(L.copy), JSON.stringify(await itemsShown()))
  await pick(L.copy)
  const plain = await clipboardText()
  check('Copy on the plain body: the long line whole (no break at the drawn blocks)', plain.includes(LONG) && plain.includes('Elso sor') && plain.includes('utolso sor'), `${plain.length} chars`)
  // beside the body (the reader's header): no menu
  await page.locator('.reader-subject, .reader h2, .reader-toolbar').first().click({ button: 'right' })
  await sleep(300)
  check('a right click beside the plain body: no reader menu', (await menu.count()) === 0)
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  if (app) await app.close().catch(() => {})
  await server.close()
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log names no URL or address', !/otpbank|example\.(com|org)/i.test(mainLog))
check('the main log: no error line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
check('no console error on the page', problems.length === 0, problems.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
