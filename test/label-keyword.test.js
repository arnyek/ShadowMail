// The IMAP keyword of a label (0.17.0, migration 16): the encoding of the name, the length rule, the reserved and
// taken keywords, imapflow's own atom check on random names, the migration from 15 and the keyword's life in Labels.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { formatFlag } from 'imapflow/lib/tools.js'
import { tempDir } from './helpers/tmp.js'
import { memoryIndex, addAccount } from './helpers/fixtures.js'
import { openDatabase, openMailDatabase } from '../core/db/index.js'
import { migrate, currentVersion, backupPath } from '../core/db/migrate.js'
import { MIGRATIONS } from '../core/db/schema.js'
import { labelKeyword, KEYWORD_MAX, RESERVED_KEYWORDS } from '../core/db/label-keyword.js'
import { Labels, cleanLabelName } from '../core/db/labels.js'

const SHAPE = /^[a-z0-9=_!#'+,./:?@^|~-]+$/

test('labelKeyword: the card examples', () => {
  assert.equal(labelKeyword('Számla'), 'sz=c3=a1mla')
  assert.equal(labelKeyword('To Do'), 'to=20do')
  assert.equal(labelKeyword('Junk'), 'junk_2')
  assert.equal(labelKeyword('$label1'), '=24label1')
  assert.equal(labelKeyword('Számla', ['sz=c3=a1mla']), 'sz=c3=a1mla_2')
  assert.equal(labelKeyword('Számla', ['SZ=C3=A1MLA', 'sz=c3=a1mla_2']), 'sz=c3=a1mla_3', 'taken compares in lower case')
})

test('labelKeyword: the kept characters, the escaped ones (= itself too), NFC and the lower case', () => {
  assert.equal(labelKeyword("a!#'+,-./:?@^_|~z"), "a!#'+,-./:?@^_|~z")
  assert.equal(labelKeyword('a=b'), 'a=3db', 'the escape character is escaped')
  assert.equal(labelKeyword('(x){%*"\\]}'), '=28x=29=7b=25=2a=22=5c=5d=7d')
  assert.equal(labelKeyword('a`b<c>d;e&f$g[h'), 'a=60b=3cc=3ed=3be=26f=24g=5bh')
  assert.equal(labelKeyword('Á'), labelKeyword('Á'), 'NFC: the composed and the decomposed name are one')
  assert.equal(labelKeyword('ÁRVÍZ'), labelKeyword('árvíz'))
  for (const word of RESERVED_KEYWORDS) assert.equal(labelKeyword(word.toUpperCase()), `${word}_2`, word)
})

test('labelKeyword: a long name is cut in whole units and gets a hash; two long names differ', () => {
  const jp = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ' // 30 letters, 270 characters encoded
  const k = labelKeyword(jp)
  assert.ok(k.length <= KEYWORD_MAX, `${k.length}`)
  assert.match(k, /^(=[0-9a-f]{2})+_[0-9a-f]{8}$/, 'no =xx is cut')
  const hash = crypto.createHash('sha256').update(jp, 'utf8').digest('hex').slice(0, 8)
  assert.ok(k.endsWith(`_${hash}`))
  assert.notEqual(labelKeyword(`${jp}x`), k)
  const ascii = 'a'.repeat(60)
  assert.equal(labelKeyword(ascii), `${'a'.repeat(41)}_${crypto.createHash('sha256').update(ascii).digest('hex').slice(0, 8)}`)
  assert.equal(labelKeyword('a'.repeat(50)), 'a'.repeat(50), '50 characters stay as they are')
  assert.equal(labelKeyword('a'.repeat(50), ['a'.repeat(50)]), `${'a'.repeat(48)}_2`, 'a taken long one is cut for the suffix')
  const taken = [k]
  assert.ok(labelKeyword(jp, taken).length <= KEYWORD_MAX && labelKeyword(jp, taken) !== k)
})

test('labelKeyword: 10 000 random valid names: imapflow sends each as it is, <= 50, only the allowed characters, all different', () => {
  const pools = [
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
    'áéíóöőúüűÁÉÍÓÖŐÚÜŰßçñøÆ',
    'あいうえお日本語中文한국어',
    'αβγδЖЗИКЛ',
    '😀🎉👍🏽',
  ].map(s => [...s])
  const seed = crypto.createHash('sha256').update('label-keyword').digest()
  let state = seed.readUInt32LE(0) || 1
  const rnd = n => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % n
  }
  const taken = new Set()
  let made = 0
  while (made < 10_000) {
    const len = 1 + rnd(64)
    let name = ''
    for (let i = 0; i < len; i++) {
      const pool = pools[rnd(pools.length)]
      name += pool[rnd(pool.length)]
    }
    try {
      name = cleanLabelName(name)
    } catch {
      continue
    }
    if ([...name].length > 64) continue
    const k = labelKeyword(name, taken)
    assert.equal(formatFlag(k), k, `imapflow sends it as it is: ${k}`)
    assert.ok(k.length <= KEYWORD_MAX, `${k} (${k.length})`)
    assert.match(k, SHAPE)
    assert.ok(!taken.has(k), `unique: ${k}`)
    assert.ok(!RESERVED_KEYWORDS.has(k))
    taken.add(k)
    made++
  }
})

