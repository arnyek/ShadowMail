// The search by date: one query whose inner part picks the newest ids under every condition, the snippet computed for
// those only. The result must be what the date order always meant: the same rows, in date order (ties by id), with the
// same snippets, under every filter and limit. The relevance order is not touched (its SQL is pinned below).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, addMessage, DAY } from './helpers/fixtures.js'
import { Labels } from '../core/db/labels.js'

const BASE = Date.UTC(2026, 0, 1)
const N = 1200

function setup(t) {
  const { db, index } = memoryIndex(t)
  const a = addAccount(db, { name: 'A' })
  const b = addAccount(db, { name: 'B' })
  const labels = new Labels(db)
  const kw = labels.create('Kulcsszavas', '#123456')
  const local = labels.create('Helyi', '#654321')
  const ids = []
  for (let i = 0; i < N; i++) {
    const words = ['alma']
    if (i % 2 === 0) words.push('korte')
    if (i % 7 === 0) words.push('szamla')
    if (i % 11 === 0) words.push('szamlazas')
    const flags = []
    if (i % 3 !== 0) flags.push('\\Seen')
    if (i % 5 === 0) flags.push('\\Flagged')
    if (i % 4 === 1) flags.push(kw.keyword)
    ids.push(
      addMessage(index, i % 6 === 0 ? b.id : a.id, {
        uid: i + 1,
        messageId: `<m${i}@example.invalid>`,
        subject: i % 9 === 0 ? `Ajanlat ${i}` : `Targy ${i}`,
        fromName: i % 4 === 0 ? 'Szabo Anna' : 'Kiss Bela',
        fromAddr: i % 4 === 0 ? 'szabo@example.invalid' : 'kiss@example.invalid',
        to: i % 8 === 0 ? 'Nagy Eva <nagy@example.invalid>' : 'cimzett@example.invalid',
        // unique dates, not in id order (the newest is not the last inserted)
        date: BASE + ((i * 7919) % N) * 60_000,
        flags: flags.join(' '),
        body: `${words.join(' ')} szoveg ${i} ${'kitoltes '.repeat(i % 13)}`,
      }),
    )
  }
  // a folder of their own for every fifth message (the folder filter matches without case)
  db.prepare(`UPDATE messages SET folder = 'Projekt' WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(ids.filter((_, i) => i % 5 === 2)))
  db.prepare(`UPDATE messages SET has_attachments = 1 WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(ids.filter((_, i) => i % 4 === 3)))
  db.prepare(`INSERT INTO message_labels (account_id, label_key, label_id, created_at)
    SELECT DISTINCT account_id, label_key, ?, 0 FROM messages WHERE label_key IS NOT NULL AND id IN (SELECT value FROM json_each(?))`).run(local.id, JSON.stringify(ids.filter((_, i) => i % 3 === 1)))
  return { db, index, a, b, kw, local, ids }
}

// what the date order means: every hit (the relevance branch, untouched, with a limit above the hit count), sorted by
// date and then id, newest first, cut to the limit; snippets included (snippet() does not depend on the order)
function expected(index, args) {
  const all = index.search({ ...args, sort: 'relevance', limit: 100_000 })
  assert.ok(all.length < 100_000)
  return all
    .sort((x, y) => y.date - x.date || y.id - x.id)
    .slice(0, args.limit)
    .map(r => [r.id, r.snip])
}
const got = (index, args) => index.search({ ...args, sort: 'date' }).map(r => [r.id, r.snip])

const QUERIES = ['alma', 'alma korte', 'sza*', '"alma korte"', 'korte OR szamla', 'alma NOT korte', 'subject:Ajanlat', 'alma"']

test('by date: the same rows, order and snippets as every hit sorted by date, for every query shape and limit', t => {
  const s = setup(t)
  for (const query of QUERIES) {
    for (const limit of [1, 50, 500, 5000]) {
      const want = expected(s.index, { query, limit })
      assert.ok(want.length > 0, `${query}: no hits in the fixture`)
      assert.deepEqual(got(s.index, { query, limit }), want, `${query} / ${limit}`)
    }
  }
  // only a sender or a recipient (an FTS condition without text)
  for (const args of [{ from: 'Szabo' }, { to: 'Nagy' }, { query: 'alma', from: 'Kiss' }, { query: 'korte', to: 'nagy@example.invalid' }]) {
    assert.deepEqual(got(s.index, { ...args, limit: 500 }), expected(s.index, { ...args, limit: 500 }), JSON.stringify(args))
  }
})

