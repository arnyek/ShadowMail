// Reply, reply all, forward: the pure helpers, and the whole way with the fake IMAP server, the
// local SMTP server and the reader: threading headers, recipients without our own address, the quote,
// the forwarded attachments byte for byte, \Answered / $Forwarded on the original, one thread.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { memoryIndex, addAccount, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { MessageReader } from '../app/main/reader.js'
import { Composer, displayAddress, parseRecipients } from '../app/main/compose.js'
import { Contacts } from '../core/db/contacts.js'
import { parseMessage } from '../core/mime/message.js'
import { replySubject, forwardSubject, replyReferences, replyRecipients, quoteHtml as quoteWith, forwardHtml as forwardWith } from '../core/smtp/compose.js'
import { hu } from '../app/renderer/i18n/hu.js'
import { setLanguage } from '../app/renderer/i18n/index.js'
// the outgoing quote in Hungarian, as before the words became a parameter
const quoteHtml = o => quoteWith(o, hu.outgoingQuote, 'hu-HU')
const forwardHtml = o => forwardWith(o, hu.outgoingQuote, 'hu-HU')

const ME = 'teszt@example.invalid'
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const fixture = name => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url))

test('subjects: one "Re: " / "Fwd: ", whatever prefix and case the original had', () => {
  assert.equal(replySubject('Ajánlat'), 'Re: Ajánlat')
  assert.equal(replySubject('Re: Ajánlat'), 'Re: Ajánlat')
  assert.equal(replySubject('RE: Ajánlat'), 'Re: Ajánlat')
  assert.equal(replySubject('Re[2]: Ajánlat'), 'Re: Ajánlat')
  assert.equal(replySubject('Vá: Ajánlat'), 'Re: Ajánlat')
  assert.equal(replySubject('AW: Angebot'), 'Re: Angebot')
  assert.equal(replySubject(''), 'Re: ')
  assert.equal(replySubject('Regisztráció'), 'Re: Regisztráció', 'not a prefix without the colon')
  assert.equal(forwardSubject('Számla'), 'Fwd: Számla')
  assert.equal(forwardSubject('FW: Számla'), 'Fwd: Számla')
  assert.equal(forwardSubject('Fwd: Számla'), 'Fwd: Számla')
})

test('References = the original References + its Message-ID; no duplicates', () => {
  assert.deepEqual(replyReferences({ references: ['<a@x>', '<b@x>'], messageId: '<c@x>' }), ['<a@x>', '<b@x>', '<c@x>'])
  assert.deepEqual(replyReferences({ references: ['<a@x>', '<c@x>'], messageId: '<c@x>' }), ['<a@x>', '<c@x>'])
  assert.deepEqual(replyReferences({ references: [], messageId: '<c@x>' }), ['<c@x>'])
})

test('reply all: our own address (any case) is never a recipient; Reply-To wins; every address once; Cc stays Cc', () => {
  const original = {
    from: [{ name: 'Anna', address: 'anna@example.invalid' }],
    replyTo: [],
    to: [{ name: 'Én', address: 'TESZT@Example.Invalid' }, { name: 'Béla', address: 'bela@example.invalid' }, { name: '', address: 'anna@example.invalid' }],
    cc: [{ name: '', address: 'teszt@example.invalid' }, { name: 'Cili', address: 'cili@example.invalid' }],
  }
  assert.deepEqual(replyRecipients(original, { ownAddresses: [ME] }), { to: [{ name: 'Anna', address: 'anna@example.invalid' }], cc: [] })
  const all = replyRecipients(original, { all: true, ownAddresses: [ME, 'masik@sajat.invalid'] })
  assert.deepEqual(all.to.map(a => a.address), ['anna@example.invalid', 'bela@example.invalid'])
  assert.deepEqual(all.cc.map(a => a.address), ['cili@example.invalid'])
  assert.deepEqual(replyRecipients({ ...original, replyTo: [{ name: 'Lista', address: 'lista@example.invalid' }] }, { ownAddresses: [ME] }).to.map(a => a.address), ['lista@example.invalid'])
})

