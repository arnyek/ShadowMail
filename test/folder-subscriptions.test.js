// SPDX-License-Identifier: GPL-3.0-or-later
// Folder subscriptions: the sync shows and syncs only the subscribed server folders, the
// role folders always; a folder that showed before the upgrade stays (kept, migration 12), without a server write;
// the subscriptions dialog lists the server's folders, a tick subscribes, an untick unsubscribes and drops the kept
// flag; a role folder cannot be unsubscribed. Real SyncManager + FolderActions + IPC with the fake IMAP server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { FolderActions } from '../app/main/folders.js'
import { registerFolderIpc } from '../app/main/ipc/folders.js'
import { shownFolders, isRoleCandidate, subscriptionsKnown } from '../core/imap/folders.js'
import { startImapWire } from './helpers/imap-wire.js'
import { Syncer } from '../core/imap/sync.js'
import { createImapClient } from '../core/imap/client.js'

const NOW = Date.UTC(2026, 10, 16, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const msg = n => ({ from: `k${n}@example.invalid`, to: 'en@example.invalid', subject: `Levél ${n}`, messageId: `<s${n}@x>`, date: NOW - n * DAY, body: `Szöveg ${n}` })
const SUBSCRIBED = ['INBOX', 'Projekt', 'Ügyek']

async function setup(t, { known = true, type = 'imap' } = {}) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, type === 'pop3' ? { type: 'pop3' } : {})
  const server = new FakeImapServer()
  server.delimiter = '/'
  server.addMailbox('INBOX').addMailbox('Sent').addMailbox('Trash', { specialUse: '\\Trash' }).addMailbox('Projekt').addMailbox('Ügyek').addMailbox('Régi').addMailbox('Régi/2020')
  server.addMessages('Régi', [msg(1), msg(2)])
  server.addMessages('Projekt', [msg(3)])
  for (const p of SUBSCRIBED) server.subscribed.add(p)
  server.subscriptionsKnown = known
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
  }
  const storeDir = path.join(tempDir(t), 'store')
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), notify: () => {}, connect: () => server.connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  const idle = () => until(() => !manager.entries.get(row.id).syncer.current)
  if (type === 'imap') {
    manager.startAll()
    await until(() => manager.entries.get(row.id).idle.connected)
    await idle()
  }
  const syncs = []
  const logs = []
  const folders = new FolderActions({
    index, store, storeDir,
    withConnection: (id, fn) => manager.withConnection(id, fn),
    requestSync: (id, f) => (syncs.push([id, f]), manager.requestSync(id, f)),
    log: l => logs.push(l),
  })
  const shown = () => index.folderList(row.id).filter(f => !f.is_local).map(f => f.path).sort()
  const fullSync = async () => {
    manager.requestSync(row.id)
    await sleep(20)
    await idle()
  }
  return { db, index, row, server, manager, folders, shown, fullSync, idle, syncs, logs }
}

test('the rule: subscribed, kept, a role or a role candidate shows; an unsubscribed other folder does not', () => {
  // the imapflow 2.11 shape: subscribed: true, or the field left out (it never writes false)
  const f = (p, extra = {}) => ({ path: p, delimiter: '/', specialUse: null, ...extra })
  const listed = [f('INBOX', { subscribed: true }), f('Sent'), f('Lomtár', { specialUse: '\\Trash' }),
    f('INBOX/Drafts'), f('Projekt', { subscribed: true }), f('Régi'), f('Mentett'), f('Választott'), f('Ismeretlen'), f('Hamis', { subscribed: false })]
  const got = shownFolders(listed, { kept: new Map([['Mentett', 1], ['Régi', 0]]), roles: new Set(['Választott']) }).map(x => x.path)
  assert.deepEqual(got, ['INBOX', 'Sent', 'Lomtár', 'INBOX/Drafts', 'Projekt', 'Mentett', 'Választott'])
  assert.equal(isRoleCandidate(f('Projekt/Sent')), false, 'a usual name deeper down is no role candidate')
  assert.equal(isRoleCandidate(f('inbox')), true)
})

test('subscriptionsKnown: only a folder other than INBOX that is not true tells the state', () => {
  const f = (p, subscribed) => ({ path: p, ...(subscribed === undefined ? {} : { subscribed }) })
  assert.equal(subscriptionsKnown([f('INBOX', true), f('Projekt', true), f('Régi')]), true)
  assert.equal(subscriptionsKnown([f('INBOX', true), f('Projekt', true), f('Régi', true)]), false, 'all true: LSUB refused, or all subscribed')
  assert.equal(subscriptionsKnown([f('INBOX'), f('Projekt', true)]), false, 'INBOX alone does not tell (imapflow: INBOX is always true)')
  assert.equal(subscriptionsKnown([]), false)
})

