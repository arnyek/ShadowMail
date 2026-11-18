// SPDX-License-Identifier: GPL-3.0-or-later
// Raw 8-bit header fields without RFC 2047 encoding (old PHP form mailers): a field that is not valid UTF-8 is decoded
// with the top-level Content-Type charset, or windows-1250; a valid UTF-8 field stays UTF-8. Everywhere a header is
// shown or searched: the reader, the list (IMAP and POP3 rows), the search index, the reply/forward quote, the source
// view's summary, the old-POP3 search; and the rows stored before (the IMAP server's header fields, the POP3 .eml).
// Fixtures: test/fixtures/raw-headers/raw-8bit-*.eml (synthetic, make-raw-8bit.py). Not under fixtures/mail: the reader,
// layout and splitter e2e load that whole folder and count its messages.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { utf8Headers, headerCharset, headerEnd } from '../core/mime/raw-headers.js'
import { parseMessage, headerColumns, hasBrokenHeader } from '../core/mime/message.js'
import { rawView } from '../core/mime/raw-view.js'
import { messageText } from '../core/pop3/local-search.js'
import { searchResultHere } from '../core/mime/search-text-service.js'
import { quoteHtml, forwardHtml } from '../core/smtp/compose.js'
import { memoryIndex, addAccount, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer, headerFields } from './helpers/fake-imap.js'
import { FakePop3Server } from './helpers/fake-pop3.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { Syncer } from '../core/imap/sync.js'
import { Pop3Fetcher } from '../core/pop3/fetcher.js'
import { Pop3Client } from '../core/pop3/client.js'
import { hu } from '../app/renderer/i18n/hu.js'

const BAD = String.fromCharCode(0xfffd)
const NOW = Date.UTC(2026, 10, 17, 9, 0, 0)
const fixture = name => fs.readFileSync(new URL(`./fixtures/raw-headers/${name}`, import.meta.url))
const LATIN2 = fixture('raw-8bit-iso-8859-2.eml')
const UTF8 = fixture('raw-8bit-utf8.eml')
const NOCHARSET = fixture('raw-8bit-no-charset.eml')

// what the fixtures say (make-raw-8bit.py)
const L2_SUBJECT = 'Tükörfúrógép árajánlatkérés: őszi kőművesmunka'
const L2_FROM = { name: 'Kertész Előd Ödön', address: 'kerteszelod@example.invalid' }
const L2_TO = [{ name: 'Árvíztűrő Ügyfélszolgálat', address: 'ugyfel@example.invalid' }]
const L2_CC = [{ name: 'Szőlősi Bea', address: 'bea@example.invalid' }, { name: 'Fűzfa Győző', address: 'gyozo@example.invalid' }]

/** A raw header block from pieces: strings are ASCII, Buffers go in as they are. */
const raw = (...parts) => Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))))
// the Hungarian letters in ISO-8859-2 (ASCII as it is)
const LATIN2_BYTES = { 'á': 0xe1, 'é': 0xe9, 'í': 0xed, 'ó': 0xf3, 'ö': 0xf6, 'ő': 0xf5, 'ú': 0xfa, 'ü': 0xfc, 'ű': 0xfb, 'Á': 0xc1, 'É': 0xc9, 'Í': 0xcd, 'Ó': 0xd3, 'Ö': 0xd6, 'Ő': 0xd5, 'Ú': 0xda, 'Ü': 0xdc, 'Ű': 0xdb }
const latin2 = s => Buffer.from([...s].map(c => LATIN2_BYTES[c] ?? c.charCodeAt(0)))

test('fixtures: raw 8-bit, no RFC 2047 in the raw fields, CRLF; the latin2 one is not valid UTF-8', () => {
  const head = LATIN2.subarray(0, headerEnd(LATIN2)).toString('latin1')
  assert.match(head, /^Subject: T\xfck\xf6rf\xfar\xf3g\xe9p \xe1raj\xe1nlatk\xe9r\xe9s: \xf5szi k\xf5m\xfbvesmunka\r$/m)
  assert.match(head, /^From: Kert\xe9sz El\xf5d \xd6d\xf6n<kerteszelod@example\.invalid>\r$/m)
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(LATIN2.subarray(0, headerEnd(LATIN2))))
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(UTF8.subarray(0, headerEnd(UTF8))))
})

