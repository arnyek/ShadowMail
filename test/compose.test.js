// Composing and sending against a local SMTP server (smtp-server) that keeps every message byte
// for byte, in all three security modes, plus the fake IMAP server for Drafts / Sent and a POP3
// account's local folders. Nothing leaves the machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { memoryIndex, addAccount, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { selfSignedCert } from './helpers/fake-servers.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { Composer, parseRecipients, MAX_ATTACHMENTS_BYTES } from '../app/main/compose.js'
import { registerComposeIpc, parseForm, COMPOSE_CHANNELS, guardComposerClose } from '../app/main/ipc/compose.js'
import { Contacts } from '../core/db/contacts.js'
import { People } from '../core/db/people.js'
import { composeMessage } from '../core/smtp/compose.js'
import { hu } from '../app/renderer/i18n/hu.js'

const USER = 'teszt@example.invalid'
const PASS = 'Helyes-Jelszo-123'
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

/** A local SMTP server keeping { envelope, raw } of every message. mode: none | starttls | tls */
async function startSmtp(t, { mode = 'none', cert = null, refuse = [] } = {}) {
  const received = []
  const server = new SMTPServer({
    // refuse: addresses answered with 550 at RCPT TO
    onRcptTo(address, session, cb) {
      if (refuse.includes(address.address)) cb(Object.assign(new Error('No such user here'), { responseCode: 550 }))
      else cb()
    },
    secure: mode === 'tls',
    ...(mode !== 'none' ? cert : {}),
    disabledCommands: mode === 'none' ? ['STARTTLS'] : [],
    allowInsecureAuth: mode === 'none',
    authMethods: ['PLAIN', 'LOGIN'],
    logger: false,
    onAuth(auth, session, cb) {
      if (auth.username === USER && auth.password === PASS) cb(null, { user: USER, secure: session.secure })
      else cb(new Error('Invalid username or password'))
    },
    onData(stream, session, cb) {
      const chunks = []
      stream.on('data', c => chunks.push(c))
      stream.on('end', () => {
        received.push({ secure: session.secure, from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map(r => r.address), raw: Buffer.concat(chunks) })
        cb()
      })
    },
  })
  server.on('error', () => {})
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  onCleanup(t, () => new Promise(r => server.close(r)))
  return { port: server.server.address().port, received }
}

function tlsOff(account) {
  return { ...account, tls_verify: 0 } // the test certificate is self-signed
}

async function setup(t, { type = 'imap', smtpMode = 'none', cert = null, saveSent = 1, password = PASS, refuse = [] } = {}) {
  const smtp = await startSmtp(t, { mode: smtpMode, cert, refuse })
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, {
    type, email: USER, display_name: 'Kovács Árpád', smtp_host: '127.0.0.1', smtp_port: smtp.port, smtp_security: smtpMode, smtp_user: USER,
    save_sent_to_server: saveSent, tls_verify: smtpMode === 'none' ? 1 : 0,
  })
  const imap = new FakeImapServer().addMailbox('INBOX').addMailbox('Drafts', { specialUse: '\\Drafts' }).addMailbox('Sent', { specialUse: '\\Sent' })
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: password, smtp: password }),
  }
  const dataDir = tempDir(t)
  const storeDir = path.join(dataDir, 'store')
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), notify: () => {}, connect: () => imap.connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  if (type === 'imap') {
    manager.startAll()
    await until(() => manager.entries.get(row.id).idle.connected)
  } else {
    index.ensureLocalFolders(row.id, [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Trash', specialUse: '\\Trash' }])
  }
  const people = new People(db, { now: () => NOW })
  const contacts = new Contacts(db, { people })
  const composer = new Composer({
    index, store, contacts, storeDir, sealed: sealedStore(storeDir), dataDir,
    withConnection: (id, fn) => manager.withConnection(id, fn),
    requestSync: (id, f) => manager.requestSync(id, f),
    now: () => NOW,
  })
  const dir = tempDir(t)
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(20_000)])
  const pdfPath = path.join(dir, 'számla 2026.pdf')
  fs.writeFileSync(pdfPath, pdf)
  const txtPath = path.join(dir, 'árvíztűrő tükörfúrógép.txt')
  fs.writeFileSync(txtPath, 'Ékezetes tartalom: őű\r\n')
  return { db, index, row, smtp, imap, manager, composer, contacts, people, storeDir, dataDir, pdf, pdfPath, txtPath }
}

