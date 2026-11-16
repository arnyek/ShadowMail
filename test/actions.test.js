// Message actions with the fake IMAP server (and a POP3 account's local folders): read / unread,
// star, move, delete to the Trash, final delete with confirmation (inside the Trash, no Trash at all),
// on 1 and on 25 messages; the server's state is checked; a dropped connection changes nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { FakePop3Server } from './helpers/fake-pop3.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { MessageReader } from '../app/main/reader.js'
import { MailActions, trashFolder, applyFlagChange } from '../app/main/actions.js'
import { registerActionIpc, ACTION_CHANNELS } from '../app/main/ipc/actions.js'

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const msg = n => ({ from: `k${n}@example.invalid`, to: 'en@example.invalid', subject: `Levél ${n}`, messageId: `<m${n}@x>`, date: NOW - n * 60_000, body: `Szöveg ${n}` })

async function setup(t, { trash = true, count = 30 } = {}) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db)
  const server = new FakeImapServer().addMailbox('INBOX').addMailbox('Archív')
  if (trash) server.addMailbox('Trash', { specialUse: '\\Trash' })
  server.addMessages('INBOX', Array.from({ length: count }, (_, i) => msg(i + 1)))
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
  }
  const changes = []
  const manager = new SyncManager({ store, index, notify: () => {}, connect: () => server.connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => manager.entries.get(row.id).idle.connected)
  const storeDir = path.join(tempDir(t), 'store')
  const actions = new MailActions({
    index, store, storeDir,
    withConnection: (id, fn) => manager.withConnection(id, fn),
    onChange: c => changes.push(c),
    requestSync: (id, folders) => manager.requestSync(id, folders),
  })
  const reader = new MessageReader({ index, sealed: sealedStore(storeDir), withConnection: (id, fn) => manager.withConnection(id, fn) })
  const inbox = () => index.listFolder({ accountId: row.id, folder: 'INBOX', limit: 1000 })
  const ids = n => inbox().slice(0, n).map(m => m.id)
  const serverFlags = folder => [...server.mailboxes.get(folder).messages.values()].map(m => [...m.flags].sort().join(' '))
  return { db, index, row, server, manager, actions, reader, inbox, ids, serverFlags, changes, storeDir }
}

test('read / unread / star / unstar on 1 and on 25 messages: the server and the index agree', async t => {
  const s = await setup(t)
  for (const n of [1, 25]) {
    const sel = s.ids(n)
    await s.actions.run({ ids: sel, action: 'read' })
    assert.equal(s.serverFlags('INBOX').filter(f => f.includes('\\Seen')).length, n)
    assert.ok(sel.every(id => s.index.get(id).flags.includes('\\Seen')))
    await s.actions.run({ ids: sel, action: 'star' })
    assert.equal(s.serverFlags('INBOX').filter(f => f.includes('\\Flagged')).length, n)
    await s.actions.run({ ids: sel, action: 'unread' })
    await s.actions.run({ ids: sel, action: 'unstar' })
    assert.deepEqual(s.serverFlags('INBOX').filter(Boolean), [])
    assert.ok(sel.every(id => s.index.get(id).flags === ''))
  }
  assert.ok(s.server.openLog.filter(o => o.via === 'lock' && o.readOnly === false).length >= 8, 'actions SELECT read-write')
  assert.ok(s.changes.every(c => c.folders.includes('INBOX')))
})

test('move 25 (UIDPLUS): the rows follow with their new UIDs, an opened message keeps its file and its pin', async t => {
  const s = await setup(t)
  const sel = s.ids(25)
  await s.reader.open(sel[0])
  const opened = s.index.get(sel[0])
  assert.ok(opened.store_path && opened.body_pinned === 1)
  await s.actions.run({ ids: sel, action: 'move', target: 'Archív' })
  assert.equal(s.server.mailboxes.get('INBOX').messages.size, 5)
  assert.equal(s.server.mailboxes.get('Archív').messages.size, 25)
  assert.equal(s.inbox().length, 5)
  const moved = s.index.get(sel[0])
  assert.equal(moved.folder, 'Archív')
  assert.ok(s.server.mailboxes.get('Archív').messages.has(moved.uid))
  assert.equal(moved.store_path, opened.store_path)
  assert.equal(moved.body_pinned, 1)
  assert.ok(fs.existsSync(path.join(s.storeDir, moved.store_path)))
  // a sync afterwards does not duplicate them
  s.manager.syncNow()
  await until(() => s.manager.status()[0].running === false && s.manager.status()[0].lastFinished)
  await sleep(50)
  assert.equal(s.index.listFolder({ accountId: s.row.id, folder: 'Archív', limit: 100 }).length, 25)
})

