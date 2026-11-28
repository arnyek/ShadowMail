#!/usr/bin/env node
// .eml files dropped on "Új levél" in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/eml-drop-e2e.mjs          (E2E_LANG=en: the same in English)
//
// Two POP3 accounts (fake POP3 server) and a local SMTP server; the second account's inbox is selected:
// 1. A file drag over the button lights it up, leaving takes the light away; a message drag (the list's own) does not.
// 2. A template .eml (To, Cc, Bcc, subject, HTML with an embedded PNG, a PDF; From / Reply-To / Message-ID /
//    In-Reply-To / References / X- headers of its own) dropped: one composer, From = the selected account, the fields,
//    Bcc shown, the image visible, the PDF in the bar. Sent: a new Message-ID, none of the file's reply headers,
//    the PDF and the image byte for byte.
// 3. A hostile .eml (script, onerror, external image, style, javascript: link): nothing of it in the composer nor sent.
// 4. Over 25 MB, a PDF, a broken .eml: the own error text beside the list, no composer.
// 5. Six files at once: five composers and one notice.
// The main log has no file name or path; no error line but the expected "eml not opened" ones; the renderer
// console no error or warning.
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
import { pngFile } from '../helpers/inline-images.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'
import { dropFiles } from './drag-env.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-eml-ejtes'
const FIRST = 'elso@example.invalid'
const SECOND = 'masodik@example.invalid'
const SUBJECT = 'Sablon: árvíztűrő tükörfúrógép'
const PNG = pngFile(48, 32, { seed: 3 })
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(6000)])
const b64 = buf => buf.toString('base64').replace(/.{76}/g, '$&\r\n')

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 5 minutes')
  process.exit(1)
}, 300_000)
watchdog.unref()

function templateEml({ subject = SUBJECT, html = '<p>Szia <b>mindenki</b>!</p><p><img src="cid:kep1@minta" alt=""></p>' } = {}) {
  return Buffer.from(
    'From: Régi Feladó <regi@example.invalid>\r\nReply-To: valasz@example.invalid\r\n' +
      'To: Első Címzett <cimzett1@example.invalid>, cimzett2@example.invalid\r\nCc: Másolat Kati <cc@example.invalid>\r\nBcc: rejtett@example.invalid\r\n' +
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\n` +
      'Message-ID: <regi-azonosito@example.invalid>\r\nIn-Reply-To: <elozo@example.invalid>\r\nReferences: <elozo@example.invalid>\r\n' +
      'X-Mailer: ShadowMail\r\nX-ShadowMail-Forward-Of: <eredeti@example.invalid>\r\nDate: Fri, 20 Nov 2026 10:00:00 +0100\r\nMIME-Version: 1.0\r\n' +
      'Content-Type: multipart/mixed; boundary="M"\r\n\r\n--M\r\nContent-Type: multipart/related; boundary="R"\r\n\r\n' +
      `--R\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html}\r\n` +
      `--R\r\nContent-Type: image/png\r\nContent-ID: <kep1@minta>\r\nContent-Disposition: inline; filename="kep.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(PNG)}\r\n--R--\r\n` +
      `--M\r\nContent-Type: application/pdf; name="szamla.pdf"\r\nContent-Disposition: attachment; filename="szamla.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(PDF)}\r\n--M--\r\n`,
  )
}

const received = []
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN', 'LOGIN'], logger: false,
  onAuth: (a, _s, cb) => cb(null, { user: a.username }),
  onData(stream, session, cb) {
    const chunks = []
    stream.on('data', c => chunks.push(c))
    stream.on('end', () => (received.push({ from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map(r => r.address), raw: Buffer.concat(chunks) }), cb()))
  },
})
smtp.on('error', () => {})
await new Promise(r => smtp.listen(0, '127.0.0.1', r))

