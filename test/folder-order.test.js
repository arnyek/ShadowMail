// SPDX-License-Identifier: GPL-3.0-or-later
// The manual order of the accounts and of the folders among their displayed siblings: the tree's rule
// (buildFolderTree), the writes (MailIndex.reorderFolders / resetFolderOrder, AccountStore.reorder), that it survives a
// reopen of the encrypted file, a new folder goes to the end, a renamed one keeps its place, every bad input writes
// nothing, a path never changes, and no server is asked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { tempDir, onCleanup } from './helpers/tmp.js'
import { addAccount, memoryIndex, sealedStore, DAY } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { openMailDatabase } from '../core/db/index.js'
import { MailIndex, FolderOrderError } from '../core/db/mail-index.js'
import { buildFolderTree, flattenTree, siblingsOf } from '../core/imap/folders.js'
import { AccountStore, AccountError } from '../core/accounts/model.js'
import { FolderActions } from '../app/main/folders.js'
import { registerFolderIpc } from '../app/main/ipc/folders.js'
import { registerAccountIpc } from '../app/main/ipc/accounts.js'

const f = (p, extra = {}) => ({ path: p, delimiter: '/', special_use: null, count: 0, unread: 0, ...extra })
const shape = tree => flattenTree(tree).map(({ node, depth }) => `${'  '.repeat(depth)}${node.name}${node.selectable ? '' : ' (-)'}`)
const ROWS = () => [
  f('INBOX'),
  f('Drafts', { special_use: '\\Drafts' }),
  f('Sent', { special_use: '\\Sent' }),
  f('Trash', { special_use: '\\Trash' }),
  f('Ügyfelek'),
  f('Ügyfelek/Bp'),
  f('Ügyfelek/Debrecen'),
  f('Ügyfelek/Ádám'),
  f('alma'),
  f('Zöldség'),
  f('Régi/2019'), // Régi is a placeholder (no row)
]
const withOrder = (rows, order) => rows.map(r => (r.path in order ? { ...r, sort_order: order[r.path] } : r))

test('the tree rule: no manual order anywhere = the old tree byte for byte (sort_order NULL or missing)', () => {
  const plain = JSON.stringify(buildFolderTree(ROWS()))
  assert.equal(JSON.stringify(buildFolderTree(ROWS().map(r => ({ ...r, sort_order: null })))), plain)
  assert.deepEqual(shape(buildFolderTree(ROWS())), ['INBOX', 'Drafts', 'Sent', 'Trash', 'alma', 'Régi (-)', '  2019', 'Ügyfelek', '  Ádám', '  Bp', '  Debrecen', 'Zöldség'])
})

test('the tree rule: ordered members by sort_order, the rest (new folders, placeholders) at the end alphabetically; a role folder moves too; each sibling list on its own', () => {
  // the top level ordered, a new folder (Zöldség) and the placeholder (Régi) without an order; the children of Ügyfelek untouched
  const tree = buildFolderTree(withOrder(ROWS(), { Ügyfelek: 0, Sent: 1, INBOX: 2, alma: 3, Drafts: 4, Trash: 5 }))
  assert.deepEqual(shape(tree), ['Ügyfelek', '  Ádám', '  Bp', '  Debrecen', 'Sent', 'INBOX', 'alma', 'Drafts', 'Trash', 'Régi (-)', '  2019', 'Zöldség'])
  // only the children ordered: the top level keeps the old rule
  const children = buildFolderTree(withOrder(ROWS(), { 'Ügyfelek/Debrecen': 0, 'Ügyfelek/Ádám': 1 }))
  assert.deepEqual(shape(children), ['INBOX', 'Drafts', 'Sent', 'Trash', 'alma', 'Régi (-)', '  2019', 'Ügyfelek', '  Debrecen', '  Ádám', '  Bp', 'Zöldség'])
  // equal numbers (cannot come from reorderFolders, but a hand-made value must not break it): by name
  assert.deepEqual(shape(buildFolderTree(withOrder(ROWS(), { alma: 0, Zöldség: 0 }))).slice(0, 2), ['alma', 'Zöldség'])
})

