// The label picker's state (Labels.stateOf: how many of the chosen rows carry each label) reads the chosen rows once.
// It must give exactly what the rule of labelsOfRows gives (local bindings on (account, label_key), and on an IMAP
// account the labels whose keyword is a word of the row's flags, each label once per row), on random data: IMAP and
// POP3 accounts, copies of a message in two folders, rows without a key, keywords in any case and inside other words,
// bindings of keys no chosen row has, a deleted label, repeated and unknown ids.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, addMessage } from './helpers/fixtures.js'
import { Labels } from '../core/db/labels.js'

// mulberry32: a float LCG's correlated calls collapse
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// the rule as labelsOfRows applies it, and the rows that exist
function byRule(db, labels, ids) {
  const rows = [...new Set(ids)]
  const counts = new Map()
  for (const of of labels.labelsOfRows(rows).values()) for (const label of of) counts.set(label, (counts.get(label) || 0) + 1)
  const total = db.prepare('SELECT COUNT(DISTINCT m.id) AS n FROM json_each(?) j CROSS JOIN messages m ON m.id = j.value').get(JSON.stringify(rows)).n
  return { total, counts }
}

function build(t, seed) {
  const r = rng(seed)
  const pick = a => a[Math.floor(r() * a.length)]
  const { db, index } = memoryIndex(t)
  const accs = [addAccount(db, { type: 'imap' }), addAccount(db, { type: 'imap' }), addAccount(db, { type: 'pop3' })]
  const labels = new Labels(db, { now: () => 1 })
  const made = ['Számla', 'To Do', 'Junk', 'kw', 'Ünnep', 'Projekt X'].map(n => labels.create(n, '#112233'))
  const words = flags => {
    const out = []
    if (r() < 0.6) out.push('\\Seen')
    for (const l of made) {
      const x = r()
      if (x < 0.2) out.push(l.keyword)
      else if (x < 0.25) out.push(l.keyword.toUpperCase())
      else if (x < 0.28) out.push(`x${l.keyword}`) // not the word
    }
    if (r() < 0.1) out.push('$Forwarded')
    return [...flags, ...out].join(' ')
  }
  const ids = []
  let uid = 0
  for (let i = 0; i < 300; i++) {
    const acc = pick(accs)
    const mid = r() < 0.9 ? `<m${Math.floor(r() * 220)}@example.invalid>` : null // repeats: copies of one message
    const id = addMessage(index, acc.id, { uid: ++uid, messageId: mid, subject: `S${i}`, date: i, flags: words([]) })
    if (r() < 0.3) db.prepare("UPDATE messages SET folder = 'Archive' WHERE id = ?").run(id)
    ids.push(id)
  }
  // bindings: on keys of rows, and on keys no row has
  const keys = db.prepare('SELECT DISTINCT account_id, label_key FROM messages WHERE label_key IS NOT NULL').all()
  const bind = db.prepare('INSERT OR IGNORE INTO message_labels (account_id, label_key, label_id, created_at) VALUES (?, ?, ?, 0)')
  for (const k of keys) for (const l of made) if (r() < 0.15) bind.run(k.account_id, k.label_key, l.id)
  for (let i = 0; i < 20; i++) bind.run(pick(accs).id, `orphan-${i}`, pick(made).id)
  // a deleted label: its bindings go with it, its keyword stays in the flags
  if (r() < 0.5) labels.remove(made[5].id)
  return { db, labels, ids, r }
}

test('stateOf = the rule of labelsOfRows, on random data (30 seeds, every selection shape)', t => {
  for (let seed = 1; seed <= 30; seed++) {
    const { db, labels, ids, r } = build(t, seed)
    const some = ids.filter(() => r() < 0.4)
    const selections = [
      ids,
      some,
      [...some, ...some.slice(0, 20)], // repeats count once
      [...some, 10_000_001, 10_000_002], // unknown ids: not in the total
      [ids[0]],
      [],
    ]
    for (const [n, sel] of selections.entries()) {
      const want = byRule(db, labels, sel)
      const got = labels.stateOf(sel)
      assert.equal(got.total, want.total, `seed ${seed} selection ${n}: total`)
      // the same entries in the same order (the IPC sends the Map as an array)
      assert.deepEqual([...got.counts], [...want.counts], `seed ${seed} selection ${n}: counts`)
    }
  }
})

test('stateOf: a POP3 row never counts a keyword, an IMAP row counts it once with a local binding of the same label', t => {
  const { db, index } = memoryIndex(t)
  const imap = addAccount(db, { type: 'imap' })
  const pop = addAccount(db, { type: 'pop3' })
  const labels = new Labels(db, { now: () => 1 })
  const bill = labels.create('Számla', '#112233')
  const a = addMessage(index, imap.id, { uid: 1, messageId: '<a@x>', flags: `\\Seen ${bill.keyword.toUpperCase()}` })
  const b = addMessage(index, pop.id, { uid: 1, messageId: '<b@x>', flags: bill.keyword })
  const key = db.prepare('SELECT label_key FROM messages WHERE id = ?').pluck().get(a)
  db.prepare('INSERT INTO message_labels (account_id, label_key, label_id, created_at) VALUES (?, ?, ?, 0)').run(imap.id, key, bill.id)
  assert.deepEqual(labels.stateOf([a, b]), { total: 2, counts: new Map([[bill.id, 1]]) })
})

test('stateOf keeps its limits: more than 100 000 ids or a bad id is bad_request', t => {
  const { db } = memoryIndex(t)
  const labels = new Labels(db, { now: () => 1 })
  assert.throws(() => labels.stateOf(Array.from({ length: 100_001 }, (_, i) => i + 1)), { code: 'bad_request' })
  assert.throws(() => labels.stateOf([1, 'x']), { code: 'bad_request' })
  assert.throws(() => labels.stateOf(null), { code: 'bad_request' })
})

test('stateOf reads only the bindings of the chosen rows\' keys, by the primary key (not the whole table)', t => {
  const { db, index } = memoryIndex(t)
  const imap = addAccount(db, { type: 'imap' })
  const labels = new Labels(db, { now: () => 1 })
  const [x, y] = ['X', 'Y'].map(n => labels.create(n, '#112233'))
  const a = addMessage(index, imap.id, { uid: 1, messageId: '<a@x>' })
  const b = addMessage(index, imap.id, { uid: 2, messageId: '<b@x>' })
  const keyOf = id => db.prepare('SELECT label_key FROM messages WHERE id = ?').pluck().get(id)
  const bind = db.prepare('INSERT INTO message_labels (account_id, label_key, label_id, created_at) VALUES (?, ?, ?, 0)')
  bind.run(imap.id, keyOf(a), x.id)
  bind.run(imap.id, keyOf(b), y.id)
  for (let i = 0; i < 500; i++) bind.run(imap.id, `other-${i}`, x.id)
  assert.deepEqual(labels.stateOf([a]), { total: 1, counts: new Map([[x.id, 1]]) })
  assert.deepEqual(labels.stateOf([a, b]), { total: 2, counts: new Map([[x.id, 1], [y.id, 1]]) })
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${labels.s.stateRows.source}`).all('[]').map(r => r.detail)
  assert.ok(plan.some(d => /SEARCH ml USING (COVERING INDEX|PRIMARY KEY|INDEX sqlite_autoindex_message_labels)/.test(d)), plan.join(' | '))
  assert.ok(!plan.some(d => /SCAN ml/.test(d)), plan.join(' | '))
})
