// SPDX-License-Identifier: GPL-3.0-or-later
// The composer's colours on the way out (core/smtp/text-colors.js, sanitize.js sanitizeCompose `rich`): a coloured and
// highlighted text goes out with its <font color> and its highlight style in the HTML part, the text part has the text
// without colour; a draft saved, opened again and sent keeps them; a reply or a forward of a coloured message quotes it
// without colour (as before). Against a local SMTP server and the fake IMAP server; the editor's sanitizer runs on jsdom
// with the options the composer page gives it (Composer.jsx: form() rich, writeBody rich only for a saved body, table rows
// otherwise; that choice itself: test/compose-colors-ui.test.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { memoryIndex, addAccount, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { MessageReader } from '../app/main/reader.js'
import { Composer } from '../app/main/compose.js'
import { Contacts } from '../core/db/contacts.js'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'
import { TEXT_COLORS, HIGHLIGHT_COLORS } from '../core/smtp/text-colors.js'

const ME = 'teszt@example.invalid'
const NOW = Date.UTC(2026, 10, 20, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const t0 = performance.now()
  while (!(await fn())) {
    if (performance.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const purify = createDOMPurify(new JSDOM('').window)
const RED = TEXT_COLORS[0].hex
const BLUE = TEXT_COLORS[3].hex
const YELLOW = HIGHLIGHT_COLORS[0].style
const GREEN = HIGHLIGHT_COLORS[1].style
// what the editor writes (measured by the planner, Electron 45.3.0, styleWithCSS off)
const COLOURED = `<p>Sima, <font color="${RED}">piros</font>, <span style="${YELLOW}">sárga kiemelés</span>, <font color="${BLUE}" style="${GREEN}"><b>kék zöldön</b></font>.</p>`
const original = html => new MailComposer({ from: 'Kovács Árpád <arpad@sender.invalid>', to: ME, subject: 'Színes levél', messageId: '<szines@sender.invalid>', date: new Date(NOW), html, text: 'Szia!' }).compile().build()

async function setup(t) {
  const received = []
  const smtp = new SMTPServer({
    disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN'], logger: false,
    onAuth: (a, _s, cb) => cb(null, { user: a.username }),
    onData(stream, session, cb) {
      const chunks = []
      stream.on('data', c => chunks.push(c))
      stream.on('end', () => (received.push(Buffer.concat(chunks)), cb()))
    },
  })
  smtp.on('error', () => {})
  await new Promise(r => smtp.listen(0, '127.0.0.1', r))
  onCleanup(t, () => new Promise(r => smtp.close(r)))
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { email: ME, display_name: 'Teszt Elek', smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none', smtp_user: ME })
  const imap = new FakeImapServer().addMailbox('INBOX').addMailbox('Drafts', { specialUse: '\\Drafts' }).addMailbox('Sent', { specialUse: '\\Sent' })
  const uid = imap.addMessage('INBOX', { from: 'arpad@sender.invalid', to: ME, subject: 'x', messageId: '<szines@sender.invalid>', date: NOW, body: 'x', source: await original(`<p>Eredeti:</p>${COLOURED}<p><font color="#ff0000">idegen piros</font></p>`) })
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: 'jelszo', smtp: 'jelszo' }),
  }
  const storeDir = path.join(tempDir(t), 'store')
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), notify: () => {}, connect: () => imap.connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => manager.entries.get(row.id).idle.connected)
  const reader = new MessageReader({ index, sealed: sealedStore(storeDir), withConnection: (id, fn) => manager.withConnection(id, fn) })
  const composer = new Composer({
    index, store, contacts: new Contacts(db), storeDir, sealed: sealedStore(storeDir), reader,
    withConnection: (id, fn) => manager.withConnection(id, fn),
    requestSync: (id, f) => manager.requestSync(id, f),
    now: () => NOW,
  })
  const messageId = index.getByUid(row.id, 'INBOX', uid).id
  // the composer page: writeBody's sanitizer over the starting body, form()'s over the editor's text
  const startBody = (sid, html, saved) => sanitizeCompose(purify, html, saved ? { sessionId: sid, rich: true } : { sessionId: sid, tableRows: true })
  const formOf = (sid, f, html) => ({ accountId: f.accountId ?? row.id, to: f.to || 'Valaki <valaki@example.invalid>', cc: '', bcc: '', subject: f.subject || 'Színek', html: sanitizeCompose(purify, html, { sessionId: sid, rich: true }), inReplyTo: f.inReplyTo, references: f.references })
  return { row, imap, composer, messageId, received, startBody, formOf }
}

