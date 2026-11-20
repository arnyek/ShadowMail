#!/usr/bin/env node
// "Szerkesztés" on a saved draft in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/edit-draft-e2e.mjs          (E2E_LANG=en: the same in English)
//
// A POP3 account (local Drafts and Sent, fake POP3 server) and a local SMTP server:
// 1. A message in the inbox has no "Szerkesztés" button (neither in the toolbar nor below).
// 2. Its forward (with its attachment) saved as a draft: in Drafts the reader shows "Szerkesztés" twice (toolbar, below);
//    the composer it opens (with a DOUBLE click: the second click comes while the first one is still being prepared)
//    is the only one, and holds the same recipient, subject, body and attachment.
// 3. "Szerkesztés" again, and two compose:open calls at once, while that composer is open: no second window.
// 4. The text changed and saved: Drafts holds ONE copy, with the new text.
// 5. Opened again and sent: Drafts is empty, Sent holds it, the SMTP server got it.
// The main log has no error line, the renderer console no error or warning.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, locale, seedLanguage } from './lang.mjs'
import { useTheme, e2eTheme } from './theme-env.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-szerkesztes'
const ME = 'teszt@example.invalid'
const SUBJECT = 'Ajánlat kérés'
const savedHint = (d => t.composeSavedAt(d).replace(d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }), '').trim())(new Date())

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

const received = []
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN', 'LOGIN'], logger: false,
  onAuth: (a, _s, cb) => cb(null, { user: a.username }),
  onData(stream, session, cb) {
    const chunks = []
    stream.on('data', c => chunks.push(c))
    stream.on('end', () => (received.push(Buffer.concat(chunks)), cb()))
  },
})
smtp.on('error', () => {})
await new Promise(r => smtp.listen(0, '127.0.0.1', r))