test('a new account: only the subscribed and the role folders show and sync; the unsubscribed ones are not fetched', async t => {
  const s = await setup(t)
  assert.deepEqual(s.shown(), ['INBOX', 'Projekt', 'Sent', 'Trash', 'Ügyek'])
  assert.equal(s.index.listFolder({ accountId: s.row.id, folder: 'Régi', limit: 10 }).length, 0)
  assert.deepEqual([...s.index.keptFolders(s.row.id).values()].filter(v => v !== 0), [], 'a new account has no kept folder')
  assert.equal(s.index.listFolder({ accountId: s.row.id, folder: 'Projekt', limit: 10 }).length, 1)
})

test('a server without subscription data: every folder shows, as before', async t => {
  const s = await setup(t, { known: false })
  assert.deepEqual(s.shown(), ['INBOX', 'Projekt', 'Régi', 'Régi/2020', 'Sent', 'Trash', 'Ügyek'])
})

test('the upgrade: the folders that showed stay (kept, no server write); the subscribed ones decide by subscription later', async t => {
  // the 0.14 picture: every folder showed (no subscription filter), Régi with its two messages
  const s = await setup(t, { known: false })
  assert.equal(s.index.listFolder({ accountId: s.row.id, folder: 'Régi', limit: 10 }).length, 2)
  // migration 12 on this database: every server folder undecided
  s.db.prepare('UPDATE folders SET kept = NULL WHERE is_local = 0').run()
  const subscribedBefore = [...s.server.subscribed].sort()
  // the first sync after the upgrade gets no subscription data (LSUB refused: imapflow says true of every folder):
  // nothing is decided, everything shows
  await s.fullSync()
  assert.deepEqual([...s.index.keptFolders(s.row.id).values()].filter(v => v !== null), [], 'undecided while the state is unknown')
  assert.deepEqual(s.shown(), ['INBOX', 'Projekt', 'Régi', 'Régi/2020', 'Sent', 'Trash', 'Ügyek'])
  s.server.subscriptionsKnown = true
  await s.fullSync()
  assert.deepEqual(s.shown(), ['INBOX', 'Projekt', 'Régi', 'Régi/2020', 'Sent', 'Trash', 'Ügyek'], 'nothing that showed disappears')
  assert.equal(s.index.listFolder({ accountId: s.row.id, folder: 'Régi', limit: 10 }).length, 2, 'its messages stay')
  const kept = s.index.keptFolders(s.row.id)
  assert.deepEqual([kept.get('Régi'), kept.get('Régi/2020'), kept.get('Projekt'), kept.get('INBOX')], [1, 1, 0, 0])
  assert.deepEqual([...s.server.subscribed].sort(), subscribedBefore, 'no SUBSCRIBE on the server')
  // a folder made on the server later, unsubscribed, does not show
  s.server.addMailbox('Új')
  await s.fullSync()
  assert.ok(!s.shown().includes('Új'))
  assert.equal(s.index.keptFolders(s.row.id).get('Régi'), 1, 'the decision is kept, not taken again')
})

test('the dialog: every server folder with shown / subscribed / kept / role', async t => {
  const s = await setup(t, { known: false })
  s.db.prepare('UPDATE folders SET kept = NULL WHERE is_local = 0').run()
  s.server.subscriptionsKnown = true
  await s.fullSync()
  s.server.addMailbox('Új')
  const { folders } = await s.folders.subscriptions({ accountId: s.row.id })
  const by = Object.fromEntries(folders.map(f => [f.path, f]))
  assert.deepEqual(Object.keys(by).sort(), ['INBOX', 'Projekt', 'Régi', 'Régi/2020', 'Sent', 'Trash', 'Új', 'Ügyek'])
  assert.deepEqual([by['Régi'].shown, by['Régi'].subscribed, by['Régi'].kept], [true, false, true])
  assert.deepEqual([by['Új'].shown, by['Új'].subscribed, by['Új'].kept, by['Új'].role], [false, false, false, null])
  assert.deepEqual([by['Projekt'].shown, by['Projekt'].subscribed], [true, true])
  assert.ok(by.INBOX.role && by.Sent.role && by.Trash.role, 'role folders are marked')
  assert.equal(by['Régi/2020'].delimiter, '/')
})