test('the tree rule: a role folder that lives under INBOX on the server is a top-level sibling; INBOX keeps its own children list', () => {
  const d = (p, o) => ({ ...f(p, { delimiter: '.' }), ...(o === undefined ? {} : { sort_order: o }) })
  const tree = buildFolderTree([d('INBOX', 3), d('INBOX.Sent', 0), d('INBOX.Trash', 1), d('INBOX.Drafts', 2), d('INBOX.Számlák', 0), d('INBOX.Projektek', 1), d('INBOX.Akták')])
  assert.deepEqual(shape(tree), ['Sent', 'Trash', 'Drafts', 'INBOX', '  Számlák', '  Projektek', '  Akták'])
  assert.deepEqual(siblingsOf(tree, null).map(n => n.path), ['INBOX.Sent', 'INBOX.Trash', 'INBOX.Drafts', 'INBOX'])
  assert.deepEqual(siblingsOf(tree, 'INBOX').map(n => n.path), ['INBOX.Számlák', 'INBOX.Projektek', 'INBOX.Akták'])
  assert.equal(siblingsOf(tree, 'INBOX.Nincs'), null)
})

// an encrypted file database, as the app has it, with two accounts' folders
function openFile(file, key) {
  const { db } = openMailDatabase(file, { key })
  return { db, index: new MailIndex(db) }
}
function seed(t) {
  const file = path.join(tempDir(t), 'mail.sqlite')
  const key = crypto.randomBytes(32)
  const { db, index } = openFile(file, key)
  const a = addAccount(db)
  const b = addAccount(db)
  for (const r of ROWS()) index.addFolder(a.id, r.path, '/', false)
  for (const p of ['Drafts', 'Sent', 'Trash']) db.prepare('UPDATE folders SET special_use = ? WHERE account_id = ? AND path = ?').run(`\\${p}`, a.id, p)
  for (const p of ['INBOX', 'Másik']) index.addFolder(b.id, p, '/', false)
  return { file, key, db, index, a, b }
}
const tree = (index, id) => buildFolderTree(index.folders(id))
const table = db => JSON.stringify(db.prepare('SELECT * FROM folders ORDER BY account_id, path').all())

