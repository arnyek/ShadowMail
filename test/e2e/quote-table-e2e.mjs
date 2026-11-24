#!/usr/bin/env node
// A table in a reply's and a forward's quote keeps its grid and the original's formatting, in the real app (headless
// Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/quote-table-e2e.mjs          (E2E_LANG=en: the same in English)
//
// One POP3 account (fake POP3 server), one local SMTP server; in INBOX one HTML message formatted with its own <style>
// sheet (classes): a table written as the Chromium writes a copied one (no space or line between the cells:
// "</th><td>"), a caption, header cells with a background, cell borders, a coloured and a Georgia text, an element whose
// own style beats the sheet, a nested table; and hidden text (a display:none preheader, white on white).
// 1. Reply: the quote has the table as a table (the nested one too), the sheet's border, background, colour and font on
//    the elements, the own style over the sheet, the header cells bold, the rows and cells in order, no hidden text.
//    Sent: the HTML keeps the table and the formatting, no hidden text; the text/plain part has a line per row, the cells
//    one TAB apart.
// 2. Forward: the same in its quote and in the sent mail.
// 3. A table nested MID_LEVELS deep: the outer MAX_PASTE_TABLE_DEPTH levels stay tables, the ones past it come as lines,
//    the innermost text is there.
// 4. A table nested 1000 deep (past the reader's depth cut: the quote's old way, as lines): the reply's composer is ready
//    with the innermost text within DEEP_MS (jsdom's sanitizing of deep nesting is superlinear, so its time is measured
//    here, in this Chromium).
// 5. The 2000-block stylesheet newsletter (test/helpers/newsletter.js, 300 rules ending in a tag under a class): the
//    reply's composer is ready within NEWS_MS, the quote formatted (a link has its rule's colour and size from the sheet),
//    the display:none preheader is not in it.
// The composer's console has no error or warning (no CSP line), the main log no error line, the net-guard log is empty.
// KNOWN (before this work, the project note): the MAIN window's reader writes a CSP line for each style attribute of the
// message it shows; those are counted apart.
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
import { MAX_PASTE_TABLE_DEPTH } from '../../core/mime/paste-prepare.js'
import { newsletterHtml } from '../helpers/newsletter.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-idezettabla'
const ME = { name: 'A-fiók', email: 'a@example.invalid', display: 'Anna Táblás' }
const SUBJECT_IN = 'Utalási adatok táblázatban'
const SUBJECT_DEEP = 'Mélyen beágyazott táblázat'
const SUBJECT_MID = 'Harminc szint mély táblázat'
const MID_LEVELS = 30
const DEEP_MS = 3000
const DEEP_LEVELS = Number(process.env.DEEP_LEVELS || 1000)
const SUBJECT_NEWS = 'Stíluslapos hírlevél'
const NEWS_MS = 1500

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

const SHEET =
  '<style>' +
  'table.u { border-collapse: collapse; } ' +
  'td.c { border: 1px solid #999999; } ' +
  'th.h { background-color: #eeeeee; border: 1px solid #999999; } ' +
  '.k { color: #c62828; font-family: Georgia, serif; } ' +
  'p.own { color: #2e7d32; } ' +
  '.pre { display: none; } ' +
  '</style>'
const TABLE =
  '<table class="u"><caption>Utalás</caption><tbody>' +
  '<tr><th class="h">Kedvezményezett neve:</th><td class="c">Példa Kft</td></tr>' +
  '<tr><th class="h">Számlaszám:</th><td class="c"><span class="k">11111111-22222222</span></td></tr>' +
  '<tr><th class="h">Összeg:</th><td class="c">12 500 Ft</td></tr>' +
  '<tr><td class="c">Tétel</td><td class="c">Ár<table><tr><td>belső1</td><td>belső2</td></tr></table></td></tr>' +
  '</tbody></table>'
const HTML_IN =
  `<html><head>${SHEET}</head><body>` +
  '<div class="pre">ELOSZOVEG-REJTETT</div>' +
  '<p>Az utalás adatai:</p>' +
  TABLE +
  '<p class="own" style="color: #1565c0;">Saját szín</p>' +
  '<p style="color: #ffffff;">FEHER-REJTETT</p>' +
  '<p>Üdv, Ödön</p></body></html>'