const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(4000)])
const pop = await new FakePop3Server().listen()
pop.add(Buffer.from([
  'From: Kovács Anna <anna@example.invalid>', `To: Teszt Elek <${ME}>`, 'Subject: =?utf-8?q?Aj=C3=A1nlat_k=C3=A9r=C3=A9s?=',
  `Date: ${new Date().toUTCString()}`, 'Message-ID: <szerk-1@example.invalid>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '',
  '--B', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', 'Kérem az árajánlatot.', '--B',
  'Content-Type: application/pdf; name="alaprajz.pdf"', 'Content-Disposition: attachment; filename="alaprajz.pdf"', 'Content-Transfer-Encoding: base64', '',
  pdf.toString('base64').replace(/.{76}/g, '$&\r\n'), '--B--', '',
].join('\r\n')))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-d1-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: ME, display_name: 'Teszt Elek',
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
  // E2E_THEME=<id>: the run under that theme (classic-blue: the compact density's 32 px buttons in the narrowest reader)
  await useTheme(app, page)
  if (e2eTheme) console.log(`THEME ${await page.evaluate(() => `${document.documentElement.dataset.theme} ${document.documentElement.dataset.density}`)}`)
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  const pane = page.locator('.folder-tree section', { hasText: 'POP3-fiók' })
  const folder = p => pane.locator(`.folder[data-path="${p}"]`)
  const row = s => page.locator('.msg-row', { hasText: s })
  const editButtons = () => page.locator('.reader .reader-edit-draft')
  const rows = folderPath =>
    page.evaluate(async f => {
      const acc = (await window.shadowMail.mail.folders()).accounts[0]
      const res = await window.shadowMail.mail.list({ accountId: acc.id, folder: f })
      return res.ok ? res.rows.map(r => r.subject) : ['(error)']
    }, folderPath)
  const composerOf = async click => {
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), click()])
    await win.setViewportSize({ width: 900, height: 700 })
    await win.waitForFunction(() => document.querySelector('#compose-subject')?.value)
    return win
  }
  const fieldsOf = win =>
    win.evaluate(() => ({
      to: document.querySelector('#compose-to').value,
      subject: document.querySelector('#compose-subject').value,
      html: document.querySelector('.editor').innerHTML,
      attachments: [...document.querySelectorAll('.compose-attachments li.attachment-chip')].map(li => li.textContent.trim()),
    }))
  // a click that closes its window: the window may go before the click's own bookkeeping ends ("Target page ... has
  // been closed"); the close event is what counts, a click error on a closed window is not a failure
  const clickClosing = async (win, name, timeout) => {
    const closed = win.waitForEvent('close', { timeout })
    await win.getByRole('button', { name, exact: true }).click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
  }
  const saveAndClose = async win => {
    await win.getByRole('button', { name: t.composeSaveDraft, exact: true }).click()
    await win.locator('.hint[role="status"]').filter({ hasText: savedHint }).waitFor({ timeout: 15_000 })
    await clickClosing(win, t.composeCloseWindow, 15_000)
  }

  // the narrowest reader: on the right of the list, the main window at its minimum (860), the list as wide as it may be
  const narrowFit = async () => {
    await page.locator('.reader-pane-switch').click() // none -> right
    await page.setViewportSize({ width: 860, height: 900 })
    const listSplit = page.locator('.splitter[data-split="list"]')
    await listSplit.focus()
    for (let i = 0; i < 40; i++) await listSplit.press('ArrowRight')
    await page.waitForTimeout(300)
    const fit = await page.evaluate(() => {
      const over = sel => [...document.querySelectorAll(sel)].map(e => e.scrollWidth - e.clientWidth).find(d => d > 1) ?? 0
      // every toolbar button keeps a usable width (the compact theme's 32 px), and the label button is in, inside the bar
      const bar = document.querySelector('.reader-tools').getBoundingClientRect()
      const buttons = [...document.querySelectorAll('.reader-tools button')].map(b => b.getBoundingClientRect())
      const tag = document.querySelector('.reader-tools .reader-label-open')
      const tagBox = tag && tag.getBoundingClientRect()
      return {
        reader: Math.round(document.querySelector('.reader').getBoundingClientRect().width),
        toolbar: over('.reader-toolbar, .reader-tools'),
        replies: over('.reader-replies'),
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        minButton: Math.round(Math.min(...buttons.map(b => b.width)) * 10) / 10,
        tagInside: Boolean(tagBox && tagBox.left >= bar.left - 0.5 && tagBox.right <= bar.right + 0.5),
      }
    })
    await listSplit.dblclick() // the list's default width back
    await page.locator('.reader-pane-switch').click() // right -> bottom
    await page.locator('.reader-pane-switch').click() // bottom -> none
    await page.setViewportSize({ width: 1280, height: 900 })
    return fit
  }
  // 1. the inbox: no "Szerkesztés"
  await row(SUBJECT).waitFor({ timeout: 20_000 })
  await row(SUBJECT).click()
  await page.locator('.reader-tools').waitFor()
  check('a message in the inbox: no edit button, neither in the toolbar nor below', (await editButtons().count()) === 0)
  check('a message in the inbox: reply-all in the toolbar as before', (await page.locator('.reader-tools').getByRole('button', { name: t.replyModes.replyAll, exact: true }).count()) === 1)
  console.log(`MEASURED the inbox message in the narrowest reader: ${JSON.stringify(await narrowFit())}`)

  // 2. its forward, saved as a draft
  let win = await composerOf(() => page.locator('.reader-tools').getByRole('button', { name: t.replyModes.forward, exact: true }).click())
  await win.locator('#compose-to').fill('Címzett Béla <bela@example.invalid>')
  await win.locator('.editor').click()
  await win.keyboard.press('Control+Home')
  await win.keyboard.type('Első változat. ')
  await saveAndClose(win)
  await folder('Drafts').click()
  await row(`Fwd: ${SUBJECT}`).waitFor({ timeout: 15_000 })
  check('the forward saved: one draft', JSON.stringify(await rows('Drafts')) === JSON.stringify([`Fwd: ${SUBJECT}`]), JSON.stringify(await rows('Drafts')))
  await row(`Fwd: ${SUBJECT}`).click()
  await page.locator('.reader-tools').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(300) // the account's folders are known by then (the button needs its roles)
  const names = await editButtons().evaluateAll(els => els.map(e => e.getAttribute('aria-label') || e.textContent.trim()))
  check('a draft in Drafts: the edit button in the toolbar and below, named in the interface language', names.length === 2 && names.every(n => n === t.replyModes.edit), JSON.stringify(names))
  const replyAllTool = await page.locator('.reader-tools').getByRole('button', { name: t.replyModes.replyAll, exact: true }).count()
  const replyAllBelow = await page.locator('.reader-replies').getByRole('button', { name: t.replyModes.replyAll, exact: true }).count()
  check('a draft: no reply-all in the toolbar, it stays below', replyAllTool === 0 && replyAllBelow === 1, `toolbar ${replyAllTool}, below ${replyAllBelow}`)
  const draftFit = await narrowFit()
  check('the narrowest reader (right of the list, 860 px, the list at its widest): no overflow in the toolbar or below', draftFit.reader <= 380 && draftFit.toolbar === 0 && draftFit.replies === 0 && draftFit.page <= 0, JSON.stringify(draftFit))
  check('the narrowest reader: every toolbar button at least 32 px wide, the label button inside the bar', draftFit.minButton >= 32 && draftFit.tagInside, JSON.stringify(draftFit))
  const composers = () => app.windows().filter(w => w.url().includes('#compose='))
  win = await composerOf(() => page.locator('.reader-tools .reader-edit-draft').dblclick())
  await page.waitForTimeout(1500)
  check('a double click on the edit button: one composer window', composers().length === 1, `${composers().length}`)
  const first = await fieldsOf(win)
  check('the composer holds the recipient, subject, body and attachment', first.to.includes('bela@example.invalid') && first.subject === `Fwd: ${SUBJECT}` && first.html.includes('Első változat.') && first.html.includes('Kérem az árajánlatot.') && first.attachments.some(a => a.includes('alaprajz.pdf')), JSON.stringify({ ...first, html: first.html.slice(0, 120) }))

  // 3. "Szerkesztés" again: no second window
  const windowsBefore = app.windows().length
  await page.locator('.reader-replies .reader-edit-draft').click()
  const draftId = await page.evaluate(async () => {
    const acc = (await window.shadowMail.mail.folders()).accounts[0]
    return (await window.shadowMail.mail.list({ accountId: acc.id, folder: 'Drafts' })).rows[0].id
  })
  const both = await page.evaluate(id => Promise.all([1, 2].map(() => window.shadowMail.compose.open({ mode: 'draft', messageId: id }))), draftId)
  await page.waitForTimeout(1500)
  check('the same draft again (a click, two calls at once): no second composer window', app.windows().length === windowsBefore && both.every(r => r.ok && r.existing), `${windowsBefore} -> ${app.windows().length} ${JSON.stringify(both)}`)

  // 4. changed and saved: one copy, the new text
  await win.locator('.editor').click()
  await win.keyboard.press('Control+Home')
  await win.keyboard.type('Javított változat. ')
  await saveAndClose(win)
  await page.waitForTimeout(500)
  check('changed and saved: Drafts holds ONE copy', JSON.stringify(await rows('Drafts')) === JSON.stringify([`Fwd: ${SUBJECT}`]), JSON.stringify(await rows('Drafts')))
  await page.locator('.reader-back').click() // the open message covers the list (no reading pane)
  await row(`Fwd: ${SUBJECT}`).click()
  await page.locator('.reader pre.mail-text, .reader iframe.mail-frame').first().waitFor({ timeout: 10_000 })
  win = await composerOf(() => page.locator('.reader-tools .reader-edit-draft').click())
  const second = await fieldsOf(win)
  check('opened again: the new text, the attachment kept', second.html.includes('Javított változat.') && second.attachments.some(a => a.includes('alaprajz.pdf')), second.html.slice(0, 160))

  // 5. sent: gone from Drafts, in Sent, at the SMTP server
  await clickClosing(win, t.composeSend, 30_000)
  for (let i = 0; i < 50 && (received.length === 0 || (await rows('Drafts')).length > 0); i++) await page.waitForTimeout(200)
  const sentMail = received.length ? await simpleParser(received[0]) : null
  check('sent: Drafts is empty', (await rows('Drafts')).length === 0, JSON.stringify(await rows('Drafts')))
  check('sent: Sent holds it', (await rows('Sent')).includes(`Fwd: ${SUBJECT}`), JSON.stringify(await rows('Sent')))
  check('the SMTP server got the edited text with the attachment', received.length === 1 && sentMail.text.includes('Javított változat.') && sentMail.attachments.some(a => a.filename === 'alaprajz.pdf'), `${received.length} message(s)`)
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