test('migration 15 -> 16 on an encrypted database with labels: the .bak-15, a unique keyword for each label in the list order, the bindings unchanged', t => {
  const file = path.join(tempDir(t), 'mail.sqlite')
  const key = crypto.randomBytes(32)
  const old = openDatabase(file, key)
  migrate(old, MIGRATIONS.slice(0, 15))
  const acc = addAccount(old).id
  const add = old.prepare('INSERT INTO labels (name, color, sort_order, created_at) VALUES (?, ?, ?, 1)')
  // inserted out of the list order; the reserved words get a suffix
  const names = [['Junk', 2], ['Számla', 0], ['To Do', 1], ['nonjunk', 3]]
  for (const [name, order] of names) add.run(name, '#aabbcc', order)
  old.prepare("INSERT INTO message_labels (account_id, label_key, label_id, created_at) VALUES (?, 'm:a@b', 1, 5), (?, 'h:00', 2, 6)").run(acc, acc)
  const bindings = JSON.stringify(old.prepare('SELECT * FROM message_labels ORDER BY rowid').all())
  old.close()

  const { db, migration } = openMailDatabase(file, { key })
  try {
    assert.deepEqual(migration, { from: 15, to: 17, backup: backupPath(file, 15) })
    assert.ok(fs.existsSync(`${file}.bak-15`))
    const got = Object.fromEntries(db.prepare('SELECT name, keyword FROM labels').all().map(r => [r.name, r.keyword]))
    assert.deepEqual(got, { Számla: 'sz=c3=a1mla', 'To Do': 'to=20do', Junk: 'junk_2', nonjunk: 'nonjunk_2' })
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM message_labels ORDER BY rowid').all()), bindings, 'the bindings byte for byte')
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_labels_keyword' AND sql LIKE '%UNIQUE%'").get())
    assert.throws(() => db.prepare("UPDATE labels SET keyword = 'to=20do' WHERE name = 'Junk'").run(), /UNIQUE/)
  } finally {
    db.close()
  }
  const bak = openDatabase(`${file}.bak-15`, key)
  try {
    assert.equal(currentVersion(bak), 15)
    assert.ok(!bak.prepare("SELECT name FROM pragma_table_info('labels')").pluck().all().includes('keyword'))
  } finally {
    bak.close()
  }
})

test('migration 15 -> 16: labels that would take the same keyword in the list order get _2, _3; 1..17 on an empty file', t => {
  const file = path.join(tempDir(t), 'mail.sqlite')
  const key = crypto.randomBytes(32)
  const old = openDatabase(file, key)
  migrate(old, MIGRATIONS.slice(0, 15))
  // a collision comes from a label named like another one's suffixed keyword: "Junk" wants junk_2, and so does the label
  // named "junk_2". The list order (sort_order) decides, not the id: "junk_2" is first in the list but made later
  const add = old.prepare('INSERT INTO labels (name, color, sort_order, created_at) VALUES (?, ?, ?, 1)')
  add.run('Junk', '#aabbcc', 1)
  add.run('junk_2', '#aabbcc', 0)
  old.close()
  const { db } = openMailDatabase(file, { key })
  try {
    assert.deepEqual(db.prepare('SELECT name, keyword FROM labels ORDER BY sort_order').all().map(r => [r.name, r.keyword]), [['junk_2', 'junk_2'], ['Junk', 'junk_3']])
  } finally {
    db.close()
  }
  const fresh = path.join(tempDir(t), 'fresh.sqlite')
  const { db: db2, migration } = openMailDatabase(fresh, { key })
  try {
    assert.deepEqual(migration, { from: 0, to: 17, backup: null })
    assert.ok(db2.prepare("SELECT name FROM pragma_table_info('labels')").pluck().all().includes('keyword'))
  } finally {
    db2.close()
  }
})

test('Labels: create makes the keyword, a rename keeps it, the old name made anew gets _2; list and get give it', t => {
  const { db } = memoryIndex(t)
  const labels = new Labels(db, { now: () => 1000 })
  const a = labels.create('Számla', '#aabbcc')
  assert.equal(a.keyword, 'sz=c3=a1mla')
  assert.equal(labels.rename(a.id, 'Kifizetve').keyword, 'sz=c3=a1mla', 'a rename keeps the keyword')
  const b = labels.create('Számla', '#112233')
  assert.equal(b.keyword, 'sz=c3=a1mla_2')
  assert.equal(labels.get(b.id).keyword, 'sz=c3=a1mla_2')
  assert.deepEqual(labels.list().map(l => [l.name, l.keyword]), [['Kifizetve', 'sz=c3=a1mla'], ['Számla', 'sz=c3=a1mla_2']])
  assert.equal(labels.create('JUNK', '#112233').keyword, 'junk_2')
})
