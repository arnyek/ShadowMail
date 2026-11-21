// SPDX-License-Identifier: GPL-3.0-or-later
// Moving a folder under another one (FolderActions.move, folder:move): the fake IMAP server (one RENAME, the subtree,
// the messages, the subscriptions with a server that carries a child's subscription along and with one that does not),
// every refusal without a server call or an index write, the moved root's manual order, a POP3 account's local folders
// (the index only) and the IPC.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { FolderActions } from '../app/main/folders.js'
import { registerFolderIpc } from '../app/main/ipc/folders.js'
import { buildFolderTree, siblingsOf } from '../core/imap/folders.js'

const NOW = Date.UTC(2026, 10, 19, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const t0 = performance.now()
  while (!(await fn())) {
    if (performance.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const msg = n => ({ from: `k${n}@example.invalid`, to: 'en@example.invalid', subject: `Levél ${n}`, messageId: `<mv${n}@x>`, date: NOW - n * DAY, body: `Szöveg ${n}` })

// A/B (2 messages) with A/B/x (1), C with C/c, D with D/b, the Trash with Trash/Régi, Junk; prefix: the personal namespace
async function setup(t, { delimiter = '/', prefix = '', carries = false, known = false, type = 'imap' } = {}) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, type === 'pop3' ? { type: 'pop3' } : {})
  const server = new FakeImapServer()
  server.delimiter = delimiter
  server.prefix = prefix
  server.renameCarriesSubscriptions = carries
  server.subscriptionsKnown = known
  const d = delimiter
  const p = name => `${prefix}${name.split('/').join(d)}`
  server.addMailbox('INBOX').addMailbox(p('Trash'), { specialUse: '\\Trash' }).addMailbox(p('Trash/Régi')).addMailbox(p('Junk'), { specialUse: '\\Junk' })
  for (const f of ['A', 'A/B', 'A/B/x', 'C', 'C/c', 'D', 'D/b']) server.addMailbox(p(f))
  server.addMessages(p('A/B'), [msg(1), msg(2)])
  server.addMessages(p('A/B/x'), [msg(3)])
  for (const f of ['Trash', 'Trash/Régi', 'Junk', 'A', 'A/B', 'A/B/x', 'C', 'C/c', 'D', 'D/b']) server.subscribed.add(p(f))
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
  const syncs = []
  const changes = []
  let calls = 0
  const folders = new FolderActions({
    index, store, storeDir,
    withConnection: (id, fn) => (calls++, manager.withConnection(id, fn)),
    onChange: c => changes.push(c),
    requestSync: (id, f) => (syncs.push([id, f]), manager.requestSync(id, f)),
  })
  const local = () => index.folderList(row.id).map(f => f.path).sort()
  const ids = folder => db.prepare('SELECT id FROM messages WHERE account_id = ? AND folder = ? ORDER BY id').all(row.id, folder).map(r => r.id)
  const idle = () => until(() => !manager.entries.get(row.id).syncer.current)
  const renames = () => server.actionLog.filter(a => a.op === 'rename')
  return { db, index, row, server, manager, folders, local, ids, idle, p, changes, syncs, renames, calls: () => calls }
}

test('IMAP: A/B under C is one RENAME, the subtree and its messages follow (same ids), then a full sync', async t => {
  const s = await setup(t)
  await s.idle()
  const before = { b: s.ids('A/B'), x: s.ids('A/B/x') }
  assert.equal(before.b.length, 2)
  assert.deepEqual(await s.folders.move({ accountId: s.row.id, path: 'A/B', parent: 'C' }), { path: 'C/B' })
  assert.deepEqual(s.renames(), [{ op: 'rename', path: 'A/B', to: 'C/B' }])
  assert.ok(s.local().includes('C/B') && s.local().includes('C/B/x') && !s.local().some(p => p.startsWith('A/B')), JSON.stringify(s.local()))
  assert.deepEqual(s.ids('C/B'), before.b)
  assert.deepEqual(s.ids('C/B/x'), before.x)
  assert.deepEqual(s.syncs.at(-1), [s.row.id, undefined], 'a full sync after the move')
  assert.deepEqual(s.changes.at(-1), { accountId: s.row.id, folders: ['A/B', 'C/B'] })
  await s.idle()
  assert.ok(s.local().includes('C/B/x'), 'still there after the sync (the moved folders are subscribed)')
})

test('to the top level (parent null): the leaf; with a namespace prefix the server form comes back', async t => {
  const s = await setup(t)
  await s.idle()
  assert.deepEqual(await s.folders.move({ accountId: s.row.id, path: 'A/B', parent: null }), { path: 'B' })
  assert.ok(s.local().includes('B/x'))
  const n = await setup(t, { delimiter: '.', prefix: 'INBOX.' })
  await n.idle()
  assert.deepEqual(await n.folders.move({ accountId: n.row.id, path: 'INBOX.A.B', parent: 'INBOX.C' }), { path: 'INBOX.C.B' })
  assert.deepEqual(await n.folders.move({ accountId: n.row.id, path: 'INBOX.C.B', parent: null }), { path: 'INBOX.B' })
  assert.ok(n.local().includes('INBOX.B.x'), JSON.stringify(n.local()))
})

test('every refusal: no RENAME, no index write, no sync', async t => {
  const s = await setup(t, { known: true })
  // an automatic role (the server's SPECIAL-USE flag) on a folder under one of our own
  s.server.addMailbox('D/Küldött', { specialUse: '\\Sent' })
  s.server.subscribed.add('D/Küldött')
  await s.idle()
  s.manager.requestSync(s.row.id)
  await sleep(20)
  await s.idle()
  const cases = [
    [{ path: 'Trash', parent: 'C' }, 'protected_folder'],
    [{ path: 'D', parent: 'C' }, 'protected_subfolder'], // D/Küldött below it has an automatic role
    [{ path: 'C/c', parent: 'C/c' }, 'bad_target'], // itself
    [{ path: 'C', parent: 'C/c' }, 'bad_target'], // under itself
    [{ path: 'C/c', parent: 'C' }, 'bad_target'], // its present parent
    [{ path: 'C/c', parent: 'Nincs' }, 'bad_target'], // no such folder
    [{ path: 'C', parent: null }, 'bad_target'], // already on the top level
    [{ path: 'C/c', parent: 'Trash' }, 'trash_target'],
    [{ path: 'C/c', parent: 'Trash/Régi' }, 'trash_target'],
    [{ path: 'C/c', parent: 'Junk' }, 'trash_target'],
    [{ path: 'Nincs', parent: 'C' }, 'not_found'],
  ]
  const local = s.local()
  for (const [q, code] of cases) {
    await assert.rejects(s.folders.move({ accountId: s.row.id, ...q }), { code }, JSON.stringify(q))
  }
  await assert.rejects(s.folders.move({ accountId: s.row.id, path: 'D/b', parent: 'A' }), { code: 'folder_exists' }, '"b" vs "B" (A/B)')
  // a folder row without a delimiter (a flat server)
  s.db.prepare("UPDATE folders SET delimiter = NULL WHERE account_id = ? AND path = 'C'").run(s.row.id)
  await assert.rejects(s.folders.move({ accountId: s.row.id, path: 'C', parent: 'A' }), { code: 'no_subfolders' })
  assert.deepEqual(s.renames(), [])
  assert.deepEqual(s.local(), local)
  assert.deepEqual(s.syncs, [])
  assert.equal(s.calls(), 0, 'no server call for a refusal')
})

test('the server refuses the RENAME (NO): server_refused, the index unchanged', async t => {
  const s = await setup(t)
  await s.idle()
  s.server.addMailbox('C/B') // on the server only: the RENAME's target exists there
  const local = s.local()
  await assert.rejects(s.folders.move({ accountId: s.row.id, path: 'A/B', parent: 'C' }), { code: 'server_refused' })
  assert.deepEqual(s.local(), local)
  assert.deepEqual(s.ids('A/B').length, 2)
})

test('the moved root loses its manual order; the target list keeps its own rule', async t => {
  const s = await setup(t)
  await s.idle()
  const order = () => Object.fromEntries(s.index.folderList(s.row.id).map(f => [f.path, f.sort_order]))
  // a manual order on A's children and on the top level
  s.index.reorderFolders(s.row.id, 'A', ['A/B'])
  const top = siblingsOf(buildFolderTree(s.index.folderList(s.row.id)), null).map(n => n.path)
  s.index.reorderFolders(s.row.id, null, [...top].reverse())
  assert.equal(order()['A/B'], 0)
  await s.folders.move({ accountId: s.row.id, path: 'A/B', parent: 'C' })
  assert.equal(order()['C/B'], null, 'the moved root: no manual order')
  assert.equal(order()['C/c'], null, 'C\'s children had none, and still have none')
  await s.folders.move({ accountId: s.row.id, path: 'C/B', parent: null })
  assert.equal(order().B, null)
  const after = siblingsOf(buildFolderTree(s.index.folderList(s.row.id)), null).map(n => n.path)
  assert.equal(after.at(-1), 'B', `after the manually ordered ones: ${after.join(', ')}`)
})

for (const carries of [false, true]) {
  test(`subscriptions (the server ${carries ? 'carries' : 'does not carry'} a child's subscription): the subtree stays subscribed, a kept folder stays unsubscribed`, async t => {
    const s = await setup(t, { carries, known: true })
    // y: on the server, unsubscribed, not shown; z: unsubscribed but kept (shown)
    s.server.addMailbox('A/B/y').addMailbox('A/B/z')
    s.server.subscribed.add('A/B/z')
    await s.idle()
    s.manager.requestSync(s.row.id)
    await sleep(20)
    await s.idle()
    s.server.subscribed.delete('A/B/z')
    s.db.prepare("UPDATE folders SET kept = 1 WHERE account_id = ? AND path = 'A/B/z'").run(s.row.id)
    assert.ok(!s.local().includes('A/B/y') && s.local().includes('A/B/z'), JSON.stringify(s.local()))
    await s.folders.move({ accountId: s.row.id, path: 'A/B', parent: 'C' })
    const sub = [...s.server.subscribed].filter(p => p.includes('B')).sort()
    assert.deepEqual(sub, ['C/B', 'C/B/x'], `subscribed: ${sub.join(', ')}`)
    s.manager.requestSync(s.row.id)
    await sleep(20)
    await s.idle()
    assert.ok(['C/B', 'C/B/x', 'C/B/z'].every(p => s.local().includes(p)) && !s.local().includes('C/B/y'), JSON.stringify(s.local()))
  })
}

test('POP3 local folders: the index only, no connection', async t => {
  const s = await setup(t, { type: 'pop3' })
  await s.folders.create({ accountId: s.row.id, parent: null, name: 'A' })
  await s.folders.create({ accountId: s.row.id, parent: 'A', name: 'B' })
  await s.folders.create({ accountId: s.row.id, parent: 'A/B', name: 'x' })
  await s.folders.create({ accountId: s.row.id, parent: null, name: 'C' })
  assert.deepEqual(await s.folders.move({ accountId: s.row.id, path: 'A/B', parent: 'C' }), { path: 'C/B' })
  assert.ok(s.local().includes('C/B/x') && !s.local().includes('A/B'))
  assert.deepEqual(await s.folders.move({ accountId: s.row.id, path: 'C/B', parent: null }), { path: 'B' })
  assert.equal(s.calls(), 0)
  assert.deepEqual(s.syncs, [])
})

test('IPC folder:move: exactly { accountId, path, parent }, a trusted sender only', async t => {
  const s = await setup(t)
  await s.idle()
  const handlers = new Map()
  registerFolderIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, folders: s.folders, isTrustedSender: e => e.ok })
  const call = (arg, ok = true) => handlers.get('folder:move')({ ok }, arg)
  const id = s.row.id
  assert.deepEqual(await call({ accountId: id, path: 'A/B', parent: 'C' }, false), { ok: false, error: 'untrusted_sender' })
  for (const bad of [null, [], { accountId: id, path: 'A/B' }, { accountId: id, path: 'A/B', parent: 'C', extra: 1 }, { accountId: '1', path: 'A/B', parent: 'C' }, { accountId: id, path: '', parent: 'C' }, { accountId: id, path: 'A/B', parent: 5 }, { accountId: id, path: 'A/B', parent: '' }, { accountId: id, path: 'A/B', parent: undefined }]) {
    assert.deepEqual(await call(bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
  }
  assert.deepEqual(s.renames(), [])
  assert.deepEqual(await call({ accountId: id, path: 'A/B', parent: 'C' }), { ok: true, path: 'C/B' })
  assert.deepEqual(await call({ accountId: id, path: 'C/B', parent: null }), { ok: true, path: 'B' })
})

// the same subtree subscriptions on a plain rename (a server that does not carry a child's subscription:
// measured on the live test server, folder-move-live.mjs (a))
for (const carries of [false, true]) {
  test(`rename (the server ${carries ? 'carries' : 'does not carry'} a child's subscription): the renamed subtree stays subscribed, no stale old name, a kept folder stays unsubscribed`, async t => {
    const s = await setup(t, { carries, known: true })
    s.server.addMailbox('A/B/z')
    s.server.subscribed.add('A/B/z')
    await s.idle()
    s.manager.requestSync(s.row.id)
    await sleep(20)
    await s.idle()
    s.server.subscribed.delete('A/B/z')
    s.db.prepare("UPDATE folders SET kept = 1 WHERE account_id = ? AND path = 'A/B/z'").run(s.row.id)
    assert.deepEqual(await s.folders.rename({ accountId: s.row.id, path: 'A/B', name: 'Új' }), { path: 'A/Új' })
    const sub = [...s.server.subscribed].filter(p => p.startsWith('A/')).sort()
    assert.deepEqual(sub, ['A/Új', 'A/Új/x'], `subscribed: ${sub.join(', ')}`)
    s.manager.requestSync(s.row.id)
    await sleep(20)
    await s.idle()
    assert.ok(['A/Új', 'A/Új/x', 'A/Új/z'].every(p => s.local().includes(p)) && !s.local().some(p => p.startsWith('A/B')), JSON.stringify(s.local()))
  })
}

// A rename, a move or a create while a full sync runs, after its LIST: the run's clean-up must not drop the written rows
// (they are not in its LIST), or the subtree drops out of the index and comes back with new message ids at the next
// run. The skipped clean-up (here: C/c deleted on the server meanwhile) happens at the next full run.
const RACES = [
  ['rename A -> Z', s => s.folders.rename({ accountId: s.row.id, path: 'A', name: 'Z' }), { b: 'Z/B', x: 'Z/B/x', gone: 'A' }],
  ['move A/B under C', s => s.folders.move({ accountId: s.row.id, path: 'A/B', parent: 'C' }), { b: 'C/B', x: 'C/B/x', gone: 'A/B' }],
  ['create Új', s => s.folders.create({ accountId: s.row.id, parent: null, name: 'Új' }), { b: 'A/B', x: 'A/B/x', made: 'Új' }],
]
for (const [name, act, want] of RACES) {
  test(`${name} racing a full sync after its LIST: nothing written is dropped, the same message ids; the clean-up waits a run`, async t => {
    const s = await setup(t)
    // a message synced after A/B: a row dropped and filled in again cannot get its old id back
    s.server.addMessages(s.p('D/b'), [msg(9)])
    s.manager.requestSync(s.row.id)
    await sleep(20)
    await s.idle()
    const before = { b: s.ids('A/B'), x: s.ids('A/B/x') }
    assert.equal(before.b.length, 2)
    assert.ok(Math.max(...s.ids('D/b')) > Math.max(...before.b, ...before.x), 'D/b holds a later id')
    // local data on a row of the subtree: the user opened it (pinned)
    const pinned = id => s.db.prepare('SELECT body_pinned FROM messages WHERE id = ?').get(id)?.body_pinned
    s.index.setPinned(before.b[0])
    // the measured live server keeps the UIDVALIDITY on a RENAME: the rows may stay as they are
    s.server.renameKeepsUidValidity = true
    let fired = false
    let afterRace = null
    s.server.afterList = async () => {
      // the next run's LIST: the racing run has ended, the next one has not touched a folder yet
      if (fired) {
        if (!afterRace) afterRace = { local: s.local(), b: s.ids(want.b), x: s.ids(want.x) }
        return
      }
      fired = true
      // the run's LIST is made; the app's write and a folder deleted on the server land before its clean-up
      s.server.mailboxes.delete(s.p('C/c'))
      await act(s)
    }
    s.manager.requestSync(s.row.id)
    await until(() => fired)
    // a create asks for a targeted run only: a full one brings the clean-up
    s.manager.requestSync(s.row.id)
    await until(() => afterRace)
    assert.deepEqual(afterRace.b, before.b, `${want.b} right after the racing run`)
    assert.deepEqual(afterRace.x, before.x, `${want.x} right after the racing run`)
    if (want.made) assert.ok(afterRace.local.includes(want.made), JSON.stringify(afterRace.local))
    assert.ok(afterRace.local.includes('C/c'), 'the racing run skipped its clean-up')
    await sleep(20)
    await s.idle()
    assert.deepEqual(s.ids(want.b), before.b, `${want.b} after the next run`)
    assert.deepEqual(s.ids(want.x), before.x, `${want.x} after the next run`)
    if (want.gone) assert.ok(!s.local().some(p => p === want.gone || p.startsWith(want.gone + '/')), JSON.stringify(s.local()))
    if (want.made) assert.ok(s.local().includes(want.made))
    assert.ok(!s.local().includes('C/c'), 'the next full run dropped the deleted folder')
    assert.equal(pinned(before.b[0]), 1, 'the pinned row is the same row, still pinned')
  })
}

// A role picked by hand moves with its folder (the owner's decision): the folder row keeps its role and role_manual,
// the index rewrites its path in place; an automatic role (the Inbox, the server's SPECIAL-USE flag, a usual name)
// still refuses a rename and a move. Two full syncs after each step: the sync keeps a hand-picked role on its row.
const roleOf = (s, p) => ({ ...s.db.prepare('SELECT role, role_manual FROM folders WHERE account_id = ? AND path = ?').get(s.row.id, p) })
const fullSync = async s => {
  s.manager.requestSync(s.row.id)
  await sleep(20)
  await s.idle()
}
const ARCHIVE = { role: 'archive', role_manual: 1 }

for (const keeps of [true, false]) {
  test(`a hand-picked Archive under A/B: renaming A and moving A take it along, now and after two full syncs (RENAME ${keeps ? 'keeps' : 'changes'} the UIDVALIDITY)`, async t => {
    const s = await setup(t, { known: true })
    s.server.renameKeepsUidValidity = keeps
    await s.idle()
    s.folders.setRole({ accountId: s.row.id, role: 'archive', path: 'A/B' })
    assert.deepEqual(await s.folders.rename({ accountId: s.row.id, path: 'A', name: 'A2' }), { path: 'A2' })
    assert.deepEqual(s.renames(), [{ op: 'rename', path: 'A', to: 'A2' }])
    assert.deepEqual(roleOf(s, 'A2/B'), ARCHIVE, 'right after the rename')
    await s.idle()
    await fullSync(s)
    await fullSync(s)
    assert.deepEqual(roleOf(s, 'A2/B'), ARCHIVE, 'after two full syncs')
    assert.ok(!s.local().some(p => p === 'A' || p.startsWith('A/')), JSON.stringify(s.local()))
    assert.deepEqual(await s.folders.move({ accountId: s.row.id, path: 'A2', parent: 'C' }), { path: 'C/A2' })
    assert.deepEqual(roleOf(s, 'C/A2/B'), ARCHIVE, 'right after the move')
    await s.idle()
    await fullSync(s)
    await fullSync(s)
    assert.deepEqual(roleOf(s, 'C/A2/B'), ARCHIVE, 'after two full syncs')
    assert.deepEqual(s.index.folderList(s.row.id).filter(f => f.role === 'archive').map(f => f.path), ['C/A2/B'], 'one Archive')
  })
}

test('a hand-picked role on the folder itself: renamed (A/B -> A/Bb) and moved to the top level, the role on the new path', async t => {
  const s = await setup(t, { known: true })
  await s.idle()
  s.folders.setRole({ accountId: s.row.id, role: 'archive', path: 'A/B' })
  assert.deepEqual(await s.folders.rename({ accountId: s.row.id, path: 'A/B', name: 'Bb' }), { path: 'A/Bb' })
  assert.deepEqual(roleOf(s, 'A/Bb'), ARCHIVE)
  await s.idle()
  assert.deepEqual(await s.folders.move({ accountId: s.row.id, path: 'A/Bb', parent: null }), { path: 'Bb' })
  assert.deepEqual(roleOf(s, 'Bb'), ARCHIVE)
  await s.idle()
  await fullSync(s)
  await fullSync(s)
  assert.deepEqual(roleOf(s, 'Bb'), ARCHIVE)
  assert.ok(s.local().includes('Bb/x'), 'the subfolder came along')
})

test('a hand-picked role with a "." delimiter and the INBOX. namespace: renamed and moved, the role follows', async t => {
  const s = await setup(t, { delimiter: '.', prefix: 'INBOX.', known: true })
  await s.idle()
  s.folders.setRole({ accountId: s.row.id, role: 'archive', path: 'INBOX.A.B' })
  assert.deepEqual(await s.folders.rename({ accountId: s.row.id, path: 'INBOX.A', name: 'A2' }), { path: 'INBOX.A2' })
  assert.deepEqual(roleOf(s, 'INBOX.A2.B'), ARCHIVE)
  await s.idle()
  assert.deepEqual(await s.folders.move({ accountId: s.row.id, path: 'INBOX.A2.B', parent: null }), { path: 'INBOX.B' })
  assert.deepEqual(roleOf(s, 'INBOX.B'), ARCHIVE)
  await s.idle()
  await fullSync(s)
  await fullSync(s)
  assert.deepEqual(roleOf(s, 'INBOX.B'), ARCHIVE)
})

test('a hand-picked role renamed while a full sync runs (after its LIST, before its clean-up): kept, also after two more full syncs', async t => {
  const s = await setup(t, { known: true })
  await s.idle()
  s.folders.setRole({ accountId: s.row.id, role: 'archive', path: 'A/B' })
  await s.idle()
  let fired = false
  s.server.afterList = async () => {
    if (fired) return
    fired = true
    await s.folders.rename({ accountId: s.row.id, path: 'A', name: 'Z' })
  }
  s.manager.requestSync(s.row.id)
  await until(() => fired)
  await sleep(20)
  await s.idle()
  assert.deepEqual(roleOf(s, 'Z/B'), ARCHIVE, 'after the racing run')
  await fullSync(s)
  await fullSync(s)
  assert.deepEqual(roleOf(s, 'Z/B'), ARCHIVE, 'after two more full syncs')
  assert.deepEqual(s.index.folderList(s.row.id).filter(f => f.role === 'archive').map(f => f.path), ['Z/B'])
})

test('an automatic role still refuses: the SPECIAL-USE Sent and a named "Archive" on the folder, a SPECIAL-USE folder under ours; no server call, no index write', async t => {
  const s = await setup(t, { known: true })
  s.server.addMailbox('Sent', { specialUse: '\\Sent' }).addMailbox('Archive').addMailbox('D/Vázlat', { specialUse: '\\Drafts' })
  for (const f of ['Sent', 'Archive', 'D/Vázlat']) s.server.subscribed.add(f)
  await s.idle()
  await fullSync(s)
  assert.equal(roleOf(s, 'Archive').role, 'archive')
  assert.equal(roleOf(s, 'Archive').role_manual, 0)
  assert.deepEqual(roleOf(s, 'D/Vázlat'), { role: 'drafts', role_manual: 0 }, 'the SPECIAL-USE folder under ours has its automatic role')
  const local = s.local()
  const calls = s.calls()
  for (const q of [{ path: 'Sent', parent: 'C' }, { path: 'Archive', parent: 'C' }]) {
    await assert.rejects(s.folders.move({ accountId: s.row.id, ...q }), { code: 'protected_folder' }, JSON.stringify(q))
    await assert.rejects(s.folders.rename({ accountId: s.row.id, path: q.path, name: 'Más' }), { code: 'protected_folder' }, q.path)
  }
  await assert.rejects(s.folders.move({ accountId: s.row.id, path: 'D', parent: 'C' }), { code: 'protected_subfolder' })
  await assert.rejects(s.folders.rename({ accountId: s.row.id, path: 'D', name: 'D2' }), { code: 'protected_subfolder' })
  // the Inbox is never moved: an Inbox picked as nothing by hand is still the Inbox
  await assert.rejects(s.folders.rename({ accountId: s.row.id, path: 'INBOX', name: 'Bejövő' }), { code: 'protected_folder' })
  assert.deepEqual(s.renames(), [])
  assert.deepEqual(s.local(), local)
  assert.equal(s.calls(), calls, 'no server call')
})

test('an automatic folder picked by hand stays refused: the SPECIAL-USE Sent pinned as sent, a usual-named "Sent" pinned beside "Elküldött elemek", a \\Junk pinned as archive', async t => {
  const s = await setup(t, { known: true })
  s.server.addMailbox('Sent', { specialUse: '\\Sent' })
  s.server.subscribed.add('Sent')
  await s.idle()
  await fullSync(s)
  s.folders.setRole({ accountId: s.row.id, role: 'sent', path: 'Sent' })
  await s.idle()
  assert.deepEqual(roleOf(s, 'Sent'), { role: 'sent', role_manual: 1 })
  const calls = s.calls()
  await assert.rejects(s.folders.move({ accountId: s.row.id, path: 'Sent', parent: 'C' }), { code: 'protected_folder' })
  await assert.rejects(s.folders.rename({ accountId: s.row.id, path: 'Sent', name: 'Kuldott' }), { code: 'protected_folder' })
  // the server's \Junk folder picked by hand as the Archive: a candidate still, refused
  s.folders.setRole({ accountId: s.row.id, role: 'archive', path: 'Junk' })
  await s.idle()
  assert.deepEqual(roleOf(s, 'Junk'), { role: 'archive', role_manual: 1 })
  await assert.rejects(s.folders.move({ accountId: s.row.id, path: 'Junk', parent: 'C' }), { code: 'protected_folder' })
  assert.deepEqual(s.renames(), [])
  assert.equal(s.calls(), calls, 'no server call')

  // no SPECIAL-USE at all: "Sent" and "Elküldött elemek" by their usual names, "Sent" picked by hand
  const n = await setup(t, { known: true })
  n.server.addMailbox('Sent').addMailbox('Elküldött elemek')
  for (const f of ['Sent', 'Elküldött elemek']) n.server.subscribed.add(f)
  await n.idle()
  await fullSync(n)
  n.folders.setRole({ accountId: n.row.id, role: 'sent', path: 'Sent' })
  await n.idle()
  assert.deepEqual(roleOf(n, 'Sent'), { role: 'sent', role_manual: 1 })
  await assert.rejects(n.folders.rename({ accountId: n.row.id, path: 'Sent', name: 'Kuldott' }), { code: 'protected_folder' })
  await assert.rejects(n.folders.move({ accountId: n.row.id, path: 'Sent', parent: 'C' }), { code: 'protected_folder' })
  // a usual-named folder under a folder of ours is no candidate (the name counts on the top level only): it moves
  n.folders.setRole({ accountId: n.row.id, role: 'sent', path: 'A/B' })
  await n.idle()
  assert.deepEqual(await n.folders.rename({ accountId: n.row.id, path: 'A', name: 'A2' }), { path: 'A2' })
  assert.deepEqual(roleOf(n, 'A2/B'), { role: 'sent', role_manual: 1 })
  assert.deepEqual(n.renames(), [{ op: 'rename', path: 'A', to: 'A2' }])
})

test('a hand-picked Trash: it can be moved itself, nothing can be moved under it (trash_target), it cannot be deleted', async t => {
  const s = await setup(t, { known: true })
  await s.idle()
  s.folders.setRole({ accountId: s.row.id, role: 'trash', path: 'C' })
  await assert.rejects(s.folders.move({ accountId: s.row.id, path: 'D/b', parent: 'C' }), { code: 'trash_target' })
  await assert.rejects(s.folders.move({ accountId: s.row.id, path: 'D/b', parent: 'C/c' }), { code: 'trash_target' }, 'under it too')
  await assert.rejects(s.folders.remove({ accountId: s.row.id, path: 'C', confirmed: true }), { code: 'protected_folder' })
  assert.deepEqual(await s.folders.move({ accountId: s.row.id, path: 'C', parent: 'D' }), { path: 'D/C' })
  assert.deepEqual(roleOf(s, 'D/C'), { role: 'trash', role_manual: 1 })
  await s.idle()
  await fullSync(s)
  assert.deepEqual(roleOf(s, 'D/C'), { role: 'trash', role_manual: 1 })
})

test('a sibling whose name starts the same (A vs AB): moving or renaming A leaves AB and its messages alone, AB is a valid target', async t => {
  const s = await setup(t, { known: true })
  s.server.addMailbox('AB').addMailbox('AB/k')
  s.server.subscribed.add('AB')
  s.server.subscribed.add('AB/k')
  s.server.addMessages('AB', [msg(7)])
  await s.idle()
  s.manager.requestSync(s.row.id)
  await sleep(20)
  await s.idle()
  const abIds = s.ids('AB')
  assert.equal(abIds.length, 1, JSON.stringify(s.local()))
  await s.folders.move({ accountId: s.row.id, path: 'A', parent: 'D' })
  assert.ok(s.local().includes('AB') && s.local().includes('AB/k') && s.local().includes('D/A/B/x'), JSON.stringify(s.local()))
  assert.deepEqual(s.ids('AB'), abIds)
  assert.ok(s.server.subscribed.has('AB') && s.server.subscribed.has('AB/k'), [...s.server.subscribed].join(','))
  assert.deepEqual(await s.folders.move({ accountId: s.row.id, path: 'AB', parent: 'D/A' }), { path: 'D/A/AB' })
  assert.deepEqual(s.ids('D/A/AB'), abIds, 'the same ids right after the move')
  assert.ok(s.local().includes('D/A/AB/k') && s.local().includes('D/A/B/x'), JSON.stringify(s.local()))
  // a rename of D/A takes D/A/AB along (it is under it). The sync the move asked for finishes first: a rename while a
  // full sync runs drops a subfolder for a sync round (reported separately; not what this test is about)
  await s.idle()
  assert.deepEqual(await s.folders.rename({ accountId: s.row.id, path: 'D/A', name: 'Z' }), { path: 'D/Z' })
  assert.ok(s.local().includes('D/Z/AB/k') && s.local().includes('D/Z/B/x') && !s.local().some(p => p.startsWith('D/A')), JSON.stringify(s.local()))
})