const form = (s, over = {}) => ({
  accountId: s.row.id,
  to: 'Teszt Címzett <teszt@example.invalid>',
  cc: '',
  bcc: '',
  subject: 'Ékezetes tárgy: árvíztűrő tükörfúrógép',
  html: '<p>Szia! <b>Félkövér</b> és <i>dőlt</i>.</p><ul><li>egy</li><li>kettő</li></ul>',
  ...over,
})

test('send to itself: arrives, attachments byte for byte (a PDF and an accented name), accented subject and name, HTML + text', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  const added = s.composer.addFiles(sid, [s.pdfPath, s.txtPath])
  assert.deepEqual(added.map(a => a.filename), ['számla 2026.pdf', 'árvíztűrő tükörfúrógép.txt'])
  const res = await s.composer.sendNow(sid, form(s))
  assert.equal(res.sent, true)
  assert.equal(s.smtp.received.length, 1)
  const got = await simpleParser(s.smtp.received[0].raw)
  assert.equal(got.subject, 'Ékezetes tárgy: árvíztűrő tükörfúrógép')
  assert.deepEqual(got.from.value, [{ address: USER, name: 'Kovács Árpád' }])
  assert.match(got.html, /<b>Félkövér<\/b>/)
  assert.match(got.text, /Félkövér/)
  assert.match(got.text, /egy/)
  assert.deepEqual(got.attachments.map(a => [a.filename, sha(a.content)]), [
    ['számla 2026.pdf', sha(s.pdf)],
    ['árvíztűrő tükörfúrógép.txt', sha(fs.readFileSync(s.txtPath))],
  ])
  // the raw headers are pure ASCII (encoded words), the name is not mangled
  const head = s.smtp.received[0].raw.toString('latin1').split('\r\n\r\n')[0]
  assert.ok(!/[^\x00-\x7f]/.test(head), 'headers are 7-bit')
  assert.ok(s.contacts.suggest('teszt').some(c => c.address === 'teszt@example.invalid'), 'the recipient is a contact now')
})

test('Bcc: in the envelope, not in the sent message; kept in the Sent copy only', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await s.composer.sendNow(sid, form(s, { cc: 'Másolat <cc@example.invalid>', bcc: 'Titkos <titkos@example.invalid>' }))
  const r = s.smtp.received[0]
  assert.deepEqual(r.to.sort(), ['cc@example.invalid', 'teszt@example.invalid', 'titkos@example.invalid'])
  assert.doesNotMatch(r.raw.toString('latin1'), /titkos@example\.invalid/i)
  assert.doesNotMatch(r.raw.toString('latin1'), /^bcc:/im)
  const sent = [...s.imap.mailboxes.get('Sent').messages.values()]
  assert.equal(sent.length, 1)
  assert.match(sent[0].source.toString('latin1'), /^Bcc: .*titkos@example\.invalid/im)
})

test('Sent: exactly one copy on the server (\\Seen); none when save_sent_to_server is off (Gmail)', async t => {
  const s = await setup(t)
  await s.composer.sendNow(s.composer.open(), form(s))
  const sent = [...s.imap.mailboxes.get('Sent').messages.values()]
  assert.equal(sent.length, 1)
  assert.ok(sent[0].flags.has('\\Seen'))
  assert.equal(sha(sent[0].source).length, 64)
  const g = await setup(t, { saveSent: 0 })
  await g.composer.sendNow(g.composer.open(), form(g))
  assert.equal(g.imap.mailboxes.get('Sent').messages.size, 0)
  assert.equal(g.smtp.received.length, 1)
})

