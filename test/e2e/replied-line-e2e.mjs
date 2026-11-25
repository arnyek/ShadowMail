#!/usr/bin/env node
// The reader's "You replied: <date>" / "You forwarded this" line in the real app, headless Electron + Playwright.
// Not part of `npm test`.
//
//   E2E_LANG=hu|en node test/e2e/replied-line-e2e.mjs [--shots <dir>]
//
// A POP3 account (fake POP3 server: two received messages) and a local smtp-server for its SMTP side; the replies are
// sent from the app, so the reply rows are the account's own local Sent copies. Nothing leaves the machine.
// Measured: no line without a flag; after a reply sent from the open reader the line appears without reopening, with
// the reply's date (list form, the full date in the title) as a link that opens that reply; after a second reply the
// latest date and the count in the title; after a forward "replied · forwarded" on one line; a forward-only message
// shows only the forwarded part; with the replies deleted from Sent "You replied" without a date or a link;
// no Content-Security-Policy line on the console.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SMTPServer } from 'smtp-server'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, locale, seedLanguage } from './lang.mjs'

const { values } = parseArgs({ options: { shots: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-valaszsor'
const ME = 'teszt@example.invalid'

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

// the reader's own formats (list-format.js): the replies are sent today, so the list form is the time
const timeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
const fullFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' })

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

const mail = (id, subject, body, minutesAgo) => Buffer.from([
  'From: Kovács Anna <anna@example.invalid>',
  `To: Teszt Elek <${ME}>`,
  `Subject: ${subject}`,
  `Date: ${new Date(Date.now() - minutesAgo * 60_000).toUTCString()}`,
  `Message-ID: <${id}@example.invalid>`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  body,
  '',
].join('\r\n'))
const pop = await new FakePop3Server().listen()
pop.add(mail('valasz-1', 'Ajanlatkeres', 'Kérem az árajánlatot.', 30))
pop.add(mail('tovabb-1', 'Csak tovabbitom', 'Ezt csak továbbítom.', 20))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-replied-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let accountId
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  accountId = store.save({
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: ME, display_name: 'Teszt Elek',
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none',
  }).account.id
  db.close()
}
if (values.shots) fs.mkdirSync(values.shots, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
const cspLines = []

async function reply(page, body) {
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name: t.replyModes.reply, exact: true }).click()])
  win.on('console', m => /Content Security Policy|Content-Security-Policy/i.test(m.text()) && cspLines.push(m.text()))
  await win.setViewportSize({ width: 900, height: 700 })
  await win.waitForFunction(() => document.querySelector('#compose-subject')?.value)
  await win.locator('.editor').click()
  await win.keyboard.press('Control+Home')
  await win.keyboard.type(body)
  await Promise.all([win.waitForEvent('close'), win.getByRole('button', { name: t.composeSend, exact: true }).click()])
}

/** The Sent rows answering <valasz-1>, newest first: { id, date } (the line's own rule). */
async function replies(page) {
  const rows = (await page.evaluate(async id => (await window.shadowMail.mail.list({ accountId: id, folder: 'Sent' })).rows, accountId))
  return rows.sort((a, b) => b.date - a.date || b.id - a.id)
}

async function openOriginal(page, subject) {
  // the default layout shows the reader in place of the list: back to the list first
  if (await page.locator('.reader-back').count()) await page.locator('.reader-back').click()
  await page.locator('.msg-row', { hasText: subject }).click({ timeout: 20_000 })
  await page.locator('.reader-subject', { hasText: subject }).waitFor()
  await page.locator('.reader .mail-text').waitFor()
}

