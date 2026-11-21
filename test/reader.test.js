// Opening a message with the fake IMAP server: download once into data/store, \Seen on the server
// through a read-write SELECT, pinning (the text enters the index beyond the limit and stays there),
// charsets, embedded images and attachments of the open message only, login safety, offline open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { MessageReader } from '../app/main/reader.js'
import { applyBodyLimit } from '../core/db/body-limit.js'
import { openMailDatabase } from '../core/db/index.js'
import { MailIndex } from '../core/db/mail-index.js'
import { registerReaderIpc } from '../app/main/ipc/reader.js'
import { setLanguage } from '../app/renderer/i18n/index.js'
import { parseMessage } from '../core/mime/message.js'

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 3000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const fixture = name => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url))
const plain = (n, extra = {}) => ({
  from: `k${n}@example.invalid`, to: 'en@example.invalid', subject: `Levél ${n}`, messageId: `<m${n}@x>`, date: NOW - DAY, body: `Szöveg ${n}`, ...extra,
})

async function setup(t, { db: givenDb = null } = {}) {
  let db, index
  if (givenDb) {
    db = givenDb
    index = new MailIndex(db)
  } else {
    ;({ db, index } = memoryIndex(t))
  }
  const row = addAccount(db)
  const server = new FakeImapServer().addMailbox('INBOX')
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
  }
  const events = []
  const manager = new SyncManager({
    store,
    index,
    notify: e => events.push(e),
    connect: () => server.connect(),
    now: () => NOW,
    throttleMs: 5,
    syncerOptions: { retryDelaysMs: [30, 30] },
    idleOptions: { retryDelaysMs: [30], debounceMs: 10 },
  })
  onCleanup(t, () => manager.stopAll())
  const storeDir = path.join(tempDir(t), 'store')
  const reader = new MessageReader({
    index,
    sealed: sealedStore(storeDir),
    withConnection: (id, fn) => manager.withConnection(id, fn),
    onChange: c => manager.notifyChange(c),
  })
  const sync = async () => {
    manager.startAll()
    await until(() => manager.entries.get(row.id).idle.connected)
  }
  const byUid = uid => index.getByUid(row.id, 'INBOX', uid)
  return { db, index, row, server, manager, reader, storeDir, events, sync, byUid }
}

test('open: downloads once into data/store, \\Seen on the server via a read-write SELECT, the list sees the change', async t => {
  const { server, reader, sync, byUid, storeDir, events, index } = await setup(t)
  const uid = server.addMessage('INBOX', plain(1))
  await sync()
  assert.equal(server.mailboxes.get('INBOX').messages.get(uid).flags.has('\\Seen'), false, 'the sync never marks as read')
  const before = server.openLog.length

  const m = await reader.open(byUid(uid).id)
  assert.equal(m.subject, 'Levél 1')
  assert.match(m.text, /Szöveg 1/)
  assert.equal(m.html, null)
  assert.equal(m.seenError, null)
  assert.ok(server.mailboxes.get('INBOX').messages.get(uid).flags.has('\\Seen'), 'read on the server')
  assert.deepEqual(server.openLog.slice(before), [{ path: 'INBOX', readOnly: false, via: 'lock' }])
  const row = byUid(uid)
  assert.ok(row.flags.split(' ').includes('\\Seen'))
  assert.equal(row.store_path, `${row.account_id}/${row.id}.eml`)
  assert.equal(sealedStore(storeDir).read(row.store_path).toString('utf8'), server.mailboxes.get('INBOX').messages.get(uid).source.toString('utf8'))
  await until(() => events.some(e => e.kind === 'mail'))
  assert.equal(index.folders(row.account_id).find(f => f.path === 'INBOX').unread, 0)

  // second open: from the cache, nothing downloaded again, no SELECT (already read)
  const fulls = () => server.fetchLog.filter(f => f.kind === 'full').length
  assert.equal(fulls(), 1)
  const opens = server.openLog.length
  await reader.open(row.id)
  assert.equal(fulls(), 1)
  assert.equal(server.openLog.length, opens)
})

test('open: a message beyond the limit is pinned, its text enters the index, and a smaller limit later does not take it out', async t => {
  const { reader, sync, byUid, server, row, index } = await setup(t)
  const old = server.addMessage('INBOX', plain(2, { date: NOW - 4 * 365 * DAY, body: 'Ritkaszó-cetlifelirat a régi levélben' }))
  await sync()
  const before = byUid(old)
  assert.equal(before.body_state, 3)
  assert.equal(index.search({ accountId: row.id, query: 'cetlifelirat' }).length, 0)
  assert.equal(index.search({ accountId: row.id, query: 'Levél 2' }).length, 1, 'the subject is found')

  await reader.open(before.id)
  const after = byUid(old)
  assert.equal(after.body_pinned, 1)
  assert.equal(after.body_state, 1)
  assert.match(after.preview, /cetlifelirat/)
  assert.equal(index.search({ accountId: row.id, query: 'cetlifelirat' }).length, 1)

  applyBodyLimit(index, { ...row, body_index_days: 365 }, NOW)
  applyBodyLimit(index, { ...row, body_index_days: 1095 }, NOW)
  assert.equal(index.search({ accountId: row.id, query: 'cetlifelirat' }).length, 1, 'pinned: still found')
})

