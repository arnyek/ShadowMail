#!/usr/bin/env node
// The composer in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/compose-e2e.mjs [--shot <file.png>]
//
// A POP3 account (fake POP3 server, local Drafts and Sent) whose SMTP side is a local smtp-server that
// keeps every message byte for byte. Nothing leaves the machine. The open dialog is replaced inside the
// app (the attachments are picked from a temporary folder). One step waits the real 60 s autosave.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, locale, seedLanguage } from './lang.mjs'

const { values } = parseArgs({ options: { shot: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-levelíró'
const USER = 'teszt@example.invalid'
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
// the "draft saved" hint without its time; the "sending failed: " prefix without the reason
const savedHint = (d => t.composeSavedAt(d).replace(d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }), '').trim())(new Date())
const sendFailed = t.composeError('auth_failed').replace(t.composeErrors.auth_failed, '')

const received = []
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'],
  allowInsecureAuth: true,
  authMethods: ['PLAIN', 'LOGIN'],
  logger: false,
  // one address the server refuses at RCPT TO (a partly refused send)
  onRcptTo: (address, _s, cb) => (address.address === 'nincs@example.invalid' ? cb(Object.assign(new Error('No such user here'), { responseCode: 550 })) : cb()),
  onAuth: (auth, _s, cb) => (auth.password === 'jo-jelszo' ? cb(null, { user: auth.username }) : cb(new Error('Invalid username or password'))),
  onData(stream, session, cb) {
    const chunks = []
    stream.on('data', c => chunks.push(c))
    stream.on('end', () => {
      received.push({ to: session.envelope.rcptTo.map(r => r.address), raw: Buffer.concat(chunks) })
      cb()
    })
  },
})
smtp.on('error', () => {})
await new Promise(r => smtp.listen(0, '127.0.0.1', r))
const smtpPort = smtp.server.address().port

const pop = await new FakePop3Server().listen()
pop.add(Buffer.from(`From: Feladó Ferenc <ferenc@example.invalid>\r\nTo: ${USER}\r\nSubject: Régi\r\nDate: ${new Date().toUTCString()}\r\n\r\nszia\r\n`))
// a message with mailto: links: one with Cc, Bcc, subject and a body holding markup, one broken
const MAILTO = 'mailto:anna@example.invalid?cc=cili@example.invalid&bcc=rejtett@example.invalid&subject=%C3%81rv%C3%ADz%20k%C3%A9rd%C3%A9s&body=Els%C5%91%20sor%0D%0A%3Cb%3Enem%20f%C3%A9lk%C3%B6v%C3%A9r%3C%2Fb%3E'
pop.add(Buffer.from(`From: Linkes Lili <lili@example.invalid>\r\nTo: ${USER}\r\nSubject: Mailto-link\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p><a id="mt" href="${MAILTO}">Írj nekem</a> <a id="bad" href="mailto:a%ZZ@example.invalid">rossz</a></p>\r\n`))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-k8-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
const files = path.join(work, 'files')
fs.mkdirSync(files)
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(30_000)])
fs.writeFileSync(path.join(files, 'szamla.pdf'), pdf)
fs.writeFileSync(path.join(files, 'árvíztűrő tükörfúrógép.txt'), 'Ékezetes tartalom őű\r\n')
let accountId
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER) // vault.json + the encrypted mail.sqlite
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  accountId = store.save({
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: USER, display_name: 'Kovács Árpád', signature: 'Kovács Árpád\nShadowMail teszt',
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: smtpPort, smtp_security: 'none', smtp_same_password: false, smtp_password: 'jo-jelszo',
  }).account.id
  db.close()
}

// a hung step must not hang the run: the whole measurement gets 6 minutes
const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 6 minutes')
  process.exit(1)
}, 360_000)
watchdog.unref()

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
const folderCount = (page, folder) =>
  page.evaluate(async ([id, f]) => (await window.shadowMail.mail.folders()).accounts.find(a => a.id === id).folders.find(x => x.path === f)?.count ?? -1, [accountId, folder])