try {
  const page = await app.firstWindow()
  page.on('console', m => /Content Security Policy|Content-Security-Policy/i.test(m.text()) && cspLines.push(m.text()))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await openOriginal(page, 'Ajanlatkeres')
  const line = page.locator('.reader-replied')

  // 1. no flag: no line
  check('no \\Answered / $Forwarded: no line', (await line.count()) === 0)

  // 2. a reply from the open reader: the line appears without reopening
  await reply(page, 'Első válasz.')
  await line.locator('[data-part="replied"] .reader-replied-open').waitFor({ timeout: 5_000 }).catch(() => {})
  let rs = await replies(page)
  let link = line.locator('[data-part="replied"] .reader-replied-open')
  check('after the reply, without reopening: the replied part with a link', (await link.count()) === 1 && rs.length === 1, `${await line.count()} line, ${rs.length} in Sent`)
  check('the link: the reply date in the list form, the full date in the title',
    (await link.innerText()) === timeFmt.format(new Date(rs[0].date)) && (await link.getAttribute('title')) === fullFmt.format(new Date(rs[0].date)),
    `${await link.innerText()} | ${await link.getAttribute('title')}`)
  check('the replied text', (await line.locator('[data-part="replied"]').innerText()).replace(/\s+/g, ' ').trim() === `${t.repliedLine.on.trim()} ${timeFmt.format(new Date(rs[0].date))}`, await line.locator('[data-part="replied"]').innerText())
  check('no forwarded part yet', (await line.locator('[data-part="forwarded"]').count()) === 0)
  if (values.shots) await page.locator('.reader-head, .reader').first().screenshot({ path: path.join(values.shots, 'replied-one.png') })

  // 3. the link opens the reply
  await link.click()
  await page.locator('.reader-subject', { hasText: /^Re: Ajanlatkeres$/ }).waitFor({ timeout: 5_000 }).catch(() => {})
  const opened = await page.locator('.reader-subject').innerText()
  const frameText = await page.frameLocator('.mail-frame iframe, iframe.mail-frame').first().locator('body').innerText({ timeout: 5_000 }).catch(() => page.locator('.reader-body').innerText())
  check('the link opens the reply in the reader', /^(Re|AW|Vá): Ajanlatkeres$/i.test(opened) && /Első válasz\./.test(frameText), `${opened} | ${frameText.slice(0, 60).replace(/\n/g, ' ')}`)

  // 4. a second reply: the latest date, the count in the title, the link opens the latest
  await openOriginal(page, 'Ajanlatkeres')
  await reply(page, 'Második válasz.')
  for (let i = 0; i < 50 && (rs = await replies(page)).length < 2; i++) await page.waitForTimeout(100)
  const wantTitle = t.repliedLine.many(2, fullFmt.format(new Date(rs[0].date)))
  await page.waitForFunction(w => document.querySelector('.reader-replied-open')?.title === w, wantTitle, { timeout: 5_000 }).catch(() => {})
  link = line.locator('[data-part="replied"] .reader-replied-open')
  check('two replies: the latest date, the count in the title', rs.length === 2 &&
    (await link.innerText()) === timeFmt.format(new Date(rs[0].date)) && (await link.getAttribute('title')) === t.repliedLine.many(2, fullFmt.format(new Date(rs[0].date))),
    `${rs.length} | ${await link.innerText()} | ${await link.getAttribute('title')}`)
  await link.click()
  await page.locator('.reader-subject', { hasText: /^Re: Ajanlatkeres$/ }).waitFor({ timeout: 5_000 }).catch(() => {})
  const latestText = await page.frameLocator('.mail-frame iframe, iframe.mail-frame').first().locator('body').innerText({ timeout: 5_000 }).catch(() => page.locator('.reader-body').innerText())
  check('the link opens the latest reply', /Második válasz\./.test(latestText), latestText.slice(0, 60).replace(/\n/g, ' '))

  // 5. a forward too: one line, the replied part first, a separator, then "You forwarded this"
  await openOriginal(page, 'Ajanlatkeres')
  {
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name: t.replyModes.forward, exact: true }).click()])
    await win.setViewportSize({ width: 900, height: 700 })
  await win.waitForFunction(() => document.querySelector('#compose-subject')?.value)
    await win.locator('#compose-to').fill('Valaki <valaki@example.invalid>')
    await Promise.all([win.waitForEvent('close'), win.getByRole('button', { name: t.composeSend, exact: true }).click()])
  }
  await line.locator('[data-part="forwarded"]').waitFor({ timeout: 5_000 }).catch(() => {})
  const parts = await line.locator('[data-part]').evaluateAll(els => els.map(e => e.dataset.part))
  check('replied and forwarded: one line, replied first, then forwarded', (await line.count()) === 1 && parts.join(',') === 'replied,forwarded', parts.join(','))
  check('the separator between them', (await line.locator('.reader-replied-sep').count()) === 1 && (await line.locator('.reader-replied-sep').getAttribute('aria-hidden')) === 'true')
  check('the forwarded text, no date', (await line.locator('[data-part="forwarded"]').innerText()).trim() === t.repliedLine.forwarded && (await line.locator('[data-part="forwarded"] button').count()) === 0)
  if (values.shots) await page.locator('.reader').first().screenshot({ path: path.join(values.shots, 'replied-forwarded.png') })

  // 6. a forward only
  await openOriginal(page, 'Csak tovabbitom')
  check('the other message: no line yet', (await line.count()) === 0)
  {
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name: t.replyModes.forward, exact: true }).click()])
    await win.setViewportSize({ width: 900, height: 700 })
  await win.waitForFunction(() => document.querySelector('#compose-subject')?.value)
    await win.locator('#compose-to').fill('Valaki <valaki@example.invalid>')
    await Promise.all([win.waitForEvent('close'), win.getByRole('button', { name: t.composeSend, exact: true }).click()])
  }
  await line.locator('[data-part="forwarded"]').waitFor({ timeout: 5_000 }).catch(() => {})
  check('forward only: only the forwarded part', (await line.locator('[data-part]').evaluateAll(els => els.map(e => e.dataset.part))).join(',') === 'forwarded' && (await line.locator('.reader-replied-sep').count()) === 0)

  // 7. the replies deleted from Sent (permanently): "You replied", no date, no link
  rs = await replies(page)
  const replyIds = []
  for (const r of rs) if (/Ajanlatkeres/.test(r.subject) && !/^(Fwd|Tov)/i.test(r.subject)) replyIds.push(r.id)
  const del = await page.evaluate(async ids => window.shadowMail.mail.action({ ids, action: 'delete', permanent: true }), replyIds)
  await openOriginal(page, 'Ajanlatkeres')
  await page.waitForTimeout(300)
  const repliedPart = line.locator('[data-part="replied"]')
  check('replies gone from Sent: "You replied", no date, no link', replyIds.length === 2 && del && del.ok !== false &&
    (await repliedPart.innerText()).trim() === t.repliedLine.none && (await repliedPart.locator('button').count()) === 0,
    `${replyIds.length} ${JSON.stringify(del)} | ${await repliedPart.innerText().catch(() => '-')}`)
  check('the forwarded part stays', (await line.locator('[data-part="forwarded"]').count()) === 1)

  check('no Content-Security-Policy line on the console', cspLines.length === 0, cspLines.slice(0, 2).join(' | '))
} catch (err) {
  check('run', false, err.stack.split('\n')[0])
  if (values.shots) await (await app.firstWindow()).screenshot({ path: path.join(values.shots, 'failure.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
  await pop.close()
  smtp.close(() => {})
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
