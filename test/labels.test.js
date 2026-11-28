// Labels, the data layer (0.17.0, migration 15): the label key, the migration from 14, the survival of a label
// when its row goes and comes back (move without a UID map, UIDVALIDITY change), the binding per account, and the
// rules of the label list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from './helpers/tmp.js'
import { memoryIndex, addAccount, addMessage } from './helpers/fixtures.js'
import { openDatabase, openMailDatabase } from '../core/db/index.js'
import { migrate, currentVersion, backupPath } from '../core/db/migrate.js'
import { MIGRATIONS } from '../core/db/schema.js'
import { MailIndex } from '../core/db/mail-index.js'
import { labelKeyOf, bareMessageId } from '../core/db/label-key.js'
import { Labels, LabelError, MAX_LABEL_IDS } from '../core/db/labels.js'

const setup = t => {
  const { db, index } = memoryIndex(t)
  return { db, index, labels: new Labels(db, { now: () => 1000 }), acc: addAccount(db).id }
}
const labelsOf = (labels, id) => labels.labelsOfRows([id]).get(id) || []
const rowsOf = (db, id) => db.prepare('SELECT COUNT(*) FROM message_labels').pluck().get()
const code = c => err => err instanceof LabelError && err.code === c

test('labelKeyOf: the bare Message-ID, case kept; without one a hash of the sender, the date and the size', () => {
  assert.equal(labelKeyOf({ message_id: '<a@b>' }), 'm:a@b')
  assert.equal(labelKeyOf({ message_id: ' <a@b> ' }), 'm:a@b')
  assert.equal(labelKeyOf({ message_id: '<Ab.Cd@Host>' }), 'm:Ab.Cd@Host', 'the case stays')
  assert.equal(labelKeyOf({ message_id: 'a@b' }), 'm:a@b', 'without brackets')
  assert.equal(bareMessageId('  <  a@b  >  '), 'a@b')
  const base = { message_id: null, from_addr: 'Kuldo@Example.invalid', date: 1700000000000, size: 1234 }
  const k = labelKeyOf(base)
  assert.match(k, /^h:[0-9a-f]{32}$/)
  for (const empty of ['', '   ', '<>', ' < > ', undefined]) assert.equal(labelKeyOf({ ...base, message_id: empty }), k, `empty: ${JSON.stringify(empty)}`)
  assert.equal(labelKeyOf({ ...base, from_addr: 'kuldo@example.invalid' }), k, 'the sender case does not count')
  assert.equal(labelKeyOf({ ...base, subject: 'any other subject' }), k, 'the subject is not part of it')
  assert.notEqual(labelKeyOf({ ...base, size: 1235 }), k, 'another size')
  assert.notEqual(labelKeyOf({ ...base, date: 1700000000001 }), k, 'another date')
  assert.notEqual(labelKeyOf({ ...base, from_addr: 'masik@example.invalid' }), k, 'another sender')
  assert.equal(labelKeyOf({ message_id: null, from_addr: null, date: null, size: null }), labelKeyOf({}), 'null and missing are the same')
})

test('insertMany fills the key on every new row; a header repair (setHeaders, a new subject) does not change it', t => {
  const { db, index, acc } = setup(t)
  const a = addMessage(index, acc, { uid: 1, messageId: '<x1@example.invalid>', subject: 'old' })
  const b = addMessage(index, acc, { uid: 2, date: 5000, subject: 'r�gi' })
  assert.equal(index.get(a).label_key, 'm:x1@example.invalid')
  const before = index.get(b).label_key
  assert.equal(before, labelKeyOf(index.get(b)), 'the h: key from the stored columns')
  assert.ok(index.setHeaders(b, { subject: 'régi', from_name: 'Név', to_addrs: 'c@example.invalid', cc_addrs: '' }))
  assert.equal(index.get(b).subject, 'régi')
  assert.equal(index.get(b).label_key, before)
  assert.equal(db.prepare('SELECT COUNT(*) FROM messages WHERE label_key IS NULL').pluck().get(), 0)
})

