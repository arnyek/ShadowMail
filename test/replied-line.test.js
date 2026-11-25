// The reader's "You replied: <date>" / "You forwarded this" line: the latest reply in the account's Sent-role folder
// (In-Reply-To = the message's Message-ID, through idx_messages_inreply), its count, and the flags it rests on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, DAY } from './helpers/fixtures.js'
import { sealedStore } from './helpers/fixtures.js'
import { tempDir } from './helpers/tmp.js'
import { MessageReader } from '../app/main/reader.js'

const NOW = Date.UTC(2026, 10, 25, 9, 0, 0)

// a row straight into the index, in any folder (the fixtures' addMessage writes INBOX only)
function put(index, accountId, folder, uid, m) {
  index.insertMany([{
    account_id: accountId, folder, uid, message_id: m.messageId || null, in_reply_to: m.inReplyTo || null, refs: null,
    from_addr: 'en@example.invalid', from_name: null, to_addrs: 'anna@example.invalid', cc_addrs: '', subject: m.subject || '',
    date: m.date, idate: m.date, flags: m.flags || '', size: 100, has_attachments: 0, attachments: null, body_state: 0,
    sender_text: 'en@example.invalid', recipients_text: 'anna@example.invalid',
  }])
  return index.getByUid(accountId, folder, uid).id
}

function setup(t, { sent = 'Sent' } = {}) {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  for (const [path, special] of [['INBOX', null], ...(sent ? [[sent, '\\Sent']] : []), ['Archive', '\\Archive']]) {
    index.upsertFolder({ account_id: account.id, path, delimiter: '/', special_use: special, uidvalidity: '1', synced_at: NOW })
  }
  const reader = new MessageReader({ index, sealed: sealedStore(tempDir(t)), withConnection: async () => { throw new Error('no network here') } })
  return { db, index, account, reader }
}

test('replyIn: the latest reply in the folder and how many; other folders, accounts and messages do not count', t => {
  const { db, index, account } = setup(t)
  const other = addAccount(db, { name: 'Másik', email: 'masik@example.invalid' })
  index.upsertFolder({ account_id: other.id, path: 'Sent', delimiter: '/', special_use: '\\Sent', uidvalidity: '1', synced_at: NOW })
  put(index, account.id, 'INBOX', 1, { messageId: '<orig@x>', date: NOW - 3 * DAY })
  assert.equal(index.replyIn(account.id, 'Sent', '<orig@x>'), null, 'no reply yet')
  const first = put(index, account.id, 'Sent', 1, { messageId: '<r1@x>', inReplyTo: '<orig@x>', date: NOW - 2 * DAY })
  assert.deepEqual(index.replyIn(account.id, 'Sent', '<orig@x>'), { id: first, date: NOW - 2 * DAY, count: 1 })
  const second = put(index, account.id, 'Sent', 2, { messageId: '<r2@x>', inReplyTo: '<orig@x>', date: NOW - DAY })
  put(index, account.id, 'Archive', 1, { messageId: '<r3@x>', inReplyTo: '<orig@x>', date: NOW })
  put(index, other.id, 'Sent', 1, { messageId: '<r4@x>', inReplyTo: '<orig@x>', date: NOW })
  put(index, account.id, 'Sent', 3, { messageId: '<r5@x>', inReplyTo: '<else@x>', date: NOW })
  assert.deepEqual(index.replyIn(account.id, 'Sent', '<orig@x>'), { id: second, date: NOW - DAY, count: 2 }, 'the latest of the two in Sent')
  assert.equal(index.replyIn(account.id, 'Sent', null), null)
  assert.equal(index.replyIn(account.id, null, '<orig@x>'), null)
})

test('replyIn: the query runs on idx_messages_inreply', t => {
  const { db, index } = setup(t)
  for (const stmt of [index.s.latestReply, index.s.replyCount]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${stmt.source}`).all('<orig@x>', 1, 'Sent').map(r => r.detail).join(' | ')
    assert.match(plan, /idx_messages_inreply/, plan)
  }
  db.exec('ANALYZE')
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${index.s.latestReply.source}`).all('<orig@x>', 1, 'Sent').map(r => r.detail).join(' | ')
  assert.match(plan, /idx_messages_inreply/, `after ANALYZE too: ${plan}`)
})

