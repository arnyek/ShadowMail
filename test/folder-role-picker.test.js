// SPDX-License-Identifier: GPL-3.0-or-later
// The role picker (account settings): the user's choice for a role beats every automatic rule, survives the syncs,
// moves the role off its old holder, goes back to the automatic rule on "Automatic" or when the folder disappears from
// the server; a folder created in the app gets its usual-name role at once. Real SyncManager + FolderActions + the
// IPC, the fake IMAP server (STATUS counts the messages in it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { FolderActions } from '../app/main/folders.js'
import { registerFolderIpc, CHOOSABLE_ROLES } from '../app/main/ipc/folders.js'
import { assignRoles, resolveRoles } from '../core/imap/folders.js'

const NOW = Date.UTC(2026, 10, 16, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const msg = n => ({ from: `k${n}@example.invalid`, to: 'en@example.invalid', subject: `Levél ${n}`, messageId: `<m${n}@x>`, date: NOW - n * DAY, body: `Szöveg ${n}` })
const byRole = roles => Object.fromEntries([...roles].map(([p, r]) => [r, p]))

async function setup(t, { type = 'imap' } = {}) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, type === 'pop3' ? { type: 'pop3' } : {})
  const server = new FakeImapServer()
  server.delimiter = '/'
  // a mailbox of two programs: "Sent" (the traffic) and "Elküldött elemek" (another program's); Trash flagged by the server
  server.addMailbox('INBOX').addMailbox('Sent').addMailbox('Elküldött elemek').addMailbox('Trash', { specialUse: '\\Trash' }).addMailbox('Drafts').addMailbox('Régi').addMailbox('Archive')
  server.addMessages('Sent', [msg(1), msg(2), msg(3)])
  server.addMessages('Elküldött elemek', [msg(4)])
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
  const syncs = []
  const logs = []
  const folders = new FolderActions({
    index, store, storeDir,
    withConnection: (id, fn) => manager.withConnection(id, fn),
    onChange: c => changes.push(c),
    requestSync: (id, f) => (syncs.push([id, f]), manager.requestSync(id, f)),
    log: l => logs.push(l),
  })
  const idle = () => until(() => !manager.entries.get(row.id).syncer.current)
  const roles = () => byRole(assignRoles(index.folderList(row.id)))
  const fullSync = async () => {
    manager.requestSync(row.id)
    await sleep(20)
    await idle()
  }
  return { db, index, row, server, manager, folders, idle, roles, fullSync, changes, syncs, logs }
}

test('resolveRoles: the chosen role beats the server flag, the earlier role and the counts', () => {
  const f = paths => paths.map(p => ({ path: p, delimiter: '/', specialUse: p === 'Trash' ? '\\Trash' : null }))
  const folders = f(['INBOX', 'Sent', 'Elküldött elemek', 'Trash', 'Régi'])
  const manual = new Map([['Elküldött elemek', 'sent'], ['Régi', 'trash']])
  const previous = new Map([['Sent', 'sent'], ['Trash', 'trash']])
  const counts = new Map([['Sent', 3], ['Elküldött elemek', 1]])
  const r = byRole(resolveRoles(folders, { previous, counts, manual }).roles)
  assert.equal(r.sent, 'Elküldött elemek')
  assert.equal(r.trash, 'Régi', 'over the server\'s \\Trash flag')
  // a chosen folder that is not listed (gone) does not count; INBOX cannot be chosen away
  const gone = byRole(resolveRoles(f(['INBOX', 'Sent']), { manual: new Map([['Nincs', 'sent'], ['INBOX', 'inbox']]) }).roles)
  assert.deepEqual(gone, { inbox: 'INBOX', sent: 'Sent' })
})