test('migration 14 -> 15 on an encrypted 0.16.0 database: the .bak-14 is made, every row has its key, the same key a new insert gives', t => {
  const file = path.join(tempDir(t), 'mail.sqlite')
  const key = crypto.randomBytes(32)
  const old = openDatabase(file, key)
  migrate(old, MIGRATIONS.slice(0, 14))
  const acc = addAccount(old).id
  const rows = []
  const ins = old.prepare(`INSERT INTO messages (account_id, folder, uid, message_id, from_addr, to_addrs, cc_addrs, subject, date, idate, flags, size,
    has_attachments, body_state) VALUES (?, 'INBOX', ?, ?, ?, '', '', 's', ?, ?, '', ?, 0, 0)`)
  for (let i = 1; i <= 40; i++) {
    const r = { uid: i, message_id: i % 4 ? `<m${i}@Example.invalid>` : null, from_addr: `Feladó${i}@example.invalid`, date: 1_700_000_000_000 + i, size: 100 + i }
    ins.run(acc, r.uid, r.message_id, r.from_addr, r.date, r.date, r.size)
    rows.push(r)
  }
  old.close()

  const { db, migration } = openMailDatabase(file, { key })
  try {
    assert.deepEqual(migration, { from: 14, to: 18, backup: backupPath(file, 14) })
    assert.ok(fs.existsSync(`${file}.bak-14`))
    assert.equal(db.prepare('SELECT COUNT(*) FROM messages WHERE label_key IS NULL').pluck().get(), 0, 'no NULL key')
    const stored = new Map(db.prepare('SELECT uid, label_key FROM messages').all().map(r => [r.uid, r.label_key]))
    for (const r of rows) assert.equal(stored.get(r.uid), labelKeyOf(r), `uid ${r.uid}`)
    assert.equal(db.prepare("SELECT COUNT(*) FROM messages WHERE label_key LIKE 'h:%'").pluck().get(), 10)
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_label_key'").get())
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_message_labels_label'").get())
    // the same messages inserted anew (as a resync would) get exactly the migrated keys
    const index = new MailIndex(db)
    db.prepare('DELETE FROM messages').run()
    index.insertMany(rows.map(r => ({ account_id: acc, folder: 'INBOX', uid: r.uid, message_id: r.message_id, in_reply_to: null, refs: null,
      from_addr: r.from_addr, from_name: null, to_addrs: '', cc_addrs: '', subject: 'other', date: r.date, idate: r.date, flags: '', size: r.size,
      has_attachments: 0, attachments: null })))
    for (const r of db.prepare('SELECT uid, label_key FROM messages').all()) assert.equal(r.label_key, stored.get(r.uid), `reinserted uid ${r.uid}`)
  } finally {
    db.close()
  }
  const bak = openDatabase(`${file}.bak-14`, key)
  try {
    assert.equal(currentVersion(bak), 14)
    assert.ok(!bak.prepare("SELECT name FROM pragma_table_info('messages')").pluck().all().includes('label_key'))
  } finally {
    bak.close()
  }
})