const htmlPart = async raw => (await simpleParser(raw)).html
const textPart = async raw => (await simpleParser(raw)).text

test('sent: the HTML part keeps the palette colour (font color) and the highlight (its exact style); the text part has the text, no colour', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  assert.equal((await s.composer.sendNow(sid, s.formOf(sid, {}, COLOURED))).sent, true)
  const html = await htmlPart(s.received[0])
  assert.ok(html.includes(`<font color="${RED}">piros</font>`), html)
  assert.ok(html.includes(`<span style="${YELLOW}">sárga kiemelés</span>`), html)
  assert.ok(html.includes(`<font color="${BLUE}" style="${GREEN}"><b>kék zöldön</b></font>`), html)
  const text = await textPart(s.received[0])
  assert.match(text, /Sima, piros, sárga kiemelés, kék zöldön\./)
  assert.ok(!/#[0-9a-f]{6}|rgb\(|color/i.test(text), text)
})

test('sent: a colour the toolbar does not make goes out too (rich: a checked colour), what loads or breaks out does not', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  const html = '<p><font color="#ff0000">idegen</font> <span style="background-color: yellow;">sárga</span> <span style="color: red; background-color: rgb(255, 245, 157);">kettő</span> <span style="background: url(https://evil.invalid/t.png); position: fixed;">kép</span></p>'
  await s.composer.sendNow(sid, s.formOf(sid, {}, html))
  const out = await htmlPart(s.received[0])
  assert.match(out, /<font color="#ff0000">idegen<\/font> <span style="background-color: yellow;">sárga<\/span> <span style="color: red; background-color: rgb\(255, 245, 157\);">kettő<\/span> kép<\/p>/)
  assert.ok(!/url\(|evil|position/i.test(out), out)
})

test('a draft saved, opened again, sent: the colours are there at each step', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, s.formOf(sid, { subject: 'Színes piszkozat' }, COLOURED))
  const drafts = [...s.imap.mailboxes.get('Drafts').messages.values()]
  assert.equal(drafts.length, 1)
  const row = { id: 9999, account_id: s.row.id, folder: 'Drafts', message_id: null }
  s.composer.reader = { source: async () => ({ row, source: drafts[0].source }) }
  const sid2 = s.composer.open()
  const f = await s.composer.prepare(sid2, { mode: 'draft', messageId: 9999 })
  assert.ok(f.draftHtml.includes(`<font color="${RED}">`) && f.draftHtml.includes(YELLOW), f.draftHtml)
  // the composer page writes it into the editor with colours (a saved body), and sends what the editor holds
  const editor = s.startBody(sid2, f.draftHtml, true)
  assert.ok(editor.includes(`<font color="${RED}">piros</font>`) && editor.includes(`<span style="${YELLOW}">`), editor)
  await s.composer.sendNow(sid2, s.formOf(sid2, f, editor))
  const html = await htmlPart(s.received[0])
  assert.ok(html.includes(`<font color="${RED}">piros</font>`), html)
  assert.ok(html.includes(`<span style="${YELLOW}">sárga kiemelés</span>`), html)
  assert.ok(html.includes(`<font color="${BLUE}" style="${GREEN}"><b>kék zöldön</b></font>`), html)
})

for (const mode of ['reply', 'forward']) {
  test(`${mode} to a coloured message: the quote has no colour (as before), the own coloured text keeps its colour`, async t => {
    const s = await setup(t)
    const sid = s.composer.open()
    const f = await s.composer.prepare(sid, { mode, messageId: s.messageId })
    assert.ok(f.quote.includes(`color="${RED}"`) && f.quote.includes(YELLOW), 'the original\'s colours reach the page (the page drops them)')
    // the composer page: the starting body is no saved body -> without colours
    const editor = s.startBody(sid, f.quote, false)
    assert.ok(!/<font|style=|color=/i.test(editor), editor)
    assert.ok(editor.includes('sárga kiemelés') && editor.includes('idegen piros'), 'the text stays')
    await s.composer.sendNow(sid, s.formOf(sid, { ...f, to: f.to || 'Valaki <valaki@example.invalid>' }, `<p>Saját <font color="${RED}">piros</font>.</p>${editor}`))
    const html = await htmlPart(s.received[0])
    assert.equal((html.match(/<font /g) || []).length, 1, html)
    assert.ok(html.includes(`Saját <font color="${RED}">piros</font>.`), html)
    assert.ok(!html.includes(YELLOW) && !html.includes(GREEN) && !html.includes('#ff0000'), html)
  })
}