const pop = await new FakePop3Server().listen()
pop.add(Buffer.from(`From: Valaki <valaki@example.invalid>\r\nTo: ${SECOND}\r\nSubject: Egy levél\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <egy@example.invalid>\r\n\r\nSzia.\r\n`))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-e1-e2e-'))
const dataDir = path.join(work, 'data')
// the files: names a log must never show
const files = path.join(work, 'Bizalmas Ügyfél mappa')
fs.mkdirSync(dataDir)
fs.mkdirSync(files)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const smtpCols = { smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none' }
  store.save({ ...newAccountDefaults('pop3'), name: 'Első fiók', email: FIRST, display_name: 'Első Fiók', in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass, ...smtpCols })
  store.save({ ...newAccountDefaults('pop3'), name: 'Második fiók', email: SECOND, display_name: 'Kovács Árpád', in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass, ...smtpCols })
  db.close()
}
const file = (name, bytes) => {
  const p = path.join(files, name)
  fs.writeFileSync(p, bytes)
  return p
}
const template = file('Kovács Béla ajánlat.eml', templateEml())
const hostile = file('Gyanús levél.eml', templateEml({
  subject: 'Ellenséges',
  html: '<style>p{color:red}</style><script>alert(1)</script><p onclick="alert(2)">Szia<img src="x" onerror="alert(3)"></p><p><img src="https://evil.example/pixel.gif"></p><p><a href="javascript:alert(4)">katt</a></p><p style="background:url(https://evil.example/bg)">bg</p>',
}))
const pdfFile = file('Titkos szerződés.pdf', PDF)
const broken = file('Sérült üzenet.eml', PNG)
const bigFile = path.join(files, 'Óriás archívum.eml')
{
  const fd = fs.openSync(bigFile, 'w')
  fs.writeSync(fd, 'Subject: nagy\r\n\r\n')
  fs.ftruncateSync(fd, 25 * 1024 * 1024 + 100)
  fs.closeSync(fd)
}
const six = [1, 2, 3, 4, 5, 6].map(n => file(`Sablon ${n}.eml`, templateEml({ subject: `Hatos ${n}` })))

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []
const BAD = /<script|onerror|onclick|evil\.example|javascript:|<style|alert\(/i
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  const button = page.locator('.compose-button')
  const composers = () => app.windows().filter(w => w.url().includes('#compose='))
  const waitComposers = async (n, ms = 15_000) => {
    for (const end = performance.now() + ms; performance.now() < end && composers().length < n; ) await page.waitForTimeout(100)
    return composers()
  }
  const closeAll = async () => {
    for (const w of composers()) await w.close().catch(() => {})
    for (let i = 0; i < 50 && composers().length; i++) await page.waitForTimeout(100)
  }
  const ready = async win => {
    await win.setViewportSize({ width: 900, height: 760 })
    await win.waitForFunction(() => document.querySelector('#compose-subject')?.value, null, { timeout: 15_000 })
    await win.waitForFunction(() => [...document.querySelectorAll('.editor img')].every(i => i.complete), null, { timeout: 10_000 }).catch(() => {})
  }
  const fieldsOf = win =>
    win.evaluate(() => ({
      from: document.querySelector('#compose-from').textContent,
      to: document.querySelector('#compose-to').value,
      cc: document.querySelector('#compose-cc')?.value ?? null,
      bcc: document.querySelector('#compose-bcc')?.value ?? null,
      bccShown: Boolean(document.querySelector('#compose-bcc') && document.querySelector('#compose-bcc').getClientRects().length),
      subject: document.querySelector('#compose-subject').value,
      html: document.querySelector('.editor').innerHTML,
      images: [...document.querySelectorAll('.editor img')].map(i => ({ src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight })),
      attachments: [...document.querySelectorAll('.compose-attachments li.attachment-chip')].map(li => li.dataset.filename),
    }))
  const errorText = () => page.locator('.action-error').textContent({ timeout: 5000 }).catch(() => null)
  const noticeText = () => page.locator('.action-notice').textContent({ timeout: 5000 }).catch(() => null)
  const clearBanners = async () => {
    for (const sel of ['.action-error', '.action-notice']) if (await page.locator(sel).count()) await page.locator(sel).getByRole('button', { name: t.close }).click()
  }

  // the second account's inbox selected: it is the From of every composer below
  const second = page.locator('.folder-tree section', { hasText: 'Második fiók' })
  await second.locator('.folder[data-path="INBOX"]').click()
  await page.locator('.msg-row', { hasText: 'Egy levél' }).first().waitFor({ timeout: 20_000 })

  // 1. the light
  const light = await button.evaluate(el => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'a.eml', { type: 'message/rfc822' }))
    const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
    el.dispatchEvent(ev)
    return { taken: ev.defaultPrevented }
  })
  await page.waitForTimeout(100)
  const lit = await button.evaluate(el => el.classList.contains('drop-eml') && getComputedStyle(el).outlineStyle === 'solid')
  await button.evaluate(el => el.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body, dataTransfer: new DataTransfer() })))
  await page.waitForTimeout(100)
  const off = await button.evaluate(el => !el.classList.contains('drop-eml'))
  check('a file drag over "New message": taken, the button lights up (an outline), leaving takes it away', light.taken && lit && off, JSON.stringify({ ...light, lit, off }))
  const list = await button.evaluate(el => {
    const dt = new DataTransfer()
    dt.setData('application/x-shadowmail-ids', '[1]')
    const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
    el.dispatchEvent(ev)
    return { taken: ev.defaultPrevented, lit: el.classList.contains('drop-eml') }
  })
  check('a message drag (the list\'s own) over the button: not taken, no light', !list.taken && !list.lit, JSON.stringify(list))

  // 2. the template
  const drop1 = await dropFiles(page, [template], button)
  let [win] = await waitComposers(1)
  check('the template dropped: taken, one composer', drop1.accepted && composers().length === 1, `${JSON.stringify(drop1)} ${composers().length}`)
  await ready(win)
  const f = await fieldsOf(win)
  check('From = the selected (second) account', f.from.includes(SECOND) && !f.from.includes(FIRST), f.from)
  check('To, Cc and subject from the file', f.to.includes('cimzett1@example.invalid') && f.to.includes('cimzett2@example.invalid') && (f.cc || '').includes('cc@example.invalid') && f.subject === SUBJECT, JSON.stringify({ to: f.to, cc: f.cc, subject: f.subject }))
  check('Bcc from the file, shown', f.bccShown && f.bcc === 'rejtett@example.invalid', JSON.stringify({ bcc: f.bcc, shown: f.bccShown }))
  check('the body, and the embedded image visible as the session\'s own', f.html.includes('mindenki') && f.images.length === 1 && f.images[0].src.startsWith('inl-img://session/') && f.images[0].w === 48 && f.images[0].h === 32, JSON.stringify(f.images))
  check('the PDF in the attachment bar (the image is not attached again)', JSON.stringify(f.attachments) === JSON.stringify(['szamla.pdf']), JSON.stringify(f.attachments))
  {
    const closed = win.waitForEvent('close', { timeout: 30_000 })
    await win.getByRole('button', { name: t.composeSend, exact: true }).click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
  }
  for (let i = 0; i < 100 && received.length === 0; i++) await page.waitForTimeout(100)
  const sent = received[0]
  if (sent) {
    const head = sent.raw.toString('latin1').split('\r\n\r\n')[0]
    const mail = await simpleParser(sent.raw, { keepCidLinks: true })
    const inline = mail.attachments.filter(a => a.cid)
    const pdf = mail.attachments.find(a => a.filename === 'szamla.pdf')
    check('sent from the second account to To, Cc and Bcc', sent.from === SECOND && ['cc@example.invalid', 'cimzett1@example.invalid', 'cimzett2@example.invalid', 'rejtett@example.invalid'].every(a => sent.to.includes(a)), JSON.stringify({ from: sent.from, to: sent.to }))
    check('sent: a new Message-ID', /^Message-ID: </im.test(head) && !head.includes('regi-azonosito'), (head.match(/^Message-ID:.*$/im) || [''])[0])
    check('sent: no In-Reply-To, References, Reply-To, Bcc or X-ShadowMail-Forward-Of from the file', !/^(In-Reply-To|References|Reply-To|Bcc|X-ShadowMail-Forward-Of):/im.test(head) && !/elozo@|valasz@|regi@/.test(head), head.split('\r\n').filter(l => /^(In-Reply-To|References|Reply-To|Bcc|X-)/i.test(l)).join(' | '))
    check('sent: the PDF and the image byte for byte', Boolean(pdf && pdf.content.equals(PDF)) && inline.length === 1 && inline[0].content.equals(PNG) && mail.html.includes(`cid:${inline[0].cid}`), `${inline.length} inline`)
  } else check('the SMTP server got the message', false, 'nothing received')

  // 3. hostile
  await dropFiles(page, [hostile], button)
  ;[win] = await waitComposers(1)
  if (win) {
    await ready(win)
    const h = await fieldsOf(win)
    check('a hostile .eml: nothing of its script, handlers, external images, style or javascript: link in the composer', !BAD.test(h.html) && h.html.includes('Szia') && h.html.includes('katt'), h.html.slice(0, 200))
    const closed = win.waitForEvent('close', { timeout: 30_000 })
    await win.getByRole('button', { name: t.composeSend, exact: true }).click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
    for (let i = 0; i < 100 && received.length < 2; i++) await page.waitForTimeout(100)
    check('a hostile .eml: nothing of it in the message sent', received.length === 2 && !BAD.test(received[1].raw.toString('utf8')), `${received.length} received`)
  } else check('a hostile .eml: a composer', false)

  // 4. errors
  const errorCase = async (name, p, text) => {
    await clearBanners()
    const before = app.windows().length
    await dropFiles(page, [p], button)
    const got = await errorText()
    await page.waitForTimeout(500)
    check(`${name}: its own error text, no composer`, got === text && app.windows().length === before, JSON.stringify(got))
  }
  await errorCase('over 25 MB', bigFile, t.emlDrop.error('eml_too_large', { bytes: 25 * 1024 * 1024 + 100, max: 25 * 1024 * 1024 }))
  await errorCase('a PDF', pdfFile, t.emlDrop.error('not_eml', {}))
  await errorCase('a broken .eml', broken, t.emlDrop.error('eml_unreadable', {}))
  await clearBanners()

  // 5. six at once
  await dropFiles(page, six, button)
  const five = await waitComposers(5)
  await page.waitForTimeout(1500)
  const notice = await noticeText()
  check('six files at once: five composers', composers().length === 5, `${five.length} -> ${composers().length}`)
  check('six files at once: one notice', notice === t.emlDrop.tooMany(1, 5) && (await page.locator('.action-error').count()) === 0, JSON.stringify(notice))
  const subjects = await Promise.all(composers().map(async w => (await ready(w), w.locator('#compose-subject').inputValue())))
  check('six files at once: the first five, each once', JSON.stringify(subjects.sort()) === JSON.stringify(['Hatos 1', 'Hatos 2', 'Hatos 3', 'Hatos 4', 'Hatos 5']), JSON.stringify(subjects))
  await closeAll()
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  await app.close().catch(() => {})
  await pop.close()
  await new Promise(r => smtp.close(r))
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
const emlLines = mainLog.split('\n').filter(l => l.includes('compose: eml'))
check('the main log: the eml lines with code and size only', emlLines.length >= 3 && emlLines.every(l => /compose: eml (opened \(\d+ bytes\)|not opened \([a-z_]+(, \d+ bytes)?\))$/.test(l.trim())), emlLines.join(' | '))
const leaks = ['Bizalmas', 'Kovács Béla', 'Gyanús', 'Titkos', 'Sérült', 'Óriás', 'Sablon ', files, '.eml', '.pdf'].filter(s => mainLog.includes(s))
check('the main log: no file name or path', leaks.length === 0, leaks.join(', '))
const errLines = mainLog.trim().split('\n').filter(l => /failed|error/i.test(l))
check('the main log: no error or failure line', errLines.length === 0, errLines.join(' | '))
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
