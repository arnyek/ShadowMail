// SPDX-License-Identifier: GPL-3.0-or-later
// The taskbar badge's number (core/db/unread-total.js) and when it is drawn again (app/main/unread-badge.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, addMessage } from './helpers/fixtures.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unreadInboxTotal, watchUnreadChanges, UNREAD_SQL } from '../core/db/unread-total.js'
import { createVaultedDatabase } from '../core/vault/vaulted-db.js'
import { AccountStore } from '../core/accounts/model.js'
import { MailIndex } from '../core/db/mail-index.js'
import { newAccountDefaults } from '../core/accounts/defaults.js'
import { createUnreadBadge, taskbarUnreadOn } from '../app/main/unread-badge.js'
import { assignRoles } from '../core/imap/folders.js'

function seed(t) {
  const { db, index } = memoryIndex(t)
  const imap = addAccount(db, { type: 'imap', email: 'a@example.invalid' })
  const pop = addAccount(db, { type: 'pop3', email: 'b@example.invalid' })
  for (const [path, specialUse] of [['INBOX', null], ['Spam', '\\Junk'], ['Archív', '\\Archive'], ['Kuka', '\\Trash'], ['Saját', null]]) {
    index.upsertFolder({ account_id: imap.id, path, delimiter: '/', special_use: specialUse, uidvalidity: '1', synced_at: 1 })
  }
  index.ensureLocalFolders(pop.id, [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Trash', specialUse: '\\Trash' }])
  let uid = 1
  // the shared fixture always writes INBOX: the row is moved to its folder right after
  const put = (accountId, folder, flags) => {
    const id = addMessage(index, accountId, { uid: uid++, flags, subject: `m${uid}`, date: uid })
    if (folder !== 'INBOX') db.prepare('UPDATE messages SET folder = ? WHERE id = ?').run(folder, id)
  }
  for (let i = 0; i < 7; i++) put(imap.id, 'INBOX', i < 3 ? '\\Seen' : '')
  for (const f of ['Spam', 'Archív', 'Kuka', 'Saját']) put(imap.id, f, '')
  for (let i = 0; i < 5; i++) put(pop.id, 'INBOX', i === 0 ? '\\Seen \\Flagged' : '$NotSeen')
  put(pop.id, 'Sent', '')
  return { db, index, imap, pop }
}

// the sidebar's own numbers: the inbox row of every account
const sidebarInboxUnread = (index, accountIds) =>
  accountIds.reduce((sum, id) => {
    const folders = index.folders(id)
    const roles = assignRoles(folders)
    return sum + folders.filter(f => roles.get(f.path) === 'inbox').reduce((s, f) => s + f.unread, 0)
  }, 0)

// the same total by a full table walk (NOT INDEXED): the index must give exactly this
const fullTotal = db =>
  [...new Set(db.prepare('SELECT account_id FROM folders').all().map(r => r.account_id))].reduce((sum, id) => {
    const folders = db.prepare('SELECT path, special_use FROM folders WHERE account_id = ?').all(id)
    const walk = db.prepare(UNREAD_SQL.replace('FROM messages', 'FROM messages NOT INDEXED'))
    return sum + [...assignRoles(folders)].filter(([, r]) => r === 'inbox').reduce((x, [p]) => x + walk.get(id, p).n, 0)
  }, 0)

test('the total: every account inbox (IMAP and POP3), the sidebar rule; Spam, Archive, Trash, own folders, Sent not counted', t => {
  const s = seed(t)
  assert.equal(unreadInboxTotal(s.db), 4 + 4)
  assert.equal(unreadInboxTotal(s.db), sidebarInboxUnread(s.index, [s.imap.id, s.pop.id]))
})

test('the change signal: insert, a flag, a move out of the inbox, a delete, a folder and an account deleted (cascade)', t => {
  const s = seed(t)
  let calls = 0
  const stop = watchUnreadChanges(s.db, () => calls++)
  const steps = [
    ['insert', () => addMessage(s.index, s.imap.id, { uid: 900, flags: '' })],
    ['flag', () => s.db.prepare("UPDATE messages SET flags = '\\Seen' WHERE uid = 900").run()],
    ['move', () => s.db.prepare("UPDATE messages SET folder = 'Archív' WHERE account_id = ? AND folder = 'INBOX' AND uid = 4").run(s.imap.id)],
    ['delete', () => s.db.prepare('DELETE FROM messages WHERE uid = 5').run()],
    ['folder', () => s.db.prepare("DELETE FROM folders WHERE account_id = ? AND path = 'Saját'").run(s.imap.id)],
    ['account', () => s.db.prepare('DELETE FROM accounts WHERE id = ?').run(s.pop.id)],
  ]
  for (const [name, step] of steps) {
    const before = calls
    step()
    assert.ok(calls > before, `${name}: a signal`)
  }
  assert.equal(unreadInboxTotal(s.db), sidebarInboxUnread(s.index, [s.imap.id]), 'after the deleted account: only the other one')
  // a body or a preview written: no signal (it does not change the number)
  const before = calls
  s.db.prepare("UPDATE messages SET preview = 'x', body_state = 1 WHERE account_id = ?").run(s.imap.id)
  assert.equal(calls, before)
  stop()
  addMessage(s.index, s.imap.id, { uid: 901, flags: '' })
  assert.equal(calls, before, 'stopped: no more signals')
})

test('a throwing onChange: the insert, the flag update and the delete still go through, one log line per error code, no number or data', t => {
  const s = seed(t)
  // the bare behaviour (no guard), measured: a SQL function that throws fails the statement whose trigger called it
  s.db.function('bare_throw', { deterministic: false }, () => {
    throw new Error('boom')
  })
  s.db.exec('CREATE TEMP TRIGGER bare_ins AFTER INSERT ON main.messages BEGIN SELECT bare_throw(); END')
  assert.throws(() => addMessage(s.index, s.imap.id, { uid: 800, flags: '' }), /boom/, 'without a guard the insert fails')
  s.db.exec('DROP TRIGGER temp.bare_ins')
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE uid = 800').get().n, 0, 'and its row is not there')
  // the watcher: its onChange throws every time
  const logs = []
  let calls = 0
  let code = 'EBADGE'
  const stop = watchUnreadChanges(
    s.db,
    () => {
      calls++
      throw Object.assign(new Error('Olvasatlan számla 42'), { code })
    },
    { log: line => logs.push(line) },
  )
  addMessage(s.index, s.imap.id, { uid: 801, flags: '' })
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE uid = 801').get().n, 1, 'inserted')
  s.db.prepare("UPDATE messages SET flags = '\\Seen' WHERE uid = 801").run()
  assert.equal(s.db.prepare('SELECT flags FROM messages WHERE uid = 801').get().flags, '\\Seen', 'updated')
  s.db.prepare('DELETE FROM messages WHERE uid = 801').run()
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE uid = 801').get().n, 0, 'deleted')
  assert.ok(calls >= 3)
  assert.deepEqual(logs, ['taskbar badge: change signal failed (EBADGE)'], 'one line for the repeated error, no message or number')
  // another error code: one more line, once
  code = 'EOTHER'
  for (let uid = 802; uid < 805; uid++) addMessage(s.index, s.imap.id, { uid, flags: '' })
  code = 'EBADGE'
  addMessage(s.index, s.imap.id, { uid: 805, flags: '' })
  assert.deepEqual(logs, ['taskbar badge: change signal failed (EBADGE)', 'taskbar badge: change signal failed (EOTHER)'], 'one line per error code')
  stop()
})

test('the recount: 5000 messages marked read at once -> one recount and one apply, the right number', async t => {
  const s = seed(t)
  for (let i = 0; i < 5000; i++) addMessage(s.index, s.imap.id, { uid: 10_000 + i, flags: '' })
  const applied = []
  const badge = createUnreadBadge({ total: () => unreadInboxTotal(s.db), apply: n => applied.push(n), delayMs: 30 })
  badge.refresh()
  assert.deepEqual(applied, [8 + 5000])
  const stop = watchUnreadChanges(s.db, () => badge.changed())
  s.db.prepare("UPDATE messages SET flags = '\\Seen' WHERE account_id = ? AND folder = 'INBOX'").run(s.imap.id)
  await new Promise(r => setTimeout(r, 100))
  assert.deepEqual(applied, [8 + 5000, 4], 'one apply for the 5000 changes, at most two in all')
  stop()
})

test('the switch: off -> the badge goes and no recount; on -> recount; stop (lock) -> the badge goes; the stored value', () => {
  let total = 3
  const applied = []
  const timers = []
  const badge = createUnreadBadge({ total: () => total, apply: n => applied.push(n), setTimer: fn => (timers.push(fn), timers.length), clearTimer: () => {} })
  badge.refresh()
  badge.setEnabled(false)
  total = 5
  badge.changed()
  assert.equal(timers.length, 0, 'switched off: nothing scheduled')
  badge.setEnabled(true)
  badge.stop()
  badge.changed()
  assert.deepEqual(applied, [3, 0, 5, 0])
  assert.deepEqual(['on', 'off', undefined, null, 'x', ''].map(taskbarUnreadOn), [true, false, true, true, true, true])
})

test('the count reads the partial index of migration 7 (the WHERE is its expression); without the index: a table walk', t => {
  const s = seed(t)
  const plan = () => s.db.prepare(`EXPLAIN QUERY PLAN ${UNREAD_SQL}`).all(s.imap.id, 'INBOX').map(r => r.detail).join('; ')
  assert.match(plan(), /USING INDEX idx_messages_unread\b/)
  s.db.exec('ANALYZE')
  assert.match(plan(), /USING INDEX idx_messages_unread\b/, 'with statistics too')
  // the negative control: the same query without the index walks the table (or another index); the total stays right
  const total = unreadInboxTotal(s.db)
  s.db.exec('DROP INDEX idx_messages_unread')
  assert.doesNotMatch(plan(), /idx_messages_unread/)
  assert.equal(unreadInboxTotal(s.db), total)
})

test('the index gives what a full walk gives: IMAP and POP3, after read / unread, a move, a delete, a new message', t => {
  const s = seed(t)
  const ids = (acc, folder) => s.db.prepare('SELECT id FROM messages WHERE account_id = ? AND folder = ? ORDER BY id').all(acc, folder).map(r => r.id)
  const flags = (id, f) => s.db.prepare('UPDATE messages SET flags = ? WHERE id = ?').run(f, id)
  const [i1, i2, i3] = ids(s.imap.id, 'INBOX').slice(3)
  const [p1, p2] = ids(s.pop.id, 'INBOX').slice(1)
  const steps = [
    ['IMAP read', () => flags(i1, '\\Seen')],
    ['IMAP unread again, other flags kept', () => flags(i1, '\\Flagged')],
    ['IMAP read among other flags', () => flags(i2, '\\Answered \\Seen $Forwarded')],
    ['POP3 read', () => flags(p1, '\\Seen')],
    ['POP3 $NotSeen stays unread', () => flags(p2, '$NotSeen')],
    ['IMAP move out of the inbox', () => s.db.prepare("UPDATE messages SET folder = 'Archív' WHERE id = ?").run(i3)],
    ['IMAP move back', () => s.db.prepare("UPDATE messages SET folder = 'INBOX' WHERE id = ?").run(i3)],
    ['POP3 to the Trash', () => s.db.prepare("UPDATE messages SET folder = 'Trash' WHERE id = ?").run(p2)],
    ['IMAP delete', () => s.db.prepare('DELETE FROM messages WHERE id = ?').run(i2)],
    ['new messages', () => (addMessage(s.index, s.imap.id, { uid: 950, flags: '' }), addMessage(s.index, s.pop.id, { uid: 951, flags: '\\Seen' }))],
  ]
  assert.equal(unreadInboxTotal(s.db), fullTotal(s.db), 'at the start')
  for (const [name, step] of steps) {
    step()
    assert.equal(unreadInboxTotal(s.db), fullTotal(s.db), name)
    assert.equal(unreadInboxTotal(s.db), sidebarInboxUnread(s.index, [s.imap.id, s.pop.id]), `${name}: = the sidebar`)
  }
})

// the REAL database of the app: the encrypted file (vault + SQLCipher), rows with a 200-character preview, the count right
// after the sidebar's own folders() (the app's order). A memory database measured 15.6 ms where the file took 177 ms.
test('the recount stays fast on the encrypted file database: 100 000 messages in the inbox, after folders(), median <= 20 ms, max <= 40 ms', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-unread-perf-'))
  let opened = null
  // ONE hook, the database closed first: Windows cannot delete an open file (EBUSY), and the folder must go even then
  t.after(() => {
    try {
      opened?.db.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  opened = await createVaultedDatabase(dir, 'Teszt-mesterjelszo-gyors')
  const { db, vault } = opened
  const store = new AccountStore(db, vault, { storeDir: path.join(dir, 'store') })
  const form = { ...newAccountDefaults('imap'), name: 'Nagy', email: 'nagy@example.invalid', in_host: '127.0.0.1', in_port: 1, in_security: 'none', in_user: 'u', in_password: 'p', smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none' }
  const id = store.save(form).account.id
  const index = new MailIndex(db)
  index.upsertFolder({ account_id: id, path: 'INBOX', delimiter: '/', special_use: null, uidvalidity: '1', synced_at: 1 })
  const row = i => ({ account_id: id, folder: 'INBOX', uid: i + 1, message_id: `<m${i}@example.invalid>`, in_reply_to: null, refs: null, from_addr: `k${i % 500}@example.invalid`, from_name: `Küldő ${i % 500}`, to_addrs: 'nagy@example.invalid', cc_addrs: '', subject: `Tárgy ${i} `.padEnd(60, 'x'), date: i, idate: i, flags: i % 3 ? '\\Seen' : '', size: 5000, has_attachments: 0, attachments: null, body_state: 0, sender_text: 'Küldő <k@example.invalid>', recipients_text: 'nagy@example.invalid' })
  for (let i = 0; i < 100_000; i += 5000) index.insertMany(Array.from({ length: 5000 }, (_, k) => row(i + k)))
  db.prepare('UPDATE messages SET preview = substr(hex(randomblob(100)), 1, 200)').run()
  const times = []
  for (let i = 0; i < 10; i++) {
    index.folders(id)
    const t0 = performance.now()
    assert.equal(unreadInboxTotal(db), 33_334)
    times.push(performance.now() - t0)
  }
  times.sort((x, y) => x - y)
  const median = (times[4] + times[5]) / 2
  console.log(`MEASURED the recount, encrypted file, 100 000 messages, after folders(): median ${median.toFixed(1)} ms, max ${times[9].toFixed(1)} ms`)
  assert.ok(median <= 20 && times[9] <= 40, `${median} / ${times[9]} ms`)
})