test('choose, survive the syncs, go back to Automatic; the role leaves its old holder', async t => {
  const s = await setup(t)
  await s.idle()
  assert.equal(s.roles().sent, 'Sent', 'automatic: the bigger of the two')
  assert.equal(s.roles().trash, 'Trash')

  assert.deepEqual(await s.folders.setRole({ accountId: s.row.id, role: 'sent', path: 'Elküldött elemek' }), { changed: 2 })
  assert.equal(s.roles().sent, 'Elküldött elemek', 'at once, before any sync')
  assert.equal(s.index.folderList(s.row.id).find(f => f.path === 'Sent').role, null, 'the old holder lost it')
  assert.equal(s.changes.at(-1).accountId, s.row.id)
  assert.ok(s.changes.at(-1).folders.includes('Sent') && s.changes.at(-1).folders.includes('Elküldött elemek'))
  assert.deepEqual(s.syncs.at(-1), [s.row.id, undefined], 'a full sync decides the rest again')
  await s.idle()
  await s.fullSync()
  assert.equal(s.roles().sent, 'Elküldött elemek', 'the choice survives the syncs')
  assert.equal(s.index.folderList(s.row.id).find(f => f.path === 'Sent').role, null)

  // a chosen trash beats the server's \Trash flag, also after a sync
  await s.folders.setRole({ accountId: s.row.id, role: 'trash', path: 'Régi' })
  await s.idle()
  await s.fullSync()
  assert.equal(s.roles().trash, 'Régi')
  assert.equal(s.index.folderList(s.row.id).find(f => f.path === 'Trash').role, null)

  // choosing a folder that has another role: it takes the new one, the old one is decided again by the sync
  await s.folders.setRole({ accountId: s.row.id, role: 'drafts', path: 'Elküldött elemek' })
  assert.equal(s.roles().drafts, 'Elküldött elemek')
  await s.idle()
  await s.fullSync()
  assert.equal(s.roles().sent, 'Sent', 'sent went back to the automatic rule')
  assert.equal(s.roles().drafts, 'Elküldött elemek')

  // Automatic: the sync decides with the usual rule
  await s.folders.setRole({ accountId: s.row.id, role: 'drafts', path: null })
  await s.folders.setRole({ accountId: s.row.id, role: 'trash', path: null })
  await s.idle()
  await s.fullSync()
  assert.equal(s.roles().drafts, 'Drafts')
  assert.equal(s.roles().trash, 'Trash')
  assert.equal(s.index.manualRoles(s.row.id).size, 0)
  // the log names the role, never the folder
  assert.ok(s.logs.every(l => !/Elküldött|Régi|Drafts/.test(l)), JSON.stringify(s.logs))
})

test('a chosen folder that disappears from the server: the role goes back to the automatic rule', async t => {
  const s = await setup(t)
  await s.idle()
  await s.folders.setRole({ accountId: s.row.id, role: 'archive', path: 'Régi' })
  await s.idle()
  assert.equal(s.roles().archive, 'Régi')
  s.server.mailboxes.delete('Régi')
  await s.fullSync()
  assert.equal(s.roles().archive, 'Archive')
  assert.equal(s.index.manualRoles(s.row.id).size, 0)
})

test('a folder created in the app gets its usual-name role at once (no full sync yet)', async t => {
  const s = await setup(t)
  s.server.mailboxes.delete('Archive')
  await s.fullSync()
  assert.equal(s.roles().archive, undefined)
  await s.folders.create({ accountId: s.row.id, name: 'Archive' })
  assert.equal(s.roles().archive, 'Archive', 'from the name, before the full sync stores it')
  await s.idle()
  await s.fullSync()
  assert.equal(s.index.folderList(s.row.id).find(f => f.path === 'Archive').role, 'archive', 'the sync agrees')
})

test('errors: unknown folder, local folder, POP3; nothing is written', async t => {
  const s = await setup(t)
  await s.idle()
  const before = JSON.stringify(s.index.folderList(s.row.id))
  assert.throws(() => s.folders.setRole({ accountId: s.row.id, role: 'sent', path: 'Nincs' }), { code: 'not_found' })
  assert.throws(() => s.folders.setRole({ accountId: 999, role: 'sent', path: null }), { code: 'not_found' })
  assert.equal(JSON.stringify(s.index.folderList(s.row.id)), before)
  const p = await setup(t, { type: 'pop3' })
  assert.throws(() => p.folders.setRole({ accountId: p.row.id, role: 'sent', path: null }), { code: 'pop3_local' })
})

