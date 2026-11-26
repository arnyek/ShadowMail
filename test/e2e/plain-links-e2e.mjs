#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The addresses of a plain-text message as links, in the real app (headless Electron + Playwright). Not part of
// `npm test`.
//
//   node test/e2e/plain-links-e2e.mjs        (E2E_LANG=en: the same in English)
//
// A POP3 account with a plain-text message: a web address at a sentence's end, a "www." one in brackets, an e-mail
// address, a javascript: text, and a line longer than one drawn block with an address across the block boundary.
// Measured: the links and their hrefs; the shown text unchanged; a click on the web link calls shell.openExternal once
// with the whole address and the page does not navigate; a click on the e-mail address opens a composer with it;
// "Copy link" in the right-click menu puts the address on the clipboard; the address across the block boundary is two
// links to one href, and the page's copy gives it whole; the reply's quote and the source view have no link.
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
const MASTER = 'Teszt-mesterjelszo-sima-linkek'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

const WEB = 'https://ugyfel.example.com/szamla?id=42'
const WWW = 'www.pelda.example.org/info'
const MAIL = 'iroda@example.org'
const LONG = `https://hosszu.example.com/${'p'.repeat(40)}`
const body = [
  `Kedves Ugyfel! A szamla itt van: ${WEB}.`,
  `(Bovebben: ${WWW})`,
  `Kerdes eseten irjon: ${MAIL}.`,
  'Ez nem link: javascript:alert(1)',
  `${'-'.repeat(990)}${LONG} ${'y '.repeat(1200)}`,
  'Udvozlettel',
].join('\r\n')
const server = await new FakePop3Server().listen()
server.add(Buffer.from(`From: f@example.invalid\r\nSubject: Sima linkek\r\nDate: ${new Date(2025, 3, 5, 12).toUTCString()}\r\nMessage-ID: <sima-1@example.invalid>\r\n\r\n${body}\r\n`))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-plain-links-e2e-'))
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
  page.on('console', m => m.type() === 'error' && !/ERR_CONNECTION_REFUSED|connect ECONNREFUSED/.test(m.text()) && problems.push(m.text()))
  page.on('pageerror', e => problems.push(e.message))
  await page.setViewportSize({ width: 1280, height: 900 })
  await app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async url => {
      globalThis.__opened.push(url)
    }
  })
  const opened = () => app.evaluate(() => globalThis.__opened.slice())
  const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText())
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row', { hasText: 'Sima linkek' }).waitFor({ timeout: 20_000 })
  await page.locator('.reader-pane-switch').click() // the reader beside the list
  await page.locator('.msg-row', { hasText: 'Sima linkek' }).click()
  const pre = page.locator('pre.mail-text')
  await pre.waitFor()
  const links = () => pre.locator('a').evaluateAll(as => as.map(a => ({ href: a.getAttribute('href'), text: a.textContent, target: a.target, rel: a.rel })))

  // 1. the links and the text
  const all = await links()
  const hrefs = [...new Set(all.map(l => l.href))]
  check('the links: web (no full stop), www. (no bracket), e-mail, the long one; no javascript:', JSON.stringify(hrefs) === JSON.stringify([WEB, `https://${WWW}`, `mailto:${MAIL}`, LONG]), JSON.stringify(hrefs))
  check('every link opens outside the page (target _blank, noopener noreferrer)', all.every(l => l.target === '_blank' && /noopener/.test(l.rel) && /noreferrer/.test(l.rel)))
  const shown = (await pre.innerText()).replace(/\r/g, '')
  check('the shown text unchanged', shown.includes(`A szamla itt van: ${WEB}.`) && shown.includes(`(Bovebben: ${WWW})`) && shown.includes('javascript:alert(1)'), shown.slice(0, 120))
  const longPieces = all.filter(l => l.href === LONG)
  check('the address across the block boundary: two links to one href, together the address', longPieces.length === 2 && longPieces.map(l => l.text).join('') === LONG, JSON.stringify(longPieces.map(l => l.text.length)))

  // 2. a click on the web link: one openExternal with the whole address, no navigation
  const urlBefore = page.url()
  await pre.locator(`a[href="${WEB}"]`).click()
  await sleep(400)
  check('a click on the web link: one shell.openExternal with the whole address', JSON.stringify(await opened()) === JSON.stringify([WEB]), JSON.stringify(await opened()))
  check('the page did not navigate', page.url() === urlBefore)

  // 3. a click on the e-mail address: a composer with it
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), pre.locator(`a[href="mailto:${MAIL}"]`).click()])
  await win.waitForFunction(() => document.querySelector('#compose-to')?.value, null, { timeout: 15_000 }).catch(() => {})
  const to = await win.evaluate(() => document.querySelector('#compose-to')?.value ?? null).catch(() => null)
  check('a click on the e-mail address: a composer with it', typeof to === 'string' && to.includes(MAIL), String(to))
  await win.close().catch(() => {})

  // 4. the right-click menu on a plain link: Copy link
  await pre.locator(`a[href="https://${WWW}"]`).click({ button: 'right' })
  const menu = page.locator('.reader-context-menu')
  await menu.waitFor({ timeout: 3000 }).catch(() => {})
  await menu.getByRole('menuitem', { name: t.readerContextMenu.copyLink, exact: true }).click().catch(() => {})
  await sleep(200)
  check('the right-click menu on a plain link: Copy link puts the address on the clipboard', (await clipboardText()) === `https://${WWW}`, await clipboardText())

  // 5. the page's copy keeps the address across the block boundary whole
  await page.evaluate(() => {
    const pre = document.querySelector('pre.mail-text')
    const as = [...pre.querySelectorAll('a')].filter(a => a.getAttribute('href').startsWith('https://hosszu'))
    const r = document.createRange()
    r.setStartBefore(as[0])
    r.setEndAfter(as[as.length - 1])
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
    document.execCommand('copy')
  })
  check('copying the address across the block boundary gives it whole', (await clipboardText()) === LONG, `${(await clipboardText()).length} / ${LONG.length}`)

  // 6. the reply's quote has no link
  const [rwin] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name: t.replyModes.reply, exact: true }).click()])
  await rwin.waitForFunction(() => document.querySelector('.editor')?.innerText.includes('szamla'), null, { timeout: 15_000 }).catch(() => {})
  const quote = await rwin.evaluate(() => ({ text: document.querySelector('.editor').innerText, links: document.querySelectorAll('.editor a').length })).catch(() => null)
  check('the reply\'s quote: the text, no link', quote && quote.text.includes(WEB) && quote.links === 0, JSON.stringify(quote && { links: quote.links }))
  await rwin.close().catch(() => {})

  // 7. the source view has no link
  await page.locator('.reader-tools').getByRole('button', { name: t.readerMore, exact: true }).click()
  await page.getByRole('menuitem', { name: t.source.menuOriginal, exact: true }).click()
  await page.locator('.source-modal').waitFor({ timeout: 5000 })
  await sleep(300)
  const sourceLinks = await page.locator('.source-modal a').count()
  const sourceHasText = (await page.locator('.source-modal').innerText()).includes(WEB)
  check('the source view: the address as text, no link', sourceHasText && sourceLinks === 0, `${sourceLinks} link(s)`)
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  if (app) await app.close().catch(() => {})
  await server.close()
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log names no address', !/ugyfel\.example|pelda\.example|iroda@/i.test(mainLog))
check('the main log: no error line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
check('no console error on the page', problems.length === 0, problems.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
