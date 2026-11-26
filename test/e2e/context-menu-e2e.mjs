#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The right click in a message, the main-process side, in the real app (headless Electron + Playwright). Not part of
// `npm test`; the menu on screen is the next step, here the page side is played through the preload bridge.
//
//   node test/e2e/context-menu-e2e.mjs        (E2E_LANG=en: the same in English)
//
// A POP3 account with an HTML message of links (as the link-target e2e) and a plain-text one. Measured: a right click
// on a link in the message frame (which runs no script) sends the page a menu (token, items, place) with no URL or
// address in it; "copy link" puts the REAL href on the clipboard (not the link text), the 9000-character one whole, and
// opens nothing; "open" calls shell.openExternal once with the href; a mailto link offers the address, decoded; a
// selection offers "copy" with the selected text; an empty place "select all"; a token is good once, an old one after
// a new right click does nothing; Shift+F10 on a focused link opens the same menu; the frame's sandbox is unchanged.
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

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-jobb-klikk'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 3 minutes')
  process.exit(1)
}, 180_000)
watchdog.unref()

const OTHER = 'https://otpbank-login.example.com/belepes?u=1'
const LONG_HREF = `https://evil.example.com/${'a'.repeat(9000)}`
const html = `<div><p><a id="other" href="${OTHER}">otpbank.hu</a> &nbsp; szöveg utána</p><p><a id="long" href="${LONG_HREF}">Részletek</a></p><p><a id="mail" href="mailto:t%C3%BCnde%40example.org,b@example.org?subject=Hi">info@example.org</a></p><p id="words">Kérem az árajánlatot holnapig.</p><p>.</p><p id="empty">.</p></div>`