test('the IPC: only a trusted sender, one of the five roles, a path or null, no other key', async t => {
  const s = await setup(t)
  await s.idle()
  const handlers = new Map()
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) }
  let trusted = true
  registerFolderIpc({ ipcMain, folders: s.folders, isTrustedSender: () => trusted })
  const call = (q, ok = true) => ((trusted = ok), handlers.get('folders:setRole')({}, q))
  assert.deepEqual(CHOOSABLE_ROLES, ['drafts', 'sent', 'trash', 'junk', 'archive'])
  assert.deepEqual(await call({ accountId: s.row.id, role: 'sent', path: null }, false), { ok: false, error: 'untrusted_sender' })
  const bad = [
    null, [], 'x', { accountId: s.row.id, role: 'inbox', path: null }, { accountId: s.row.id, role: 'spam', path: null },
    { accountId: s.row.id, role: 'sent' }, { accountId: s.row.id, role: 'sent', path: '' }, { accountId: s.row.id, role: 'sent', path: 5 },
    { accountId: 0, role: 'sent', path: null }, { accountId: s.row.id, role: 'sent', path: null, extra: 1 }, { accountId: s.row.id, role: 'sent', path: 'x'.repeat(1001) },
  ]
  for (const q of bad) assert.deepEqual(await call(q), { ok: false, error: 'bad_request' }, JSON.stringify(q)?.slice(0, 80))
  assert.deepEqual(await call({ accountId: s.row.id, role: 'sent', path: 'Nincs' }), { ok: false, error: 'not_found' })
  assert.deepEqual(await call({ accountId: s.row.id, role: 'sent', path: 'Elküldött elemek' }), { ok: true, changed: 2 })
  assert.equal(s.roles().sent, 'Elküldött elemek')
})

test('no gap after "Automatic" or a choice that takes a role away: every role is decided again at once', async t => {
  const s = await setup(t)
  // the mixed mailbox of the folder-role fix: when Trash is taken away, two more trash candidates by name, the bigger one is real
  s.server.addMailbox('Törölt elemek').addMailbox('INBOX.Törölt elemek')
  s.server.addMessages('Törölt elemek', [msg(10), msg(11)])
  await s.fullSync()
  assert.equal(s.roles().sent, 'Sent')
  assert.equal(s.roles().trash, 'Trash', 'the server flag (and then the stored role)')
  // choose, then Automatic: at once, before any sync, the bigger of the two (not the alphabet's "Elküldött elemek")
  s.folders.setRole({ accountId: s.row.id, role: 'sent', path: 'Elküldött elemek' })
  s.folders.setRole({ accountId: s.row.id, role: 'sent', path: null })
  assert.equal(s.roles().sent, 'Sent', 'Automatic decides at once by the local counts')
  // a choice that takes the Trash folder for another role: trash goes to the bigger name candidate at once
  s.folders.setRole({ accountId: s.row.id, role: 'archive', path: 'Trash' })
  assert.equal(s.roles().archive, 'Trash')
  assert.equal(s.roles().trash, 'Törölt elemek', 'the bigger one, not the empty INBOX.Törölt elemek of the alphabet')
  // every role is stored (nothing left to the name fallback)
  const stored = new Set(s.index.folderList(s.row.id).filter(f => f.role).map(f => f.role))
  for (const r of ['inbox', 'sent', 'trash', 'archive']) assert.ok(stored.has(r), r)
})

test('assignRoles: the name fallback gives a role only to a single candidate; two wait for the sync', () => {
  const rows = [
    { path: 'INBOX', role: 'inbox' },
    { path: 'Sent', role: null },
    { path: 'Elküldött elemek', role: null },
    { path: 'Archive', role: null },
  ].map(r => ({ delimiter: '/', special_use: null, role_manual: 0, ...r }))
  const r = byRole(assignRoles(rows))
  assert.equal(r.sent, undefined, 'two sent candidates: no guess by the alphabet')
  assert.equal(r.archive, 'Archive', 'one archive candidate: its role at once')
})

test('INBOX cannot be chosen for another role: bad_request, nothing changes', async t => {
  const s = await setup(t)
  await s.idle()
  const before = JSON.stringify(s.index.folderList(s.row.id))
  assert.throws(() => s.folders.setRole({ accountId: s.row.id, role: 'sent', path: 'INBOX' }), { code: 'bad_request' })
  assert.throws(() => s.folders.setRole({ accountId: s.row.id, role: 'sent', path: 'inbox' }), { code: 'bad_request' })
  assert.equal(JSON.stringify(s.index.folderList(s.row.id)), before)
  const handlers = new Map()
  registerFolderIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, folders: s.folders, isTrustedSender: () => true })
  assert.deepEqual(await handlers.get('folders:setRole')({}, { accountId: s.row.id, role: 'sent', path: 'INBOX' }), { ok: false, error: 'bad_request' })
  assert.equal(s.roles().sent, 'Sent')
})