test('move without UIDPLUS: the rows go, the target folder is synced and has them', async t => {
  const s = await setup(t)
  s.server.uidplus = false
  const sel = s.ids(3)
  await s.actions.run({ ids: sel, action: 'move', target: 'Archív' })
  assert.equal(s.index.get(sel[0]), undefined)
  await until(() => s.index.listFolder({ accountId: s.row.id, folder: 'Archív', limit: 100 }).length === 3)
})

test('delete: to the Trash; inside the Trash only with confirmation, then gone on the server and locally (file too)', async t => {
  const s = await setup(t)
  const sel = s.ids(25)
  await s.reader.open(sel[0])
  const file = path.join(s.storeDir, s.index.get(sel[0]).store_path)
  const res = await s.actions.run({ ids: sel, action: 'delete' })
  assert.deepEqual(res, { done: 25, final: false })
  assert.equal(s.server.mailboxes.get('Trash').messages.size, 25)
  assert.equal(s.index.get(sel[0]).folder, 'Trash')

  await assert.rejects(s.actions.run({ ids: sel, action: 'delete' }), { code: 'confirm_needed' })
  assert.equal(s.server.mailboxes.get('Trash').messages.size, 25, 'nothing happened without confirmation')
  const fin = await s.actions.run({ ids: sel, action: 'delete', permanent: true })
  assert.deepEqual(fin, { done: 25, final: true })
  assert.equal(s.server.mailboxes.get('Trash').messages.size, 0)
  assert.equal(s.index.get(sel[0]), undefined)
  assert.equal(fs.existsSync(file), false, 'the downloaded file is gone too')
})

test('a double delete (two quick requests for one message): the second waits and asks, nothing is lost', async t => {
  const s = await setup(t, { count: 5 })
  const [id] = s.ids(1)
  await s.reader.open(id) // downloaded and pinned: its file must survive
  const file = path.join(s.storeDir, s.index.get(id).store_path)
  assert.ok(fs.existsSync(file))
  const first = s.actions.run({ ids: [id], action: 'delete' })
  const second = s.actions.run({ ids: [id], action: 'delete' })
  assert.deepEqual(await first, { done: 1, final: false })
  await assert.rejects(second, err => err.code === 'confirm_needed' && err.inTrash === true)
  const row = s.index.get(id)
  assert.ok(row, 'the moved row is still in the index')
  assert.equal(row.folder, 'Trash')
  assert.ok(fs.existsSync(path.join(s.storeDir, row.store_path)), 'and its downloaded file too')
  assert.equal(s.server.mailboxes.get('INBOX').messages.size, 4)
  assert.equal(s.server.mailboxes.get('Trash').messages.size, 1)
  // the IPC passes the dialog's hint on
  const handlers = new Map()
  registerActionIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, actions: s.actions, index: s.index, isTrustedSender: () => true })
  assert.deepEqual(await handlers.get('mail:action')({}, { ids: [id], action: 'delete' }), { ok: false, error: 'confirm_needed', inTrash: true })
  // a failed action does not block the next one
  await assert.rejects(s.actions.run({ ids: [999999], action: 'read' }), { code: 'not_found' })
  assert.deepEqual(await s.actions.run({ ids: s.ids(1), action: 'read' }), { done: 1, final: false })
})

