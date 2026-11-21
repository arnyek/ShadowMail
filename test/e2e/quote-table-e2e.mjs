#!/usr/bin/env node
// A table in a reply's and a forward's quote, in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/quote-table-e2e.mjs          (E2E_LANG=en: the same in English)
//
// One POP3 account (fake POP3 server), one local SMTP server; in INBOX one HTML message with a table written as the
// Chromium writes a copied one (no space or line between the cells: "</th><td>"), a caption, header cells, a nested table.
// 1. Reply: in the quote no <table>, each row a line of its own, the cells one space apart, a header cell bold, the
//    caption the first line. Sent: the HTML has no <table>, the text/plain part has each row on a line of its own, and
//    no two cells run together.
// 2. Forward: the same in its quote and in the sent mail.
// 3. A second message, a table nested 1000 deep: the reply's composer is ready with the innermost text within DEEP_MS
//    (jsdom's sanitizing of deep nesting is superlinear, so its time is measured here, in this Chromium).
// The renderer console has no error or warning, the main log no error line, the net-guard log is empty.
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
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-idezettabla'
const ME = { name: 'A-fiók', email: 'a@example.invalid', display: 'Anna Táblás' }
const SUBJECT_IN = 'Utalási adatok táblázatban'
const SUBJECT_DEEP = 'Mélyen beágyazott táblázat'
const DEEP_MS = 3000
const DEEP_LEVELS = Number(process.env.DEEP_LEVELS || 1000)

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

// the lines a reader sees, in order (the caption first, the nested table's row after its row's own line)
const LINES = ['Utalás', 'Kedvezményezett neve: Példa Kft', 'Számlaszám: 11111111-22222222', 'Összeg: 12 500 Ft', 'Tétel Ár', 'belső1 belső2']
const TABLE =
  // no style attribute: the main window's reader writes a CSP console line for every styled element (known, not this
  // card's; the composer's own paste has its own e2e for that)
  '<table><caption>Utalás</caption><tbody>' +
  '<tr><th>Kedvezményezett neve:</th><td>Példa Kft</td></tr>' +
  '<tr><th>Számlaszám:</th><td>11111111-22222222</td></tr>' +
  '<tr><th>Összeg:</th><td>12 500 Ft</td></tr>' +
  '<tr><td>Tétel</td><td>Ár<table><tr><td>belső1</td><td>belső2</td></tr></table></td></tr>' +
  '</tbody></table>'
// two cells run together (what the quote showed before)
const RUN_TOGETHER = ['neve:Példa', 'Számlaszám:1111', 'Összeg:12', 'TételÁr', 'belső1belső2']

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
    messageId: '<tablas-1@example.invalid>',
    date: new Date(Date.UTC(2026, 10, 19, 8, 0, 0)),
    html: `<p>Az utalás adatai:</p>${TABLE}<p>Üdv, Ödön</p>`,
    text: 'Az utalás adatai. Üdv, Ödön',
  }).compile().build(),
)
pop.add(
  await new MailComposer({
    from: 'Ügyfél Ödön <ugyfel@example.invalid>',
    to: `${ME.display} <${ME.email}>`,
    subject: SUBJECT_DEEP,
    messageId: '<tablas-2@example.invalid>',
    date: new Date(Date.UTC(2026, 10, 19, 9, 0, 0)),
    html: `<p>Mély:</p>${'<table><tr><td>'.repeat(DEEP_LEVELS)}legbelso${'</td></tr></table>'.repeat(DEEP_LEVELS)}`,
    text: 'Mély',
  }).compile().build(),
)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-quote-table-e2e-'))
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
const sentMail = async (page, n) => {
  for (let i = 0; i < 75 && received.length < n; i++) await page.waitForTimeout(200)
  return received[n - 1] ? simpleParser(received[n - 1], { keepCidLinks: true }) : null
}
// the editor as a reader sees it: its lines (innerText), whether a <table> is left, the bold texts
const editorView = win =>
  win.evaluate(() => {
    const ed = document.querySelector('.editor')
    return {
      lines: ed.innerText.split('\n').map(l => l.trim()).filter(Boolean),
      tables: ed.querySelectorAll('table').length,
      bold: [...ed.querySelectorAll('b, strong')].map(b => b.textContent.trim()),
    }
  })
// the lines in order, each a line of its own (a quote marker "> " before them is allowed)
const inOrder = (lines, want) => {
  let at = -1
  for (const w of want) {
    const i = lines.findIndex((l, k) => k > at && l.replace(/^(?:>\s?)+/, '').trim() === w)
    if (i < 0) return false
    at = i
  }
  return true
}