// the rich mode on the way out (core/smtp/rich-style.js): a table with its grid, a background, a colspan, a coloured and a
// font-faced text; the HTML part is the sanitized body, the text part a line per row with TABs
const RICH = '<p>Ajánlat: <font color="#1f497d" face="Calibri">kék Calibri</font> és <span style="font-size: 14pt; font-weight: bold;">nagy</span>.</p>' +
  '<table border="1" cellpadding="4" style="border-collapse: collapse; border: 1px solid #999999; position: absolute; background: url(https://evil.invalid/t.png);">' +
  '<caption>Árlista</caption><tr><th colspan="2" bgcolor="#eeeeee" style="text-align: left;" class="x" onclick="x()">Termék és darab</th></tr>' +
  '<tr><td style="border: 1px solid #999999; padding: 2px 6px;">Kazán A</td><td align="right" style="background-color: rgb(255, 245, 157);">1</td></tr>' +
  '<tr><td>Kazán B</td><td align="right">2</td></tr></table><p>Üdv</p>'
const RICH_OUT = '<p>Ajánlat: <font color="#1f497d" face="Calibri">kék Calibri</font> és <span style="font-size: 14pt; font-weight: bold;">nagy</span>.</p>' +
  '<table border="1" cellpadding="4" style="border-collapse: collapse; border: 1px solid #999999;"><caption>Árlista</caption><tbody>' +
  '<tr><th colspan="2" bgcolor="#eeeeee" style="text-align: left;">Termék és darab</th></tr>' +
  '<tr><td style="border: 1px solid #999999; padding: 2px 6px;">Kazán A</td><td align="right" style="background-color: rgb(255, 245, 157);">1</td></tr>' +
  '<tr><td>Kazán B</td><td align="right">2</td></tr></tbody></table><p>Üdv</p>'
const RICH_TEXT = 'Ajánlat: kék Calibri és nagy.\n\nÁrlista\nTermék és darab\nKazán A\t1\nKazán B\t2\n\nÜdv'

test('sent, rich: the HTML part is the sanitized body (the grid, the background, the colspan, the font, the size); the text part a line per row, the cells TAB apart', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  const form = s.formOf(sid, {}, RICH)
  assert.equal(form.html, RICH_OUT, 'what form() sends')
  assert.equal((await s.composer.sendNow(sid, form)).sent, true)
  const got = await simpleParser(s.received[0])
  assert.equal(got.html, RICH_OUT)
  assert.equal(got.text.trim(), RICH_TEXT)
  assert.ok(!/evil|position|onclick|class=/.test(s.received[0].toString()), 'nothing of what goes')
})

test('rich: a draft saved, opened again, sent gives the same HTML and text part as sending it at once', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, s.formOf(sid, { subject: 'Gazdag piszkozat' }, RICH))
  const drafts = [...s.imap.mailboxes.get('Drafts').messages.values()]
  assert.equal(drafts.length, 1)
  const row = { id: 9999, account_id: s.row.id, folder: 'Drafts', message_id: null }
  s.composer.reader = { source: async () => ({ row, source: drafts[0].source }) }
  const sid2 = s.composer.open()
  const f = await s.composer.prepare(sid2, { mode: 'draft', messageId: 9999 })
  assert.equal(f.draftHtml, RICH_OUT, 'the saved body is the sent body')
  // the composer page writes the saved body rich (a table stays a table) and sends what the editor holds
  const editor = s.startBody(sid2, f.draftHtml, true)
  assert.equal(editor, RICH_OUT)
  await s.composer.sendNow(sid2, s.formOf(sid2, f, editor))
  const got = await simpleParser(s.received[0])
  assert.equal(got.html, RICH_OUT)
  assert.equal(got.text.trim(), RICH_TEXT)
})