test('untick: a kept folder goes (local flag only), a subscribed one is unsubscribed on the server; tick: SUBSCRIBE', async t => {
  const s = await setup(t, { known: false })
  s.db.prepare('UPDATE folders SET kept = NULL WHERE is_local = 0').run()
  s.server.subscriptionsKnown = true
  await s.fullSync()
  // a kept one (unsubscribed on the server already): no server call, the flag goes, the next sync drops it
  assert.deepEqual(await s.folders.setSubscribed({ accountId: s.row.id, path: 'Régi', subscribed: false }), { subscribed: false })
  await s.fullSync()
  assert.ok(!s.shown().includes('Régi'))
  assert.equal(s.index.listFolder({ accountId: s.row.id, folder: 'Régi', limit: 10 }).length, 0, 'its rows left the index')
  assert.equal(s.server.mailboxes.get('Régi').messages.size, 2, 'the server keeps the messages')
  // a subscribed one: UNSUBSCRIBE
  await s.folders.setSubscribed({ accountId: s.row.id, path: 'Projekt', subscribed: false })
  assert.ok(!s.server.subscribed.has('Projekt'))
  await s.fullSync()
  assert.ok(!s.shown().includes('Projekt'))
  // tick: SUBSCRIBE, and it comes back with its messages
  await s.folders.setSubscribed({ accountId: s.row.id, path: 'Régi', subscribed: true })
  assert.ok(s.server.subscribed.has('Régi'))
  await s.fullSync()
  assert.ok(s.shown().includes('Régi'))
  assert.equal(s.index.listFolder({ accountId: s.row.id, folder: 'Régi', limit: 10 }).length, 2)
  assert.ok(s.syncs.length >= 3, 'every change asks for a full sync')
  assert.ok(s.logs.every(l => !/Régi|Projekt/.test(l)), 'no folder name in the log')
})

test('a role folder cannot be unsubscribed; unknown folder, POP3', async t => {
  const s = await setup(t)
  for (const p of ['INBOX', 'Sent', 'Trash']) {
    await assert.rejects(s.folders.setSubscribed({ accountId: s.row.id, path: p, subscribed: false }), { code: 'role_folder' }, p)
  }
  await assert.rejects(s.folders.setSubscribed({ accountId: s.row.id, path: 'Nincs', subscribed: true }), { code: 'not_found' })
  const p = await setup(t, { type: 'pop3' })
  await assert.rejects(p.folders.subscriptions({ accountId: p.row.id }), { code: 'pop3_local' })
  await assert.rejects(p.folders.setSubscribed({ accountId: p.row.id, path: 'INBOX', subscribed: true }), { code: 'pop3_local' })
})

test('IPC: the two channels check their requests', async t => {
  const s = await setup(t)
  const handlers = new Map()
  registerFolderIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, folders: s.folders, isTrustedSender: () => true })
  const subs = q => handlers.get('folders:subscriptions')({}, q)
  const set = q => handlers.get('folders:setSubscribed')({}, q)
  assert.equal((await subs({ accountId: s.row.id })).ok, true)
  for (const bad of [null, {}, { accountId: 0 }, { accountId: s.row.id, x: 1 }]) assert.deepEqual(await subs(bad), { ok: false, error: 'bad_request' })
  for (const bad of [{ accountId: s.row.id, path: 'Régi' }, { accountId: s.row.id, path: '', subscribed: true }, { accountId: s.row.id, path: 'Régi', subscribed: 'yes' }, { accountId: s.row.id, path: 'Régi', subscribed: true, x: 1 }]) {
    assert.deepEqual(await set(bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
  }
  assert.deepEqual(await set({ accountId: s.row.id, path: 'Sent', subscribed: false }), { ok: false, error: 'role_folder' })
  assert.deepEqual(await set({ accountId: s.row.id, path: 'Régi', subscribed: true }), { ok: true, subscribed: true })
})

