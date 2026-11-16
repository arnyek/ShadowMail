// Folder management with the fake IMAP server ("/" and "."+"INBOX." servers) and a POP3 account's
// local folders: create (also as a subfolder), rename (subfolders and messages move with it), delete
// (confirmation, not with subfolders), the role folders are protected, names are checked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { FolderActions, checkFolderName } from '../app/main/folders.js'
import { MessageReader } from '../app/main/reader.js'
import { registerFolderIpc, FOLDER_CHANNELS } from '../app/main/ipc/folders.js'

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const msg = n => ({ from: `k${n}@example.invalid`, to: 'en@example.invalid', subject: `Levél ${n}`, messageId: `<m${n}@x>`, date: NOW - n * DAY, body: `Szöveg ${n}` })

async function setup(t, { delimiter = '/', prefix = '', type = 'imap' } = {}) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, type === 'pop3' ? { type: 'pop3' } : {})
  const server = new FakeImapServer()
  server.delimiter = delimiter
  server.prefix = prefix
  const p = name => (prefix ? `${prefix}${name}` : name)
  server.addMailbox('INBOX').addMailbox(p('Trash'), { specialUse: '\\Trash' }).addMailbox(p('Sent')).addMailbox(p('Régi'))
  server.addMessages(p('Régi'), [msg(1), msg(2)])
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
  }
  const storeDir = path.join(tempDir(t), 'store')
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), notify: () => {}, connect: () => server.connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  if (type === 'imap') {
    manager.startAll()
    await until(() => manager.entries.get(row.id).idle.connected)
  }
  const changes = []
  const folders = new FolderActions({
    index, store, storeDir,
    withConnection: (id, fn) => manager.withConnection(id, fn),
    onChange: c => changes.push(c),
    requestSync: (id, f) => manager.requestSync(id, f),
  })
  const local = () => index.folders(row.id).map(f => f.path).sort()
  const onServer = () => [...server.mailboxes.keys()].sort()
  const idle = () => until(() => !manager.entries.get(row.id).syncer.current)
  return { db, index, row, server, manager, folders, local, onServer, idle, p, changes, storeDir }
}

test('"/" server: create top level and subfolder, rename (subfolder and messages follow), delete with confirmation', async t => {
  const s = await setup(t)
  assert.deepEqual(await s.folders.create({ accountId: s.row.id, name: 'Projektek' }), { path: 'Projektek' })
  assert.deepEqual(await s.folders.create({ accountId: s.row.id, parent: 'Projektek', name: '2026 Ősz' }), { path: 'Projektek/2026 Ősz' })
  assert.ok(s.onServer().includes('Projektek/2026 Ősz'))
  assert.ok(s.server.subscribed.has('Projektek') && s.server.subscribed.has('Projektek/2026 Ősz'), 'subscribed (other clients show it)')
  assert.ok(s.local().includes('Projektek/2026 Ősz'))

  // rename a folder with messages and one with a subfolder
  await s.idle()
  const ids = s.index.listFolder({ accountId: s.row.id, folder: 'Régi' }).map(m => m.id)
  assert.equal(ids.length, 2)
  assert.deepEqual(await s.folders.rename({ accountId: s.row.id, path: 'Régi', name: 'Archív 2020' }), { path: 'Archív 2020' })
  assert.ok(ids.every(id => s.index.get(id).folder === 'Archív 2020'), 'the messages moved locally at once')
  await s.folders.rename({ accountId: s.row.id, path: 'Projektek', name: 'Ügyek' })
  assert.ok(s.onServer().includes('Ügyek/2026 Ősz') && !s.onServer().includes('Projektek'))
  assert.ok(s.local().includes('Ügyek/2026 Ősz') && !s.local().some(p => p.startsWith('Projektek')))
  // after the sync the tree matches the server (no stale or doubled folders)
  await s.idle()
  await until(() => s.index.listFolder({ accountId: s.row.id, folder: 'Archív 2020' }).length === 2)
  assert.deepEqual(s.local(), s.onServer())

  await assert.rejects(s.folders.remove({ accountId: s.row.id, path: 'Ügyek', confirmed: true }), { code: 'has_children' })
  await assert.rejects(s.folders.remove({ accountId: s.row.id, path: 'Ügyek/2026 Ősz' }), { code: 'confirm_needed' })
  assert.ok(s.onServer().includes('Ügyek/2026 Ősz'), 'nothing without confirmation')
  await s.folders.remove({ accountId: s.row.id, path: 'Ügyek/2026 Ősz', confirmed: true })
  await s.folders.remove({ accountId: s.row.id, path: 'Ügyek', confirmed: true })
  assert.ok(!s.onServer().some(p => p.startsWith('Ügyek')))
  assert.ok(!s.local().some(p => p.startsWith('Ügyek')))
})

