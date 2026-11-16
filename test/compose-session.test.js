// one compose session over its life. A sent session sends and saves
// nothing again; saves, sends and discards of one session run one after the other; a draft left in the
// old account by a From change is tried again; no Sent copy -> the draft stays; the data-folder check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { SMTPServer } from 'smtp-server'
import { memoryIndex, addAccount, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { Composer } from '../app/main/compose.js'
import { Contacts } from '../core/db/contacts.js'

const USER = 'teszt@example.invalid'
const PASS = 'Helyes-Jelszo-123'
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const t0 = performance.now()
  while (!(await fn())) {
    if (performance.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}

async function startSmtp(t, refuse = []) {
  const received = []
  const server = new SMTPServer({
    onRcptTo(address, session, cb) {
      if (refuse.includes(address.address)) cb(Object.assign(new Error('No such user here'), { responseCode: 550 }))
      else cb()
    },
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN'],
    logger: false,
    onAuth(auth, session, cb) {
      cb(null, { user: USER })
    },
    onData(stream, session, cb) {
      const chunks = []
      stream.on('data', c => chunks.push(c))
      stream.on('end', () => {
        received.push({ to: session.envelope.rcptTo.map(r => r.address), raw: Buffer.concat(chunks).toString() })
        cb()
      })
    },
  })
  server.on('error', () => {})
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  onCleanup(t, () => new Promise(r => server.close(r)))
  return { port: server.server.address().port, received }
}

async function setup(t, { refuse = [], type = 'imap', extraImap = [] } = {}) {
  const smtp = await startSmtp(t, refuse)
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type, email: USER, display_name: 'K', smtp_host: '127.0.0.1', smtp_port: smtp.port, smtp_security: 'none', smtp_user: USER, save_sent_to_server: 1, tls_verify: 1 })
  // more IMAP account rows reaching the same fake server (an alias sender on one login)
  const extras = extraImap.map((over, i) => addAccount(db, { type: 'imap', email: `alias${i}@example.invalid`, smtp_host: '127.0.0.1', smtp_port: smtp.port, smtp_security: 'none', smtp_user: USER, in_user: row.in_user, ...over }))
  const imap = new FakeImapServer().addMailbox('INBOX').addMailbox('Drafts', { specialUse: '\\Drafts' }).addMailbox('Sent', { specialUse: '\\Sent' })
  const hooks = {} // op -> (orig, ...args): one IMAP call replaced in a test
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: PASS, smtp: PASS }),
  }
  const connect = async () => {
    const c = await imap.connect()
    const append = c.append.bind(c)
    c.append = (...a) => (hooks.append ? hooks.append(append, ...a) : append(...a))
    return c
  }
  const dataDir = tempDir(t)
  const storeDir = path.join(dataDir, 'store')
  const manager = new SyncManager({
    store, index, sealed: sealedStore(storeDir), notify: () => {}, connect, now: () => NOW, throttleMs: 5,
    syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 },
  })
  onCleanup(t, () => manager.stopAll())
  if (type === 'imap') {
    manager.startAll()
    await until(() => manager.entries.get(row.id).idle.connected)
    for (const e of extras) await until(() => manager.entries.get(e.id).idle.connected)
  } else {
    index.ensureLocalFolders(row.id, [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }])
  }
  const logs = []
  const composer = new Composer({
    index, store, contacts: new Contacts(db), storeDir, sealed: sealedStore(storeDir), dataDir,
    withConnection: (id, fn) => manager.withConnection(id, fn),
    requestSync: (id, f) => manager.requestSync(id, f),
    now: () => NOW,
    log: m => logs.push(m),
  })
  return { db, index, row, extras, hooks, smtp, imap, manager, composer, storeDir, dataDir, logs }
}

const form = (s, over = {}) => ({ accountId: s.row.id, to: 'ok@example.invalid', cc: '', bcc: '', subject: 'Tárgy', html: '<p>Szia</p>', ...over })
const serverDrafts = s => [...s.imap.mailboxes.get('Drafts').messages.values()]
const localDrafts = (s, accountId) => s.index.listFolder({ accountId, folder: 'Drafts', limit: 50 })