test('open: the pinned text survives a restart (file database)', async t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'mail.sqlite')
  let { db } = openMailDatabase(file)
  const s = await setup(t, { db })
  const old = s.server.addMessage('INBOX', plain(3, { date: NOW - 4 * 365 * DAY, body: 'Hosszúéletű kulcsszó: pegazusgyűjtemény' }))
  await s.sync()
  await s.reader.open(s.byUid(old).id)
  await s.manager.stopAll()
  db.close()
  ;({ db } = openMailDatabase(file))
  onCleanup(t, () => db.close())
  const index = new MailIndex(db)
  applyBodyLimit(index, s.row, NOW)
  assert.equal(index.search({ accountId: s.row.id, query: 'pegazusgyujtemeny' }).length, 1, 'found after reopening, accents optional')
})

test('open: ISO-8859-2 and windows-1250 messages keep their accents', async t => {
  const { reader, sync, byUid, server } = await setup(t)
  const a = server.addMessage('INBOX', plain(4, { source: fixture('mail/iso-8859-2.eml') }))
  const b = server.addMessage('INBOX', plain(5, { source: fixture('mail/windows-1250.eml') }))
  await sync()
  const expected = 'Árvíztűrő tükörfúrógép. Őszi ősz, ünnepi űrhajó: ÁÉÍÓÖŐÚÜŰ áéíóöőúüű.'
  const ma = await reader.open(byUid(a).id)
  assert.equal(ma.subject, 'Ékezetes tárgy ISO-8859-2')
  assert.equal(ma.text.trim(), expected)
  const mb = await reader.open(byUid(b).id)
  assert.equal(mb.subject, 'Ékezetes tárgy windows-1250')
  assert.ok(mb.html.includes(expected), mb.html)
  assert.ok(mb.html.includes('„idézet” – gondolatjel'))
})

test('open: headers, attachments (embedded logo not listed), executables flagged; cid images and "load images" belong to the open message only', async t => {
  const { reader, sync, byUid, server } = await setup(t)
  const uid = server.addMessage('INBOX', plain(6, { source: fixture('mail/cid-and-attachments.eml') }))
  const other = server.addMessage('INBOX', plain(7))
  await sync()
  const id = byUid(uid).id
  const m = await reader.open(id)
  assert.equal(m.subject, 'Beadás képpel és mellékletekkel')
  assert.deepEqual(m.from, [{ name: 'Kovács Árpád', address: 'arpad@sender.invalid' }])
  assert.deepEqual(m.to.map(a => a.address), ['teszt@example.invalid', 'masik@example.invalid'])
  assert.deepEqual(m.cc, [{ name: 'Harmadik', address: 'harmadik@example.invalid' }])
  assert.equal(m.hasExternalImages, true)
  assert.deepEqual(m.attachments.map(a => [a.filename, a.executable, a.browserActive]), [
    ['szamla.pdf', false, false],
    ['telepito.exe', true, false],
    ['szamla.pdf.html', false, true],
  ])
  assert.ok(!('content' in m.attachments[0]), 'no contents in the view')

  const img = reader.cidImage(id, 'logo@sender.invalid')
  assert.equal(img.contentType, 'image/png')
  assert.equal(img.content.subarray(1, 4).toString(), 'PNG')
  // the reference as another program writes it: another case, %-encoded, in < > (the same part)
  for (const ref of ['LOGO@Sender.Invalid', 'logo%40sender.invalid', '<logo@sender.invalid>']) assert.ok(reader.cidImage(id, ref)?.content.equals(img.content), ref)
  assert.equal(reader.cidImage(id, 'logo@sender'), null, 'a prefix is no match')
  assert.equal(reader.cidImage(id, 'nincs-ilyen'), null)
  assert.equal(reader.cidImage(id + 1000, 'logo@sender.invalid'), null)
  assert.equal(reader.attachment(id, m.attachments[1].index).content.subarray(0, 2).toString(), 'MZ')

  assert.equal(reader.allowedImageHosts().size, 0, 'images are off until asked')
  assert.deepEqual(reader.allowImages(id), ['127.0.0.1:47811'])
  assert.deepEqual([...reader.allowedImageHosts()], ['127.0.0.1:47811'])
  const token = reader.setView(id, '<p>x</p>')
  assert.deepEqual(reader.view(token), { html: '<p>x</p>', imagesAllowed: true })

  await reader.open(byUid(other).id)
  assert.equal(reader.allowedImageHosts().size, 0, 'another message: images blocked again')
  assert.equal(reader.cidImage(id, 'logo@sender.invalid'), null, 'cid images of the previous message are gone')
  assert.equal(reader.view(token), null)
  assert.throws(() => reader.attachment(id, 0), { code: 'not_open' })

  // opening the first one again: images are off again
  await reader.open(id)
  assert.equal(reader.allowedImageHosts().size, 0)

  // a failed open does not leave the previous message's permission behind
  reader.allowImages(id)
  assert.equal(reader.allowedImageHosts().size, 1)
  await assert.rejects(reader.open(999_999), { code: 'not_found' })
  assert.equal(reader.allowedImageHosts().size, 0)
  assert.equal(reader.cidImage(id, 'logo@sender.invalid'), null)
})