test('drafts: saved three times -> exactly one copy in Drafts; sending removes it; works without UIDPLUS too', async t => {
  for (const uidplus of [true, false]) {
    const s = await setup(t)
    s.imap.uidplus = uidplus
    const sid = s.composer.open()
    for (let i = 0; i < 3; i++) await s.composer.saveDraft(sid, form(s, { subject: `Piszkozat ${i}` }))
    const drafts = [...s.imap.mailboxes.get('Drafts').messages.values()]
    assert.equal(drafts.length, 1, `uidplus=${uidplus}`)
    assert.ok(drafts[0].flags.has('\\Draft'))
    assert.match(drafts[0].source.toString(), /Subject: Piszkozat 2/)
    await s.composer.sendNow(sid, form(s))
    assert.equal(s.imap.mailboxes.get('Drafts').messages.size, 0, 'the draft goes after sending')
  }
})

test('a failed send keeps the message as a draft and says why; a wrong SMTP password is not retried', async t => {
  const s = await setup(t, { password: 'rossz-jelszo-123' })
  const sid = s.composer.open()
  await assert.rejects(s.composer.sendNow(sid, form(s)), err => {
    assert.equal(err.code, 'auth_failed')
    assert.equal(err.draftSaved, true)
    return true
  })
  assert.equal(s.smtp.received.length, 0)
  assert.equal(s.imap.mailboxes.get('Drafts').messages.size, 1, 'kept as a draft')
  assert.equal(s.imap.mailboxes.get('Sent').messages.size, 0)
})

test('the server down: error, draft kept; bad and missing recipients are refused before anything is sent', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await assert.rejects(s.composer.sendNow(sid, form(s, { to: 'nem-cim, jo@example.invalid' })), err => err.code === 'bad_address' && err.detail.includes('nem-cim'))
  await assert.rejects(s.composer.sendNow(sid, form(s, { to: '' })), { code: 'no_recipients' })
  const down = { ...form(s) }
  s.db.prepare('UPDATE accounts SET smtp_port = 1 WHERE id = ?').run(s.row.id)
  await assert.rejects(s.composer.sendNow(sid, down), err => err.code === 'connection_refused' && err.draftSaved === true)
  assert.equal(s.smtp.received.length, 0)
  assert.equal(s.imap.mailboxes.get('Drafts').messages.size, 1)
})

for (const mode of ['starttls', 'tls']) {
  test(`SMTP security "${mode}": sent over TLS`, async t => {
    const cert = selfSignedCert(t)
    if (!cert) return t.skip('openssl not available')
    const s = await setup(t, { smtpMode: mode, cert })
    await s.composer.sendNow(s.composer.open(), form(s))
    assert.equal(s.smtp.received.length, 1)
    assert.equal(s.smtp.received[0].secure, true)
  })
}

test('POP3 account: draft and Sent copy in the local folders, one each', async t => {
  const s = await setup(t, { type: 'pop3' })
  const sid = s.composer.open()
  s.composer.addFiles(sid, [s.pdfPath])
  await s.composer.saveDraft(sid, form(s, { subject: 'Helyi piszkozat' }))
  await s.composer.saveDraft(sid, form(s, { subject: 'Helyi piszkozat 2' }))
  const drafts = s.index.listFolder({ accountId: s.row.id, folder: 'Drafts' })
  assert.deepEqual(drafts.map(m => m.subject), ['Helyi piszkozat 2'])
  await s.composer.sendNow(sid, form(s))
  assert.equal(s.index.listFolder({ accountId: s.row.id, folder: 'Drafts' }).length, 0)
  const sent = s.index.listFolder({ accountId: s.row.id, folder: 'Sent' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].has_attachments, 1)
  const row = s.index.get(sent[0].id)
  assert.ok(fs.existsSync(path.join(s.storeDir, row.store_path)))
  assert.equal(s.index.search({ accountId: s.row.id, query: 'Félkövér' }).length, 1, 'the sent text is searchable')
})

test('attachments: over the size limit refused; a folder is not a file', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  const big = path.join(tempDir(t), 'nagy.bin')
  fs.writeFileSync(big, Buffer.alloc(MAX_ATTACHMENTS_BYTES + 1))
  assert.throws(() => s.composer.addFiles(sid, [big]), { code: 'too_large' })
  assert.throws(() => s.composer.addFiles(sid, [path.dirname(big)]), { code: 'not_a_file' })
  assert.deepEqual(s.composer.attachmentList(sid), [])
})