test('reorderFolders: the order survives a reopen of the encrypted file; a new folder goes to the end; a renamed one keeps its place; resetFolderOrder gives the old tree back', t => {
  const s = seed(t)
  const before = JSON.stringify(tree(s.index, s.a.id))
  const paths = () => s.db.prepare('SELECT path FROM folders ORDER BY account_id, path').pluck().all()
  const allPaths = paths()
  assert.equal(s.index.reorderFolders(s.a.id, null, ['Zöldség', 'Trash', 'INBOX', 'Ügyfelek', 'alma', 'Sent', 'Drafts']), 7)
  assert.equal(s.index.reorderFolders(s.a.id, 'Ügyfelek', ['Ügyfelek/Debrecen', 'Ügyfelek/Bp', 'Ügyfelek/Ádám']), 3)
  assert.deepEqual(paths(), allPaths, 'no path changed')
  s.db.close()

  const again = openFile(s.file, s.key)
  onCleanup(t, () => again.db.open && again.db.close())
  assert.deepEqual(shape(tree(again.index, s.a.id)), ['Zöldség', 'Trash', 'INBOX', 'Ügyfelek', '  Debrecen', '  Bp', '  Ádám', 'alma', 'Sent', 'Drafts', 'Régi (-)', '  2019'])
  assert.deepEqual(shape(tree(again.index, s.b.id)), ['INBOX', 'Másik'], 'the other account untouched')

  // a new folder (a sync, a folder:create) has no order: the end of its list, among the unordered ones by name
  again.index.addFolder(s.a.id, 'Bárka', '/', false)
  again.index.addFolder(s.a.id, 'Ügyfelek/Ajka', '/', false)
  assert.deepEqual(shape(tree(again.index, s.a.id)), ['Zöldség', 'Trash', 'INBOX', 'Ügyfelek', '  Debrecen', '  Bp', '  Ádám', '  Ajka', 'alma', 'Sent', 'Drafts', 'Bárka', 'Régi (-)', '  2019'])
  // a rename (the folder and its subfolders, in place) keeps the places
  again.index.renameFolderTree(s.a.id, 'Ügyfelek', 'Partnerek', '/')
  again.index.renameFolderTree(s.a.id, 'Ügyfelek/Bp', 'Ügyfelek/Budapest', '/') // nothing left under the old name: no-op
  again.index.renameFolderTree(s.a.id, 'Partnerek/Bp', 'Partnerek/Budapest', '/')
  assert.deepEqual(shape(tree(again.index, s.a.id)), ['Zöldség', 'Trash', 'INBOX', 'Partnerek', '  Debrecen', '  Budapest', '  Ádám', '  Ajka', 'alma', 'Sent', 'Drafts', 'Bárka', 'Régi (-)', '  2019'])
  // a deleted folder takes its order with its row
  again.index.resetFolder(s.a.id, 'Trash')
  assert.equal(again.db.prepare("SELECT COUNT(*) FROM folders WHERE account_id = ? AND path = 'Trash'").pluck().get(s.a.id), 0)

  // reset: every folder of the account back to the default rule, the other account's order stays
  again.index.reorderFolders(s.b.id, null, ['Másik', 'INBOX'])
  assert.ok(again.index.resetFolderOrder(s.a.id) > 0)
  assert.equal(again.db.prepare('SELECT COUNT(*) FROM folders WHERE account_id = ? AND sort_order IS NOT NULL').pluck().get(s.a.id), 0)
  assert.deepEqual(shape(tree(again.index, s.b.id)), ['Másik', 'INBOX'])
  // the same folders never ordered: byte for byte
  const fresh = seed(t)
  fresh.index.renameFolderTree(fresh.a.id, 'Ügyfelek', 'Partnerek', '/')
  fresh.index.renameFolderTree(fresh.a.id, 'Partnerek/Bp', 'Partnerek/Budapest', '/')
  fresh.index.addFolder(fresh.a.id, 'Bárka', '/', false)
  fresh.index.addFolder(fresh.a.id, 'Partnerek/Ajka', '/', false)
  fresh.index.resetFolder(fresh.a.id, 'Trash')
  assert.equal(JSON.stringify(tree(again.index, s.a.id)), JSON.stringify(tree(fresh.index, fresh.a.id)))
  assert.notEqual(before, JSON.stringify(tree(again.index, s.a.id)), 'the folders did change (so the comparison above means something)')
  fresh.db.close()
})

test('reorderFolders: every bad list is refused and writes nothing', t => {
  const s = seed(t)
  onCleanup(t, () => s.db.close())
  s.index.reorderFolders(s.a.id, null, ['alma', 'INBOX', 'Drafts', 'Sent', 'Trash', 'Ügyfelek', 'Zöldség']) // an order to keep
  const snapshot = table(s.db)
  const top = ['INBOX', 'Drafts', 'Sent', 'Trash', 'Ügyfelek', 'alma', 'Zöldség']
  const cases = [
    ['a member missing', s.a.id, null, top.slice(1), 'order_mismatch'],
    ['a foreign path', s.a.id, null, [...top, 'Nincs-ilyen'], 'order_mismatch'],
    ['a foreign path instead of a member', s.a.id, null, [...top.slice(1), 'Nincs-ilyen'], 'order_mismatch'],
    ['a repeated path', s.a.id, null, [...top, 'alma'], 'order_mismatch'],
    ['a repeated path instead of a member', s.a.id, null, [...top.slice(1), 'alma'], 'order_mismatch'],
    ['the other account\'s folder', s.a.id, null, [...top.slice(1), 'Másik'], 'order_mismatch'],
    ['this list to the other account', s.b.id, null, top, 'order_mismatch'],
    ['a path under another parent', s.a.id, null, [...top.slice(1), 'Ügyfelek/Bp'], 'order_mismatch'],
    ['a child list with a top-level path', s.a.id, 'Ügyfelek', ['Ügyfelek/Bp', 'Ügyfelek/Debrecen', 'alma'], 'order_mismatch'],
    ['the placeholder in the list', s.a.id, null, [...top, 'Régi'], 'order_mismatch'],
    ['a case variant', s.a.id, null, [...top.slice(0, -1), 'zöldség'], 'order_mismatch'],
    ['an empty list for a full parent', s.a.id, 'Ügyfelek', [], 'order_mismatch'],
    ['an unknown parent', s.a.id, 'Nincs', [], 'not_found'],
    ['a parent of the other account', s.a.id, 'Másik', [], 'not_found'],
  ]
  for (const [what, account, parent, paths, code] of cases) {
    assert.throws(() => s.index.reorderFolders(account, parent, paths), err => err instanceof FolderOrderError && err.code === code, what)
    assert.equal(table(s.db), snapshot, `${what}: nothing written`)
  }
  // a placeholder parent is a real displayed parent: its list is its real children
  assert.equal(s.index.reorderFolders(s.a.id, 'Régi', ['Régi/2019']), 1)
})