const server = await new FakePop3Server().listen()
server.add(Buffer.from(`From: f@example.invalid\r\nSubject: Linkes level\r\nDate: ${new Date(2025, 3, 6, 12).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html}\r\n`))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-context-menu-e2e-'))
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
  // "Blocked script execution in 'mail-view:...'": Playwright's own probes into the sandboxed frame, refused
  page.on('console', m => m.type() === 'error' && !/ERR_CONNECTION_REFUSED|connect ECONNREFUSED|^Blocked script execution in 'mail-view:/.test(m.text()) && problems.push(m.text()))
  page.on('pageerror', e => problems.push(e.message))
  await page.setViewportSize({ width: 1400, height: 1000 })
  // shell.openExternal counted, never called for real
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
  // the page side: every contextMenu notice the main process sends, as the reader will get it
  await page.evaluate(() => {
    window.__menus = []
    window.shadowMail.onStatus(p => p && p.kind === 'contextMenu' && window.__menus.push(p))
  })
  await page.locator('.msg-row', { hasText: 'Linkes level' }).waitFor({ timeout: 20_000 })
  await page.locator('.msg-row', { hasText: 'Linkes level' }).click()
  const frameEl = page.locator('iframe.mail-frame')
  await frameEl.waitFor()
  const frame = await (await frameEl.elementHandle()).contentFrame()
  await frame.locator('#empty').waitFor()
  check('the frame keeps its sandbox (no script, no same-origin)', (await frameEl.getAttribute('sandbox')) === 'allow-popups allow-popups-to-escape-sandbox')

  const menus = () => page.evaluate(() => window.__menus.slice())
  // the reader shows the menu on screen since its next step: an open one is closed first, as the user would
  const closeMenu = async () => {
    if (await page.locator('[role="menu"]').count()) {
      await page.keyboard.press('Escape')
      await page.locator('[role="menu"]').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
    }
  }
  const rightClick = async (locator, opts = {}) => {
    await closeMenu()
    const before = (await menus()).length
    await locator.click({ button: 'right', ...opts })
    for (let i = 0; i < 50 && (await menus()).length === before; i++) await sleep(40)
    const all = await menus()
    return all.length > before ? all[all.length - 1] : null
  }
  const choose = (token, item) => page.evaluate(([tk, it]) => window.shadowMail.contextMenuChoose(tk, it), [token, item])

  // 1. a link whose text shows another domain: the menu, no URL to the page; copy: the real href, nothing opened
  await setClipboard('előtte')
  let m = await rightClick(frame.locator('#other'))
  check('a right click on a link: a menu to the page with the link items', m && JSON.stringify(m.items) === '["copyLink","openLink"]' && m.source === 'mail' && typeof m.token === 'string', JSON.stringify(m))
  check('the notice to the page carries no URL and no address', m && !/example|otpbank|http|@/.test(JSON.stringify(m)), JSON.stringify(m))
  let r = await choose(m.token, 'copyLink')
  check('copyLink: the REAL href on the clipboard, not the link text', r.ok && (await clipboardText()) === OTHER, await clipboardText())
  check('copyLink: nothing opened', (await opened()).length === 0)
  check('the same token again: nothing (one use)', (await choose(m.token, 'openLink')).error === 'stale' && (await opened()).length === 0)

  // 2. the 9000-character href: whole
  m = await rightClick(frame.locator('#long'))
  r = await choose(m.token, 'copyLink')
  const copied = await clipboardText()
  check('the 9000-character href: copied whole', r.ok && copied === LONG_HREF, `${copied.length} / ${LONG_HREF.length}`)

  // 3. open: the shared opener, once, with the href
  m = await rightClick(frame.locator('#other'))
  r = await choose(m.token, 'openLink')
  await sleep(200)
  check('openLink: shell.openExternal once, with the href', r.ok && JSON.stringify(await opened()) === JSON.stringify([OTHER]), JSON.stringify(await opened()))

  // 4. mailto: the address, decoded, several with ", "
  m = await rightClick(frame.locator('#mail'))
  check('a mailto link: copy address and new mail', m && JSON.stringify(m.items) === '["copyAddress","newMail"]', JSON.stringify(m && m.items))
  r = await choose(m.token, 'copyAddress')
  check('copyAddress: the addresses decoded, without "mailto:" and the query', r.ok && (await clipboardText()) === 'tünde@example.org, b@example.org', await clipboardText())

  // 5. an old token after a new right click: nothing
  const old = await rightClick(frame.locator('#other'))
  const fresh = await rightClick(frame.locator('#long'))
  await setClipboard('marad')
  check('an old token after a new right click: nothing written', (await choose(old.token, 'copyLink')).error === 'stale' && (await clipboardText()) === 'marad')
  check('a token the main process never made: nothing', (await choose('00000000-0000-4000-8000-000000000000', 'copyLink')).error === 'stale' && (await clipboardText()) === 'marad')
  check('an item the menu did not offer: nothing', (await choose(fresh.token, 'copyAddress')).error === 'not_offered' && (await clipboardText()) === 'marad')

  // 6. a selection: copy, with the selected text
  await frame.locator('#words').click({ clickCount: 3 })
  m = await rightClick(frame.locator('#words'))
  check('a selection: the copy item', m && m.items.includes('copy') && !m.items.includes('selectAll'), JSON.stringify(m && m.items))
  r = await choose(m.token, 'copy')
  check('copy: the selected text on the clipboard', r.ok && (await clipboardText()).trim() === 'Kérem az árajánlatot holnapig.', JSON.stringify(await clipboardText()))

  // 7. an empty place: select all
  await frame.locator('#empty').click()
  m = await rightClick(frame.locator('#empty'), { position: { x: 300, y: 2 } })
  check('an empty place: select all', m && JSON.stringify(m.items) === '["selectAll"]', JSON.stringify(m && m.items))

  // 8. the keyboard: Shift+F10 on a focused link
  await closeMenu()
  await frame.locator('#other').focus()
  const before = (await menus()).length
  await page.keyboard.press('Shift+F10')
  for (let i = 0; i < 50 && (await menus()).length === before; i++) await sleep(40)
  const all = await menus()
  m = all.length > before ? all[all.length - 1] : null
  check('Shift+F10 on a focused link: the same menu', m && JSON.stringify(m.items) === '["copyLink","openLink"]', JSON.stringify(m))
  if (m) {
    await choose(m.token, 'copyLink')
    check('Shift+F10 then copyLink: the real href', (await clipboardText()) === OTHER)
  }
  check('nothing else opened', JSON.stringify(await opened()) === JSON.stringify([OTHER]))
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  if (app) await app.close().catch(() => {})
  await server.close()
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log names no URL or address', !/otpbank|example\.(com|org)|tünde/i.test(mainLog), mainLog.split('\n').filter(l => /otpbank|example/i.test(l)).slice(0, 2).join(' | '))
check('the main log: no error line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
check('no console error on the page', problems.length === 0, problems.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