test('recipients: names with accents and commas, several separators, bad ones listed', () => {
  const r = parseRecipients(['"Kovács, Árpád" <arpad@example.invalid>, b@example.invalid', 'Nagy Béla <bela@example.invalid>; rossz@', ''])
  assert.deepEqual(r.ok.map(a => a.address), ['arpad@example.invalid', 'b@example.invalid', 'bela@example.invalid'])
  assert.equal(r.ok[0].name, 'Kovács, Árpád')
  assert.ok(r.bad.length >= 1)
})

test('contacts: sent recipients first, then senders of received mail; LIKE wildcards are literal', async t => {
  const { db } = memoryIndex(t)
  const c = new Contacts(db)
  c.recordSent([{ name: 'Kovács Anna', address: 'Anna@Example.invalid' }], 1)
  c.recordSent([{ name: '', address: 'anna@example.invalid' }], 2)
  assert.deepEqual(c.suggest('anna'), [{ name: 'Kovács Anna', address: 'anna@example.invalid' }])
  assert.deepEqual(c.suggest('a'), [], 'at least 2 characters')
  assert.deepEqual(c.suggest('%'), [])
  assert.deepEqual(c.suggest('_x'), [])
})

test('composeMessage: one Message-ID for the same session, threading headers', async () => {
  const m = await composeMessage({ from: { name: 'Én', address: 'en@example.invalid' }, to: [{ address: 'te@example.invalid' }], subject: 'Re: x', text: 'szia', inReplyTo: '<a@b>', references: ['<z@b>', '<a@b>'] })
  const p = await simpleParser(m.raw)
  assert.equal(p.inReplyTo, '<a@b>')
  assert.deepEqual([].concat(p.references), ['<z@b>', '<a@b>'])
  assert.match(m.messageId, /^<[0-9a-f-]+@example\.invalid>$/)
})

test('compose IPC: only the app pages, the form checked, error codes and draftSaved passed on', async t => {
  const s = await setup(t, { password: 'rossz-jelszo-123' })
  const handlers = new Map()
  const opened = []
  registerComposeIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    composer: s.composer,
    store: { list: () => [{ id: s.row.id, name: 'x', email: USER, display_name: 'Kovács Árpád', signature: 'sig', type: 'imap', in_password: 'never' }] },
    contacts: s.contacts,
    openWindow: id => {
      opened.push(id)
      return { on: () => {}, isDestroyed: () => false, close: () => {}, destroy: () => {} }
    },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    windowOf: () => null,
    isTrustedSender: e => e.ok,
  })
  const call = (ch, ...args) => handlers.get(ch)({ ok: true }, ...args)
  assert.deepEqual([...handlers.keys()].sort(), [...COMPOSE_CHANNELS].sort())
  assert.deepEqual(await handlers.get('compose:open')({ ok: false }), { ok: false, error: 'untrusted_sender' })
  const { sessionId } = await call('compose:open')
  assert.deepEqual(opened, [sessionId])
  const acc = await call('compose:accounts')
  assert.ok(!('in_password' in acc.accounts[0]), 'only the listed fields go to the page')
  for (const bad of [null, { accountId: 'x' }, { accountId: s.row.id, to: 5 }, { accountId: s.row.id, references: 'x' }]) {
    assert.deepEqual(await call('compose:send', sessionId, bad), { ok: false, error: 'bad_request' })
  }
  assert.deepEqual(await call('compose:send', 'not-a-session', { accountId: s.row.id }), { ok: false, error: 'bad_request' })
  const res = await call('compose:send', sessionId, { accountId: s.row.id, to: USER, subject: 'x', html: '<p>x</p>' })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'auth_failed')
  assert.equal(res.draftSaved, true)
  assert.deepEqual(parseForm({ accountId: 1 }), { accountId: 1, to: '', cc: '', bcc: '', subject: '', html: '', inReplyTo: null, references: [] })
})

test('composer window close: asks while the app runs; when the app quits it closes without asking', () => {
  const listeners = {}
  const sent = []
  const win = { on: (ev, fn) => (listeners[ev] = fn), webContents: { send: ch => sent.push(ch) } }
  let quitting = false
  guardComposerClose(win, () => quitting)
  const close = () => {
    let prevented = false
    listeners.close({ preventDefault: () => (prevented = true) })
    return prevented
  }
  assert.equal(close(), true, 'the X button: held back')
  assert.deepEqual(sent, ['compose:closeRequested'], 'the page is asked')
  quitting = true
  assert.equal(close(), false, 'quitting: closes at once')
  assert.equal(sent.length, 1, 'no question while quitting')
  quitting = false
  win.__allowClose = true
  assert.equal(close(), false, 'after the page decided: closes')
})