// FolderActions as main.js builds it, with every server path recorded
function actions(s) {
  const calls = { connection: 0, sync: 0, changes: [] }
  const store = { getRow: id => s.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) }
  const folders = new FolderActions({
    index: s.index,
    store,
    storeDir: path.join(path.dirname(s.file), 'store'),
    withConnection: async () => {
      calls.connection++
      throw new Error('no server call expected')
    },
    requestSync: () => calls.sync++,
    onChange: c => calls.changes.push(c),
  })
  return { folders, calls }
}

test('the IPC: folders:reorder / folders:resetOrder; malformed = bad_request, a wrong list = order_mismatch, nothing written; no server call, no path change', async t => {
  const s = seed(t)
  onCleanup(t, () => s.db.close())
  const { folders, calls } = actions(s)
  const handlers = new Map()
  registerFolderIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, folders, isTrustedSender: e => e.ok })
  const call = (ch, arg, ok = true) => handlers.get(ch)({ ok }, arg)
  const paths = () => s.db.prepare('SELECT account_id, path FROM folders ORDER BY account_id, path').all()
  const allPaths = paths()
  const snapshot = table(s.db)

  assert.deepEqual(await call('folders:reorder', { accountId: s.a.id, parentKey: null, paths: [] }, false), { ok: false, error: 'untrusted_sender' })
  const top = ['Zöldség', 'alma', 'Ügyfelek', 'Trash', 'Sent', 'Drafts', 'INBOX']
  const malformed = [
    null, [], 'x',
    { accountId: s.a.id, parentKey: null }, // no paths
    { accountId: s.a.id, paths: top }, // no parentKey (null must be said)
    { accountId: String(s.a.id), parentKey: null, paths: top },
    { accountId: 0, parentKey: null, paths: top },
    { accountId: s.a.id, parentKey: 5, paths: top },
    { accountId: s.a.id, parentKey: '', paths: top },
    { accountId: s.a.id, parentKey: null, paths: 'alma' },
    { accountId: s.a.id, parentKey: null, paths: [...top.slice(1), 7] },
    { accountId: s.a.id, parentKey: null, paths: [...top.slice(1), ''] },
    { accountId: s.a.id, parentKey: null, paths: [...top.slice(1), 'x'.repeat(1001)] },
    { accountId: s.a.id, parentKey: null, paths: Array.from({ length: 5001 }, (_, i) => `m${i}`) },
  ]
  for (const bad of malformed) assert.deepEqual(await call('folders:reorder', bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad)?.slice(0, 80))
  for (const bad of [null, {}, { accountId: 'x' }, { accountId: -1 }]) assert.deepEqual(await call('folders:resetOrder', bad), { ok: false, error: 'bad_request' })
  assert.deepEqual(await call('folders:reorder', { accountId: s.a.id, parentKey: null, paths: [...top, 'alma'] }), { ok: false, error: 'order_mismatch' })
  assert.deepEqual(await call('folders:reorder', { accountId: 999, parentKey: null, paths: [] }), { ok: false, error: 'not_found' })
  assert.deepEqual(await call('folders:resetOrder', { accountId: 999 }), { ok: false, error: 'not_found' })
  assert.deepEqual(await call('folders:reorder', { accountId: s.a.id, parentKey: 'Nincs', paths: [] }), { ok: false, error: 'not_found' })
  assert.equal(table(s.db), snapshot, 'nothing written by any refused call')
  assert.deepEqual(calls.changes, [], 'no change event for a refused call')

  assert.deepEqual(await call('folders:reorder', { accountId: s.a.id, parentKey: null, paths: top }), { ok: true, count: 7 })
  assert.deepEqual(shape(tree(s.index, s.a.id)).filter(l => !l.startsWith(' ')), [...top.map(p => p), 'Régi (-)'])
  assert.deepEqual(calls.changes, [{ accountId: s.a.id, folders: [] }], 'the window reloads the tree')
  assert.deepEqual(await call('folders:resetOrder', { accountId: s.a.id }), { ok: true, count: 7 })
  assert.equal(table(s.db), snapshot, 'reset: the table is the never-ordered one again')
  assert.deepEqual(paths(), allPaths, 'the hierarchy (every path) unchanged')
  assert.deepEqual([calls.connection, calls.sync], [0, 0], 'no server connection, no sync asked')
})