test('quote and forward block: the header line, escaped text, the original body', () => {
  const o = { from: [{ name: 'Kovács <Árpád>', address: 'a@x.invalid' }], to: [{ name: '', address: 'b@x.invalid' }], cc: [], subject: 'T & <S>', date: NOW, text: 'Első sor\n<második>', html: null }
  const q = quoteHtml(o)
  assert.match(q, /^<p>2026\. 11\. 12\. \d\d:00, Kovács &lt;Árpád&gt; &lt;a@x\.invalid&gt; írta:<\/p>/)
  assert.match(q, /<blockquote><p>Első sor<br>&lt;második&gt;<\/p><\/blockquote>/)
  const f = forwardHtml(o)
  assert.match(f, /Továbbított üzenet/)
  assert.match(f, /Tárgy: T &amp; &lt;S&gt;/)
  assert.match(f, /Címzett: b@x\.invalid/)
  assert.doesNotMatch(f, /Másolat:/, 'an empty Cc line is left out')
})

async function setup(t, { type = 'imap' } = {}) {
  const received = []
  const smtp = new SMTPServer({
    disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN'], logger: false,
    onAuth: (a, _s, cb) => cb(null, { user: a.username }),
    onData(stream, session, cb) {
      const chunks = []
      stream.on('data', c => chunks.push(c))
      stream.on('end', () => (received.push({ to: session.envelope.rcptTo.map(r => r.address), raw: Buffer.concat(chunks) }), cb()))
    },
  })
  smtp.on('error', () => {})
  await new Promise(r => smtp.listen(0, '127.0.0.1', r))
  onCleanup(t, () => new Promise(r => smtp.close(r)))
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type, email: ME, display_name: 'Teszt Elek', smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none', smtp_user: ME })
  const imap = new FakeImapServer().addMailbox('INBOX').addMailbox('Drafts', { specialUse: '\\Drafts' }).addMailbox('Sent', { specialUse: '\\Sent' })
  const uid = imap.addMessage('INBOX', { from: 'arpad@sender.invalid', to: ME, subject: 'x', messageId: '<cid-and-attachments@sender.invalid>', date: NOW, body: 'x', source: fixture('mail/cid-and-attachments.eml') })
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: 'jelszo', smtp: 'jelszo' }),
  }
  const storeDir = path.join(tempDir(t), 'store')
  const stores = []
  const connect = async () => {
    const client = await imap.connect()
    const add = client.messageFlagsAdd.bind(client)
    client.messageFlagsAdd = async (range, flags, opts) => (stores.push({ path: client.mailbox && client.mailbox.path, range, flags: [].concat(flags) }), add(range, flags, opts))
    return client
  }
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), notify: () => {}, connect, now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
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
  const original = index.getByUid(row.id, 'INBOX', uid)
  const serverFlags = () => [...imap.mailboxes.get('INBOX').messages.get(uid).flags].sort()
  const send = async (sid, form) => composer.sendNow(sid, { accountId: form.accountId, to: form.to, cc: form.cc, bcc: '', subject: form.subject, html: `<p>Válaszom.</p>${form.quote}`, inReplyTo: form.inReplyTo, references: form.references })
  return { db, index, row, imap, manager, reader, composer, original, received, serverFlags, send, stores, uid }
}

// ---- a reply / forward saved as a draft, opened again from Drafts, sent ----

const sourceOf = (imap, box) => [...imap.mailboxes.get(box).messages.values()].map(m => m.source.toString('latin1'))
const FORWARD_OF = /^x-shadowmail-forward-of:/im