// ---- partly refused sends, unsaved text, attachments of the data folder ----
import { createDraftState } from '../app/renderer/src/draft-state.js'

test('draft state: a change typed DURING a save stays unsaved', () => {
  const d = createDraftState()
  assert.equal(d.dirty, false)
  d.touch()
  const token = d.beginSave() // a slow autosave starts
  d.touch() // the user types on meanwhile
  d.saved(token) // the save finishes
  assert.equal(d.dirty, true, 'the new text is not marked saved: closing asks')
  d.saved(d.beginSave())
  assert.equal(d.dirty, false)
  d.saved(0) // an older save finishing late does not undo anything
  assert.equal(d.dirty, false)
})

test('send: a refused recipient comes back to the page and is not stored as a contact', async t => {
  const s = await setup(t, { refuse: ['nincs@example.invalid'] })
  const sid = s.composer.open()
  const res = await s.composer.sendNow(sid, form(s, { to: 'Jó <ok@example.invalid>, Nincs <nincs@example.invalid>' }))
  assert.deepEqual(res.rejected, ['nincs@example.invalid'])
  assert.equal(res.sent, true)
  assert.deepEqual(s.smtp.received[0].to, ['ok@example.invalid'])
  const known = s.contacts.suggest('example').map(c => c.address)
  assert.ok(known.includes('ok@example.invalid') && !known.includes('nincs@example.invalid'), JSON.stringify(known))
})

test('send: a failed Sent copy comes back as a warning', async t => {
  const s = await setup(t)
  s.imap.refuseOps.add('append')
  const sid = s.composer.open()
  const res = await s.composer.sendNow(sid, form(s, { to: 'ok@example.invalid' }))
  assert.equal(res.sent, true)
  assert.ok(res.warnings.some(w => w.startsWith('sent_copy_failed')), JSON.stringify(res.warnings))
  const text = hu.composeSentWithWarnings(res.rejected, res.warnings)
  assert.match(text, /Elküldött mappába nem került másolat/)
})

test('attachments: nothing from the own data folder of the app (mail.sqlite, the cache)', async t => {
  const s = await setup(t)
  fs.mkdirSync(s.storeDir, { recursive: true })
  const secret = path.join(s.dataDir, 'mail.sqlite')
  fs.writeFileSync(secret, 'db')
  const cached = path.join(s.storeDir, 'x.eml')
  fs.writeFileSync(cached, 'eml')
  const sid = s.composer.open()
  assert.throws(() => s.composer.addFiles(sid, [secret]), { code: 'forbidden_path' })
  assert.throws(() => s.composer.addFiles(sid, [cached]), { code: 'forbidden_path' })
  assert.equal(s.composer.addFiles(sid, [s.pdfPath]).length, 1, 'a file outside is fine')
})

