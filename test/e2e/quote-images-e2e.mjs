#!/usr/bin/env node
// The original's embedded images in a reply's and a forward's quote, in the real app (headless Electron + Playwright,
// the real nativeImage). Not part of `npm test`.
//
//   node test/e2e/quote-images-e2e.mjs          (E2E_LANG=en: the same in English)
//
// One POP3 account (fake POP3 server), one local SMTP server; in INBOX one HTML message with an embedded 1000 x 50 PNG,
// an image no one refers to and a PDF; a second one whose HTML refers to its image in ANOTHER CASE than the Content-ID
// (and %-encoded), as some mail programs write it, and two parts whose Content-IDs differ only in case.
// 0. The reader: the second message's image shows in the frame (a decoded width), each of the pair shows its own, and
//    none of them is offered as an attachment.
// 1. Reply: the image in the quote as this session's image, shown (1000 px natural width); its size menu: Small ->
//    width="320". Sent: one inline part, our own cid, the PNG byte for byte, width="320"; no attachment.
// 2. Forward: the image in the quote; the attachment bar has only the PDF and the unreferred image. Sent: the image
//    once, embedded; the PDF and the other image as attachments.
// The renderer console has no error or warning, the main log no error line and no file name, the net-guard log is empty.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { pngFile } from '../helpers/inline-images.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-idezetkepek'
const ME = { name: 'A-fiók', email: 'a@example.invalid', display: 'Anna Képes' }
const SUBJECT_IN = 'Beágyazott képes levél'
const SUBJECT_CASE = 'Más írásmódú hivatkozás'

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

const LOGO = pngFile(1000, 50, { seed: 3 })
const OTHER = pngFile(60, 40, { seed: 4 })
const NAMES = ['beagyazott-logo-titok.png', 'nem-hivatkozott-titok.png', 'szerzodes-titok.pdf', 'masik-iras-titok.png', 'par-kis-titok.png', 'par-nagy-titok.png']

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
const pop = await new FakePop3Server().listen()
pop.add(
  await new MailComposer({
    from: 'Ügyfél Ödön <ugyfel@example.invalid>',
    to: `${ME.display} <${ME.email}>`,
    subject: SUBJECT_IN,
    messageId: '<kepes-1@example.invalid>',
    date: new Date(Date.UTC(2026, 10, 19, 8, 0, 0)),
    html: '<p>A logónk:</p><p><img src="cid:logo@ugyfel.invalid"></p><p>Üdv, Ödön</p>',
    text: 'A logónk. Üdv, Ödön',
    attachments: [
      { filename: NAMES[0], content: LOGO, contentType: 'image/png', cid: 'logo@ugyfel.invalid' },
      { filename: NAMES[1], content: OTHER, contentType: 'image/png', cid: 'other@ugyfel.invalid' },
      { filename: NAMES[2], content: Buffer.from('%PDF-1.4\n% e2e\n%%EOF\n'), contentType: 'application/pdf' },
    ],
  }).compile().build(),
)

pop.add(
  await new MailComposer({
    from: 'Ügyfél Ödön <ugyfel@example.invalid>',
    to: `${ME.display} <${ME.email}>`,
    subject: SUBJECT_CASE,
    messageId: '<kepes-2@example.invalid>',
    date: new Date(Date.UTC(2026, 10, 19, 9, 0, 0)),
    html: '<p>Másként írva:</p><p><img id="caseimg" src="cid:LOGO%40Ugyfel.Invalid"></p><p><img id="pairlow" src="cid:pair@ugyfel.invalid"><img id="pairup" src="cid:PAIR@ugyfel.invalid"></p>',
    text: 'Másként írva',
    attachments: [
      { filename: NAMES[3], content: OTHER, contentType: 'image/png', cid: 'logo@ugyfel.invalid' },
      { filename: NAMES[4], content: pngFile(30, 10, { seed: 5 }), contentType: 'image/png', cid: 'pair@ugyfel.invalid' },
      { filename: NAMES[5], content: pngFile(44, 10, { seed: 6 }), contentType: 'image/png', cid: 'PAIR@ugyfel.invalid' },
    ],
  }).compile().build(),
)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-quote-img-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({
    ...newAccountDefaults('pop3'), name: ME.name, email: ME.email, display_name: ME.display,
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none',
  })
  db.close()
}

const results = []
const consoleLines = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
const INL = /^inl-img:\/\/session\/([0-9a-f-]{36})\/[0-9a-f]{24}$/
const sentMail = async (page, n) => {
  for (let i = 0; i < 75 && received.length < n; i++) await page.waitForTimeout(200)
  return received[n - 1] ? simpleParser(received[n - 1], { keepCidLinks: true }) : null
}
const quoteImages = win =>
  win.evaluate(async () => {
    const imgs = [...document.querySelectorAll('.editor blockquote img, .editor img')]
    await Promise.all(imgs.map(i => (i.complete ? null : new Promise(r => (i.onload = i.onerror = r)))))
    return [...new Set(imgs)].map(i => ({ src: i.getAttribute('src'), natural: i.naturalWidth, width: i.getAttribute('width') }))
  })

