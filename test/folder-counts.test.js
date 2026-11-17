// SPDX-License-Identifier: GPL-3.0-or-later
// The sidebar's folder counts from the indexes: MailIndex.folders() = the former LEFT JOIN (walked NOT INDEXED) after every
// kind of change, IMAP and POP3; the query plans (the message count on a covering (account_id, folder) index, the unread
// count on idx_messages_unread, no SCAN); folderList() reads no message; MCP list_accounts_folders gives the same numbers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { FakePop3Server } from './helpers/fake-pop3.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { MailActions } from '../app/main/actions.js'
import { FolderActions } from '../app/main/folders.js'
import { createMcpTools } from '../app/main/mcp/tools.js'
import { UNREAD_SQL } from '../core/db/unread-total.js'

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 6000) => {
  for (const end = Date.now() + ms; !(await fn()); await sleep(5)) if (Date.now() > end) throw new Error('timed out waiting')
}
const msg = n => ({ from: `k${n}@example.invalid`, to: 'en@example.invalid', subject: `Levél ${n}`, messageId: `<m${n}@x>`, date: NOW - n * 60_000, body: `Szöveg ${n}` })

// the former query of folders(), with a full table walk: what the new counts must equal
const OLD_FOLDERS = `SELECT f.path, f.delimiter, f.special_use, f.is_local, f.synced_at, f.sort_order, f.role, f.role_manual, f.kept, COUNT(m.id) AS count,
    COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND instr(m.flags, '\\Seen') = 0 THEN 1 ELSE 0 END), 0) AS unread
  FROM folders f LEFT JOIN messages m NOT INDEXED ON m.account_id = f.account_id AND m.folder = f.path
  WHERE f.account_id = ? GROUP BY f.path ORDER BY f.path`

async function setup(t) {
  const { db, index } = memoryIndex(t)
  const imap = addAccount(db)
  const server = new FakeImapServer().addMailbox('INBOX').addMailbox('Archív').addMailbox('Trash', { specialUse: '\\Trash' }).addMailbox('Üres')
  server.addMessages('INBOX', Array.from({ length: 12 }, (_, i) => msg(i + 1)))
  const pop = await new FakePop3Server().listen()
  onCleanup(t, () => pop.close())
  for (let i = 0; i < 4; i++) pop.add(Buffer.from(`Subject: POP ${i}\r\nDate: ${new Date(NOW - i * DAY).toUTCString()}\r\n\r\nszöveg ${i}\r\n`))
  const pop3 = addAccount(db, { type: 'pop3', in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user })
  const storeDir = path.join(tempDir(t), 'store')
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: pop.pass }),
  }
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), notify: () => {}, connect: () => server.connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => manager.entries.get(imap.id).idle.connected)
  await until(() => index.listFolder({ accountId: pop3.id, folder: 'INBOX' }).length === 4)
  const idle = () => until(() => manager.status().every(s => !s.running && !s.busy))
  await idle()
  const deps = { index, store, storeDir, withConnection: (id, fn) => manager.withConnection(id, fn), requestSync: (id, f) => manager.requestSync(id, f) }
  const actions = new MailActions(deps)
  const folders = new FolderActions(deps)
  const old = id => db.prepare(OLD_FOLDERS).all(id)
  const ids = (id, folder) => index.listFolder({ accountId: id, folder, limit: 1000 }).map(m => m.id)
  return { db, index, imap, pop3, server, manager, actions, folders, old, ids, idle }
}