// the REAL imapflow over TCP (test/helpers/imap-wire.js with LSUB): it never says subscribed: false, it leaves the field
// out of an unsubscribed folder, and with LSUB refused it says true of every folder. The fake IMAP above follows it, this
// test keeps the two honest.
test('real imapflow over TCP with LSUB: the unsubscribed folders do not show; the upgrade decides only when LSUB answered; the dialog and the ticks', async t => {
  const FOLDERS = ['INBOX', 'Sent', 'Projekt', 'Régi', 'Ügyfelek'].map(p => ({ path: p }))
  const wire = await startImapWire({ folders: FOLDERS, delimiter: '.', subscribed: ['INBOX', 'Sent', 'Projekt'], lsub: 'no' })
  onCleanup(t, () => wire.close())
  const { db, index } = memoryIndex(t)
  const account = addAccount(db, { in_host: '127.0.0.1', in_port: wire.port, in_security: 'none' })
  const syncer = new Syncer({ account, index, getPassword: async () => 'p' })
  onCleanup(t, () => syncer.stop())
  const shown = () => index.folderList(account.id).map(f => f.path).sort()
  const ALL = ['INBOX', 'Projekt', 'Régi', 'Sent', 'Ügyfelek']

  // what imapflow itself gives (the shape the rule is built on)
  const probe = createImapClient(account, 'p')
  await probe.connect()
  const unknown = Object.fromEntries((await probe.list()).map(f => [f.path, f.subscribed]))
  wire.setLsub('ok')
  const known = Object.fromEntries((await probe.list()).map(f => [f.path, f.subscribed]))
  await probe.logout()
  assert.deepEqual(unknown, { INBOX: true, Sent: true, Projekt: true, Régi: true, Ügyfelek: true }, 'LSUB refused: true for all')
  assert.deepEqual(known, { INBOX: true, Sent: true, Projekt: true, Régi: undefined, Ügyfelek: undefined }, 'LSUB answered: true or nothing, never false')

  // the 0.14 picture (LSUB refused: every folder shows), then migration 12: every server folder undecided
  wire.setLsub('no')
  await syncer.run()
  assert.equal(syncer.state.lastError, null, syncer.state.lastError)
  assert.deepEqual(shown(), ALL)
  db.prepare('UPDATE folders SET kept = NULL WHERE is_local = 0').run()
  // the first sync after the upgrade, LSUB still refused: nothing decided, nothing gone
  await syncer.run()
  assert.deepEqual(shown(), ALL)
  assert.deepEqual([...index.keptFolders(account.id).values()].filter(v => v !== null), [], 'undecided while LSUB is refused')
  // LSUB answers: the folders that showed are kept, nothing disappears, nothing written on the server
  wire.setLsub('ok')
  await syncer.run()
  assert.deepEqual(shown(), ALL, 'nothing that showed disappears')
  const kept = index.keptFolders(account.id)
  assert.deepEqual([kept.get('Régi'), kept.get('Ügyfelek'), kept.get('Projekt'), kept.get('INBOX')], [1, 1, 0, 0])
  assert.ok(!wire.log.some(l => /^(UN)?SUBSCRIBE\b/i.test(l)), 'no subscription change on the server')

  // a new account against the same server: only the subscribed (and role) folders show
  const fresh = memoryIndex(t)
  const account2 = addAccount(fresh.db, { in_host: '127.0.0.1', in_port: wire.port, in_security: 'none' })
  const syncer2 = new Syncer({ account: account2, index: fresh.index, getPassword: async () => 'p' })
  onCleanup(t, () => syncer2.stop())
  await syncer2.run()
  assert.deepEqual(fresh.index.folderList(account2.id).map(f => f.path).sort(), ['INBOX', 'Projekt', 'Sent'])

  // the dialog and the ticks on the real client
  const store = { list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) }
  const withConnection = async (id, fn) => {
    const c = createImapClient(account, 'p')
    await c.connect()
    try {
      return await fn(c)
    } finally {
      await c.logout().catch(() => {})
    }
  }
  const folders = new FolderActions({ index, store, storeDir: path.join(tempDir(t), 'store'), withConnection, requestSync: () => {}, log: () => {} })
  const by = Object.fromEntries((await folders.subscriptions({ accountId: account.id })).folders.map(f => [f.path, f]))
  assert.deepEqual([by.Régi.shown, by.Régi.subscribed, by.Régi.kept], [true, false, true])
  assert.deepEqual([by.Projekt.shown, by.Projekt.subscribed, by.Projekt.kept], [true, true, false])
  const before = wire.log.length
  await folders.setSubscribed({ accountId: account.id, path: 'Régi', subscribed: false })
  assert.ok(!wire.log.slice(before).some(l => /^UNSUBSCRIBE\b/i.test(l)), 'a kept, unsubscribed folder: no server call')
  assert.equal(index.keptFolders(account.id).get('Régi'), 0)
  await folders.setSubscribed({ accountId: account.id, path: 'Ügyfelek', subscribed: true })
  await folders.setSubscribed({ accountId: account.id, path: 'Projekt', subscribed: false })
  assert.deepEqual([...wire.subscribed].sort(), ['INBOX', 'Sent', 'Ügyfelek'], 'SUBSCRIBE Ügyfelek, UNSUBSCRIBE Projekt on the server')
  await syncer.run()
  assert.deepEqual(shown(), ['INBOX', 'Sent', 'Ügyfelek'], 'the next sync follows the server')
})
