#!/usr/bin/env node
// The composer's Tab order in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/compose-tab-e2e.mjs          (E2E_LANG=en: the same in English)
//
// In each composer window (a new message, a reply, a forward, an edited draft):
// - Tab from the Subject lands in the text, Shift+Tab from the text goes back to the Subject;
// - no formatting button is a Tab stop.
// In the new message, the formatting bar from the keyboard: Alt+F10 from the text enters it (the first button), the
// arrows, Home and End move, Enter formats the selected text and goes back to it, Alt+F10 again comes back to the last
// used button, Esc goes back to the text with its selection; with the bar hidden Alt+F10 does nothing; the formatting
// toggle names the key in its tooltip.
// The main log has no error line, the renderer console no error or warning.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { SMTPServer } from 'smtp-server'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, locale, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-tabsorrend'
const ME = 'teszt@example.invalid'
const SUBJECT = 'Tab-sorrend próba'
const savedHint = (d => t.composeSavedAt(d).replace(d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }), '').trim())(new Date())

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN', 'LOGIN'], logger: false,
  onAuth: (a, _s, cb) => cb(null, { user: a.username }),
  onData(stream, _session, cb) {
    stream.resume()
    stream.on('end', () => cb())
  },
})
smtp.on('error', () => {})
await new Promise(r => smtp.listen(0, '127.0.0.1', r))