/** mode reply / forward: prepare, save as a draft, close; the Drafts row after the sync; open it again. -> { sid, form, draftRow } */
async function draftRoundTrip(s, mode) {
  const sid = s.composer.open()
  const f = await s.composer.prepare(sid, { mode, messageId: s.original.id })
  const to = mode === 'forward' ? 'Valaki <valaki@example.invalid>' : f.to
  await s.composer.saveDraft(sid, { accountId: f.accountId, to, cc: f.cc, bcc: '', subject: f.subject, html: `<p>Piszkozat.</p>${f.quote}`, inReplyTo: f.inReplyTo, references: f.references })
  s.composer.close(sid)
  s.manager.requestSync(s.row.id, ['Drafts'])
  await until(() => s.index.listFolder({ accountId: s.row.id, folder: 'Drafts' }).length === 1)
  const draftRow = s.index.listFolder({ accountId: s.row.id, folder: 'Drafts' })[0]
  const again = s.composer.open()
  const form = await s.composer.prepare(again, { mode: 'draft', messageId: draftRow.id })
  return { sid: again, form, draftRow }
}

const sendDraft = (s, sid, form) => s.composer.sendNow(sid, { accountId: form.accountId, to: form.to, cc: form.cc, bcc: form.bcc, subject: form.subject, html: form.draftHtml, inReplyTo: form.inReplyTo, references: form.references })

test('reply: To the sender, threading headers, quote; \\Answered on the server; preparing did not mark it read; one thread', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  const form = await s.composer.prepare(sid, { mode: 'reply', messageId: s.original.id })
  assert.deepEqual(s.serverFlags(), [], 'reading the original for the reply did not set \\Seen')
  assert.equal(form.to, 'Kovács Árpád <arpad@sender.invalid>')
  assert.equal(form.cc, '')
  assert.equal(form.subject, 'Re: Beadás képpel és mellékletekkel')
  assert.equal(form.inReplyTo, '<cid-and-attachments@sender.invalid>')
  assert.deepEqual(form.references, ['<cid-and-attachments@sender.invalid>'])
  assert.deepEqual(s.composer.initial(sid).attachments, [], 'a reply carries no attachments')
  const res = await s.send(sid, form)
  assert.deepEqual(res.warnings, [])
  const got = await simpleParser(s.received[0].raw)
  assert.equal(got.inReplyTo, '<cid-and-attachments@sender.invalid>')
  assert.deepEqual([].concat(got.references), ['<cid-and-attachments@sender.invalid>'])
  assert.match(got.html, /írta:<\/p><blockquote>/)
  assert.match(got.text, /Szia!/)
  assert.deepEqual(s.serverFlags(), ['\\Answered'])
  assert.ok(s.index.get(s.original.id).flags.split(' ').includes('\\Answered'))
  // the Sent copy comes back through the sync and joins the original's thread
  await until(() => s.index.listFolder({ accountId: s.row.id, folder: 'Sent' }).length === 1)
  const thread = s.index.thread(s.original.id).map(m => m.folder)
  assert.deepEqual(thread.sort(), ['INBOX', 'Sent'])
})

test('reply all: the other recipients join, our own address is left out, Cc stays Cc', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  const form = await s.composer.prepare(sid, { mode: 'replyAll', messageId: s.original.id })
  assert.equal(form.to, 'Kovács Árpád <arpad@sender.invalid>, Másik Címzett <masik@example.invalid>')
  assert.equal(form.cc, 'Harmadik <harmadik@example.invalid>')
  assert.doesNotMatch(form.to + form.cc, /teszt@example\.invalid/i)
  await s.send(sid, form)
  assert.deepEqual(s.received[0].to.sort(), ['arpad@sender.invalid', 'harmadik@example.invalid', 'masik@example.invalid'])
})

test('forward: "Fwd:", the header block, every original attachment byte for byte; $Forwarded on the server', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  const form = await s.composer.prepare(sid, { mode: 'forward', messageId: s.original.id })
  assert.equal(form.subject, 'Fwd: Beadás képpel és mellékletekkel')
  assert.equal(form.to, '')
  assert.equal(form.inReplyTo, null)
  assert.match(form.quote, /Továbbított üzenet.*Feladó: Kovács Árpád/s)
  const originals = (await parseMessage(fixture('mail/cid-and-attachments.eml'))).attachments
  assert.deepEqual(s.composer.initial(sid).attachments.map(a => a.filename).sort(), originals.map(a => a.filename).sort())
  await s.send(sid, { ...form, to: 'Valaki <valaki@example.invalid>' })
  const got = await simpleParser(s.received[0].raw)
  const bySha = list => list.map(a => `${a.filename}:${sha(a.content)}`).sort()
  assert.deepEqual(bySha(got.attachments), bySha(originals))
  assert.deepEqual(s.serverFlags(), ['$Forwarded'])
})