test('open: a rejected login is tried once; afterwards no login at all until the user acts', async t => {
  const { reader, sync, byUid, server, manager, row } = await setup(t)
  const uid = server.addMessage('INBOX', plain(8))
  await sync()
  // the interactive connection is new: its login is rejected
  server.rejectLogin = true
  const attempts = server.loginAttempts
  await assert.rejects(reader.open(byUid(uid).id), { code: 'auth_failed' })
  assert.equal(server.loginAttempts, attempts + 1)
  await assert.rejects(reader.open(byUid(uid).id), { code: 'sync_stopped' })
  await sleep(80)
  assert.equal(server.loginAttempts, attempts + 1, 'neither the reader nor the timers tried again')
  assert.equal(manager.status().find(s => s.accountId === row.id).stopped, true)
})

test('open: a cached unread message opens offline, \\Seen is reported as not set and stays unset locally', async t => {
  const { reader, sync, byUid, server, manager, row, index } = await setup(t)
  const uid = server.addMessage('INBOX', plain(9))
  await sync()
  const id = byUid(uid).id
  await reader.open(id)
  // pretend it became unread again (e.g. on another client) and the network is gone
  index.setFlagsById(id, '')
  await manager.entries.get(row.id).interactive.close()
  server.down = true
  server.dropConnections()
  const m = await reader.open(id)
  assert.equal(m.seenError, 'connection_refused')
  assert.match(m.text, /Szöveg 9/)
  assert.equal(byUid(uid).flags, '')
})

test('open: a changed UIDVALIDITY is not trusted (the UID may name another message)', async t => {
  const { reader, sync, byUid, server } = await setup(t)
  const uid = server.addMessage('INBOX', plain(10))
  await sync()
  server.mailboxes.get('INBOX').uidValidity = 99
  await assert.rejects(reader.open(byUid(uid).id), { code: 'stale' })
  assert.equal(server.fetchLog.filter(f => f.kind === 'full').length, 0)
})

test('open: a store_path pointing outside the store folder is never read', async t => {
  const { reader, sync, byUid, server, index, storeDir } = await setup(t)
  const uid = server.addMessage('INBOX', plain(11))
  await sync()
  const id = byUid(uid).id
  const outside = path.join(path.dirname(storeDir), 'outside.eml')
  fs.writeFileSync(outside, 'Subject: kivulrol\r\n\r\nNEM SZABAD\r\n')
  index.setStorePath(id, '../outside.eml')
  const m = await reader.open(id)
  assert.equal(m.subject, 'Levél 11', 'downloaded from the server instead')
  assert.equal(byUid(uid).store_path, `${byUid(uid).account_id}/${id}.eml`)
})

test('open: unknown id and a vault that is locked', async t => {
  const { reader, sync, byUid, server, manager } = await setup(t)
  await assert.rejects(reader.open(999_999), { code: 'not_found' })
  const uid = server.addMessage('INBOX', plain(12))
  await sync()
  await manager.stopAll()
  await assert.rejects(reader.open(byUid(uid).id), { code: 'locked' })
})