try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`main ${m.type()}: ${m.text()}`))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  // 0. the reader: a reference in another case and %-encoded finds its part
  await page.locator('.msg-row', { hasText: SUBJECT_CASE }).waitFor({ timeout: 20_000 })
  await page.locator('.msg-row', { hasText: SUBJECT_CASE }).click()
  await page.locator('.reader-tools').waitFor({ timeout: 10_000 })
  let frame = null
  for (let i = 0; i < 50 && !frame; i++) {
    frame = page.frames().find(f => f.url().startsWith('mail-view://view/')) || null
    if (!frame) await page.waitForTimeout(100)
  }
  const width = frame ? await frame.waitForFunction(() => { const i = document.getElementById('caseimg'); return i && i.complete ? i.naturalWidth : 0 }, null, { timeout: 10_000 }).then(h => h.jsonValue(), () => 0) : 0
  check('reader: the image referred to in another case (and %-encoded) shows (its decoded width)', width === 60, `naturalWidth=${width}`)
  const pair = frame ? await frame.evaluate(() => ['pairlow', 'pairup'].map(id => document.getElementById(id).naturalWidth)) : []
  check('reader: two parts whose Content-IDs differ only in case each show their own image', JSON.stringify(pair) === '[30,44]', JSON.stringify(pair))
  const offered = await page.locator('.reader-attachments .attachment-card').evaluateAll(cs => cs.map(c => c.dataset.filename))
  check('reader: none of these embedded images is offered as an attachment', ![NAMES[3], NAMES[4], NAMES[5]].some(n => offered.includes(n)), JSON.stringify(offered))
  if (await page.locator('.reader-back').count()) await page.locator('.reader-back').click()

  await page.locator('.msg-row', { hasText: SUBJECT_IN }).waitFor({ timeout: 20_000 })
  await page.locator('.msg-row', { hasText: SUBJECT_IN }).click()
  await page.locator('.reader-tools').waitFor({ timeout: 10_000 })
  const fromReader = async name => {
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name, exact: true }).click()])
    win.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`composer ${m.type()}: ${m.text()}`))
    await win.setViewportSize({ width: 1100, height: 760 })
    await win.locator('.editor').waitFor()
    await win.waitForFunction(() => document.querySelector('.editor img'), null, { timeout: 15_000 })
    return win
  }
  const send = async (win, to) => {
    if (to) await win.locator('#compose-to').fill(to)
    const closed = win.waitForEvent('close', { timeout: 30_000 })
    await win.getByRole('button', { name: t.composeSend, exact: true }).click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
  }

  // 1. reply
  let w = await fromReader(t.replyModes.reply)
  let imgs = await quoteImages(w)
  check('reply: the original\'s embedded PNG in the quote, this session\'s image, shown at 1000 px', imgs.length === 1 && INL.test(imgs[0].src) && imgs[0].natural === 1000, JSON.stringify(imgs))
  check('reply: no attachment', (await w.locator('.compose-attachments .attachment-chip').count()) === 0)
  await w.locator('.editor img').first().click()
  const sizeMenu = w.getByRole('menu', { name: t.composeImageMenu.label })
  await sizeMenu.waitFor({ timeout: 10_000 })
  await sizeMenu.getByRole('menuitemradio', { name: t.composeImageMenu.small, exact: true }).click()
  await w.waitForFunction(() => document.querySelector('.editor img')?.getAttribute('width') === '320', null, { timeout: 10_000 })
  check('reply: the size menu works on the quote\'s image (Small -> width="320")', true)
  await send(w, null)
  let mail = await sentMail(page, 1)
  let inline = mail ? mail.attachments.filter(a => a.cid && mail.html.includes(`cid:${a.cid}`)) : []
  check('reply sent: one inline part, our own cid, the PNG byte for byte, width="320"; nothing else', mail && inline.length === 1 && /^img-[0-9a-f]{24}@shadowmail$/.test(inline[0].cid) && inline[0].content.equals(LOGO) && /width="320"/.test(mail.html) && mail.attachments.length === 1 && !/ugyfel\.invalid"/.test(mail.html), mail ? JSON.stringify({ parts: mail.attachments.map(a => [a.contentType, a.cid, a.filename]), html: mail.html.slice(0, 300) }) : 'nothing arrived')

  // 2. forward
  w = await fromReader(t.replyModes.forward)
  imgs = await quoteImages(w)
  check('forward: the embedded PNG in the quote', imgs.length === 1 && INL.test(imgs[0].src) && imgs[0].natural === 1000, JSON.stringify(imgs))
  const chips = await w.locator('.compose-attachments .attachment-chip').evaluateAll(cs => cs.map(c => c.dataset.filename).sort())
  check('forward: the attachment bar has only the PDF and the unreferred image', JSON.stringify(chips) === JSON.stringify([NAMES[1], NAMES[2]].sort()), JSON.stringify(chips))
  await send(w, 'masik@example.invalid')
  mail = await sentMail(page, 2)
  inline = mail ? mail.attachments.filter(a => a.cid && mail.html.includes(`cid:${a.cid}`)) : []
  const attached = mail ? mail.attachments.filter(a => !inline.includes(a)).map(a => a.filename).sort() : []
  check('forward sent: the image once, embedded; the PDF and the other image attached', mail && inline.length === 1 && inline[0].content.equals(LOGO) && JSON.stringify(attached) === JSON.stringify([NAMES[1], NAMES[2]].sort()) && mail.attachments.filter(a => a.content.equals(LOGO)).length === 1, JSON.stringify({ inline: inline.length, attached }))
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  await app.close().catch(() => {})
  await pop.close()
  await new Promise(r => smtp.close(r))
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
check('the main log: no file name', NAMES.every(n => !mainLog.includes(n)), NAMES.filter(n => mainLog.includes(n)).join(', '))
const guard = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
const guardText = fs.existsSync(guard) ? fs.readFileSync(guard, 'utf8').trim() : ''
check('net-guard log: no outgoing request', guardText === '', guardText.split('\n').slice(0, 3).join(' | '))
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