test('"." server with the "INBOX." namespace: top level gets the prefix, the subfolder the "." delimiter', async t => {
  const s = await setup(t, { delimiter: '.', prefix: 'INBOX.' })
  assert.deepEqual(await s.folders.create({ accountId: s.row.id, name: 'Projektek' }), { path: 'INBOX.Projektek' })
  assert.deepEqual(await s.folders.create({ accountId: s.row.id, parent: 'INBOX.Projektek', name: 'Példa Kft' }), { path: 'INBOX.Projektek.Példa Kft' })
  assert.ok(s.onServer().includes('INBOX.Projektek.Példa Kft'))
  await assert.rejects(s.folders.create({ accountId: s.row.id, name: 'a.b' }), { code: 'name_has_delimiter' })
  await s.folders.rename({ accountId: s.row.id, path: 'INBOX.Projektek', name: 'Ügyfelek' })
  assert.ok(s.onServer().includes('INBOX.Ügyfelek.Példa Kft'))
  await s.idle()
  await sleep(30)
  await s.idle()
  assert.deepEqual(s.local(), s.onServer())
})

test('the role folders cannot be renamed or deleted (SPECIAL-USE and the usual names)', async t => {
  const s = await setup(t)
  for (const p of ['INBOX', 'Trash', 'Sent']) {
    await assert.rejects(s.folders.rename({ accountId: s.row.id, path: p, name: 'Más' }), { code: 'protected_folder' }, p)
    await assert.rejects(s.folders.remove({ accountId: s.row.id, path: p, confirmed: true }), { code: 'protected_folder' }, p)
  }
  assert.ok(['INBOX', 'Trash', 'Sent'].every(p => s.onServer().includes(p)))
})

test('names: empty, too long, wildcards, the delimiter, an existing folder, a server refusal', async t => {
  const s = await setup(t)
  for (const [name, code] of [['', 'bad_name'], ['   ', 'bad_name'], ['x'.repeat(201), 'bad_name'], ['a*b', 'bad_name'], ['50%', 'bad_name'], ['a/b', 'name_has_delimiter'], ['inbox', 'bad_name']]) {
    await assert.rejects(s.folders.create({ accountId: s.row.id, name }), { code }, name)
  }
  await assert.rejects(s.folders.create({ accountId: s.row.id, name: 'régi' }), { code: 'folder_exists' })
  s.server.refuseOps.add('create')
  await assert.rejects(s.folders.create({ accountId: s.row.id, name: 'Új' }), { code: 'server_refused' })
  assert.ok(!s.local().includes('Új'))
  assert.deepEqual(checkFolderName('  Számlák 2026  ', '/'), { name: 'Számlák 2026' })
})

test('deleting a folder takes its messages and their downloaded files locally', async t => {
  const s = await setup(t)
  await s.idle()
  const id = s.index.listFolder({ accountId: s.row.id, folder: 'Régi' })[0].id
  const reader = new MessageReader({ index: s.index, sealed: sealedStore(s.storeDir), withConnection: (a, fn) => s.manager.withConnection(a, fn) })
  await reader.open(id)
  const file = path.join(s.storeDir, s.index.get(id).store_path)
  assert.ok(fs.existsSync(file))
  await s.folders.remove({ accountId: s.row.id, path: 'Régi', confirmed: true })
  assert.equal(s.index.get(id), undefined)
  assert.equal(fs.existsSync(file), false)
  assert.ok(!s.onServer().includes('Régi'))
})