function popAccount(s, email) {
  const pop = addAccount(s.db, { type: 'pop3', email, smtp_host: '127.0.0.1', smtp_port: s.row.smtp_port, smtp_security: 'none', smtp_user: USER })
  s.index.ensureLocalFolders(pop.id, [{ path: 'INBOX' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Sent', specialUse: '\\Sent' }])
  return pop
}

test('a partly refused send: the same session sends nothing again and saves no draft of the sent message', async t => {
  const s = await setup(t, { refuse: ['nincs@example.invalid'] })
  const sid = s.composer.open()
  const r1 = await s.composer.sendNow(sid, form(s, { to: 'ok@example.invalid, nincs@example.invalid' }))
  assert.deepEqual(r1.rejected, ['nincs@example.invalid'])
  await assert.rejects(s.composer.sendNow(sid, form(s, { to: 'ok@example.invalid, javitott@example.invalid' })), { code: 'already_sent' })
  await assert.rejects(s.composer.saveDraft(sid, form(s)), { code: 'already_sent' })
  assert.equal(s.smtp.received.length, 1, 'ok@ got it once')
  await sleep(50)
  assert.equal(serverDrafts(s).length, 0)
})

test('no Sent copy and no new draft (every APPEND refused): the earlier draft stays and the result says it is older', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, form(s))
  s.imap.refuseOps.add('append')
  const r = await s.composer.sendNow(sid, form(s))
  await sleep(50)
  assert.ok(r.warnings.some(w => w.startsWith('sent_copy_failed')), JSON.stringify(r.warnings))
  assert.ok(r.warnings.includes('kept_older_draft'), JSON.stringify(r.warnings))
  assert.equal(s.imap.mailboxes.get('Sent').messages.size, 0)
  assert.equal(serverDrafts(s).length, 1)
})

test('POP3, no Sent copy because the local Sent folder is gone: a never-saved message is saved as a draft', async t => {
  const s = await setup(t, { type: 'pop3' })
  s.db.prepare("DELETE FROM folders WHERE account_id = ? AND path = 'Sent'").run(s.row.id)
  const sid = s.composer.open()
  const r = await s.composer.sendNow(sid, form(s, { subject: 'Egyetlen példány' }))
  assert.ok(r.warnings.includes('no_sent_folder'))
  assert.ok(r.warnings.includes('kept_as_draft'))
  assert.deepEqual(localDrafts(s, s.row.id).map(m => m.subject), ['Egyetlen példány'])
})

test('From changed and the old draft could not be removed: the result says so, the next save removes it', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, form(s, { subject: 'A-ban' }))
  const pop = popAccount(s, 'pop@example.invalid')
  s.imap.uidplus = true
  s.imap.refuseOps.add('expunge')
  const res = await s.composer.saveDraft(sid, form(s, { accountId: pop.id, subject: 'B-ben' }))
  assert.equal(res.oldDraftLeft, true)
  assert.equal(serverDrafts(s).length, 1)
  s.imap.refuseOps.delete('expunge')
  const res2 = await s.composer.saveDraft(sid, form(s, { accountId: pop.id, subject: 'B-ben 2' }))
  assert.equal(res2.oldDraftLeft, false)
  await sleep(50)
  assert.equal(serverDrafts(s).length, 0, 'the old account draft is gone')
  assert.equal(localDrafts(s, pop.id).length, 1)
})

test('From changed, the old account offline: the send removes the old draft once it is back', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, form(s, { subject: 'A-ban' }))
  const pop = popAccount(s, 'pop2@example.invalid')
  const entry = s.manager.entries.get(s.row.id)
  entry.fatal = true // the old account's sync stopped: withConnection -> sync_stopped
  const res = await s.composer.saveDraft(sid, form(s, { accountId: pop.id, subject: 'B-ben' }))
  assert.equal(res.oldDraftLeft, true)
  entry.fatal = false
  const r = await s.composer.sendNow(sid, form(s, { accountId: pop.id, subject: 'B-ben' }))
  assert.deepEqual(r.warnings, [])
  await sleep(50)
  assert.equal(serverDrafts(s).length, 0)
  assert.equal(localDrafts(s, pop.id).length, 0)
})

test('two saves at once (autosave + "Mentés piszkozatként"): one draft, the later text', async t => {
  const s = await setup(t, { type: 'pop3' })
  const sid = s.composer.open()
  await Promise.all([s.composer.saveDraft(sid, form(s, { subject: 'autosave' })), s.composer.saveDraft(sid, form(s, { subject: 'mentés és bezárás' }))])
  assert.deepEqual(localDrafts(s, s.row.id).map(r => r.subject), ['mentés és bezárás'])
  for (const uidplus of [true, false]) {
    const i = await setup(t)
    i.imap.uidplus = uidplus
    const id = i.composer.open()
    await i.composer.saveDraft(id, form(i, { subject: 'első' }))
    await Promise.all([i.composer.saveDraft(id, form(i, { subject: 'autosave' })), i.composer.saveDraft(id, form(i, { subject: 'mentés és bezárás' }))])
    await sleep(50)
    const left = serverDrafts(i)
    assert.equal(left.length, 1, `uidplus=${uidplus}`)
    assert.match(left[0].source.toString(), /mentés és bezárás|=\?UTF-8\?/i)
  }
})