async function openComposer(page) {
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: t.newMessage, exact: true }).click()])
  await win.setViewportSize({ width: 900, height: 700 })
  await win.locator('.editor').waitFor()
  await win.waitForFunction(() => document.querySelector('#compose-from')?.textContent.trim())
  return win
}

try {
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [`${dir}/szamla.pdf`, `${dir}/árvíztűrő tükörfúrógép.txt`] })
  }, files)
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row', { hasText: 'Régi' }).waitFor({ timeout: 20000 })

  // 1. compose and send
  let win = await openComposer(page)
  check('composer window opens with the account and its signature', (await win.locator('.editor').innerText()).includes('ShadowMail teszt') && (await win.locator('#compose-from').innerText()).includes('Kovács Árpád <teszt@example.invalid>'))
  // the From is a menu (no native <select>), usable from the keyboard; no unstyled control
  const fromBtn = win.locator('#compose-from')
  await fromBtn.focus()
  await win.keyboard.press('ArrowDown')
  const fromMenu = win.getByRole('menu', { name: t.composeFrom })
  await fromMenu.waitFor()
  const radios = await fromMenu.getByRole('menuitemradio').count()
  const checkedFocused = await win.evaluate(() => document.activeElement?.getAttribute('aria-checked'))
  await win.keyboard.press('Escape')
  await fromMenu.waitFor({ state: 'detached' })
  const fromBack = await fromBtn.evaluate(el => el === document.activeElement)
  await win.keyboard.press('Enter')
  await fromMenu.waitFor()
  await win.keyboard.press('Enter')
  await fromMenu.waitFor({ state: 'detached' })
  check('From menu: ArrowDown opens on the current account, Esc closes, Enter keeps it', radios >= 1 && checkedFocused === 'true' && fromBack && (await fromBtn.innerText()).includes('teszt@example.invalid'))
  const ui5 = await win.evaluate(() => ({
    native: document.querySelectorAll('button:not([class]), select').length,
    unnamed: document.querySelectorAll('button.icon-btn:not([aria-label])').length,
    tools: [...document.querySelectorAll('.editor-toolbar button')].map(b => b.getAttribute('aria-label')),
  }))
  check('no native control, every icon button named; the formatting bar has the old names', ui5.native === 0 && ui5.unnamed === 0 && JSON.stringify(ui5.tools) === JSON.stringify(['bold', 'italic', 'underline', 'textColor', 'highlight', 'ul', 'ol', 'link', 'quote', 'clear'].map(k => t.composeTools[k])), JSON.stringify(ui5))
  await win.locator('#compose-to').fill('fer')
  const option = win.locator('.suggestions [role="option"]').first()
  await option.waitFor()
  const suggestion = await option.innerText()
  await win.locator('#compose-to').press('Enter')
  check('completion from a received sender', /ferenc@example\.invalid/.test(suggestion) && /Feladó Ferenc <ferenc@example\.invalid>, $/.test(await win.locator('#compose-to').inputValue()), suggestion)
  await win.locator('#compose-to').fill(`Teszt Címzett <${USER}>`)
  await win.getByRole('button', { name: t.composeShowCopies }).click()
  await win.locator('#compose-bcc').fill('Titkos <titkos@example.invalid>')
  await win.locator('#compose-subject').fill('Ékezetes tárgy: árvíztűrő tükörfúrógép')
  await win.locator('.editor').click()
  await win.keyboard.press('Control+Home')
  await win.keyboard.type('Félkövér szöveg')
  await win.keyboard.press('Shift+Home')
  await win.getByRole('button', { name: t.composeTools.bold }).click()
  await win.keyboard.press('End')
  await win.keyboard.press('Enter')
  // a paste with a script, an image and a style: the script, the image and the javascript: link go; the readable
  // text colour stays (the rich paste keeps it), and nothing else rides on a style
  await win.locator('.editor').evaluate(el => {
    el.focus()
    const dt = new DataTransfer()
    dt.setData('text/html', '<p style="color:red">Beillesztve <b>vastag</b><img src="https://tracker.invalid/p.png"><script>window.__pwned=1</script><a href="javascript:alert(1)">rossz</a> <a href="https://example.com/">jó</a></p>')
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  const editorHtml = await win.locator('.editor').innerHTML()
  const pastedStyles = [...editorHtml.matchAll(/style="([^"]*)"/gi)].map(m => m[1].trim())
  check('paste: no script, image or javascript: link; the only style is the text colour', !/<script|<img|javascript:/i.test(editorHtml) && pastedStyles.length > 0 && pastedStyles.every(s => /^color:\s*red;?$/i.test(s)) && /Beillesztve/.test(editorHtml) && /href="https:\/\/example\.com\/"/.test(editorHtml) && !(await win.evaluate(() => window.__pwned)), editorHtml.slice(0, 300))
  await win.getByRole('button', { name: t.composeAttach }).click()
  await win.locator('.compose-attachments li').nth(1).waitFor()
  check('attachments listed', (await win.locator('.compose-attachments li').count()) === 2)
  if (values.shot) await win.screenshot({ path: values.shot })
  await Promise.all([win.waitForEvent('close'), win.getByRole('button', { name: t.composeSend, exact: true }).click()])
  check('Küldés: the window closes', true)
  await new Promise(r => setTimeout(r, 300))
  check('the SMTP server got exactly one message, Bcc in the envelope only', received.length === 1 && received[0].to.includes('titkos@example.invalid') && !/titkos@example\.invalid/i.test(received[0].raw.toString('latin1')), JSON.stringify(received.map(r => r.to)))
  const got = await simpleParser(received[0].raw)
  check('accented subject and sender name', got.subject === 'Ékezetes tárgy: árvíztűrő tükörfúrógép' && got.from.value[0].name === 'Kovács Árpád', `${got.subject} | ${got.from.text}`)
  check('HTML with the bold text, and a text part', /<b>Félkövér szöveg<\/b>/.test(got.html) && /Félkövér szöveg/.test(got.text), got.html.slice(0, 200))
  const atts = got.attachments.map(a => [a.filename, sha(a.content)])
  const want = [['szamla.pdf', sha(pdf)], ['árvíztűrő tükörfúrógép.txt', sha(fs.readFileSync(path.join(files, 'árvíztűrő tükörfúrógép.txt')))]]
  check('attachments byte for byte (sha256)', JSON.stringify(atts) === JSON.stringify(want), JSON.stringify(atts))
  console.log(`  sha256 szamla.pdf = ${sha(pdf)}`)
  await page.waitForFunction(async id => (await window.shadowMail.mail.folders()).accounts.find(a => a.id === id).folders.find(f => f.path === 'Sent')?.count === 1, accountId)
  check('one copy in the local Sent', (await folderCount(page, 'Sent')) === 1)

  // 1b. the address of a deleted person is not suggested (it was: a received sender, step 1);
  // typed by hand the message still goes, and the send does not take the address back into the address book
  {
    const saved = await page.evaluate(() => window.shadowMail.contacts.save({ displayName: 'Feladó Ferenc', emails: ['ferenc@example.invalid'] }))
    const del = await page.evaluate(id => window.shadowMail.contacts.delete([id]), saved.id)
    const cwin = await openComposer(page)
    // a term every address matches: the list comes (the people of step 1's send), so its content is measured, not its delay
    await cwin.locator('#compose-to').fill('example.invalid')
    await cwin.locator('.suggestions [role="option"]').first().waitFor()
    const shown = await cwin.locator('.suggestions [role="option"]').allInnerTexts()
    await cwin.locator('#compose-to').fill('fer')
    await cwin.waitForTimeout(1000)
    const shownFer = await cwin.locator('.suggestions [role="option"]').allInnerTexts()
    check('the deleted person\'s address is not suggested (by address or by name)', saved.ok && del.ok && shown.length > 0 && !shown.some(s => /ferenc@/.test(s)) && !shownFer.some(s => /ferenc@/.test(s)), JSON.stringify({ shown, shownFer }))
    const before = received.length
    const peopleBefore = (await page.evaluate(() => window.shadowMail.contacts.count())).count
    await cwin.locator('#compose-to').fill('ferenc@example.invalid')
    await cwin.locator('#compose-subject').fill('törölt cím, kézzel')
    await Promise.all([cwin.waitForEvent('close'), cwin.getByRole('button', { name: t.composeSend, exact: true }).click()])
    await new Promise(r => setTimeout(r, 300))
    const people = await page.evaluate(() => window.shadowMail.contacts.list({ q: 'ferenc' }))
    check('typed by hand it is sent; it does not come back into the address book', received.length === before + 1 && received[before].to.includes('ferenc@example.invalid') && people.total === 0 && (await page.evaluate(() => window.shadowMail.contacts.count())).count === peopleBefore, JSON.stringify({ to: received.slice(before).map(r => r.to), people: people.total, peopleBefore }))
  }

  // 2. autosave after 60 s, then close: asked, saved, still one draft
  win = await openComposer(page)
  await win.locator('#compose-to').fill(USER)
  await win.locator('#compose-subject').fill('Automatikus piszkozat')
  await win.locator('.hint[role="status"]').filter({ hasText: savedHint }).waitFor({ timeout: 75_000 })
  check('autosave within 60 s (+ margin)', (await folderCount(page, 'Drafts')) === 1)
  await win.locator('#compose-subject').fill('Automatikus piszkozat, javítva')
  // the window's X button: BrowserWindow.close() in the main process
  await app.evaluate(({ BrowserWindow }, prefix) => BrowserWindow.getAllWindows().find(w => w.getTitle().startsWith(prefix)).close(), t.newMessage)
  await win.getByRole('alertdialog').waitFor()
  check('closing with unsaved changes asks first', (await win.getByRole('alertdialog').innerText()).includes(t.composeCloseTitle))
  check('only the close question is open (no other dialog over it)', (await win.locator('.modal-backdrop').count()) === 1)
  await Promise.all([win.waitForEvent('close', { timeout: 10_000 }), win.getByRole('alertdialog').getByRole('button', { name: t.composeSaveAndClose }).click({ timeout: 5000 })])
  await page.waitForTimeout(400)
  const drafts = await page.evaluate(async id => {
    const res = await window.shadowMail.mail.list({ accountId: id, folder: 'Drafts' })
    return res.rows.map(r => r.subject)
  }, accountId)
  check('exactly one draft, the latest version', JSON.stringify(drafts) === JSON.stringify(['Automatikus piszkozat, javítva']), JSON.stringify(drafts))

  // 2b. a partly refused send: the window shows it and sends / saves nothing again
  win = await openComposer(page)
  await win.locator('#compose-to').fill('ok@example.invalid, nincs@example.invalid')
  await win.locator('#compose-subject').fill('Részben elutasítva')
  const before = received.length
  await win.getByRole('button', { name: t.composeSend, exact: true }).click()
  await win.locator('.notice').waitFor({ timeout: 20_000 })
  const notice = await win.locator('.notice').innerText()
  check('partly refused: the notice names the refused address and says it cannot be sent again', /nincs@example\.invalid/.test(notice) && notice.includes(t.composeSentLocked), notice)
  const sendOn = await win.getByRole('button', { name: t.composeSend, exact: true }).isEnabled()
  const saveOn = await win.getByRole('button', { name: t.composeSaveDraft, exact: false }).first().isEnabled()
  const toOn = await win.locator('#compose-to').isEditable()
  const bodyOn = await win.locator('.editor').getAttribute('contenteditable')
  check('partly refused: Send, Save, the To field and the body are locked', !sendOn && !saveOn && !toOn && bodyOn === 'false', JSON.stringify({ sendOn, saveOn, toOn, bodyOn }))
  check('partly refused: exactly one message went out', received.length === before + 1, JSON.stringify(received.slice(before).map(r => r.to)))
  await Promise.all([win.waitForEvent('close', { timeout: 10_000 }), win.locator('.notice').getByRole('button').click()])
  check('partly refused: Bezárás closes the window', true)

  // 2c. a mailto: link of a message opens the composer filled from it; Bcc is not taken
  await page.locator('.msg-row', { hasText: 'Mailto-link' }).click()
  let linkFrame = null
  for (let i = 0; i < 100 && !linkFrame; i++) {
    linkFrame = page.frames().find(f => f.url().startsWith('mail-view://view/')) || null
    if (!linkFrame) await page.waitForTimeout(100)
  }
  await linkFrame.locator('#mt').waitFor()
  const windowsBefore = app.windows().length
  const [mwin] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), linkFrame.locator('#mt').click()])
  await mwin.locator('.editor').waitFor()
  await mwin.waitForFunction(() => document.querySelector('#compose-to')?.value)
  const mform = await mwin.evaluate(() => ({
    to: document.querySelector('#compose-to').value,
    cc: document.querySelector('#compose-cc')?.value ?? null,
    bcc: document.querySelector('#compose-bcc')?.value ?? '',
    subject: document.querySelector('#compose-subject').value,
    text: document.querySelector('.editor').innerText,
    bold: document.querySelectorAll('.editor b, .editor strong').length,
    from: document.querySelector('#compose-from')?.textContent || '',
  }))
  check('mailto: To, Cc and the accented subject from the link', mform.to === 'anna@example.invalid' && mform.cc === 'cili@example.invalid' && mform.subject === 'Árvíz kérdés', JSON.stringify(mform))
  check('mailto: the Bcc of the link is not taken', mform.bcc === '' && !JSON.stringify(mform).includes('rejtett'), JSON.stringify(mform))
  check('mailto: the body as plain text (markup shown, not applied), above the signature', /Első sor\n+<b>nem félkövér<\/b>/.test(mform.text) && mform.bold === 0 && mform.text.indexOf('Első sor') < mform.text.indexOf('ShadowMail teszt'), JSON.stringify(mform.text))
  check('mailto: the From is the account', mform.from.includes('teszt@example.invalid'), mform.from)
  await linkFrame.locator('#bad').click()
  await page.waitForTimeout(800)
  check('mailto: a broken link opens no window', app.windows().length === windowsBefore + 1, `${app.windows().length} windows`)
  check('mailto: the window title is the subject', (await mwin.title()) === 'Árvíz kérdés - ShadowMail', await mwin.title())
  const draftsBefore = await folderCount(page, 'Drafts')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Árvíz kérdés - ShadowMail').close())
  const discardAsk = mwin.getByRole('alertdialog')
  await Promise.all([
    mwin.waitForEvent('close', { timeout: 10_000 }),
    (async () => {
      if (await discardAsk.waitFor({ timeout: 2000 }).then(() => true, () => false)) await discardAsk.getByRole('button', { name: t.composeDiscard, exact: true }).click()
    })(),
  ])
  await page.waitForTimeout(400)
  check('mailto: closed (Elvetés if asked), no draft left', mwin.isClosed() && (await folderCount(page, 'Drafts')) === draftsBefore, `drafts ${draftsBefore} -> ${await folderCount(page, 'Drafts')}`)

  // 3. a failed send keeps the message
  await app.evaluate(() => {}) // keep the app busy-free
  win = await openComposer(page)
  await win.locator('#compose-to').fill(USER)
  await win.locator('#compose-subject').fill('Nem megy ki')
  // a bulleted list and a link from the icon bar; an attachment chip removed with its X
  await win.locator('.editor').click()
  await win.keyboard.press('Control+Home')
  await win.keyboard.type('Lista elem')
  await win.getByRole('button', { name: t.composeTools.ul, exact: true }).click()
  await win.keyboard.press('End')
  await win.keyboard.press('Enter')
  await win.keyboard.press('Enter')
  await win.getByRole('button', { name: t.composeTools.link, exact: true }).click()
  const linkDialog = win.getByRole('dialog', { name: t.composeTools.link })
  await linkDialog.getByLabel(t.composeLinkUrl).fill('https://example.invalid/ut')
  await linkDialog.getByRole('button', { name: t.composeLinkOk, exact: true }).click()
  await linkDialog.waitFor({ state: 'detached' })
  const fmt = await win.evaluate(() => ({ li: [...document.querySelectorAll('.editor ul li')].map(l => l.textContent), a: document.querySelector('.editor a')?.getAttribute('href') }))
  check('list and link from the icon bar', fmt.li.includes('Lista elem') && fmt.a === 'https://example.invalid/ut', JSON.stringify(fmt))
  await win.getByRole('button', { name: t.composeAttach, exact: true }).click()
  await win.locator('.compose-attachments li').nth(1).waitFor()
  await win.locator('.compose-attachments li', { hasText: 'szamla.pdf' }).getByRole('button', { name: t.composeRemoveAttachment('szamla.pdf'), exact: true }).click()
  await win.waitForFunction(() => document.querySelectorAll('.compose-attachments li').length === 1)
  check('attachment chips, one removed with its X', (await win.locator('.compose-attachments li.attachment-chip').count()) === 1)
  await new Promise(r => smtp.close(r))
  await win.getByRole('button', { name: t.composeSend, exact: true }).click()
  await win.getByRole('alert').waitFor({ timeout: 70_000 })
  const err = await win.getByRole('alert').innerText()
  check('SMTP down: error, kept as a draft, the window stays', err.includes(sendFailed) && err.includes(t.composeKeptAsDraft) && !win.isClosed(), err)

  // 4. the closing paths of the page. The main-process side is in
  // test/compose-session.test.js; here the IPC answers are replaced so that the page's reaction is measured.
  // Last step: the replaced handlers stay replaced.
  const closeAsk = async (w, button) => {
    await app.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows().find(x => x.getTitle() === title).close(), await w.title())
    await w.getByRole('alertdialog').waitFor()
    await w.getByRole('alertdialog').getByRole('button', { name: button, exact: true }).click()
    await w.waitForTimeout(400)
  }
  const errorText = w => w.locator('[role="alert"]').allInnerTexts().then(x => x.join(' '))
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('compose:discard')
    ipcMain.handle('compose:discard', () => ({ ok: false, error: 'server_refused' }))
    ipcMain.removeHandler('compose:saveDraft')
    ipcMain.handle('compose:saveDraft', () => ({ ok: true, savedAt: Date.now(), oldDraftLeft: true }))
    ipcMain.removeHandler('compose:send')
    ipcMain.handle('compose:send', () => new Promise(r => setTimeout(() => r({ ok: false, error: 'connection_failed' }), 4000)))
  })
  win = await openComposer(page)
  await win.locator('#compose-subject').fill('Bezárás-utak')
  await closeAsk(win, t.composeDiscard)
  check('Elvetés that failed: the window stays and says the draft may be left', !win.isClosed() && (await errorText(win)).includes(t.composeError('server_refused', null, 'discard')), await errorText(win))
  await closeAsk(win, t.composeSaveAndClose)
  check('Mentés piszkozatként with a draft left in the old account: the window stays and says so', !win.isClosed() && (await errorText(win)).includes(t.composeOldDraftLeft), await errorText(win))
  await win.locator('#compose-to').fill(USER)
  await win.locator('#compose-subject').fill('Bezárás-utak, küldés közben')
  await win.getByRole('button', { name: t.composeSend, exact: true }).click()
  await closeAsk(win, t.composeDiscard)
  check('Elvetés while sending: "wait for it", the window stays', !win.isClosed() && (await errorText(win)).includes(t.composeWaitSending), await errorText(win))
} catch (err) {
  check('run', false, err.stack)
} finally {
  await app.close().catch(() => {})
  await pop.close()
  smtp.close(() => {})
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