const HIDDEN = ['ELOSZOVEG-REJTETT', 'FEHER-REJTETT']
// the sent text/plain: a line per row, the cells one TAB apart (the caption first)
const TAB_LINES = ['Utalás', 'Kedvezményezett neve:\tPélda Kft', 'Számlaszám:\t11111111-22222222', 'Összeg:\t12 500 Ft']
// the rows of the quoted table, their cells' text
const ROWS = [['Kedvezményezett neve:', 'Példa Kft'], ['Számlaszám:', '11111111-22222222'], ['Összeg:', '12 500 Ft']]

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
    html: HTML_IN,
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
pop.add(
  await new MailComposer({
    from: 'Hírlevél <hir@example.invalid>',
    to: `${ME.display} <${ME.email}>`,
    subject: SUBJECT_NEWS,
    messageId: '<tablas-4@example.invalid>',
    date: new Date(Date.UTC(2026, 10, 19, 11, 0, 0)),
    html: newsletterHtml({ blocks: 2000, hidden: 'hirlevelrejtett', visible: 'hirlevellathato' }),
    text: 'Hírlevél',
  }).compile().build(),
)
pop.add(
  await new MailComposer({
    from: 'Ügyfél Ödön <ugyfel@example.invalid>',
    to: `${ME.display} <${ME.email}>`,
    subject: SUBJECT_MID,
    messageId: '<tablas-3@example.invalid>',
    date: new Date(Date.UTC(2026, 10, 19, 10, 0, 0)),
    html: `<p>Közepes:</p>${'<table border="1"><tr><td>'.repeat(MID_LEVELS)}kozepbelso${'</td></tr></table>'.repeat(MID_LEVELS)}`,
    text: 'Közepes',
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
const known = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
const sentMail = async (page, n) => {
  for (let i = 0; i < 75 && received.length < n; i++) await page.waitForTimeout(200)
  return received[n - 1] ? simpleParser(received[n - 1], { keepCidLinks: true }) : null
}
// the quote as the composer shows it: the tables, the computed formatting of the marked elements, the rows' cells
const editorView = win =>
  win.evaluate(() => {
    const ed = document.querySelector('.editor')
    const cs = el => (el ? getComputedStyle(el) : null)
    const outer = ed.querySelector('table')
    const th = outer && outer.querySelector('th')
    const td = outer && outer.querySelector('td')
    const k = [...ed.querySelectorAll('span, font')].find(e => e.textContent.trim() === '11111111-22222222')
    const own = [...ed.querySelectorAll('p')].find(e => e.textContent.trim() === 'Saját szín')
    return {
      text: ed.innerText,
      tables: ed.querySelectorAll('table').length,
      rows: outer ? [...outer.rows].map(r => [...r.cells].map(c => c.firstChild && c.firstChild.nodeType === 3 ? c.firstChild.textContent.trim() : c.textContent.trim())) : [],
      caption: outer && outer.caption ? outer.caption.textContent.trim() : null,
      thBg: cs(th)?.backgroundColor,
      thWeight: cs(th)?.fontWeight,
      tdBorder: td ? `${cs(td).borderTopWidth} ${cs(td).borderTopStyle} ${cs(td).borderTopColor}` : null,
      kColor: cs(k)?.color,
      kFont: cs(k)?.fontFamily,
      ownColor: cs(own)?.color,
    }
  })

try {
  const page = await app.firstWindow()
  page.on('console', m => {
    if (m.type() !== 'error' && m.type() !== 'warning') return
    if (/^Applying inline style violates/.test(m.text())) known.push(m.text())
    else consoleLines.push(`main ${m.type()}: ${m.text()}`)
  })
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
    let at = -1
    const inOrder = TAB_LINES.every(w => {
      const i = text.findIndex((l, n) => n > at && l.replace(/^(?:>\s?)+/, '') === w)
      return i >= 0 && (at = i) >= 0
    })
    check(`${label} sent: the HTML keeps the table, the border, the background, the colour and the font`,
      /<table/i.test(mail.html) && /border: 1px solid #999999/.test(mail.html) && /background-color: #eeeeee/.test(mail.html) && /color: #c62828/.test(mail.html) && /georgia/i.test(mail.html), mail.html.slice(0, 300))
    check(`${label} sent: text/plain has a line per row, the cells one TAB apart, in order`, inOrder, JSON.stringify(text.filter(l => /Példa|1111|12 500|Utalás/.test(l))))
    check(`${label} sent: no hidden text (HTML and text)`, HIDDEN.every(h => !mail.html.includes(h) && !mail.text.includes(h)), HIDDEN.filter(h => mail.html.includes(h) || mail.text.includes(h)).join(', '))
  }

  // 1. reply, 2. forward
  for (const [n, mode, to] of [[1, 'reply', null], [2, 'forward', 'masik@example.invalid']]) {
    const w = await fromReader(t.replyModes[mode])
    const v = await editorView(w)
    check(`${mode}: the table and the nested one are tables in the quote`, v.tables === 2, String(v.tables))
    check(`${mode}: the caption, the rows and their cells in order`, v.caption === 'Utalás' && ROWS.every((r, i) => JSON.stringify(v.rows[i]) === JSON.stringify(r)), JSON.stringify({ caption: v.caption, rows: v.rows }))
    check(`${mode}: the sheet's cell border`, v.tdBorder === '1px solid rgb(153, 153, 153)', v.tdBorder)
    check(`${mode}: the sheet's header background, the header bold`, v.thBg === 'rgb(238, 238, 238)' && Number(v.thWeight) >= 600, `${v.thBg} ${v.thWeight}`)
    check(`${mode}: the sheet's colour and font on a class`, v.kColor === 'rgb(198, 40, 40)' && /georgia/i.test(v.kFont || ''), `${v.kColor} ${v.kFont}`)
    check(`${mode}: an element's own style over the sheet`, v.ownColor === 'rgb(21, 101, 192)', v.ownColor)
    check(`${mode}: no hidden text in the quote`, HIDDEN.every(h => !v.text.includes(h)), HIDDEN.filter(h => v.text.includes(h)).join(', '))
    await send(w, to)
    sentChecks(mode, await sentMail(page, n))
  }

  // 3. a table nested MID_LEVELS deep: the outer levels stay tables, the inner ones as lines
  await openMessage(SUBJECT_MID)
  const mid = await fromReader(t.replyModes.reply, 'kozepbelso')
  const mv = await mid.evaluate(() => ({ tables: document.querySelector('.editor').querySelectorAll('table').length }))
  check(`table ${MID_LEVELS} deep: the outer ${MAX_PASTE_TABLE_DEPTH} levels tables, the rest as lines, the innermost text there`, mv.tables === MAX_PASTE_TABLE_DEPTH, JSON.stringify(mv))
  await mid.close()

  // 4. the deeply nested table
  await openMessage(SUBJECT_DEEP)
  const t0 = performance.now()
  const [deep] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name: t.replyModes.reply, exact: true }).click()])
  deep.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`composer ${m.type()}: ${m.text()}`))
  const ready = await deep.waitForFunction(() => document.querySelector('.editor')?.innerText.includes('legbelso'), null, { timeout: 15_000 }).then(() => true, () => false)
  const ms = performance.now() - t0
  const dv = await deep.evaluate(() => {
    const ed = document.querySelector('.editor')
    return ed ? { chars: ed.textContent.length, tables: ed.querySelectorAll('table').length } : null
  }).catch(e => ({ error: String(e).slice(0, 120) }))
  check(`deep table (${DEEP_LEVELS} levels): the reply's composer ready with the innermost text within ${DEEP_MS} ms (past the depth cut: as lines)`,
    ready && ms <= DEEP_MS && dv && dv.tables === 0, `${Math.round(ms)} ms, ${JSON.stringify(dv)}`)
  if (!deep.isClosed()) await deep.close()

  // 5. the stylesheet newsletter: formatted, in time
  await openMessage(SUBJECT_NEWS)
  const n0 = performance.now()
  const [news] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name: t.replyModes.reply, exact: true }).click()])
  news.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`composer ${m.type()}: ${m.text()}`))
  const newsReady = await news.waitForFunction(() => document.querySelector('.editor')?.innerText.includes('hirlevellathato'), null, { timeout: 15_000 }).then(() => true, () => false)
  const newsMs = performance.now() - n0
  // block 1: ".c1 td.x1 > a:first-child { color:#100f00; font-size:11px }" (the sheet's rule for it)
  const nv = await news.evaluate(() => {
    const ed = document.querySelector('.editor')
    const a = [...ed.querySelectorAll('a')].find(x => x.textContent.startsWith('Termék 1 '))
    const cs = a && getComputedStyle(a)
    return { links: ed.querySelectorAll('a').length, color: cs?.color, size: cs?.fontSize, hidden: ed.textContent.includes('hirlevelrejtett') }
  }).catch(e => ({ error: String(e).slice(0, 120) }))
  check(`the 2000-block newsletter: the reply's composer ready within ${NEWS_MS} ms`, newsReady && newsMs <= NEWS_MS, `${Math.round(newsMs)} ms`)
  check('the newsletter: the quote formatted (a link has its rule\'s colour and size), the preheader not in it', nv.links === 2000 && nv.color === 'rgb(16, 15, 0)' && nv.size === '11px' && nv.hidden === false, JSON.stringify(nv))
  console.log(`INFO the newsletter's reply: ${Math.round(newsMs)} ms`)
  if (!news.isClosed()) await news.close()
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
check('no composer console error or warning (no CSP line), no other main-window line', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
if (known.length) console.log(`KNOWN the reader's sanitizer on the main page: ${known.length} CSP line(s) for the message's style attributes`)
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