test('two saves at once across a From change: one draft, in the later account', async t => {
  const s = await setup(t)
  const pop = popAccount(s, 'pop3@example.invalid')
  const sid = s.composer.open()
  await Promise.all([s.composer.saveDraft(sid, form(s, { subject: 'A autosave' })), s.composer.saveDraft(sid, form(s, { accountId: pop.id, subject: 'B mentés' }))])
  await sleep(50)
  assert.equal(serverDrafts(s).length, 0)
  assert.equal(localDrafts(s, pop.id).length, 1)
})

test('"Elvetés" while the first save is still running: no draft is left', async t => {
  for (const type of ['imap', 'pop3']) {
    const s = await setup(t, { type })
    const sid = s.composer.open()
    const saving = s.composer.saveDraft(sid, form(s))
    await s.composer.discardDraft(sid)
    s.composer.close(sid)
    await saving
    await sleep(50)
    const n = type === 'imap' ? serverDrafts(s).length : localDrafts(s, s.row.id).length
    assert.equal(n, 0, type)
  }
})

test('attachments: a folder inside data named "..x" is inside; a hard link to a data file is refused', async t => {
  const s = await setup(t, { type: 'pop3' })
  const sid = s.composer.open()
  const dotted = path.join(s.dataDir, '..x')
  fs.mkdirSync(dotted)
  fs.writeFileSync(path.join(dotted, 'copy.sqlite'), 'db')
  assert.throws(() => s.composer.addFiles(sid, [path.join(dotted, 'copy.sqlite')]), { code: 'forbidden_path' })
  const db = path.join(s.dataDir, 'mail.sqlite')
  fs.writeFileSync(db, 'db')
  const outside = tempDir(t)
  const link = path.join(outside, 'innocent.txt')
  try {
    fs.linkSync(db, link)
  } catch {
    t.skip('no hard links on this file system')
    return
  }
  assert.throws(() => s.composer.addFiles(sid, [link]), { code: 'forbidden_path' })
  const plain = path.join(outside, 'plain.txt')
  fs.writeFileSync(plain, 'ok')
  assert.equal(s.composer.addFiles(sid, [plain]).length, 1, 'an ordinary file outside is fine')
  assert.throws(() => s.composer.addFiles(sid, [outside]), { code: 'not_a_file' })
})

// ---- From changes, alias senders, the closing paths ----

const subjectOf = m => (/^Subject: (.*)$/m.exec(m.source.toString()) || [])[1]?.trim()

test('From changed between two accounts on ONE login (an alias sender): the new draft stays, one copy', async t => {
  const s = await setup(t, { extraImap: [{ in_host: 'imap.example.invalid' }] })
  const B = s.extras[0]
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, form(s, { subject: 'A-ban' }))
  let appends = 0
  s.hooks.append = (orig, ...a) => (appends++, orig(...a))
  const res = await s.composer.saveDraft(sid, form(s, { accountId: B.id, subject: 'B-ben' }))
  await sleep(50)
  assert.equal(res.oldDraftLeft, false)
  assert.deepEqual(serverDrafts(s).map(subjectOf), ['B-ben'])
  assert.equal(appends, 1, 'one APPEND: the old copy is not searched for in the same mailbox, nothing saved again')
  assert.doesNotMatch(s.logs.join('\n'), /saved again/)
})

test('the same mailbox under another server name: the old-draft removal takes the new one, it is saved again', async t => {
  const s = await setup(t, { extraImap: [{ in_host: 'masik-nev.example.invalid' }] }) // the fake server answers both names
  const B = s.extras[0]
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, form(s, { subject: 'A-ban' }))
  const res = await s.composer.saveDraft(sid, form(s, { accountId: B.id, subject: 'B-ben' }))
  await sleep(50)
  assert.equal(res.oldDraftLeft, false)
  assert.deepEqual(serverDrafts(s).map(subjectOf), ['B-ben'])
  assert.match(s.logs.join('\n'), /saved again/)
})

test('"Elvetés" while the old account refuses: the current draft goes anyway, the error is returned', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, form(s, { subject: 'A-ban' }))
  const pop = popAccount(s, 'u2@example.invalid')
  s.imap.refuseOps.add('expunge')
  await s.composer.saveDraft(sid, form(s, { accountId: pop.id, subject: 'B-ben' }))
  await assert.rejects(s.composer.discardDraft(sid), { code: 'server_refused' })
  assert.equal(localDrafts(s, pop.id).length, 0, 'the current draft is gone')
  assert.equal(serverDrafts(s).length, 1, 'the old one is still there (and the page was told)')
})