test('survival: the label comes back when the row is deleted and the message arrives as a new row in another folder, after a UIDVALIDITY change there, and stays after moveRows', t => {
  const { db, index, labels, acc } = setup(t)
  const red = labels.create('Fontos', '#d32f2f').id
  db.prepare("INSERT INTO folders (account_id, path, delimiter) VALUES (?, 'INBOX', '/'), (?, 'Archiv', '/')").run(acc, acc)
  // a row as the target folder's sync inserts it (addMessage writes INBOX only)
  const arrive = (folder, uid, m) => {
    index.insertMany([{ account_id: acc, folder, uid, message_id: m.messageId || null, in_reply_to: null, refs: null, from_addr: 'kuldo@example.invalid',
      from_name: null, to_addrs: '', cc_addrs: '', subject: '', date: m.date || 0, idate: m.date || 0, flags: '', size: 100, has_attachments: 0, attachments: null }])
    return index.getByUid(acc, folder, uid).id
  }
  const withId = arrive('INBOX', 1, { messageId: '<keep@example.invalid>' })
  const noId = arrive('INBOX', 2, { date: 7000 })
  assert.equal(labels.setLabels([withId, noId], { add: [red] }).changed, 2)
  // a later row keeps the max id up: without it SQLite would give the freed ids again, and the test would not see a new id
  arrive('INBOX', 3, { messageId: '<filler@example.invalid>' })

  // a move without a UID map (INBOX -> Archiv): the row goes, the target's sync brings a new row (new id, new folder)
  index.deleteIds([withId, noId])
  assert.equal(rowsOf(db), 2, 'the binding stays without its row')
  assert.equal(labels.list()[0].count, 0, 'a binding without a row is not counted')
  assert.equal(labels.labelsOfRows([withId, noId]).size, 0)
  const back = arrive('Archiv', 50, { messageId: '<keep@example.invalid>' })
  const back2 = arrive('Archiv', 51, { date: 7000 })
  assert.ok(back > noId && back2 > noId, 'new ids')
  assert.deepEqual([index.get(back).folder, index.get(back2).folder], ['Archiv', 'Archiv'])
  assert.deepEqual(labelsOf(labels, back), [red])
  assert.deepEqual(labelsOf(labels, back2), [red], 'the h: key too')
  assert.equal(labels.list()[0].count, 2)

  // a UIDVALIDITY change of the Archive: every row of it goes, the sync brings them again
  index.clearFolderMessages(acc, 'Archiv')
  assert.equal(db.prepare("SELECT COUNT(*) FROM messages WHERE folder = 'Archiv'").pluck().get(), 0)
  const again = arrive('Archiv', 1, { messageId: '<keep@example.invalid>' })
  const again2 = arrive('Archiv', 2, { date: 7000 })
  assert.deepEqual(labelsOf(labels, again), [red])
  assert.deepEqual(labelsOf(labels, again2), [red])

  // a move with a UID map (Archiv -> INBOX): the row (and its id) stays
  index.moveRows([{ id: again, folder: 'INBOX', uid: 9 }])
  assert.equal(index.get(again).folder, 'INBOX')
  assert.deepEqual(labelsOf(labels, again), [red])
})

test('the binding is per account: two rows with one Message-ID in an account share it, another account\'s copy does not', t => {
  const { db, index, labels, acc } = setup(t)
  const other = addAccount(db).id
  const l = labels.create('Közös', '#1e88e5').id
  const inbox = addMessage(index, acc, { uid: 1, messageId: '<self@example.invalid>' })
  const sent = addMessage(index, acc, { uid: 2, messageId: '<self@example.invalid>' })
  db.prepare("UPDATE messages SET folder = 'Sent' WHERE id = ?").run(sent)
  const elsewhere = addMessage(index, other, { uid: 1, messageId: '<self@example.invalid>' })
  const res = labels.setLabels([inbox], { add: [l] })
  assert.equal(res.changed, 1, 'one binding')
  assert.deepEqual(res.folders, [{ accountId: acc, folders: res.folders[0].folders }])
  assert.deepEqual([...res.folders[0].folders].sort(), ['INBOX', 'Sent'], 'onChange reaches the other copy\'s folder')
  assert.deepEqual(labelsOf(labels, sent), [l])
  assert.deepEqual(labelsOf(labels, elsewhere), [])
  assert.equal(labels.list()[0].count, 1, 'one message, not two rows')
  // taking it off one copy takes it off the message
  labels.setLabels([sent], { remove: [l] })
  assert.deepEqual(labelsOf(labels, inbox), [])
})

test('deleting a label takes its bindings; deleting an account takes the account\'s bindings, the label stays', t => {
  const { db, index, labels, acc } = setup(t)
  const other = addAccount(db).id
  const a = labels.create('A', '#000000').id
  const b = labels.create('B', '#ffffff').id
  const m1 = addMessage(index, acc, { uid: 1, messageId: '<1@example.invalid>' })
  const m2 = addMessage(index, other, { uid: 1, messageId: '<2@example.invalid>' })
  labels.setLabels([m1, m2], { add: [a, b] })
  assert.equal(rowsOf(db), 4)
  assert.equal(labels.remove(a), 2, 'it was on two messages')
  assert.equal(rowsOf(db), 2)
  assert.deepEqual(labelsOf(labels, m1), [b])
  db.prepare('DELETE FROM accounts WHERE id = ?').run(other)
  assert.equal(rowsOf(db), 1, 'the account\'s binding went (CASCADE)')
  assert.deepEqual(labels.list().map(l => l.name), ['B'], 'the label stays')
  assert.throws(() => labels.remove(a), code('not_found'))
})