test('by date: every filter alone and all together give the rows the filter allows, newest first', t => {
  const s = setup(t)
  const filters = [
    { accountId: s.b.id },
    { folder: 'projekt' },
    { since: new Date(BASE + 300 * 60_000) },
    { before: new Date(BASE + 900 * 60_000) },
    { hasAttachment: true },
    { unread: true },
    { flagged: true },
    { label: s.kw.id },
    { label: s.local.id },
    { accountId: s.a.id, folder: 'PROJEKT', since: new Date(BASE + 100 * 60_000), before: new Date(BASE + 1100 * 60_000), unread: true, label: s.kw.id },
    { accountId: s.a.id, hasAttachment: true, flagged: true, label: s.local.id },
  ]
  for (const f of filters) {
    for (const limit of [1, 500, 5000]) {
      const want = expected(s.index, { query: 'alma', ...f, limit })
      assert.ok(want.length > 0, `no hits in the fixture: ${JSON.stringify(f)}`)
      assert.deepEqual(got(s.index, { query: 'alma', ...f, limit }), want, `${JSON.stringify(f)} / ${limit}`)
    }
  }
})

test('by date: the filter picks the rows before the limit (every third of the newest hits passes, the limit still fills)', t => {
  const s = setup(t)
  // 400 unread messages among the 1200 hits, spread over the dates; a filter applied after the limit would give ~100
  const unread = s.index.search({ query: 'alma', unread: true, sort: 'relevance', limit: 100_000 }).length
  assert.equal(unread, N / 3)
  for (const limit of [300, 400, 500]) assert.equal(s.index.search({ query: 'alma', unread: true, sort: 'date', limit }).length, Math.min(limit, unread))
})

test('by date: hits of the same date come by id, newest id first, every time', t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db)
  const same = BASE + DAY
  const ids = [1, 2, 3, 4, 5].map(uid => addMessage(index, acc.id, { uid, messageId: `<t${uid}@x>`, subject: 'Iker', date: same, body: 'iker szoveg' }))
  addMessage(index, acc.id, { uid: 6, messageId: '<t6@x>', subject: 'Iker', date: same + 1, body: 'iker szoveg' })
  const order = index.search({ query: 'iker', sort: 'date', limit: 10 }).map(r => r.id)
  assert.equal(order.length, 6)
  assert.deepEqual(order.slice(1), [...ids].reverse())
  for (let i = 0; i < 5; i++) assert.deepEqual(index.search({ query: 'iker', sort: 'date', limit: 10 }).map(r => r.id), order)
  // the limit cuts through the tie: the newest date, then the highest ids of the tied ones
  for (const limit of [2, 3, 4]) assert.deepEqual(index.search({ query: 'iker', sort: 'date', limit }).map(r => r.id), order.slice(0, limit), `limit ${limit}`)
  // without text (Claude's newest-first list): ties by id too
  assert.deepEqual(index.search({ accountId: acc.id, sort: 'date', limit: 10 }).map(r => r.id), order)
})

// the old date query, word for word (before the inner query): on a text-only search it must give the same rows
const OLD_DATE_SQL = `SELECT m.*, snippet(messages_fts, 3, '«', '»', '…', 14) AS snip,
              bm25(messages_fts, 8.0, 4.0, 2.0, 1.0) AS rank
            FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
            WHERE messages_fts MATCH ? ORDER BY m.date DESC LIMIT ?`

test('by date: a text-only search gives what the old date query gave (unique dates)', t => {
  const s = setup(t)
  for (const query of ['alma', 'alma korte', 'sza*', '"alma korte"', 'korte OR szamla', 'alma NOT korte', 'subject:Ajanlat']) {
    for (const limit of [1, 500, 5000]) {
      const old = s.db.prepare(OLD_DATE_SQL).all(query, limit).map(r => [r.id, r.snip])
      assert.deepEqual(got(s.index, { query, limit }), old, `${query} / ${limit}`)
    }
  }
})

test('by relevance: the query is the old one, byte for byte', t => {
  const s = setup(t)
  const seen = []
  const prepare = s.db.prepare.bind(s.db)
  s.db.prepare = sql => (seen.push(sql), prepare(sql))
  s.index.search({ query: 'alma', limit: 50 })
  s.index.search({ query: 'alma', sort: 'relevance', limit: 50 })
  s.db.prepare = prepare
  const old = `SELECT m.*, snippet(messages_fts, 3, '«', '»', '…', 14) AS snip,
              bm25(messages_fts, 8.0, 4.0, 2.0, 1.0) AS rank
            FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
            WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`
  assert.deepEqual(seen, [old, old])
})