test('From changed to another account: the new draft first, the old one goes only after that worked', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, form(s, { subject: 'Első változat' }))
  const draftsOf = () => [...s.imap.mailboxes.get('Drafts').messages.values()].map(m => /Subject: (.*)/.exec(m.source.toString())[1].trim())
  assert.equal(draftsOf().length, 1)
  // another account WITHOUT a Drafts folder: the save fails, the old draft must stay
  const noDrafts = addAccount(s.db, { type: 'pop3', email: 'masik@example.invalid' })
  await assert.rejects(s.composer.saveDraft(sid, form(s, { accountId: noDrafts.id, subject: 'Második' })), { code: 'no_drafts_folder' })
  assert.equal(draftsOf().length, 1, 'the old draft is still on the server')
  // another account WITH Drafts (POP3, local): saved there, then the old one goes
  const pop = addAccount(s.db, { type: 'pop3', email: 'pop@example.invalid' })
  s.index.ensureLocalFolders(pop.id, [{ path: 'INBOX' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Sent', specialUse: '\\Sent' }])
  await s.composer.saveDraft(sid, form(s, { accountId: pop.id, subject: 'Harmadik' }))
  assert.equal(s.index.listFolder({ accountId: pop.id, folder: 'Drafts', limit: 10 }).length, 1, 'saved in the new account')
  await until(() => draftsOf().length === 0)
  assert.deepEqual(draftsOf(), [], 'and only then removed from the old one')
})

test('a send adds To, Cc and Bcc as automatic people; again: none new, the name is not overwritten; a refused address is no person', async t => {
  const s = await setup(t, { refuse: ['nincs@example.invalid'] })
  const sid = s.composer.open()
  const res = await s.composer.sendNow(sid, form(s, { to: 'Első Ember <egy@example.invalid>, Nincs <nincs@example.invalid>', cc: 'Második <ketto@example.invalid>', bcc: 'harom@example.invalid' }))
  assert.equal(res.sent, true)
  assert.deepEqual(res.rejected, ['nincs@example.invalid'])
  const people = () => s.db.prepare('SELECT p.display_name AS name, p.source, e.address FROM people p JOIN person_emails e ON e.person_id = p.id ORDER BY e.address').all()
  assert.deepEqual(people(), [
    { name: 'Első Ember', source: 'auto', address: 'egy@example.invalid' },
    { name: '', source: 'auto', address: 'harom@example.invalid' },
    { name: 'Második', source: 'auto', address: 'ketto@example.invalid' },
  ])
  // the same once more, with another name for the first: nothing new, nothing rewritten
  const sid2 = s.composer.open()
  await s.composer.sendNow(sid2, form(s, { to: 'Más Név <egy@example.invalid>', cc: 'Második <ketto@example.invalid>', bcc: 'harom@example.invalid' }))
  assert.equal(s.people.count(), 3)
  assert.equal(people()[0].name, 'Első Ember')
})

test('a deleted person is not added again by a send; saved by hand (or added from a message) it can come again', async t => {
  const s = await setup(t)
  const send = async to => s.composer.sendNow(s.composer.open(), form(s, { to }))
  await send('Törölt <torolt@example.invalid>')
  const id = s.people.list().items[0].id
  assert.equal(s.people.delete([id]), 1)
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM contact_suppressed').get().n, 1)
  await send('Törölt <torolt@example.invalid>')
  assert.equal(s.people.count(), 0, 'the suppressed address does not come back')
  // by hand: off the list, and a later delete + send behaves the same again
  const again = s.people.save({ displayName: 'Kézi', emails: ['torolt@example.invalid'] })
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM contact_suppressed').get().n, 0)
  s.people.delete([again])
  const fromMessage = s.people.addSender({ address: 'Torolt@Example.invalid', name: 'Feladó' })
  assert.equal(fromMessage.created, true)
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM contact_suppressed').get().n, 0)
  assert.equal(s.people.get(fromMessage.id).source, 'manual')
})

// --- the signature image goes out as an inline (cid) part --------------------------------------------------------
const { signatureHtml, accountImageSrc, SIGNATURE_ATTR } = await import('../core/smtp/signature.js')
const SIG_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(300)])
const withImage = (s, bytes = SIG_PNG) => {
  s.composer.store.signatureImage = id => (id === s.row.id ? { type: 'image/png', bytes } : null)
}
const sigForm = (s, over = {}) => form(s, { html: `<p>Szia!</p>${signatureHtml('Üdv,\nKép Elek', accountImageSrc(s.row.id))}`, ...over })
const inlineParts = async raw => (await simpleParser(raw, { keepCidLinks: true })).attachments.filter(a => a.cid)