test('an account without a Trash: delete asks for confirmation, then expunges on the server', async t => {
  const s = await setup(t, { trash: false })
  assert.equal(trashFolder(s.index.folders(s.row.id)), null)
  const sel = s.ids(1)
  const uid = s.index.get(sel[0]).uid
  await assert.rejects(s.actions.run({ ids: sel, action: 'delete' }), { code: 'confirm_needed' })
  assert.equal(s.server.mailboxes.get('INBOX').messages.size, 30)
  await s.actions.run({ ids: sel, action: 'delete', permanent: true })
  assert.equal(s.server.mailboxes.get('INBOX').messages.size, 29)
  assert.equal(s.inbox().length, 29)
  assert.deepEqual(s.server.actionLog.at(-1), { op: 'expunge', path: 'INBOX', uids: [uid] })
  assert.equal(s.server.mailboxes.get('INBOX').messages.has(uid), false)
})

test('a dropped connection: the action fails with an error, the index and the server are unchanged', async t => {
  const s = await setup(t)
  const sel = s.ids(25)
  const before = sel.map(id => s.index.get(id))
  await s.manager.entries.get(s.row.id).interactive?.close()
  s.server.down = true
  s.server.dropConnections()
  for (const action of ['read', 'star', 'delete']) {
    await assert.rejects(s.actions.run({ ids: sel, action }), err => ['connection_refused', 'connection_lost'].includes(err.code))
  }
  await assert.rejects(s.actions.run({ ids: sel, action: 'move', target: 'Archív' }), err => ['connection_refused', 'connection_lost'].includes(err.code))
  assert.deepEqual(sel.map(id => s.index.get(id)), before)
  assert.deepEqual(s.server.actionLog, [])
})

test('the server refuses (NO): an error, the index unchanged', async t => {
  const s = await setup(t)
  const sel = s.ids(5)
  const before = sel.map(id => s.index.get(id))
  s.server.refuseOps = new Set(['flags+', 'move'])
  await assert.rejects(s.actions.run({ ids: sel, action: 'read' }), { code: 'server_refused' })
  await assert.rejects(s.actions.run({ ids: sel, action: 'move', target: 'Archív' }), { code: 'server_refused' })
  assert.deepEqual(sel.map(id => s.index.get(id)), before)
})

test('move: a row the sync already made in the target (same UID) is the duplicate and goes; ours keeps file and pin', async t => {
  const s = await setup(t)
  const [id] = s.ids(1)
  await s.reader.open(id)
  const mine = s.index.get(id)
  // the sync got there first: a bare row for the same message in the target folder, UID 77
  s.index.insertMany([{ ...mine, id: undefined, folder: 'Archív', uid: 77, store_path: null, body_state: 0, sender_text: '', recipients_text: '' }])
  const dup = s.index.getByUid(s.row.id, 'Archív', 77)
  assert.ok(dup && dup.id !== id)
  s.index.moveRows([{ id, folder: 'Archív', uid: 77 }])
  assert.equal(s.index.get(dup.id), undefined)
  const moved = s.index.get(id)
  assert.equal(moved.folder, 'Archív')
  assert.equal(moved.uid, 77)
  assert.equal(moved.store_path, mine.store_path)
  assert.equal(moved.body_pinned, 1)
})

test('a stopped account (rejected login) gets no login attempt from an action', async t => {
  const s = await setup(t)
  const e = s.manager.entries.get(s.row.id)
  e.fatal = true
  const attempts = s.server.loginAttempts
  await assert.rejects(s.actions.run({ ids: s.ids(1), action: 'read' }), { code: 'sync_stopped' })
  assert.equal(s.server.loginAttempts, attempts)
})

test('bad requests: unknown id, two folders at once, a bad target', async t => {
  const s = await setup(t)
  await assert.rejects(s.actions.run({ ids: [999_999], action: 'read' }), { code: 'not_found' })
  const a = s.ids(1)[0]
  await s.actions.run({ ids: [a], action: 'move', target: 'Archív' })
  await assert.rejects(s.actions.run({ ids: [a, s.ids(1)[0]], action: 'read' }), { code: 'mixed_selection' })
  await assert.rejects(s.actions.run({ ids: s.ids(1), action: 'move', target: 'Nincs ilyen' }), { code: 'bad_target' })
  await assert.rejects(s.actions.run({ ids: s.ids(1), action: 'move', target: 'INBOX' }), { code: 'bad_target' })
})