test('POP3: local folders the same way, the role folders protected, a deleted folder takes its messages', async t => {
  const s = await setup(t, { type: 'pop3' })
  s.index.ensureLocalFolders(s.row.id, [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Trash', specialUse: '\\Trash' }])
  assert.deepEqual(await s.folders.create({ accountId: s.row.id, name: 'Számlák' }), { path: 'Számlák' })
  assert.deepEqual(await s.folders.create({ accountId: s.row.id, parent: 'Számlák', name: '2026' }), { path: 'Számlák/2026' })
  assert.ok(s.index.folders(s.row.id).filter(f => f.path.startsWith('Számlák')).every(f => f.is_local === 1))
  s.index.insertMany([{ account_id: s.row.id, folder: 'Számlák/2026', uid: null, pop3_uidl: 'u1', message_id: null, in_reply_to: null, refs: null, from_addr: 'a', from_name: '', to_addrs: '', cc_addrs: '', subject: 'Számla', date: NOW, idate: NOW, flags: '', size: 1, has_attachments: 0, attachments: null, body_state: 1, sender_text: '', recipients_text: '' }])
  await s.folders.rename({ accountId: s.row.id, path: 'Számlák', name: 'Bejövő számlák' })
  assert.equal(s.index.getByUidl(s.row.id, 'u1').folder, 'Bejövő számlák/2026')
  await assert.rejects(s.folders.rename({ accountId: s.row.id, path: 'Trash', name: 'x' }), { code: 'protected_folder' })
  await s.folders.remove({ accountId: s.row.id, path: 'Bejövő számlák/2026', confirmed: true })
  assert.equal(s.index.getByUidl(s.row.id, 'u1'), undefined)
  assert.deepEqual(s.server.actionLog, [], 'no server involved')
})

test('a folder name with "_" and "%"-like neighbours: the subtree match is exact, not LIKE', async t => {
  const s = await setup(t)
  await s.folders.create({ accountId: s.row.id, name: 'a_b' })
  await s.folders.create({ accountId: s.row.id, name: 'axb' })
  await s.folders.create({ accountId: s.row.id, parent: 'a_b', name: 'c' })
  await s.folders.rename({ accountId: s.row.id, path: 'a_b', name: 'z' })
  assert.ok(s.local().includes('axb'), 'a LIKE "a_b%" would have renamed this too')
  assert.ok(s.local().includes('z/c'))
})

test('IPC: arguments checked, error codes passed on', async t => {
  const s = await setup(t)
  const handlers = new Map()
  registerFolderIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, folders: s.folders, isTrustedSender: e => e.ok })
  const call = (ch, arg, ok = true) => handlers.get(ch)({ ok }, arg)
  assert.deepEqual([...handlers.keys()].sort(), [...FOLDER_CHANNELS].sort())
  assert.deepEqual(await call('folder:create', { accountId: s.row.id, name: 'x' }, false), { ok: false, error: 'untrusted_sender' })
  for (const bad of [null, { accountId: 'x', name: 'a' }, { accountId: s.row.id, name: 5 }, { accountId: s.row.id, name: 'a', parent: 7 }]) {
    assert.deepEqual(await call('folder:create', bad), { ok: false, error: 'bad_request' })
  }
  assert.deepEqual(await call('folder:create', { accountId: s.row.id, name: 'IPC-mappa' }), { ok: true, path: 'IPC-mappa' })
  assert.deepEqual(await call('folder:delete', { accountId: s.row.id, path: 'IPC-mappa' }), { ok: false, error: 'confirm_needed' })
  assert.deepEqual(await call('folder:delete', { accountId: s.row.id, path: 'IPC-mappa', confirmed: 'igen' }), { ok: false, error: 'bad_request' })
  assert.deepEqual(await call('folder:delete', { accountId: s.row.id, path: 'IPC-mappa', confirmed: true }), { ok: true, path: 'IPC-mappa' })
})