test('the label list: names unique whatever the case (also beyond A-Z), 1..64 characters, colors #rrggbb; a refused change writes nothing', t => {
  const { db, labels } = setup(t)
  const s = labels.create('  Számla ', '#AABBCC')
  assert.deepEqual(s, { id: s.id, name: 'Számla', color: '#aabbcc', sort_order: 0, keyword: 'sz=c3=a1mla' })
  const before = () => db.prepare('SELECT * FROM labels ORDER BY id').all()
  const snap = before()
  assert.throws(() => labels.create('számla', '#000000'), code('name_taken'))
  assert.throws(() => labels.create('SZÁMLA', '#000000'), code('name_taken'), 'Á and á: NOCASE alone would let it in')
  assert.throws(() => labels.create('Számla', '#000000'), code('name_taken'), 'the decomposed á is the same name')
  for (const bad of ['', '   ', 'x'.repeat(65), 'a\nb', 'a\u202eb', 'a\u2028b', 'a\u2029b', 'a\u061cb', 'a\u180eb', 'a\u2060b', 5, null]) {
    assert.throws(() => labels.create(bad, '#000000'), code('bad_name'), JSON.stringify(bad))
  }
  // nothing visible: only invisible characters (with or without spaces)
  for (const bad of ['\u2060', '\u00ad', '\u3164', '\u2800', '\u00ad \u3164', '\u115f\u1160', '\uffa0', '\u034f', '\u00a0\u3000']) {
    assert.throws(() => labels.create(bad, '#000000'), code('bad_name'), JSON.stringify(bad))
  }
  // a visible name with a soft hyphen or a braille dot inside stays allowed
  assert.equal(labels.create('Sz\u00e1m\u00adla', '#000000').name, 'Sz\u00e1m\u00adla')
  assert.equal(labels.create('\u2801 pont', '#000000').name, '\u2801 pont')
  assert.equal(labels.create('é'.repeat(64), '#000000').name.length, 64, '64 characters')
  for (const bad of ['#abc', 'aabbcc', '#gg0000', '#aabbccdd', 'red', '', null]) assert.throws(() => labels.create('Új', bad), code('bad_color'), JSON.stringify(bad))
  assert.throws(() => labels.rename(s.id, 'ÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉ'), code('name_taken'))
  assert.throws(() => labels.setColor(s.id, 'blue'), code('bad_color'))
  assert.deepEqual(before().slice(0, 1), snap, 'nothing changed')
  assert.equal(labels.rename(s.id, 'számla').name, 'számla', 'its own name in another case')
  assert.equal(labels.setColor(s.id, '#00FF00').color, '#00ff00')
  assert.throws(() => labels.rename(999, 'x'), code('not_found'))
  assert.throws(() => labels.setColor(999, '#000000'), code('not_found'))
})

test('the order: new labels at the end, reorder takes exactly the existing ids once each', t => {
  const { labels } = setup(t)
  const [a, b, c] = ['Első', 'Második', 'Harmadik'].map(n => labels.create(n, '#123456').id)
  assert.deepEqual(labels.list().map(l => l.id), [a, b, c])
  labels.reorder([c, a, b])
  assert.deepEqual(labels.list().map(l => [l.id, l.sort_order]), [[c, 0], [a, 1], [b, 2]])
  for (const bad of [[a, b], [a, b, c, c], [a, b, 99], [a, a, b], [a, b, c, 99]]) assert.throws(() => labels.reorder(bad), code('order_mismatch'), JSON.stringify(bad))
  for (const bad of ['x', [a, 'b', c], null]) assert.throws(() => labels.reorder(bad), code('bad_request'))
  assert.deepEqual(labels.list().map(l => l.id), [c, a, b], 'unchanged')
  assert.equal(labels.create('Negyedik', '#123456').sort_order, 3)
})