test('signature image: a signature image: multipart/related, exactly one inline part, its Content-ID in the HTML, no sig-img or marker; the text part has the text only', async t => {
  const s = await setup(t)
  withImage(s)
  const sid = s.composer.open()
  assert.equal((await s.composer.sendNow(sid, sigForm(s))).sent, true)
  const raw = s.smtp.received[0].raw
  assert.match(raw.toString('latin1'), /Content-Type: multipart\/related/i)
  const got = await simpleParser(raw, { keepCidLinks: true })
  const parts = await inlineParts(raw)
  assert.equal(parts.length, 1)
  assert.match(parts[0].cid, /^sig-[0-9a-f]{24}@shadowmail$/)
  assert.ok(parts[0].content.equals(SIG_PNG), 'the stored bytes, byte for byte')
  assert.equal(parts[0].contentDisposition, 'inline')
  assert.ok(got.html.includes(`src="cid:${parts[0].cid}"`))
  assert.ok(!got.html.includes('sig-img') && !got.html.includes(SIGNATURE_ATTR))
  assert.match(got.text, /Kép Elek/)
  assert.ok(!/cid:|sig-img|\[/.test(got.text), got.text)
  // the image twice in the body (a copy-paste): still one part
  const sid2 = s.composer.open()
  const twice = `<p>a</p>${signatureHtml('Elek', accountImageSrc(s.row.id))}<p><img src="${accountImageSrc(s.row.id)}" alt=""></p>`
  await s.composer.sendNow(sid2, form(s, { html: twice }))
  assert.equal((await inlineParts(s.smtp.received[1].raw)).length, 1)
})

test('signature image: without an image the MIME is the old one: no related part, the HTML the old signature markup', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await s.composer.sendNow(sid, form(s, { html: `<p>Szia!</p>${signatureHtml('Elek')}` }))
  const raw = s.smtp.received[0].raw
  assert.doesNotMatch(raw.toString('latin1'), /multipart\/related/i)
  const got = await simpleParser(raw)
  assert.ok(got.html.includes('<p>Szia!</p><p><br></p><p>-- <br>Elek</p>'), got.html)
  assert.equal(got.attachments.length, 0)
})

test('signature image: only the sender account image or the session image is served; another account image is left out', async t => {
  const s = await setup(t)
  withImage(s)
  const sid = s.composer.open()
  await s.composer.sendNow(sid, form(s, { html: `<p>x</p>${signatureHtml('Elek', accountImageSrc(s.row.id + 1))}` }))
  const raw = s.smtp.received[0].raw
  assert.equal((await inlineParts(raw)).length, 0)
  assert.ok(!(await simpleParser(raw)).html.includes('<img'))
})

test('signature image: a draft saved, opened again, sent: the draft OWN image (not the account current one), exactly one part', async t => {
  const s = await setup(t, { type: 'pop3' })
  withImage(s)
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, sigForm(s, { subject: 'Képes piszkozat' }))
  const draft = s.index.listFolder({ accountId: s.row.id, folder: 'Drafts' })[0]
  // the saved draft keeps the signature marker (its sender change finds the block when reopened), and its image as a part
  const savedSource = sealedStore(s.storeDir).read(s.index.get(draft.id).store_path).toString('latin1')
  assert.ok(savedSource.includes(SIGNATURE_ATTR), 'the marker in the saved draft')
  assert.match(savedSource, /multipart\/related/i)
  // the account's image changes meanwhile: the draft keeps its own
  const newer = Buffer.concat([SIG_PNG.subarray(0, 8), crypto.randomBytes(200)])
  withImage(s, newer)
  // the reader's source(): the stored, sealed copy of the local draft
  s.composer.reader = { source: async id => { const row = s.index.get(id); return { row, source: sealedStore(s.storeDir).read(row.store_path) } } }
  const sid2 = s.composer.open()
  const f = await s.composer.prepare(sid2, { mode: 'draft', messageId: draft.id })
  assert.ok(f.draftHtml.includes(`sig-img://session/${sid2}`), f.draftHtml)
  assert.ok(f.draftHtml.includes(`<div ${SIGNATURE_ATTR}`), 'the reopened draft has its signature block')
  assert.ok(!f.draftHtml.includes('cid:sig-'))
  assert.ok(s.composer.signatureImageOf('session', sid2).bytes.equals(SIG_PNG))
  assert.deepEqual(s.composer.attachmentList(sid2), [], 'the signature image is not an attachment of the draft')
  await s.composer.sendNow(sid2, form(s, { html: f.draftHtml }))
  const parts = await inlineParts(s.smtp.received[0].raw)
  assert.equal(parts.length, 1)
  assert.ok(parts[0].content.equals(SIG_PNG), 'the draft own bytes')
  assert.ok(!s.smtp.received[0].raw.toString('latin1').includes(SIGNATURE_ATTR), 'the sent message without the marker')
})