test('the original flag failing (connection gone after the send) is a warning, the message is sent', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  const form = await s.composer.prepare(sid, { mode: 'reply', messageId: s.original.id })
  s.imap.refuseOps.add('flags+')
  const res = await s.send(sid, form)
  assert.equal(res.sent, true)
  assert.ok(res.warnings.some(w => w.startsWith('origin_flag_failed')), JSON.stringify(res.warnings))
  assert.equal(s.received.length, 1)
})

test('an unknown original: no session is left open', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await assert.rejects(s.composer.prepare(sid, { mode: 'reply', messageId: 999_999 }), { code: 'not_found' })
})

test('replyRecipients: a message we sent: the original To/Cc, like Thunderbird; to oneself -> oneself', () => {
  const me = { name: 'Én', address: 'en@sajat.invalid' }
  const sent = { from: [me], to: [{ name: 'A', address: 'a@x.invalid' }], cc: [{ name: 'B', address: 'b@x.invalid' }] }
  const own = ['EN@sajat.invalid'] // any case
  assert.deepEqual(replyRecipients(sent, { ownAddresses: own }), { to: [{ name: 'A', address: 'a@x.invalid' }], cc: [] })
  assert.deepEqual(replyRecipients(sent, { all: true, ownAddresses: own }), { to: [{ name: 'A', address: 'a@x.invalid' }], cc: [{ name: 'B', address: 'b@x.invalid' }] })
  // our own address among the original recipients is still left out
  const withMe = { ...sent, to: [...sent.to, me], cc: [...sent.cc, { address: 'en@SAJAT.invalid' }] }
  assert.deepEqual(replyRecipients(withMe, { all: true, ownAddresses: own }).to.map(a => a.address), ['a@x.invalid'])
  assert.deepEqual(replyRecipients(withMe, { all: true, ownAddresses: own }).cc.map(a => a.address), ['b@x.invalid'])
  // to oneself: To is not empty, it is the own address
  const self = { from: [me], to: [me], cc: [] }
  assert.deepEqual(replyRecipients(self, { ownAddresses: own }).to, [me])
  assert.deepEqual(replyRecipients(self, { all: true, ownAddresses: own }), { to: [me], cc: [] })
})

// ---- names with specials, reused row ids ----

test('displayAddress: a name with ( ) \\ , : @ " is quoted without " and \\, and parses back to the same address', () => {
  const names = ['x(', 'a)b', 'Kovács (Kft.)', 'Back\\slash\\', 'x,\\', 'a, b\\', 'Q: a@evil.test b@evil.test', '"Idéz"', 'attacker@evil.test', 'Sima Név']
  for (const name of names) {
    const text = displayAddress({ name, address: 'victim@test.local' })
    const { ok, bad } = parseRecipients(text)
    assert.deepEqual([bad, ok.map(a => a.address)], [[], ['victim@test.local']], `${name} -> ${text}`)
  }
  // a list of such names: every address stays its own, nothing smuggled in
  const list = [{ name: 'x,\\', address: 'v1@test.local' }, { name: 'B, attacker@evil.test', address: 'v2@test.local' }].map(displayAddress).join(', ')
  assert.deepEqual(parseRecipients(list).ok.map(a => a.address), ['v1@test.local', 'v2@test.local'])
})