test('the reader (parseMessage): ISO-8859-2 subject and names in the Content-Type charset, an RFC 2047 word beside them', async () => {
  const p = await parseMessage(LATIN2)
  assert.equal(p.subject, L2_SUBJECT)
  assert.deepEqual(p.from, [L2_FROM])
  assert.deepEqual(p.to, L2_TO)
  assert.deepEqual(p.cc, L2_CC)
  assert.match(p.html, /Kertész Előd Ödön/, 'the body was right before and stays right')
  for (const v of [p.subject, JSON.stringify(p.from), JSON.stringify(p.to), JSON.stringify(p.cc)]) assert.ok(!v.includes(BAD))
})

test('a raw UTF-8 header stays UTF-8, even with an iso-8859-2 body', async () => {
  assert.equal(utf8Headers(UTF8), UTF8, 'nothing to rewrite: the same Buffer')
  const p = await parseMessage(UTF8)
  assert.equal(p.subject, 'Űrlap: szőlőprés bérlés')
  assert.deepEqual(p.from, [{ name: 'Bárány Őrs', address: 'baranyors@example.invalid' }])
  assert.equal(p.text.trim(), 'Szöveg: köszönöm.')
})

test('no charset on the top level (multipart): windows-1250, not latin1', async () => {
  const p = await parseMessage(NOCHARSET)
  assert.equal(p.subject, 'Ajánlat: Škoda szőnyeg')
  assert.deepEqual(p.from, [{ name: 'Kőműves Ödön', address: 'komuves@example.invalid' }])
})

test('headerCharset: the top-level Content-Type charset when the decoder knows it, else windows-1250', () => {
  const ct = v => raw(`From: a@b.invalid\r\n${v}\r\nSubject: x\r\n`)
  assert.equal(headerCharset(ct('Content-Type: text/html; charset=iso-8859-2')), 'iso-8859-2')
  assert.equal(headerCharset(ct('Content-Type: text/plain; charset="ISO-8859-2"')), 'iso-8859-2')
  assert.equal(headerCharset(ct('content-type: text/plain;\r\n\tcharset=windows-1250')), 'windows-1250', 'folded, lower case')
  assert.equal(headerCharset(ct('Content-Type: text/plain; charset=utf-8')), 'windows-1250', 'UTF-8 already failed')
  assert.equal(headerCharset(ct('Content-Type: text/plain; charset=us-ascii')), 'windows-1250', 'not windows-1252')
  assert.equal(headerCharset(ct('Content-Type: text/plain; charset=x-no-such-charset')), 'windows-1250')
  assert.equal(headerCharset(ct('Content-Type: multipart/mixed; boundary=x')), 'windows-1250')
  assert.equal(headerCharset(ct('X-Other: y')), 'windows-1250')
  assert.equal(headerCharset(ct('Content-Type: text/plain; charset=iso-8859-1')), 'windows-1252', 'the WHATWG name of latin1')
  // labels the decoder resolves to UTF-8 or UTF-16: UTF-16 would swallow the CRLF and the next field
  for (const label of ['ucs-2', 'unicode', 'csunicode', 'iso-10646-ucs-2', 'unicodefeff', 'unicodefffe', 'utf-16', 'UTF-16BE', 'unicode20utf8', 'x-unicode20utf8'])
    assert.equal(headerCharset(ct(`Content-Type: text/plain; charset=${label}`)), 'windows-1250', label)
})

test('a UTF-16 label does not swallow the next field: the subject from the fallback, the From kept', async () => {
  const src = raw('Content-Type: text/plain; charset=ucs-2\r\nSubject: ', latin2('Tükör'), '\r\nFrom: Valodi <real@example.invalid>\r\nTo: to@example.invalid\r\n\r\nbody\r\n')
  const p = await parseMessage(src)
  assert.equal(p.subject, 'Tükör')
  assert.deepEqual(p.from, [{ name: 'Valodi', address: 'real@example.invalid' }])
  assert.equal((await headerColumns(src)).from_addr, 'real@example.invalid')
})