test('setLabels: an unknown label or a missing row changes nothing; add and remove in one call; the limits of the ids', t => {
  const { db, index, labels, acc } = setup(t)
  const a = labels.create('A', '#000000').id
  const b = labels.create('B', '#000000').id
  const m = addMessage(index, acc, { uid: 1, messageId: '<1@example.invalid>' })
  labels.setLabels([m], { add: [a] })
  assert.throws(() => labels.setLabels([m], { add: [b, 999] }), code('bad_request'))
  assert.throws(() => labels.setLabels([m], { remove: [a], add: [999] }), code('bad_request'))
  assert.deepEqual(labelsOf(labels, m), [a], 'nothing changed')
  assert.throws(() => labels.setLabels([m, 12345], { add: [b] }), code('not_found'))
  assert.deepEqual(labelsOf(labels, m), [a])
  for (const bad of [[], [0], ['1'], null, Array.from({ length: MAX_LABEL_IDS + 1 }, (_, i) => i + 1)]) {
    assert.throws(() => labels.setLabels(bad, { add: [b] }), code('bad_request'))
  }
  assert.throws(() => labels.setLabels([m], { add: ['x'] }), code('bad_request'))
  assert.deepEqual(labels.setLabels([m], { add: [b], remove: [a] }).changed, 2)
  assert.deepEqual(labelsOf(labels, m), [b])
  assert.equal(labels.setLabels([m], { add: [b] }).changed, 0, 'already on')
  assert.deepEqual(labels.setLabels([m], { add: [b] }).folders, [], 'no change, no folder to refresh')
  assert.equal(labels.setLabels([m], { add: [a], remove: [a] }).changed, 1, 'in both lists: on')
  assert.deepEqual(labelsOf(labels, m), [a, b], 'in the list\'s order')
  // a repeated id: each label once (the json_each join once gave [a, a, a, b, b, b])
  assert.deepEqual(labels.labelsOfRows([m, m, m]).get(m), [a, b])
  assert.equal(db.prepare('SELECT created_at FROM message_labels LIMIT 1').pluck().get(), 1000)
})

test('the label queries use their indexes (before and after ANALYZE): no read of every row of an account', t => {
  const { db, labels, index, acc } = setup(t)
  for (let i = 1; i <= 50; i++) addMessage(index, acc, { uid: i, messageId: `<p${i}@example.invalid>` })
  const plan = (st, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${st.source}`).all(...args).map(r => r.detail).join(' | ')
  for (const when of ['before ANALYZE', 'after ANALYZE']) {
    if (when === 'after ANALYZE') db.exec('ANALYZE')
    assert.match(plan(labels.s.foldersOf, acc, 'm:x'), /USING (COVERING )?INDEX idx_messages_label_key \(account_id=\? AND label_key=\?\)/, `foldersOf ${when}`)
    assert.match(plan(labels.s.keysOf, '[1]'), /SEARCH m USING INTEGER PRIMARY KEY/, `keysOf ${when}`)
    assert.match(plan(labels.s.foundIds, '[1]'), /SEARCH m USING INTEGER PRIMARY KEY/, `foundIds ${when}`)
    const rows = plan(labels.s.localOfRows, '[1]')
    assert.match(rows, /SEARCH m USING INTEGER PRIMARY KEY/, `localOfRows ${when}`)
    assert.match(rows, /SEARCH ml USING COVERING INDEX \S+ \(account_id=\? AND label_key=\?\)/, `localOfRows ${when}`)
    const flagRows = plan(labels.s.imapFlagsOfRows, '[1]')
    assert.match(flagRows, /SEARCH m USING INTEGER PRIMARY KEY/, `imapFlagsOfRows ${when}`)
    // the count's local half; its keyword half (keywordRows) reads the IMAP rows once by design: flags is in no index
    const list = plan(labels.s.localPairs)
    assert.match(list, /SEARCH m EXISTS USING COVERING INDEX idx_messages_label_key/, `localPairs ${when}`)
    assert.doesNotMatch([plan(labels.s.foldersOf, acc, 'm:x'), rows, flagRows, list].join(' | '), /SCAN m\b|SCAN messages|idx_messages_folder_date/, `no scan ${when}`)
  }
})

test('at most 1000 labels: the 1001st is too_many and writes nothing; after a delete one more fits', t => {
  const { db, labels } = setup(t)
  const ins = db.prepare("INSERT INTO labels (name, color, sort_order, created_at) VALUES (?, '#000000', ?, 0)")
  db.transaction(() => { for (let i = 0; i < 1000; i++) ins.run(`L${i}`, i) })()
  assert.throws(() => labels.create('One more', '#000000'), err => err.code === 'too_many')
  assert.equal(db.prepare('SELECT COUNT(*) FROM labels').pluck().get(), 1000)
  labels.remove(db.prepare("SELECT id FROM labels WHERE name = 'L0'").pluck().get())
  assert.equal(labels.create('One more', '#000000').name, 'One more')
  assert.equal(labels.list().length, 1000)
})