test('reply: the original deleted while the reply is written, its row id reused -> no flag on another message', async t => {
  const server = new SMTPServer({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true, logger: false, onAuth: (a, s, cb) => cb(null, { user: 'u' }), onData: (st, s, cb) => { st.resume(); st.on('end', () => cb()) } })
  server.on('error', () => {})
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  onCleanup(t, () => new Promise(r => server.close(r)))
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db, { type: 'pop3', email: 'en@example.invalid', smtp_host: '127.0.0.1', smtp_port: server.server.address().port, smtp_security: 'none', smtp_user: 'u' })
  index.ensureLocalFolders(acc.id, [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Trash', specialUse: '\\Trash' }])
  const base = { account_id: acc.id, folder: 'INBOX', uid: null, in_reply_to: null, refs: null, from_addr: 'mas@example.invalid', from_name: 'Mas', to_addrs: 'en@example.invalid', cc_addrs: '', date: 1, idate: 1, flags: '', size: 1, has_attachments: 0, attachments: null, body_state: 0, sender_text: 'mas', recipients_text: 'en' }
  index.insertMany([{ ...base, message_id: '<old@x>', pop3_uidl: 'u1', subject: 'regi' }, { ...base, message_id: '<orig@x>', pop3_uidl: 'u2', subject: 'eredeti' }])
  const orig = db.prepare("SELECT id FROM messages WHERE message_id = '<orig@x>'").get().id
  const raw = Buffer.from('From: Mas <mas@example.invalid>\r\nTo: en@example.invalid\r\nSubject: eredeti\r\nMessage-ID: <orig@x>\r\n\r\nszia\r\n')
  const reader = { source: async id => ({ row: index.get(id), source: raw }) }
  const store = { list: () => db.prepare('SELECT * FROM accounts').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id), passwordsFor: () => ({ incoming: 'p', smtp: 'p' }) }
  const composer = new Composer({ index, store, reader, contacts: new Contacts(db), storeDir: path.join(tempDir(t), 'store'), withConnection: async () => { throw new Error('no imap') } })
  const sid = composer.open()
  const f = await composer.prepare(sid, { mode: 'reply', messageId: orig })
  index.deleteIds([orig]) // gone while the reply is written; the Sent copy will get its id
  await composer.sendNow(sid, { accountId: acc.id, to: f.to, cc: '', bcc: '', subject: f.subject, html: '<p>valasz</p>', inReplyTo: f.inReplyTo, references: f.references })
  const rows = db.prepare('SELECT id, folder, flags FROM messages ORDER BY id').all()
  assert.ok(rows.every(r => !r.flags.includes('\\Answered')), JSON.stringify(rows))
})

test('the reply and forward header follows the interface language: English after the switch, Hungarian again after it', async t => {
  const s = await setup(t)
  const header = async mode => {
    const sid = s.composer.open()
    const form = await s.composer.prepare(sid, { mode, messageId: s.original.id })
    s.composer.close(sid)
    return form.quote
  }
  try {
    setLanguage('en')
    const reply = await header('reply')
    assert.match(reply, /^<p>\d\d\/\d\d\/2026, \d\d:\d\d, Kovács Árpád &lt;arpad@sender\.invalid&gt; wrote:<\/p>/)
    assert.doesNotMatch(reply, /írta/)
    const forward = await header('forward')
    assert.match(forward, /---------- Forwarded message ----------/)
    assert.match(forward, /From: Kovács Árpád &lt;arpad@sender\.invalid&gt;/)
    assert.match(forward, /Subject: Beadás képpel és mellékletekkel/)
    assert.doesNotMatch(forward, /Továbbított|Feladó|Tárgy/)
    setLanguage('hu')
    const replyHu = await header('reply')
    assert.match(replyHu, /^<p>2026\. \d\d\. \d\d\. \d\d:\d\d, Kovács Árpád &lt;arpad@sender\.invalid&gt; írta:<\/p>/)
    const forwardHu = await header('forward')
    assert.match(forwardHu, /Továbbított üzenet/)
    assert.match(forwardHu, /Tárgy: Beadás képpel és mellékletekkel/)
    assert.doesNotMatch(forwardHu, /Forwarded|wrote/)
  } finally {
    setLanguage('hu')
  }
})