test('utf8Headers: only the bad fields change; the body and the other fields stay byte for byte; LF-only too', async () => {
  const out = utf8Headers(LATIN2)
  const end = headerEnd(LATIN2)
  assert.deepEqual(out.subarray(out.length - (LATIN2.length - end)), LATIN2.subarray(end), 'the body is untouched (still iso-8859-2)')
  const outHead = out.subarray(0, headerEnd(out)).toString('utf8')
  assert.ok(outHead.includes('Message-ID: <raw8bit-1@example.invalid>\r\n'))
  assert.ok(outHead.includes('Cc: =?UTF-8?Q?Sz=C5=91l=C5=91si_Bea?= <bea@example.invalid>, Fűzfa Győző <gyozo@example.invalid>\r\n'))
  assert.equal(utf8Headers(raw('From: a@b.invalid\r\nSubject: plain\r\n\r\nbody')).toString(), 'From: a@b.invalid\r\nSubject: plain\r\n\r\nbody')
  const lf = raw('Subject: ', latin2('Árvíztűrő'), '\nContent-Type: text/plain; charset=iso-8859-2\n\nx\n')
  assert.equal((await parseMessage(lf)).subject, 'Árvíztűrő')
  // a folded raw field keeps its continuation
  const folded = raw('Subject: ', latin2('első'), '\r\n ', latin2('második'), '\r\nContent-Type: text/plain; charset=iso-8859-2\r\n\r\nx')
  assert.equal((await parseMessage(folded)).subject, 'első második')
  // not a Buffer: as it was
  assert.equal(utf8Headers('Subject: x\r\n\r\n'), 'Subject: x\r\n\r\n')
  // a body byte >= 0x80 with an ASCII header block: the same Buffer
  const body8 = raw('Subject: x\r\n\r\n', latin2('ő'))
  assert.equal(utf8Headers(body8), body8)
})

test('utf8Headers is linear: a 1 MB header block of raw fields', () => {
  const line = raw('X-Long: ', latin2('őű'.repeat(40)), '\r\n')
  const big = Buffer.concat([...Array(Math.floor(1000000 / line.length)).fill(line), raw('Content-Type: text/plain; charset=iso-8859-2\r\n\r\nx')])
  const t0 = performance.now()
  const out = utf8Headers(big)
  const ms = performance.now() - t0
  assert.ok(out.length > big.length)
  assert.ok(ms < 1000, `${ms} ms`)
})

test('the source view summary, the old-POP3 search text and the worker search text read the decoded headers', async () => {
  const v = await rawView(LATIN2)
  assert.equal(v.summary.subject, L2_SUBJECT)
  assert.match(v.summary.from, /Kertész Előd Ödön/)
  assert.ok(v.headers.includes(BAD), 'the raw header block itself is still shown as the bytes are (UTF-8 view)')
  const text = await messageText(LATIN2)
  assert.ok(text.includes(L2_SUBJECT) && text.includes('Kertész Előd Ödön') && text.includes('Fűzfa Győző'))
  const r = await searchResultHere(LATIN2, 'message')
  assert.ok(r.text.includes(L2_SUBJECT) && !r.text.includes(BAD))
})

test('the reply and forward quote name the sender and the subject decoded', async () => {
  const p = await parseMessage(LATIN2)
  const original = { ...p, date: p.date }
  const q = quoteHtml(original, hu.outgoingQuote, 'hu-HU')
  assert.match(q, /Kertész Előd Ödön/)
  assert.ok(!q.includes(BAD))
  const f = forwardHtml(original, hu.outgoingQuote, 'hu-HU')
  assert.ok(f.includes(L2_SUBJECT) && f.includes('Kertész Előd Ödön') && f.includes('Árvíztűrő Ügyfélszolgálat'))
  assert.ok(!f.includes(BAD))
})

test('headerColumns: the list row columns from a header block; the IMAP and the POP3 sender rule', async () => {
  const c = await headerColumns(LATIN2)
  assert.deepEqual(c, {
    subject: L2_SUBJECT,
    from_addr: L2_FROM.address,
    from_name: L2_FROM.name,
    to_addrs: 'Árvíztűrő Ügyfélszolgálat <ugyfel@example.invalid>',
    cc_addrs: 'Szőlősi Bea <bea@example.invalid>, Fűzfa Győző <gyozo@example.invalid>',
    sender_text: 'Kertész Előd Ödön <kerteszelod@example.invalid>',
    recipients_text: 'Árvíztűrő Ügyfélszolgálat <ugyfel@example.invalid>, Szőlősi Bea <bea@example.invalid>, Fűzfa Győző <gyozo@example.invalid>',
  })
  assert.equal(hasBrokenHeader(c), false)
  assert.equal(hasBrokenHeader({ subject: `T${BAD}k${BAD}r` }), true)
  const two = raw('From: a@b.invalid, ', latin2('Győző'), ' <c@d.invalid>\r\nContent-Type: text/plain; charset=iso-8859-2\r\n\r\n')
  assert.equal((await headerColumns(two)).sender_text, 'a@b.invalid')
  assert.equal((await headerColumns(two, { allSenders: true })).sender_text, 'a@b.invalid, Győző <c@d.invalid>')
})

// ---------------------------------------------------------------- IMAP

