import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, addMessage, DAY } from './helpers/fixtures.js'
import { toSafeFts } from '../core/db/fts.js'

const T0 = Date.UTC(2026, 10, 1)

test('search: the account filter returns only that account, no filter returns both', t => {
  const { db, index } = memoryIndex(t)
  const a = addAccount(db)
  const b = addAccount(db)
  const ida = addMessage(index, a.id, { uid: 1, subject: 'Ajánlat', body: 'A tavaszi árlista mellékelve.', date: T0 })
  const idb = addMessage(index, b.id, { uid: 1, subject: 'Re: árlista', body: 'Köszönöm az árlistát.', date: T0 + DAY })

  assert.deepEqual(index.search({ accountId: a.id, query: 'árlista' }).map(r => r.id), [ida])
  assert.deepEqual(index.search({ accountId: b.id, query: 'árlista' }).map(r => r.id), [idb])
  assert.deepEqual(index.search({ query: 'árlista' }).map(r => r.id).sort(), [ida, idb].sort())
  // without a query: the account filter still applies (folder view)
  assert.deepEqual(index.search({ accountId: a.id }).map(r => r.id), [ida])
})

test('search: accents optional and prefix match, quoted phrase, NOT, invalid syntax does not throw', t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db)
  const invoice = addMessage(index, acc.id, { uid: 1, subject: 'Kérdés', body: 'A számlával kapcsolatban írok, a fizetési határidő november 30.', date: T0 })
  const quote = addMessage(index, acc.id, { uid: 2, subject: 'Árajánlat', body: 'A fizetési feltételek a szerződésben. Határidő nincs.', date: T0 + DAY })
  const news = addMessage(index, acc.id, { uid: 3, subject: 'Hírlevél', body: 'Novemberi akciók.', date: T0 + 2 * DAY })
  const ids = rows => rows.map(r => r.id).sort((x, y) => x - y)

  assert.deepEqual(ids(index.search({ query: 'szamla' })), [invoice], '"szamla" finds "számlával"')
  assert.deepEqual(ids(index.search({ query: '"fizetési határidő"' })), [invoice], 'exact phrase')
  assert.deepEqual(ids(index.search({ query: 'fizetési NOT számlával' })), [quote], 'NOT')
  assert.deepEqual(ids(index.search({ query: 'fizetesi OR hirlevel' })), [invoice, quote, news], 'OR, accents optional')

  for (const bad of ['"unterminated', 'AND', 'NOT', '(fizetési', 'subject:', 'fizetési AND (', '***', '"']) {
    assert.doesNotThrow(() => index.search({ query: bad }), bad)
  }
  // invalid syntax falls back to free text, so the words still match
  assert.deepEqual(ids(index.search({ query: '(fizetési határidő' })), [invoice, quote], 'both contain both words')
  assert.deepEqual(index.search({ query: '"' }), [], 'punctuation only: no hits, not everything')
})

test('toSafeFts quotes every word and makes 3+ letter words prefixes', () => {
  assert.equal(toSafeFts('számla AND x'), '"számla"* "AND"* "x"')
  assert.equal(toSafeFts('  '), '')
})

test('thread(): a 3-message References chain comes back in time order', t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db)
  const other = addAccount(db)
  const reply2 = addMessage(index, acc.id, {
    uid: 3, subject: 'Re: Re: Szállítás', messageId: '<c@x>', inReplyTo: '<b@x>', refs: '<a@x> <b@x>', date: T0 + 2 * DAY,
  })
  const first = addMessage(index, acc.id, { uid: 1, subject: 'Szállítás', messageId: '<a@x>', date: T0 })
  const reply1 = addMessage(index, acc.id, { uid: 2, subject: 'Re: Szállítás', messageId: '<b@x>', inReplyTo: '<a@x>', refs: '<a@x>', date: T0 + DAY })
  addMessage(index, acc.id, { uid: 4, subject: 'Más téma', messageId: '<z@x>', date: T0 + DAY })
  // the same Message-ID in another account is not part of this account's thread
  addMessage(index, other.id, { uid: 1, subject: 'Szállítás', messageId: '<a@x>', date: T0 })

  for (const start of [first, reply1, reply2]) {
    assert.deepEqual(index.thread(start).map(r => r.id), [first, reply1, reply2], `from ${start}`)
  }
})

test('folders() counts messages and unread per account folder', t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db)
  index.upsertFolder({ account_id: acc.id, path: 'INBOX', uidvalidity: '1' })
  addMessage(index, acc.id, { uid: 1, flags: '\\Seen', date: T0 })
  addMessage(index, acc.id, { uid: 2, flags: '', date: T0 })
  assert.deepEqual(index.folders(acc.id).map(f => [f.path, f.count, f.unread]), [['INBOX', 2, 1]])
})

test('thread(): Message-IDs with _ or % are matched literally (no LIKE wildcards)', t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db)
  const root = addMessage(index, acc.id, { uid: 1, subject: 'A', messageId: '<a_b%c@x>', date: T0 })
  const reply = addMessage(index, acc.id, { uid: 2, subject: 'Re: A', messageId: '<r@x>', inReplyTo: '<a_b%c@x>', refs: '<a_b%c@x>', date: T0 + DAY })
  // refs differ only where LIKE would see wildcards: must not join the thread
  addMessage(index, acc.id, { uid: 3, subject: 'Más', messageId: '<o@x>', refs: '<aXbYZc@x>', date: T0 + DAY })
  assert.deepEqual(index.thread(root).map(r => r.id), [root, reply])
})