const pop = await new FakePop3Server().listen()
pop.add(Buffer.from([
  'From: Kovács Anna <anna@example.invalid>', `To: Teszt Elek <${ME}>`, 'Subject: =?utf-8?q?Tab-sorrend_pr=C3=B3ba?=',
  `Date: ${new Date().toUTCString()}`, 'Message-ID: <tab-1@example.invalid>', 'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', 'Az eredeti levél szövege.', '',
].join('\r\n')))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-tab-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: ME, display_name: 'Teszt Elek', signature: 'Üdv, Elek',
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none',
  })
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
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  const pane = page.locator('.folder-tree section', { hasText: 'POP3-fiók' })
  const row = s => page.locator('.msg-row', { hasText: s })
  const composerOf = async click => {
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), click()])
    win.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
    await win.setViewportSize({ width: 900, height: 700 })
    await win.waitForFunction(() => document.querySelector('#compose-from')?.textContent.includes('@') && document.querySelector('.editor')?.textContent.includes('Elek'))
    return win
  }
  const focused = win =>
    win.evaluate(() => {
      const a = document.activeElement
      if (!a) return 'none'
      if (a.id) return `#${a.id}`
      if (a.classList.contains('editor')) return 'editor'
      if (a.closest('.editor-toolbar')) return `tool:${a.getAttribute('aria-label')}`
      return `${a.tagName.toLowerCase()}.${a.className}`
    })
  const selectedText = win => win.evaluate(() => String(window.getSelection()))

  // the Tab order around the Subject, the same in every window
  const tabOrder = async (win, label) => {
    await win.locator('#compose-subject').focus()
    await win.keyboard.press('Tab')
    const afterTab = await focused(win)
    await win.keyboard.press('Shift+Tab')
    const afterShiftTab = await focused(win)
    const stops = await win.evaluate(() => [...document.querySelectorAll('.editor-toolbar button')].filter(b => b.tabIndex >= 0).length)
    const tools = await win.locator('.editor-toolbar button').count()
    check(`${label}: Tab from the Subject goes to the text, Shift+Tab back to the Subject`, afterTab === 'editor' && afterShiftTab === '#compose-subject', `${afterTab}, ${afterShiftTab}`)
    check(`${label}: the formatting bar is shown and none of its ${tools} buttons is a Tab stop`, tools === 8 && stops === 0, `${stops} stop(s)`)
  }

  await row(SUBJECT).waitFor({ timeout: 20_000 })

  // 1. a new message, and the formatting bar from the keyboard
  let win = await composerOf(() => page.locator('.compose-button').click())
  await tabOrder(win, 'new message')
  await win.locator('#compose-subject').fill('Új levél')
  await win.locator('#compose-subject').press('Tab')
  await win.keyboard.press('Control+Home')
  await win.keyboard.type('Formázandó')
  await win.keyboard.press('Shift+Home')
  await win.keyboard.press('Alt+F10')
  const entered = await focused(win)
  await win.keyboard.press('ArrowRight')
  const right = await focused(win)
  await win.keyboard.press('End')
  const end = await focused(win)
  await win.keyboard.press('ArrowRight')
  const wrapped = await focused(win)
  await win.keyboard.press('ArrowLeft')
  const left = await focused(win)
  await win.keyboard.press('Home')
  const home = await focused(win)
  check('Alt+F10 from the text enters the bar on its first button; Right, End, Right (wraps), Left, Home move in it', entered === `tool:${t.composeTools.bold}` && right === `tool:${t.composeTools.italic}` && end === `tool:${t.composeTools.clear}` && wrapped === `tool:${t.composeTools.bold}` && left === `tool:${t.composeTools.clear}` && home === `tool:${t.composeTools.bold}`, [entered, right, end, wrapped, left, home].join(' | '))
  await win.keyboard.press('ArrowRight')
  await win.keyboard.press('Enter')
  const afterEnter = await focused(win)
  const html = await win.locator('.editor').innerHTML()
  check('Enter on Italic formats the selected text and goes back to the text with it selected', afterEnter === 'editor' && /<i>Formázandó<\/i>/.test(html) && (await selectedText(win)) === 'Formázandó', `${afterEnter} ${html.slice(0, 80)}`)
  await win.keyboard.press('Alt+F10')
  const again = await focused(win)
  await win.keyboard.press('Escape')
  const afterEsc = await focused(win)
  const keptSel = await selectedText(win)
  check('Alt+F10 again comes back to the last used button; Esc goes back to the text, the selection kept', again === `tool:${t.composeTools.italic}` && afterEsc === 'editor' && keptSel === 'Formázandó', `${again}, ${afterEsc}, "${keptSel}"`)
  await win.keyboard.press('Alt+F10')
  await win.keyboard.press('Tab')
  check('Tab in the bar goes back to the text too', (await focused(win)) === 'editor' && (await selectedText(win)) === 'Formázandó', await focused(win))
  await win.keyboard.press('Alt+F10')
  await win.keyboard.press('Shift+Tab')
  check('Shift+Tab in the bar goes to the Subject', (await focused(win)) === '#compose-subject', await focused(win))
  const toggle = win.getByRole('button', { name: t.composeFormatting, exact: true })
  check('the formatting toggle names the key in its tooltip', (await toggle.getAttribute('title')) === t.composeFormattingHint && /Alt\+F10/.test(t.composeFormattingHint), await toggle.getAttribute('title'))
  await toggle.click()
  await win.locator('.editor-toolbar').waitFor({ state: 'detached' })
  await win.locator('.editor').click()
  await win.keyboard.press('Alt+F10')
  check('the bar hidden: Alt+F10 leaves the focus in the text', (await focused(win)) === 'editor', await focused(win))
  await win.locator('#compose-subject').focus()
  await win.keyboard.press('Tab')
  check('the bar hidden: Tab from the Subject still goes to the text', (await focused(win)) === 'editor', await focused(win))
  await toggle.click()
  await win.locator('.editor-toolbar').waitFor()
  await win.locator('.editor').click()
  await win.keyboard.press('End')
  await win.keyboard.press('Shift+Home')
  await win.getByRole('button', { name: t.composeTools.bold, exact: true }).click()
  check('a mouse click on a formatting button still formats the selection, the focus stays in the text', /<b>/.test(await win.locator('.editor').innerHTML()) && (await focused(win)) === 'editor', await focused(win))
  // each key on its own plain text (two of them on the same text is the browser's own business, not this check's)
  const keyed = []
  for (const key of ['Control+B', 'Control+I', 'Control+U']) {
    await win.locator('.editor').evaluate(el => {
      el.innerHTML = '<p>Billentyű</p>'
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el.firstChild)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    })
    await win.keyboard.press(key)
    keyed.push(await win.locator('.editor').innerHTML())
  }
  check('Ctrl+B, Ctrl+I and Ctrl+U in the text format the selection', keyed[0] === '<p><b>Billentyű</b></p>' && keyed[1] === '<p><i>Billentyű</i></p>' && keyed[2] === '<p><u>Billentyű</u></p>', keyed.join(' | '))
  await win.getByRole('button', { name: t.composeDiscard, exact: true }).click()
  {
    const closed = win.waitForEvent('close', { timeout: 15_000 })
    await win.locator('[role="alertdialog"]').getByRole('button', { name: t.composeDiscard, exact: true }).click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
  }

  // 2. a reply
  await row(SUBJECT).click()
  await page.locator('.reader-tools').waitFor()
  win = await composerOf(() => page.locator('.reader-tools').getByRole('button', { name: t.replyModes.reply, exact: true }).click())
  await tabOrder(win, 'reply')
  await win.close()

  // 3. a forward, saved as a draft
  win = await composerOf(() => page.locator('.reader-tools').getByRole('button', { name: t.replyModes.forward, exact: true }).click())
  await tabOrder(win, 'forward')
  await win.locator('#compose-to').fill('Címzett Béla <bela@example.invalid>')
  await win.getByRole('button', { name: t.composeSaveDraft, exact: true }).click()
  await win.locator('.hint[role="status"]').filter({ hasText: savedHint }).waitFor({ timeout: 15_000 })
  await win.close()

  // 4. the draft, edited
  await pane.locator('.folder[data-path="Drafts"]').click()
  await row(`Fwd: ${SUBJECT}`).click()
  await page.locator('.reader-tools .reader-edit-draft').waitFor({ timeout: 10_000 })
  win = await composerOf(() => page.locator('.reader-tools .reader-edit-draft').click())
  await tabOrder(win, 'edited draft')
  await win.close()
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  await app.close().catch(() => {})
  await pop.close()
  await new Promise(r => smtp.close(r))
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