// a real IMAP sync on the fake server: a new UIDVALIDITY (the fake server gives one to every renamed mailbox, as some
// servers do) throws the folder's messages away and fetches them again, but the folder row and its order stay
test('IMAP sync: a renamed folder with a new UIDVALIDITY keeps its place; so does a folder whose UIDVALIDITY changes on the server', async t => {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db)
  const server = new FakeImapServer()
  server.addMailbox('INBOX').addMailbox('Trash', { specialUse: '\\Trash' }).addMailbox('Akta').addMailbox('Regi').addMailbox('Zebra')
  const at = Date.UTC(2026, 10, 12, 9, 0, 0)
  server.addMessages('Regi', [1, 2].map(n => ({ from: `k${n}@example.invalid`, to: 'en@example.invalid', subject: `L ${n}`, messageId: `<r${n}@x>`, date: at - n * DAY, body: `b ${n}` })))
  server.addMessages('Zebra', [3].map(n => ({ from: `k${n}@example.invalid`, to: 'en@example.invalid', subject: `L ${n}`, messageId: `<z${n}@x>`, date: at - n * DAY, body: `b ${n}` })))
  const store = { list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) }
  const manager = new SyncManager({ store, index, sealed: sealedStore(path.join(tempDir(t), 'store')), notify: () => {}, connect: () => server.connect(), now: () => at, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  const until = async fn => {
    for (const end = Date.now() + 6000; !(await fn()); await new Promise(r => setTimeout(r, 5))) if (Date.now() > end) throw new Error('timed out')
  }
  const idle = () => until(() => !manager.entries.get(row.id).syncer.current)
  await until(() => manager.entries.get(row.id).idle.connected)
  await idle()
  const folders = new FolderActions({ index, store, storeDir: path.join(tempDir(t), 's'), withConnection: (id, fn) => manager.withConnection(id, fn), requestSync: (id, f) => manager.requestSync(id, f) })
  const top = () => siblingsOf(buildFolderTree(index.folders(row.id)), null).map(n => n.path)
  folders.reorder({ accountId: row.id, parentKey: null, paths: ['Zebra', 'Regi', 'INBOX', 'Akta', 'Trash'] })
  assert.deepEqual(top(), ['Zebra', 'Regi', 'INBOX', 'Akta', 'Trash'])

  await folders.rename({ accountId: row.id, path: 'Regi', name: 'Archiv' })
  await until(() => index.listFolder({ accountId: row.id, folder: 'Archiv' }).length === 2 && !manager.entries.get(row.id).syncer.current)
  assert.notEqual(index.getFolder(row.id, 'Archiv').uidvalidity, '1', 'the server did give a new UIDVALIDITY')
  assert.deepEqual(top(), ['Zebra', 'Archiv', 'INBOX', 'Akta', 'Trash'], 'after the rename and its sync')

  server.mailboxes.get('Zebra').uidValidity = 77
  manager.requestSync(row.id)
  await until(() => index.getFolder(row.id, 'Zebra').uidvalidity === '77' && !manager.entries.get(row.id).syncer.current)
  assert.equal(index.listFolder({ accountId: row.id, folder: 'Zebra' }).length, 1, 'the messages fetched again')
  assert.deepEqual(top(), ['Zebra', 'Archiv', 'INBOX', 'Akta', 'Trash'], 'after a UIDVALIDITY change')
  // a folder gone from the server takes its order with it
  server.mailboxes.delete('Akta')
  manager.requestSync(row.id)
  await until(() => !index.getFolder(row.id, 'Akta') && !manager.entries.get(row.id).syncer.current)
  assert.deepEqual(top(), ['Zebra', 'Archiv', 'INBOX', 'Trash'])
})