/** The row and its FTS row as 0.15.0 stored them (plain SQL: not through the code under test). */
function storeBroken(db, id, env) {
  db.prepare('UPDATE messages SET subject = ?, from_name = ? WHERE id = ?').run(env.subject, env.fromName, id)
  db.prepare('UPDATE messages_fts SET subject = ?, sender = ? WHERE rowid = ?').run(env.subject, env.fromName, id)
}

/** A server that reads its raw envelope strings as UTF-8, as imapflow does (measured: "T\xfck\xf6r" -> "T\uFFFDk\uFFFDr"). */
const brokenEnvelope = () => ({ subject: latin2(L2_SUBJECT).toString('utf8'), fromName: latin2(L2_FROM.name).toString('utf8') })

function imapSetup(t) {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db, { body_index_days: 1095 })
  const server = new FakeImapServer().addMailbox('INBOX')
  const env = brokenEnvelope()
  assert.ok(env.subject.includes(BAD) && env.fromName.includes(BAD), 'the envelope is broken as imapflow gives it')
  const badUid = server.addMessage('INBOX', { from: L2_FROM.address, fromName: env.fromName, to: 'ugyfel@example.invalid', subject: env.subject, messageId: '<raw8bit-1@example.invalid>', date: NOW - 86400000, body: 'x', source: LATIN2 })
  const okUid = server.addMessage('INBOX', { from: 'rendes@example.invalid', to: 'ugyfel@example.invalid', subject: 'Rendes levél', messageId: '<ok@x>', date: NOW - 86400000, body: 'Szöveg.' })
  const syncer = () => new Syncer({ account, index, connect: async () => server.client(), now: () => NOW })
  const row = uid => index.getByUid(account.id, 'INBOX', uid)
  const fts = id => db.prepare('SELECT subject, sender, recipients FROM messages_fts WHERE rowid = ?').get(id)
  const headerFetches = () => server.fetchLog.filter(f => f.kind === 'headers')
  return { db, index, account, server, syncer, row, fts, badUid, okUid, headerFetches }
}

test('fake IMAP headerFields: the named raw fields byte for byte, folded lines kept', () => {
  const h = headerFields(NOCHARSET, ['subject', 'content-type'])
  assert.deepEqual(h, Buffer.concat([NOCHARSET.subarray(NOCHARSET.indexOf('Subject:'), NOCHARSET.indexOf('Date:')), Buffer.from('Content-Type: multipart/alternative;\r\n boundary="b1"\r\n\r\n')]))
})

test('IMAP sync: a new message with a broken envelope gets its header columns from the raw fields; the list and the search are right', async t => {
  const s = imapSetup(t)
  await s.syncer().run()
  const r = s.row(s.badUid)
  assert.equal(r.subject, L2_SUBJECT)
  assert.equal(r.from_name, L2_FROM.name)
  assert.equal(r.from_addr, L2_FROM.address)
  assert.equal(r.to_addrs, 'Árvíztűrő Ügyfélszolgálat <ugyfel@example.invalid>')
  assert.deepEqual(s.fts(r.id), { subject: L2_SUBJECT, sender: 'Kertész Előd Ödön <kerteszelod@example.invalid>', recipients: 'Árvíztűrő Ügyfélszolgálat <ugyfel@example.invalid>, Szőlősi Bea <bea@example.invalid>, Fűzfa Győző <gyozo@example.invalid>' })
  assert.deepEqual(s.index.search({ query: 'kőművesmunka' }).map(m => m.uid), [s.badUid])
  assert.deepEqual(s.index.search({ query: 'kertesz' }).map(m => m.uid), [s.badUid])
  assert.equal(s.row(s.okUid).subject, 'Rendes levél')
  assert.deepEqual(s.headerFetches().map(f => f.uids), [[s.badUid]], 'only the broken one is fetched again')
})

test('IMAP sync: a broken message arriving later (the same instance, the folder already checked) is repaired before it is stored', async t => {
  const s = imapSetup(t)
  const syncer = s.syncer()
  await syncer.run()
  const env = brokenEnvelope()
  const later = s.server.addMessage('INBOX', { from: L2_FROM.address, fromName: env.fromName, to: 'ugyfel@example.invalid', subject: env.subject, messageId: '<raw8bit-later@example.invalid>', date: NOW, body: 'x', source: LATIN2 })
  s.server.fetchLog.length = 0
  await syncer.run()
  assert.equal(s.row(later).subject, L2_SUBJECT)
  assert.equal(s.row(later).from_name, L2_FROM.name)
  assert.deepEqual(s.headerFetches().map(f => f.uids), [[later]])
})