test('IPC: arguments checked, error codes passed on, mail:ids for Ctrl+A', async t => {
  const s = await setup(t)
  const handlers = new Map()
  registerActionIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, actions: s.actions, index: s.index, isTrustedSender: e => e.ok })
  const call = (ch, arg, ok = true) => handlers.get(ch)({ ok }, arg)
  assert.deepEqual([...handlers.keys()].sort(), [...ACTION_CHANNELS].sort())
  assert.deepEqual(await call('mail:action', { ids: [1], action: 'read' }, false), { ok: false, error: 'untrusted_sender' })
  for (const bad of [null, { ids: [], action: 'read' }, { ids: ['1'], action: 'read' }, { ids: [1], action: 'format c:' }, { ids: [1], action: 'move' }, { ids: [1], action: 'delete', permanent: 'yes' }]) {
    assert.deepEqual(await call('mail:action', bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
  }
  assert.deepEqual(await call('mail:action', { ids: s.ids(2), action: 'read' }), { ok: true, done: 2, final: false })
  const all = await call('mail:ids', { accountId: s.row.id, folder: 'INBOX' })
  assert.deepEqual(all.ids, s.inbox().map(m => m.id))
  assert.deepEqual(await call('mail:ids', { accountId: s.row.id, folder: 'INBOX', sort: 'x' }), { ok: false, error: 'bad_request' })
  // read / unread only (the two read above, by the flags column); a non-boolean is refused
  const inbox = s.inbox()
  const isRead = m => (m.flags || '').split(' ').includes('\\Seen')
  const read = await call('mail:ids', { accountId: s.row.id, folder: 'INBOX', seen: true })
  const unread = await call('mail:ids', { accountId: s.row.id, folder: 'INBOX', seen: false })
  assert.deepEqual(read.ids, inbox.filter(isRead).map(m => m.id))
  assert.deepEqual(unread.ids, inbox.filter(m => !isRead(m)).map(m => m.id))
  assert.ok(read.ids.length >= 2 && unread.ids.length >= 1, `${read.ids.length} read, ${unread.ids.length} unread`)
  assert.equal(read.ids.length + unread.ids.length, inbox.length)
  assert.deepEqual(await call('mail:ids', { accountId: s.row.id, folder: 'INBOX', seen: 'yes' }), { ok: false, error: 'bad_request' })
})

test('POP3: the same actions on local folders; a final delete keeps the UIDL, so nothing comes back', async t => {
  const pop = await new FakePop3Server().listen()
  onCleanup(t, () => pop.close())
  for (let i = 0; i < 3; i++) pop.add(Buffer.from(`Subject: POP ${i}\r\nDate: ${new Date(NOW - i * DAY).toUTCString()}\r\n\r\nszöveg ${i}\r\n`))
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type: 'pop3', in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user })
  const storeDir = path.join(tempDir(t), 'store')
  const store = { list: () => db.prepare('SELECT * FROM accounts').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id), passwordsFor: () => ({ incoming: pop.pass }) }
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), now: () => NOW, throttleMs: 5 })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => index.listFolder({ accountId: row.id, folder: 'INBOX' }).length === 3)
  const actions = new MailActions({ index, store, storeDir, withConnection: () => assert.fail('no server action for POP3') })
  const [a, b] = index.listFolder({ accountId: row.id, folder: 'INBOX' }).map(m => m.id)
  await actions.run({ ids: [a], action: 'read' })
  assert.equal(index.get(a).flags, '\\Seen')
  await actions.run({ ids: [a], action: 'move', target: 'Drafts' })
  assert.equal(index.get(a).folder, 'Drafts')
  await actions.run({ ids: [b], action: 'delete' })
  assert.equal(index.get(b).folder, 'Trash')
  const file = path.join(storeDir, index.get(b).store_path)
  await actions.run({ ids: [b], action: 'delete', permanent: true })
  assert.equal(index.get(b), undefined)
  assert.equal(fs.existsSync(file), false)
  manager.syncNow()
  await sleep(150)
  await until(() => !manager.status()[0].running)
  assert.equal(index.stats(row.id).total, 2, 'the deleted one is not downloaded again')
  assert.equal(pop.log.filter(l => l.startsWith('RETR')).length, 3)
})