// AccountStore.list() needs only the vault's "is a password stored" answer here
const noSecrets = { hasSecret: () => false }

test('accounts:reorder: the exact ids once each, 0..n-1 in one transaction; it survives a reopen; every bad list writes nothing', async t => {
  const file = path.join(tempDir(t), 'mail.sqlite')
  const key = crypto.randomBytes(32)
  const { db } = openFile(file, key)
  const ids = [addAccount(db, { sort_order: 0 }).id, addAccount(db, { sort_order: 1 }).id, addAccount(db, { sort_order: 2 }).id]
  const store = new AccountStore(db, noSecrets)
  const accounts = db => JSON.stringify(db.prepare('SELECT * FROM accounts ORDER BY id').all())
  const snapshot = accounts(db)
  const events = []
  const handlers = new Map()
  registerAccountIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, store, index: null, isTrustedSender: e => e.ok, notify: e => events.push(e) })
  const call = (arg, ok = true) => handlers.get('accounts:reorder')({ ok }, arg)

  assert.deepEqual(await call([ids[2], ids[0], ids[1]], false), { ok: false, error: 'untrusted_sender' })
  for (const bad of [null, undefined, 'x', { ids }, [ids[0], ids[1], String(ids[2])], [ids[0], ids[1], 1.5], [ids[0], ids[1], 0]]) {
    const res = await call(bad)
    assert.equal(res.ok, false)
    assert.equal(res.error, 'bad_request', JSON.stringify(bad))
  }
  for (const [what, bad] of [
    ['missing', [ids[0], ids[1]]],
    ['repeated', [ids[0], ids[1], ids[1]]],
    ['repeated instead of one', [ids[0], ids[0], ids[1], ids[2]]],
    ['foreign', [ids[0], ids[1], ids[2], 999]],
    ['foreign instead of one', [ids[0], ids[1], 999]],
    ['empty', []],
  ]) {
    assert.equal((await call(bad)).error, 'order_mismatch', what)
    assert.throws(() => store.reorder(bad), err => err instanceof AccountError && err.code === 'order_mismatch', what)
    assert.equal(accounts(db), snapshot, `${what}: nothing written`)
  }
  assert.deepEqual(events, [])

  const res = await call([ids[2], ids[0], ids[1]])
  assert.equal(res.ok, true)
  assert.deepEqual(res.accounts.map(a => a.id), [ids[2], ids[0], ids[1]])
  assert.deepEqual(events, [{ kind: 'accounts' }])
  assert.deepEqual(db.prepare('SELECT sort_order FROM accounts ORDER BY id').pluck().all(), [1, 2, 0])
  db.close()
  const again = openFile(file, key)
  onCleanup(t, () => again.db.close())
  assert.deepEqual(new AccountStore(again.db, noSecrets).list().map(a => a.id), [ids[2], ids[0], ids[1]], 'after a reopen')
  // a new account after a reorder still goes to the end (MAX(sort_order) + 1)
  assert.equal(again.db.prepare('SELECT MAX(sort_order) + 1 FROM accounts').pluck().get(), 3)
})