test('a reply saved as a draft, opened again from Drafts and sent: \\Answered on the original, one STORE', async t => {
  const s = await setup(t)
  const { sid, form } = await draftRoundTrip(s, 'reply')
  assert.equal(form.inReplyTo, '<cid-and-attachments@sender.invalid>')
  const before = s.stores.length
  const res = await sendDraft(s, sid, form)
  assert.deepEqual(res.warnings, [])
  assert.deepEqual(s.serverFlags(), ['\\Answered'])
  assert.ok(s.index.get(s.original.id).flags.split(' ').includes('\\Answered'))
  assert.deepEqual(s.stores.slice(before).filter(x => x.flags.includes('\\Answered')).length, 1, JSON.stringify(s.stores))
})

test('a forward saved as a draft, opened again and sent: $Forwarded on the original; X-ShadowMail-Forward-Of in the draft, never sent nor in Sent', async t => {
  const s = await setup(t)
  const { sid, form } = await draftRoundTrip(s, 'forward')
  assert.ok(sourceOf(s.imap, 'Drafts').some(src => /^x-shadowmail-forward-of: <cid-and-attachments@sender\.invalid>$/im.test(src)), 'the draft carries the original')
  const before = s.stores.length
  await sendDraft(s, sid, form)
  assert.deepEqual(s.serverFlags(), ['$Forwarded'])
  assert.deepEqual(s.stores.slice(before).filter(x => x.flags.includes('$Forwarded')).length, 1)
  assert.equal(s.received.length, 1)
  assert.doesNotMatch(s.received[0].raw.toString('latin1'), FORWARD_OF, 'the outgoing message')
  const sent = sourceOf(s.imap, 'Sent')
  assert.equal(sent.length, 1)
  assert.doesNotMatch(sent[0], FORWARD_OF, 'the Sent copy')
})

test('a forward draft saved twice keeps the header; reopened and saved again too', async t => {
  const s = await setup(t)
  const { sid, form } = await draftRoundTrip(s, 'forward')
  await s.composer.saveDraft(sid, { accountId: form.accountId, to: form.to, cc: form.cc, bcc: '', subject: form.subject, html: `${form.draftHtml}<p>Még egy sor.</p>` })
  const drafts = sourceOf(s.imap, 'Drafts')
  assert.equal(drafts.length, 1, 'one copy in Drafts')
  assert.match(drafts[0], /^x-shadowmail-forward-of: <cid-and-attachments@sender\.invalid>$/im)
})

test('a draft of another program (no X-Mailer: ShadowMail) with an In-Reply-To: no origin, no flag, the send works', async t => {
  const s = await setup(t)
  s.imap.addMessage('Drafts', {
    from: ME, to: 'arpad@sender.invalid', subject: 'Re: x', messageId: '<idegen@example.invalid>', inReplyTo: '<cid-and-attachments@sender.invalid>', date: NOW, flags: ['\\Draft', '\\Seen'], body: 'masik',
    source: `From: ${ME}\r\nTo: arpad@sender.invalid\r\nSubject: Re: x\r\nMessage-ID: <idegen@example.invalid>\r\nIn-Reply-To: <cid-and-attachments@sender.invalid>\r\nX-ShadowMail-Forward-Of: <cid-and-attachments@sender.invalid>\r\nX-Mailer: Masik Program\r\n\r\nmasik\r\n`,
  })
  s.manager.requestSync(s.row.id, ['Drafts'])
  await until(() => s.index.listFolder({ accountId: s.row.id, folder: 'Drafts' }).length === 1)
  const draftRow = s.index.listFolder({ accountId: s.row.id, folder: 'Drafts' })[0]
  const sid = s.composer.open()
  const form = await s.composer.prepare(sid, { mode: 'draft', messageId: draftRow.id })
  const res = await sendDraft(s, sid, form)
  assert.equal(res.sent, true)
  assert.deepEqual(s.serverFlags(), [])
  assert.equal(s.stores.filter(x => x.flags.includes('\\Answered') || x.flags.includes('$Forwarded')).length, 0)
})