test('flag arithmetic', () => {
  assert.equal(applyFlagChange('\\Seen \\Answered', { add: ['\\Flagged'], remove: ['\\Seen'] }), '\\Answered \\Flagged')
  assert.equal(applyFlagChange('', { add: ['\\Seen', '\\Seen'], remove: [] }), '\\Seen')
})

// ---- refused commands, UIDVALIDITY and EXPUNGE ----
import { uidRange } from '../core/imap/actions.js'

for (const [action, extra] of [['delete', { permanent: true }], ['read', {}], ['move', { target: 'Archív' }]]) {
  test(`UIDVALIDITY changed on the server (folder recreated): ${action} does nothing, an error, a sync brings the new state`, async t => {
    const s = await setup(t, { trash: false, count: 3 })
    const target = s.inbox().find(r => r.subject === 'Levél 2')
    // another client recreates INBOX: new UIDVALIDITY, UIDs from 1 again, other messages
    s.server.mailboxes.set('INBOX', { path: 'INBOX', uidValidity: 2, specialUse: null, messages: new Map(), nextUid: 1 })
    s.server.addMessages('INBOX', [msg(101), msg(102), msg(103)])
    const before = [...s.server.mailboxes.get('INBOX').messages.keys()]
    await assert.rejects(s.actions.run({ ids: [target.id], action, ...extra }), err => err.code === 'uidvalidity_changed')
    assert.deepEqual([...s.server.mailboxes.get('INBOX').messages.keys()], before, 'the new messages are untouched')
    assert.deepEqual(s.serverFlags('INBOX'), ['', '', ''], 'no flag set on them either')
    assert.equal(s.server.mailboxes.get('Archív').messages.size, 0)
    await until(() => s.index.getFolder(s.row.id, 'INBOX').uidvalidity === '2')
    await until(() => s.inbox().some(r => r.subject === 'Levél 102'))
  })
}

test('no UIDPLUS: a delete for good removes only our message, not one another client marked \\Deleted', async t => {
  const s = await setup(t, { trash: false, count: 3 })
  s.server.uidplus = false
  const other = [...s.server.mailboxes.get('INBOX').messages.values()].find(m => /Levél 3/.test(m.source.toString()))
  other.flags.add('\\Deleted') // marked by another client, not expunged
  const mine = s.inbox().find(r => r.subject === 'Levél 2')
  await s.actions.run({ ids: [mine.id], action: 'delete', permanent: true })
  const left = [...s.server.mailboxes.get('INBOX').messages.values()]
  assert.equal(left.length, 2, 'only ours is gone')
  assert.ok(left.some(m => m === other && m.flags.has('\\Deleted')), 'the other one is still there, still \\Deleted')
})

test('no MOVE and no UIDPLUS: a move copies, then removes only ours', async t => {
  const s = await setup(t, { count: 3 })
  s.server.uidplus = false
  s.server.move = false
  const other = [...s.server.mailboxes.get('INBOX').messages.values()].find(m => /Levél 3/.test(m.source.toString()))
  other.flags.add('\\Deleted')
  const mine = s.inbox().find(r => r.subject === 'Levél 1')
  await s.actions.run({ ids: [mine.id], action: 'move', target: 'Archív' })
  const inbox = [...s.server.mailboxes.get('INBOX').messages.values()]
  assert.equal(inbox.length, 2)
  assert.ok(inbox.includes(other) && other.flags.has('\\Deleted'))
  assert.equal(s.server.mailboxes.get('Archív').messages.size, 1)
})

test('uidRange: consecutive UIDs as ranges (Ctrl+A on a big folder stays short)', () => {
  assert.equal(uidRange([5, 1, 2, 3, 7, 8, 10]), '1:3,5,7:8,10')
  assert.equal(uidRange([4]), '4')
  const all = Array.from({ length: 100_000 }, (_, i) => i + 1)
  assert.equal(uidRange(all), '1:100000')
})