test('IMAP sync: a row stored broken (before 0.15.1) is repaired from the server once per instance; the FTS row too', async t => {
  const s = imapSetup(t)
  await s.syncer().run()
  const id = s.row(s.badUid).id
  // as 0.15.0 stored it
  const env = brokenEnvelope()
  storeBroken(s.db, id, env)
  assert.equal(s.fts(id).sender, env.fromName)
  assert.equal(s.index.brokenHeaderRows(s.account.id).length, 1)
  s.server.fetchLog.length = 0
  const syncer = s.syncer()
  await syncer.run()
  assert.equal(s.row(s.badUid).subject, L2_SUBJECT)
  assert.equal(s.row(s.badUid).from_name, L2_FROM.name)
  assert.equal(s.fts(id).sender, 'Kertész Előd Ödön <kerteszelod@example.invalid>')
  assert.deepEqual(s.index.search({ query: 'tukorfurogep' }).map(m => m.uid), [s.badUid])
  assert.equal(s.index.brokenHeaderRows(s.account.id).length, 0)
  assert.equal(s.headerFetches().length, 1)
  // a header that stays broken (the server has it so): checked once per instance, not on every run
  s.index.setHeaders(id, { subject: `x${BAD}`, from_name: null, to_addrs: '', cc_addrs: '', sender_text: '', recipients_text: '' })
  s.server.mailboxes.get('INBOX').messages.get(s.badUid).source = Buffer.from(`Subject: x${BAD}\r\n\r\nx`)
  await syncer.run()
  await syncer.run()
  assert.equal(s.headerFetches().length, 1, 'the same instance does not look again')
  const fresh = s.syncer()
  await fresh.run()
  assert.equal(s.headerFetches().length, 2)
  assert.equal(s.row(s.badUid).subject, `x${BAD}`, 'still broken: left as it is')
})

// ---------------------------------------------------------------- POP3

async function pop3Setup(t) {
  const server = await new FakePop3Server().listen()
  onCleanup(t, () => server.close())
  server.add(LATIN2)
  server.add(NOCHARSET)
  const { db, index } = memoryIndex(t)
  const account = addAccount(db, { type: 'pop3', in_port: server.port, in_host: '127.0.0.1', in_security: 'none', in_user: server.user })
  const storeDir = path.join(tempDir(t), 'store')
  const fetcher = () => {
    const f = new Pop3Fetcher({
      account, index, sealed: sealedStore(storeDir), now: () => NOW,
      connect: async () => {
        const c = new Pop3Client({ host: '127.0.0.1', port: server.port, security: 'none', timeoutMs: 5000 })
        await c.connect()
        await c.login(server.user, server.pass)
        return c
      },
    })
    onCleanup(t, () => f.stop())
    return f
  }
  const rows = () => index.listFolder({ accountId: account.id, folder: 'INBOX', limit: 50 })
  const fts = id => db.prepare('SELECT subject, sender FROM messages_fts WHERE rowid = ?').get(id)
  return { db, index, account, server, fetcher, rows, fts }
}

test('POP3: new messages are listed decoded; a row stored broken is repaired from its .eml without the network', async t => {
  const s = await pop3Setup(t)
  await s.fetcher().run()
  const bySubject = () => Object.fromEntries(s.rows().map(r => [r.subject, r.from_name]))
  assert.deepEqual(bySubject(), { [L2_SUBJECT]: L2_FROM.name, 'Ajánlat: Škoda szőnyeg': 'Kőműves Ödön' })
  const id = s.rows().find(r => r.subject === L2_SUBJECT).id
  assert.equal(s.fts(id).sender, 'Kertész Előd Ödön <kerteszelod@example.invalid>')
  // as 0.15.0 stored it
  const env = brokenEnvelope()
  storeBroken(s.db, id, env)
  assert.equal(s.fts(id).sender, env.fromName)
  await s.server.close() // the repair needs no server
  const f = s.fetcher()
  await f.run().catch(() => {})
  assert.deepEqual(bySubject(), { [L2_SUBJECT]: L2_FROM.name, 'Ajánlat: Škoda szőnyeg': 'Kőműves Ödön' })
  assert.deepEqual(s.fts(id), { subject: L2_SUBJECT, sender: 'Kertész Előd Ödön <kerteszelod@example.invalid>' })
  assert.deepEqual(s.index.search({ query: 'kőművesmunka' }).map(m => m.id), [id])
})