try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`main ${m.type()}: ${m.text()}`))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row', { hasText: SUBJECT_IN }).waitFor({ timeout: 20_000 })
  await page.locator('.msg-row', { hasText: SUBJECT_IN }).click()
  await page.locator('.reader-tools').waitFor({ timeout: 10_000 })
  const openMessage = async subject => {
    // the open message may stand in the list's place: back to the list first
    if (await page.locator('.reader-back').count()) await page.locator('.reader-back').click()
    await page.locator('.msg-row', { hasText: subject }).click()
    await page.locator('.reader-tools').waitFor({ timeout: 10_000 })
  }
  const fromReader = async (name, ready = '11111111') => {
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name, exact: true }).click()])
    win.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`composer ${m.type()}: ${m.text()}`))
    await win.setViewportSize({ width: 1100, height: 760 })
    await win.locator('.editor').waitFor()
    await win.waitForFunction(text => document.querySelector('.editor')?.innerText.includes(text), ready, { timeout: 15_000 })
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
  const sentChecks = (label, mail) => {
    if (!mail) return check(`${label} sent`, false, 'nothing arrived')
    const text = mail.text.split(/\r?\n/)
    check(`${label} sent: the HTML has no <table>`, !/<table/i.test(mail.html), mail.html.slice(0, 200))
    check(`${label} sent: text/plain has each row on a line of its own, in order`, inOrder(text, LINES), JSON.stringify(text.filter(l => /Példa|1111|12 500|Tétel|belső|Utalás/.test(l))))
    check(`${label} sent: no two cells run together (HTML and text)`, RUN_TOGETHER.every(r => !mail.text.includes(r) && !mail.html.includes(r)), RUN_TOGETHER.filter(r => mail.text.includes(r) || mail.html.includes(r)).join(', '))
  }

  // 1. reply, 2. forward
  for (const [n, mode, to] of [[1, 'reply', null], [2, 'forward', 'masik@example.invalid']]) {
    const w = await fromReader(t.replyModes[mode])
    const v = await editorView(w)
    check(`${mode}: no <table> in the quote`, v.tables === 0, String(v.tables))
    check(`${mode}: each row a line of its own, the cells one space apart, the caption first`, inOrder(v.lines, LINES), JSON.stringify(v.lines.filter(l => /Példa|1111|12 500|Tétel|belső|Utalás/.test(l))))
    check(`${mode}: the header cells bold`, ['Kedvezményezett neve:', 'Számlaszám:', 'Összeg:'].every(b => v.bold.includes(b)), JSON.stringify(v.bold))
    check(`${mode}: no two cells run together in the quote`, RUN_TOGETHER.every(r => !v.lines.some(l => l.includes(r))), RUN_TOGETHER.filter(r => v.lines.some(l => l.includes(r))).join(', '))
    await send(w, to)
    sentChecks(mode, await sentMail(page, n))
  }

  // 3. the deeply nested table
  await openMessage(SUBJECT_DEEP)
  const t0 = performance.now()
  const [deep] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name: t.replyModes.reply, exact: true }).click()])
  deep.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`composer ${m.type()}: ${m.text()}`))
  const ready = await deep.waitForFunction(() => document.querySelector('.editor')?.innerText.includes('legbelso'), null, { timeout: 15_000 }).then(() => true, () => false)
  const ms = performance.now() - t0
  const dv = await deep.evaluate(() => {
    const ed = document.querySelector('.editor')
    return ed ? { chars: ed.textContent.length, head: ed.innerText.slice(0, 160), tables: ed.querySelectorAll('table').length, divs: ed.querySelectorAll('div').length } : null
  }).catch(e => ({ error: String(e).slice(0, 120) }))
  check(`deep table (${DEEP_LEVELS} levels): the reply's composer ready with the innermost text within ${DEEP_MS} ms, no <table>`, ready && ms <= DEEP_MS && dv && dv.tables === 0, `${Math.round(ms)} ms, ${JSON.stringify(dv)}`)
  if (!deep.isClosed()) await deep.close()
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  await app.close().catch(() => {})
  await pop.close()
  await new Promise(r => smtp.close(r))
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
const guard = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
const guardText = fs.existsSync(guard) ? fs.readFileSync(guard, 'utf8').trim() : ''
check('net-guard log: no outgoing request', guardText === '', guardText.split('\n').slice(0, 3).join(' | '))
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