test('folders() = the former JOIN (walked NOT INDEXED), IMAP and POP3, after every kind of change; an empty folder is 0 / 0', async t => {
  const s = await setup(t)
  const same = what => {
    for (const id of [s.imap.id, s.pop3.id]) assert.deepEqual(s.index.folders(id), s.old(id), `${what}: account ${id}`)
  }
  same('after the first sync')
  assert.deepEqual(s.index.folders(s.imap.id).find(f => f.path === 'Üres'), { ...s.old(s.imap.id).find(f => f.path === 'Üres'), count: 0, unread: 0 })
  assert.deepEqual(['count', 'unread'].map(k => s.index.folders(s.imap.id).find(f => f.path === 'Üres')[k]), [0, 0], 'the empty folder')
  const steps = [
    ['IMAP read 3', () => s.actions.run({ ids: s.ids(s.imap.id, 'INBOX').slice(0, 3), action: 'read' })],
    ['IMAP unread 1 again', () => s.actions.run({ ids: s.ids(s.imap.id, 'INBOX').slice(0, 1), action: 'unread' })],
    ['IMAP move 2 to Archív', () => s.actions.run({ ids: s.ids(s.imap.id, 'INBOX').slice(3, 5), action: 'move', target: 'Archív' })],
    ['IMAP move back', async () => {
      await s.idle()
      await s.actions.run({ ids: s.ids(s.imap.id, 'Archív'), action: 'move', target: 'INBOX' }, { accountId: s.imap.id, folder: 'Archív' })
    }],
    ['IMAP to the Trash', async () => {
      await s.idle()
      await s.actions.run({ ids: s.ids(s.imap.id, 'INBOX').slice(0, 2), action: 'delete' })
    }],
    ['IMAP final delete in the Trash', async () => {
      await s.idle()
      await s.actions.run({ ids: s.ids(s.imap.id, 'Trash').slice(0, 1), action: 'delete', permanent: true })
    }],
    ['new IMAP messages', async () => {
      s.server.addMessages('INBOX', [msg(50), msg(51)])
      s.manager.syncNow(s.imap.id)
      await sleep(50)
      await s.idle()
      await until(() => s.ids(s.imap.id, 'INBOX').length >= 10)
    }],
    ['IMAP folder created', () => s.folders.create({ accountId: s.imap.id, name: 'Projekt' })],
    ['IMAP folder renamed', () => s.folders.rename({ accountId: s.imap.id, path: 'Projekt', name: 'Ügyek' })],
    ['IMAP folder deleted', async () => {
      await s.idle()
      await s.folders.remove({ accountId: s.imap.id, path: 'Ügyek', confirmed: true })
    }],
    ['POP3 read', () => s.actions.run({ ids: s.ids(s.pop3.id, 'INBOX').slice(0, 2), action: 'read' })],
    ['POP3 move to Drafts and back', async () => {
      const [a] = s.ids(s.pop3.id, 'INBOX')
      await s.actions.run({ ids: [a], action: 'move', target: 'Drafts' })
      await s.actions.run({ ids: [a], action: 'move', target: 'INBOX' })
    }],
    ['POP3 to the Trash and a final delete', async () => {
      const [a, b] = s.ids(s.pop3.id, 'INBOX')
      await s.actions.run({ ids: [a, b], action: 'delete' })
      await s.actions.run({ ids: [a], action: 'delete', permanent: true })
    }],
    ['POP3 local folder', () => s.folders.create({ accountId: s.pop3.id, name: 'Helyi' })],
  ]
  for (const [what, step] of steps) {
    await step()
    await s.idle()
    same(what)
  }
  // the account deleted: its folders go (cascade), the other account stays right
  s.manager.accountRemoved?.(s.pop3.id)
  s.db.prepare('DELETE FROM accounts WHERE id = ?').run(s.pop3.id)
  assert.deepEqual(s.index.folders(s.pop3.id), [])
  same('after an account was deleted')
  // folderList: the same rows without the counts, in the same order
  for (const id of [s.imap.id]) assert.deepEqual(s.index.folderList(id), s.index.folders(id).map(({ count, unread, ...f }) => f))
})

test('the query plans: the message count on a covering (account_id, folder) index, the unread count on idx_messages_unread, no SCAN; the former JOIN reads the table rows', async t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db)
  index.upsertFolder({ account_id: acc.id, path: 'INBOX', delimiter: '/', uidvalidity: '1', synced_at: 1 })
  const plan = (sql, ...a) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a).map(r => r.detail).join('; ')
  const COUNT = 'SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND folder = ?'
  for (const when of ['without statistics', 'after ANALYZE']) {
    const count = plan(COUNT, acc.id, 'INBOX')
    const unread = plan(UNREAD_SQL, acc.id, 'INBOX')
    assert.match(count, /USING COVERING INDEX idx_messages_folder_date \(account_id=\? AND folder=\?\)/, `${when}: ${count}`)
    assert.match(unread, /USING INDEX idx_messages_unread \(account_id=\? AND folder=\?\)/, `${when}: ${unread}`)
    for (const p of [count, unread]) assert.doesNotMatch(p, /SCAN messages/, `${when}: ${p}`)
    // the negative control: the former JOIN walks every message row of the folder (no covering index, not the unread one)
    const former = plan(OLD_FOLDERS.replace(' NOT INDEXED', ''), acc.id)
    assert.doesNotMatch(former, /COVERING INDEX idx_messages_folder_date|idx_messages_unread/, `${when}: ${former}`)
    db.exec('ANALYZE')
  }
  // folders() runs exactly these two statements per folder, folderList() none on messages
  assert.equal(index.s.countFolder.source, COUNT)
  assert.equal(index.s.unreadFolder.source, UNREAD_SQL, 'the unread count is the taskbar\'s query letter for letter (one constant)')
  assert.match(plan(index.s.folderList.source, acc.id), /^SEARCH folders/)
  assert.doesNotMatch(plan(index.s.folderList.source, acc.id), /messages/)
})

test('MCP list_accounts_folders: the same numbers as the former JOIN', async t => {
  const s = await setup(t)
  await s.actions.run({ ids: s.ids(s.imap.id, 'INBOX').slice(0, 5), action: 'read' })
  await s.idle()
  const store = { list: () => s.db.prepare('SELECT * FROM accounts ORDER BY id').all() }
  const tools = createMcpTools({ appVersion: '0.14.0', store, index: s.index, reader: null, manager: null })
  const r = await tools.call('list_accounts_folders', {})
  for (const a of r.data.accounts) {
    const old = s.old(a.id)
    assert.deepEqual(a.folders.map(f => [f.path, f.count, f.unread]), old.map(f => [f.path, f.count, f.unread]), `account ${a.id}`)
  }
  assert.ok(r.data.accounts.some(a => a.folders.some(f => f.count > 0 && f.unread > 0 && f.unread < f.count)), 'non-trivial numbers')
})