test('sent with a Sent copy while the old account refuses: the draft of the sent message goes from the current account', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, form(s, { subject: 'A-ban' }))
  const pop = popAccount(s, 'u2b@example.invalid')
  s.imap.refuseOps.add('expunge')
  await s.composer.saveDraft(sid, form(s, { accountId: pop.id, subject: 'B-ben' }))
  const r = await s.composer.sendNow(sid, form(s, { accountId: pop.id, subject: 'B-ben' }))
  assert.deepEqual(r.warnings, ['draft_not_removed:server_refused'])
  assert.equal(localDrafts(s, pop.id).length, 0)
  assert.equal(s.index.listFolder({ accountId: pop.id, folder: 'Sent', limit: 10 }).length, 1)
})

test('no Sent copy after an earlier autosave: the kept draft is the text that went out', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, form(s, { subject: 'v1 (autosave)' }))
  s.hooks.append = (orig, box, ...a) => (box === 'Sent' ? Promise.resolve(false) : orig(box, ...a))
  const r = await s.composer.sendNow(sid, form(s, { subject: 'v2 (elküldött)' }))
  await sleep(50)
  assert.ok(r.warnings.includes('kept_as_draft'), JSON.stringify(r.warnings))
  assert.deepEqual(serverDrafts(s).map(subjectOf), [subjectOf({ source: Buffer.from(s.smtp.received[0].raw) })])
  assert.equal(serverDrafts(s).length, 1)
})

test('"Elvetés" queued behind a send whose Sent copy fails: the kept draft (the only copy) stays', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, form(s, { subject: 'v1' }))
  s.hooks.append = (orig, box, ...a) => (box === 'Sent' ? Promise.resolve(false) : orig(box, ...a))
  const sending = s.composer.sendNow(sid, form(s, { subject: 'v1' }))
  const discarding = s.composer.discardDraft(sid)
  const r = await sending
  await discarding
  await sleep(50)
  assert.ok(r.warnings.includes('kept_as_draft'))
  assert.equal(serverDrafts(s).length, 1, 'the message went out without a Sent copy: its draft is kept')
  assert.equal(s.smtp.received.length, 1)
})

test('attachments: a bad file in a batch adds none of the batch', async t => {
  const s = await setup(t, { type: 'pop3' })
  const sid = s.composer.open()
  const outside = tempDir(t)
  fs.writeFileSync(path.join(outside, 'good.txt'), 'ok')
  fs.writeFileSync(path.join(s.dataDir, 'mail.sqlite'), 'db')
  assert.throws(() => s.composer.addFiles(sid, [path.join(outside, 'good.txt'), path.join(s.dataDir, 'mail.sqlite')]), { code: 'forbidden_path' })
  assert.deepEqual(s.composer.attachmentList(sid), [])
})

test('attachments: a FIFO is refused before it is opened, nothing blocks', { skip: process.platform === 'win32' }, async t => {
  const dir = tempDir(t)
  const fifo = path.join(dir, 'pipe')
  if (spawnSync('mkfifo', [fifo]).status !== 0) return t.skip('no mkfifo')
  const code = `const { Composer } = await import(${JSON.stringify(path.resolve('app/main/compose.js'))})
const c = new Composer({ index: null, store: null, contacts: null, storeDir: ${JSON.stringify(dir)}, withConnection: async () => {} })
try { c.addFiles(c.open(), [${JSON.stringify(fifo)}]); console.log('added') } catch (e) { console.log(e.code) }`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 5000, encoding: 'utf8' })
  assert.equal(r.signal, null, 'did not hang')
  assert.equal(r.stdout.trim(), 'not_a_file')
})

test('attachments: a file system without file ids (ino 0) does not forbid every file', async t => {
  const s = await setup(t, { type: 'pop3' })
  const sid = s.composer.open()
  fs.writeFileSync(path.join(s.dataDir, 'mail.sqlite'), 'db')
  const outside = tempDir(t)
  fs.writeFileSync(path.join(outside, 'szamla.pdf'), 'pdf')
  const { statSync, fstatSync } = fs
  const zeroIno = st => (st && typeof st.ino === 'bigint' ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: 0n, dev: 1n }) : st)
  fs.statSync = (...a) => zeroIno(statSync(...a))
  fs.fstatSync = (...a) => zeroIno(fstatSync(...a))
  try {
    assert.equal(s.composer.addFiles(sid, [path.join(outside, 'szamla.pdf')]).length, 1)
  } finally {
    fs.statSync = statSync
    fs.fstatSync = fstatSync
  }
})