test('the original gone (only a Sent / Drafts copy with its Message-ID left): no flag, no warning, the send works', async t => {
  const s = await setup(t)
  const { sid, form } = await draftRoundTrip(s, 'reply')
  // the original leaves; a copy with the same Message-ID stays in Sent (our own sent copy of it, say)
  s.imap.addMessage('Sent', { from: ME, to: 'x@example.invalid', subject: 'x', messageId: '<cid-and-attachments@sender.invalid>', date: NOW, body: 'masolat' })
  s.imap.mailboxes.get('INBOX').messages.delete(s.uid)
  s.manager.requestSync(s.row.id)
  await until(() => !s.index.get(s.original.id) && s.index.listFolder({ accountId: s.row.id, folder: 'Sent' }).length === 1)
  const before = s.stores.length
  const res = await sendDraft(s, sid, form)
  assert.equal(res.sent, true)
  assert.deepEqual(res.warnings, [])
  assert.equal(s.stores.slice(before).filter(x => x.flags.includes('\\Answered')).length, 0)
  const sentRows = s.db.prepare("SELECT flags FROM messages WHERE folder = 'Sent'").all()
  assert.ok(sentRows.every(r => !r.flags.includes('\\Answered')), JSON.stringify(sentRows))
})

test('the original deleted, a Sent copy with its Message-ID takes its row id: that copy is not marked', async t => {
  const server = new SMTPServer({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true, logger: false, onAuth: (a, s, cb) => cb(null, { user: 'u' }), onData: (st, s, cb) => { st.resume(); st.on('end', () => cb()) } })
  server.on('error', () => {})
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  onCleanup(t, () => new Promise(r => server.close(r)))
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db, { type: 'pop3', email: 'en@example.invalid', smtp_host: '127.0.0.1', smtp_port: server.server.address().port, smtp_security: 'none', smtp_user: 'u' })
  index.ensureLocalFolders(acc.id, [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Trash', specialUse: '\\Trash' }])
  const base = { account_id: acc.id, folder: 'INBOX', uid: null, in_reply_to: null, refs: null, from_addr: 'mas@example.invalid', from_name: 'Mas', to_addrs: 'en@example.invalid', cc_addrs: '', date: 1, idate: 1, flags: '', size: 1, has_attachments: 0, attachments: null, body_state: 0, sender_text: 'mas', recipients_text: 'en' }
  // the original is the last row (the highest rowid): a row inserted after it is deleted takes its id
  index.insertMany([{ ...base, message_id: '<old@x>', pop3_uidl: 'u1', subject: 'regi' }, { ...base, message_id: '<orig@x>', pop3_uidl: 'u2', subject: 'eredeti' }])
  const orig = db.prepare("SELECT id FROM messages WHERE message_id = '<orig@x>'").get().id
  const raw = Buffer.from('From: Mas <mas@example.invalid>\r\nTo: en@example.invalid\r\nSubject: eredeti\r\nMessage-ID: <orig@x>\r\n\r\nszia\r\n')
  const reader = { source: async id => ({ row: index.get(id), source: raw }) }
  const store = { list: () => db.prepare('SELECT * FROM accounts').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id), passwordsFor: () => ({ incoming: 'p', smtp: 'p' }) }
  const composer = new Composer({ index, store, reader, contacts: new Contacts(db), storeDir: path.join(tempDir(t), 'store'), withConnection: async () => { throw new Error('no imap') } })
  const sid = composer.open()
  const f = await composer.prepare(sid, { mode: 'reply', messageId: orig })
  index.deleteIds([orig])
  index.insertMany([{ ...base, folder: 'Sent', message_id: '<orig@x>', pop3_uidl: null, subject: 'masolat' }])
  assert.equal(db.prepare("SELECT id FROM messages WHERE folder = 'Sent' AND message_id = '<orig@x>'").get().id, orig, 'the copy took the id (else this case tests nothing)')
  await composer.sendNow(sid, { accountId: acc.id, to: f.to, cc: '', bcc: '', subject: f.subject, html: '<p>valasz</p>', inReplyTo: f.inReplyTo, references: f.references })
  const rows = db.prepare('SELECT id, folder, flags FROM messages ORDER BY id').all()
  assert.ok(rows.every(r => !r.flags.includes('\\Answered')), JSON.stringify(rows))
})
