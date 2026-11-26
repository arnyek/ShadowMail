#!/usr/bin/env node
// Reply, reply all, forward in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/reply-e2e.mjs [--shot <file.png>]
//
// A POP3 account (fake POP3 server: one received message with Cc and two attachments) and a local
// smtp-server for its SMTP side. Nothing leaves the machine.
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
import { t, seedLanguage } from './lang.mjs'

const { values } = parseArgs({ options: { shot: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-valasz'
const ME = 'teszt@example.invalid'
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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
    stream.on('end', () => (received.push({ to: session.envelope.rcptTo.map(r => r.address), raw: Buffer.concat(chunks) }), cb()))
  },
})
smtp.on('error', () => {})
await new Promise(r => smtp.listen(0, '127.0.0.1', r))

const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(10_000)])
const original = Buffer.from([
  'From: Kovács Anna <anna@example.invalid>',
  `To: Teszt Elek <${ME}>, Nagy Béla <bela@example.invalid>`,
  'Cc: Kiss Cili <cili@example.invalid>',
  'Subject: =?utf-8?q?Aj=C3=A1nlat_k=C3=A9r=C3=A9s?=',
  `Date: ${new Date().toUTCString()}`,
  'Message-ID: <eredeti-1@example.invalid>',
  'References: <korabbi-0@example.invalid>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="B"',
  '',
  '--B',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  'Kérem az árajánlatot a kazáncseréhez.',
  '--B',
  'Content-Type: application/pdf; name="alaprajz.pdf"',
  'Content-Disposition: attachment; filename="alaprajz.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  pdf.toString('base64').replace(/.{76}/g, '$&\r\n'),
  '--B--',
  '',
].join('\r\n'))
const pop = await new FakePop3Server().listen()
pop.add(original)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-k9-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let accountId
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER) // vault.json + the encrypted mail.sqlite
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  accountId = store.save({
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: ME, display_name: 'Teszt Elek', signature: 'Üdv: Teszt Elek',
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none',
  }).account.id
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })

async function compose(page, button) {
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name: button, exact: true }).click()])
  await win.setViewportSize({ width: 900, height: 700 })
  await win.waitForFunction(() => document.querySelector('#compose-subject')?.value)
  return win
}