test('replyInfo: \\Answered with a reply in Sent, without one, $Forwarded, both, none; any case', t => {
  const { index, account, reader } = setup(t)
  const answered = put(index, account.id, 'INBOX', 1, { messageId: '<a@x>', flags: '\\Seen \\Answered', date: NOW - 3 * DAY })
  const reply = put(index, account.id, 'Sent', 1, { messageId: '<ra@x>', inReplyTo: '<a@x>', date: NOW - DAY })
  assert.deepEqual(reader.replyInfo(answered), { answered: true, forwarded: false, reply: { id: reply, date: NOW - DAY, count: 1 } })
  const elsewhere = put(index, account.id, 'INBOX', 2, { messageId: '<b@x>', flags: '\\Seen \\ANSWERED', date: NOW - 3 * DAY })
  assert.deepEqual(reader.replyInfo(elsewhere), { answered: true, forwarded: false, reply: null }, 'replied elsewhere: no date')
  const forwarded = put(index, account.id, 'INBOX', 3, { messageId: '<c@x>', flags: '\\Seen $forwarded', date: NOW - 3 * DAY })
  assert.deepEqual(reader.replyInfo(forwarded), { answered: false, forwarded: true, reply: null })
  const both = put(index, account.id, 'INBOX', 4, { messageId: '<d@x>', flags: '\\Answered $Forwarded', date: NOW - 3 * DAY })
  put(index, account.id, 'Sent', 2, { messageId: '<rd@x>', inReplyTo: '<d@x>', date: NOW - 2 * DAY })
  assert.equal(reader.replyInfo(both).reply.count, 1)
  assert.equal(reader.replyInfo(both).forwarded, true)
  const none = put(index, account.id, 'INBOX', 5, { messageId: '<e@x>', flags: '\\Seen', date: NOW - 3 * DAY })
  put(index, account.id, 'Sent', 3, { messageId: '<re@x>', inReplyTo: '<e@x>', date: NOW - 2 * DAY })
  assert.deepEqual(reader.replyInfo(none), { answered: false, forwarded: false, reply: null }, 'no flag: no line, even with a reply in Sent')
  const noId = put(index, account.id, 'INBOX', 6, { flags: '\\Answered', date: NOW - 3 * DAY })
  assert.deepEqual(reader.replyInfo(noId), { answered: true, forwarded: false, reply: null }, 'no Message-ID: nothing to look up')
  assert.throws(() => reader.replyInfo(999999), e => e.code === 'not_found')
})

test('replyInfo: the Sent ROLE, not the name: a reply in a differently named \\Sent folder, none in a plain "Sent"', t => {
  const { index, account, reader } = setup(t, { sent: 'Elküldött elemek' })
  index.upsertFolder({ account_id: account.id, path: 'Sent', delimiter: '/', special_use: null, uidvalidity: '1', synced_at: NOW })
  const id = put(index, account.id, 'INBOX', 1, { messageId: '<a@x>', flags: '\\Answered', date: NOW - 2 * DAY })
  const reply = put(index, account.id, 'Elküldött elemek', 1, { messageId: '<ra@x>', inReplyTo: '<a@x>', date: NOW - DAY })
  put(index, account.id, 'Sent', 1, { messageId: '<rb@x>', inReplyTo: '<a@x>', date: NOW })
  assert.deepEqual(reader.replyInfo(id), { answered: true, forwarded: false, reply: { id: reply, date: NOW - DAY, count: 1 } })
})

test('replyInfo: an account without a Sent-role folder gives no date', t => {
  const { index, account, reader } = setup(t, { sent: null })
  const id = put(index, account.id, 'INBOX', 1, { messageId: '<a@x>', flags: '\\Answered', date: NOW - DAY })
  put(index, account.id, 'Archive', 1, { messageId: '<ra@x>', inReplyTo: '<a@x>', date: NOW })
  assert.deepEqual(reader.replyInfo(id), { answered: true, forwarded: false, reply: null })
})