test('thread view: copies of the same message (INBOX + Sent) are one row; the opened copy stays', async t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db, { email: 'en@example.invalid' })
  index.upsertFolder({ account_id: acc.id, path: 'INBOX', uidvalidity: '1', synced_at: 1 })
  index.upsertFolder({ account_id: acc.id, path: 'Sent', special_use: '\\Sent', uidvalidity: '1', synced_at: 1 })
  index.upsertFolder({ account_id: acc.id, path: 'Archívum', uidvalidity: '1', synced_at: 1 })
  let uid = 0
  const put = (folder, mid, extra = {}) => {
    uid++
    index.insertMany([{
      account_id: acc.id, folder, uid, message_id: mid, in_reply_to: extra.inReplyTo || null, refs: extra.refs || null,
      from_addr: 'en@example.invalid', from_name: 'Én', to_addrs: 'en@example.invalid', cc_addrs: '', subject: extra.subject || 'Magamnak',
      date: extra.date || 1000, idate: extra.date || 1000, flags: '', size: 1, has_attachments: 0, attachments: null, body_state: 1,
      sender_text: 'en@example.invalid', recipients_text: 'en@example.invalid',
    }])
    return index.getByUid(acc.id, folder, uid).id
  }
  // a message to oneself and the reply to it: each in the INBOX and in Sent
  const sentOrig = put('Sent', '<o@x>')
  const inOrig = put('INBOX', '<o@x>')
  const sentRe = put('Sent', '<r@x>', { inReplyTo: '<o@x>', refs: '<o@x>', subject: 'Re: Magamnak', date: 2000 })
  const inRe = put('INBOX', '<r@x>', { inReplyTo: '<o@x>', refs: '<o@x>', subject: 'Re: Magamnak', date: 2000 })
  const reader = new MessageReader({ index, sealed: sealedStore(tempDir(t)), withConnection: async () => { throw new Error('no network here') } })

  assert.equal(index.thread(inRe).length, 4, 'MailIndex.thread() still returns every copy')
  assert.deepEqual(reader.thread(inRe).map(r => r.id), [inOrig, inRe], 'opened from the INBOX: 2 rows, the INBOX copies')
  assert.deepEqual(reader.thread(sentRe).map(r => r.id), [inOrig, sentRe], 'opened from Sent: the opened Sent copy stays, the other is the INBOX copy')
  assert.deepEqual(reader.thread(sentOrig).map(r => r.id), [sentOrig, inRe])

  // two copies, neither in Sent/Trash: the smallest id wins; a message without Message-ID is never merged
  const arch = put('Archívum', '<o@x>')
  const noId1 = put('INBOX', null, { inReplyTo: '<o@x>', subject: 'Re: Magamnak (2)', date: 3000 })
  const noId2 = put('Sent', null, { inReplyTo: '<o@x>', subject: 'Re: Magamnak (2)', date: 3000 })
  const rows = reader.thread(inRe).map(r => r.id)
  assert.ok(rows.includes(inOrig) && !rows.includes(arch), 'INBOX copy (smaller id) beats the Archívum copy')
  assert.ok(rows.includes(noId1) && rows.includes(noId2), 'rows without a Message-ID stay separate')
})

test('an attachment without a name: the reader and its save dialog name it in the interface language; the default stays', async t => {
  const s = await setup(t)
  const source = Buffer.from([
    'From: k@example.invalid', 'To: en@example.invalid', 'Subject: Névtelen melléklet', 'Message-ID: <noname@x>', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain; charset=utf-8', '', 'Szöveg', '--b',
    'Content-Type: application/octet-stream', 'Content-Disposition: attachment', 'Content-Transfer-Encoding: base64', '', 'AAEC', '--b--', '',
  ].join('\r\n'))
  const uid = s.server.addMessage('INBOX', { ...plain(1), source })
  await s.sync()
  await until(() => s.byUid(uid))
  const id = s.byUid(uid).id
  const saved = []
  const handlers = new Map()
  registerReaderIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    reader: s.reader,
    tmpDir: tempDir(t),
    dialog: { showSaveDialog: async (...args) => (saved.push(args.at(-1).defaultPath), { canceled: true }) }, // (opts) or (window, opts)
    shell: { openPath: async () => '' },
    isTrustedSender: () => true,
  })
  const ipc = (ch, ...args) => handlers.get(ch)({}, ...args)
  try {
    const hu = await s.reader.open(id)
    assert.deepEqual(hu.attachments.map(a => a.filename), ['melleklet-1'])
    assert.deepEqual(await ipc('mail:saveAttachment', id, 0), { ok: true, saved: false })
    setLanguage('en')
    const en = await s.reader.open(id)
    assert.deepEqual(en.attachments.map(a => a.filename), ['attachment-1'])
    assert.deepEqual(await ipc('mail:saveAttachment', id, 0), { ok: true, saved: false })
    assert.deepEqual(saved, ['melleklet-1', 'attachment-1'])
    // the sync and Claude's path (parseMessage without the option) keep the old name, in any interface language
    assert.deepEqual((await parseMessage(source)).attachments.map(a => a.filename), ['melleklet-1'])
  } finally {
    setLanguage('hu')
  }
})