try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row', { hasText: 'Ajánlat kérés' }).click({ timeout: 20_000 })
  await page.locator('.reader .mail-text').waitFor()
  // the list row's mark (replied / forwarded: one icon at the sender cell's end, its place is reply-marks-e2e's), and a
  // mark on the page that a reload would lose
  const rowMarks = () => page.locator('.msg-row', { hasText: 'Ajánlat kérés' }).evaluate(r => {
    const m = r.querySelector('.reply-marks')
    return m ? { icons: [...m.querySelectorAll('svg')].map(s => s.getAttribute('data-icon')), title: m.getAttribute('title') } : null
  })
  check('before the reply: no replied / forwarded mark on the row', (await rowMarks()) === null)
  await page.evaluate(() => { window.__noReload = true })

  // reply
  let win = await compose(page, t.replyModes.reply)
  const editorText = await win.locator('.editor').innerText()
  check('reply: To the sender, "Re:", the quote with its header line, signature above it',
    (await win.locator('#compose-to').inputValue()) === 'Kovács Anna <anna@example.invalid>' &&
    (await win.locator('#compose-subject').inputValue()) === 'Re: Ajánlat kérés' &&
    new RegExp(`Üdv: Teszt Elek[\\s\\S]*${reEsc(t.outgoingQuote.wrote('Kovács Anna <anna@example.invalid>'))}[\\s\\S]*Kérem az árajánlatot`).test(editorText), editorText.replace(/\n/g, ' | '))
  check('reply: no attachments', (await win.locator('.compose-attachments li').count()) === 0)
  if (values.shot) await win.screenshot({ path: values.shot })
  await win.locator('.editor').click()
  await win.keyboard.press('Control+Home')
  await win.keyboard.type('Küldöm hétfőn.')
  await Promise.all([win.waitForEvent('close'), win.getByRole('button', { name: t.composeSend, exact: true }).click()])
  let got = await simpleParser(received[0].raw)
  check('reply: In-Reply-To and References', got.inReplyTo === '<eredeti-1@example.invalid>' && [].concat(got.references).join(' ') === '<korabbi-0@example.invalid> <eredeti-1@example.invalid>', `${got.inReplyTo} | ${got.references}`)
  check('reply: my text and the quote went out', /Küldöm hétfőn\./.test(got.text) && /<blockquote>/.test(got.html))
  await page.waitForTimeout(300)
  const flags = await page.evaluate(async id => (await window.shadowMail.mail.list({ accountId: id, folder: 'INBOX' })).rows[0].flags, accountId)
  check('reply: the original is \\Answered (POP3: here)', flags.split(' ').includes('\\Answered'), flags)
  await page.waitForFunction(() => document.querySelector('.msg-row .reply-marks svg[data-icon="reply"]'), null, { timeout: 5000 }).catch(() => {})
  const afterReply = await rowMarks()
  check('reply: the list row shows the reply mark at once, no reload', JSON.stringify(afterReply?.icons) === '["reply"]' && afterReply.title === t.replyMarks.answered && (await page.evaluate(() => window.__noReload === true)), JSON.stringify(afterReply))

  // reply all
  win = await compose(page, t.replyModes.replyAll)
  const to = await win.locator('#compose-to').inputValue()
  const cc = await win.locator('#compose-cc').inputValue()
  check('reply all: the others in To, Cc kept, my own address nowhere', to === 'Kovács Anna <anna@example.invalid>, Nagy Béla <bela@example.invalid>' && cc === 'Kiss Cili <cili@example.invalid>', `${to} | ${cc}`)
  await Promise.all([win.waitForEvent('close'), win.getByRole('button', { name: t.composeSend, exact: true }).click()])
  check('reply all: the envelope', JSON.stringify(received[1].to.sort()) === JSON.stringify(['anna@example.invalid', 'bela@example.invalid', 'cili@example.invalid']), JSON.stringify(received[1].to))

  // forward
  win = await compose(page, t.replyModes.forward)
  check('forward: "Fwd:", empty To, the original attachment listed, the header block in the body',
    (await win.locator('#compose-subject').inputValue()) === 'Fwd: Ajánlat kérés' && (await win.locator('#compose-to').inputValue()) === '' &&
    (await win.locator('.compose-attachments li[data-filename="alaprajz.pdf"]').count()) === 1 && new RegExp(`${reEsc(t.outgoingQuote.forwarded)}[\\s\\S]*${reEsc(t.outgoingQuote.labels.from)}: Kovács Anna`).test(await win.locator('.editor').innerText()))
  await win.locator('#compose-to').fill('Valaki <valaki@example.invalid>')
  await Promise.all([win.waitForEvent('close'), win.getByRole('button', { name: t.composeSend, exact: true }).click()])
  got = await simpleParser(received[2].raw)
  check('forward: the attachment byte for byte', got.attachments.length === 1 && got.attachments[0].filename === 'alaprajz.pdf' && sha(got.attachments[0].content) === sha(pdf), got.attachments.map(a => `${a.filename}:${sha(a.content)}`).join(','))
  await page.waitForTimeout(300)
  const flags2 = await page.evaluate(async id => (await window.shadowMail.mail.list({ accountId: id, folder: 'INBOX' })).rows[0].flags, accountId)
  check('forward: the original is $Forwarded too', flags2.split(' ').includes('$Forwarded') && flags2.split(' ').includes('\\Answered'), flags2)
  await page.waitForFunction(both => document.querySelector('.msg-row .reply-marks')?.getAttribute('title') === both, t.replyMarks.both, { timeout: 5000 }).catch(() => {})
  const afterForward = await rowMarks()
  check('forward: the list row\'s one mark (the reply icon) names both, no reload', JSON.stringify(afterForward?.icons) === '["reply"]' && afterForward.title === t.replyMarks.both && (await page.evaluate(() => window.__noReload === true)), JSON.stringify(afterForward))
  const sent = await page.evaluate(async id => (await window.shadowMail.mail.list({ accountId: id, folder: 'Sent' })).rows.map(r => r.subject), accountId)
  check('three copies in Sent', sent.length === 3, JSON.stringify(sent))
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
