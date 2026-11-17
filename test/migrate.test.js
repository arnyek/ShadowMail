import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir, onCleanup } from './helpers/tmp.js'
import { openDatabase, openMailDatabase } from '../core/db/index.js'
import { migrate, currentVersion, backupPath } from '../core/db/migrate.js'
import { MIGRATIONS } from '../core/db/schema.js'
import { MailIndex } from '../core/db/mail-index.js'
import { buildFolderTree } from '../core/imap/folders.js'

const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").all().map(r => r.name)

test('the real schema migrates an empty database to the latest version (no backup for a new file)', t => {
  const file = path.join(tempDir(t), 'mail.sqlite')
  const { db, migration } = openMailDatabase(file)
  try {
    assert.deepEqual(migration, { from: 0, to: MIGRATIONS.length, backup: null })
    assert.equal(currentVersion(db), MIGRATIONS.length)
    for (const name of ['accounts', 'account_secrets', 'folders', 'messages', 'messages_fts', 'contacts', 'pop3_seen', 'pop3_doubled', 'schema_version']) {
      assert.ok(tables(db).includes(name), name)
    }
    // the vault lives in vault.json, migration 3 drops the old vault table
    assert.ok(!tables(db).includes('vault'))
    // running again is a no-op
    assert.deepEqual(migrate(db, MIGRATIONS, { file }), { from: MIGRATIONS.length, to: MIGRATIONS.length, backup: null })
  } finally {
    db.close()
  }
  assert.equal(fs.existsSync(backupPath(file, 0)), false)
})

test('a database on a previous version gets a .bak copy first, then migrates', t => {
  const file = path.join(tempDir(t), 'mail.sqlite')
  const v2 = { version: MIGRATIONS.length + 1, name: 'test column', up: db => db.exec('ALTER TABLE contacts ADD COLUMN note TEXT') }

  // version N with one row
  let { db } = openMailDatabase(file)
  db.prepare("INSERT INTO contacts (address, name, use_count) VALUES ('a@example.invalid', 'Árvíztűrő', 1)").run()
  db.close()

  // the program now knows N+1
  ;({ db } = openMailDatabase(file, { migrations: [...MIGRATIONS, v2] }))
  try {
    assert.equal(currentVersion(db), MIGRATIONS.length + 1)
    assert.ok(db.prepare('SELECT note FROM contacts').get() !== undefined)
  } finally {
    db.close()
  }

  const bak = backupPath(file, MIGRATIONS.length)
  assert.equal(bak, `${file}.bak-${MIGRATIONS.length}`)
  assert.ok(fs.existsSync(bak), 'backup exists')
  const old = openDatabase(bak)
  try {
    assert.equal(currentVersion(old), MIGRATIONS.length, 'the backup is the pre-migration state')
    assert.equal(old.prepare('SELECT name FROM contacts').get().name, 'Árvíztűrő')
    assert.throws(() => old.prepare('SELECT note FROM contacts').get(), /no such column/)
  } finally {
    old.close()
  }
})

test('a failing migration rolls back and leaves the version unchanged', t => {
  const file = path.join(tempDir(t), 'mail.sqlite')
  openMailDatabase(file).db.close()
  const broken = { version: MIGRATIONS.length + 1, name: 'broken', up: db => { db.exec('CREATE TABLE half (x)'); throw new Error('boom') } }
  assert.throws(() => openMailDatabase(file, { migrations: [...MIGRATIONS, broken] }), /boom/)
  const db = openDatabase(file)
  try {
    assert.equal(currentVersion(db), MIGRATIONS.length)
    assert.equal(tables(db).includes('half'), false)
  } finally {
    db.close()
  }
})

test('a database newer than the program is refused', t => {
  const file = path.join(tempDir(t), 'mail.sqlite')
  openMailDatabase(file).db.close()
  assert.throws(() => openMailDatabase(file, { migrations: [] }), /newer than this program/)
})

test('deleting an account cascades to its folders, messages, secrets and search rows', t => {
  const { db } = openMailDatabase(':memory:')
  onCleanup(t, () => db.close())
  const acc = db.prepare("INSERT INTO accounts (name, email, type, in_host, in_port, in_security, in_user, created_at) VALUES ('a','a@x.invalid','imap','h',993,'tls','u',0)").run().lastInsertRowid
  db.prepare("INSERT INTO folders (account_id, path) VALUES (?, 'INBOX')").run(acc)
  const msg = db.prepare("INSERT INTO messages (account_id, folder, uid, subject) VALUES (?, 'INBOX', 1, 's')").run(acc).lastInsertRowid
  db.prepare("INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, 's', '', '', 'x')").run(msg)
  db.prepare("INSERT INTO account_secrets (account_id, kind, nonce, ciphertext, tag) VALUES (?, 'incoming', x'00', x'00', x'00')").run(acc)
  db.prepare('DELETE FROM accounts WHERE id = ?').run(acc)
  for (const table of ['folders', 'messages', 'messages_fts', 'account_secrets']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table)
  }
})

test('MCP settings: a v3 database (0.10.1) migrates to 4: the settings table is new, every other table is unchanged, the .bak-3 is made; a setting survives a reopen', t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'mail.sqlite')
  const key = Buffer.alloc(32, 7)
  const schema = db => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'settings' ORDER BY type, name").all()
  // what a 0.10.1 build leaves: the first three migrations, encrypted
  const old = openDatabase(file, key)
  migrate(old, MIGRATIONS.slice(0, 3))
  old.prepare("INSERT INTO accounts (name, email, type, in_host, in_port, in_security, in_user, body_index_days, created_at) VALUES ('régi', 'r@example.invalid', 'pop3', 'h', 995, 'tls', 'u', 1095, 0)").run()
  const before = schema(old)
  old.close()
  // up to 4 only: this is the 0.11.0 step (C1 brought migration 5, test/people.test.js)
  const { db, migration } = openMailDatabase(file, { key, migrations: MIGRATIONS.slice(0, 4) })
  try {
    assert.deepEqual(migration, { from: 3, to: 4, backup: backupPath(file, 3) })
    assert.ok(fs.existsSync(`${file}.bak-3`), 'the pre-migration copy')
    assert.deepEqual(db.prepare("SELECT name, sql FROM sqlite_master WHERE name = 'settings'").get().name, 'settings')
    assert.deepEqual(schema(db), before, 'no other table, index or trigger changed')
    assert.equal(db.prepare('SELECT count(*) AS n FROM accounts').get().n, 1, 'the data stays')
    db.prepare("INSERT INTO settings (key, value) VALUES ('claude_access', 'on')").run()
  } finally {
    db.close()
  }
  const { db: again } = openMailDatabase(file, { key, migrations: MIGRATIONS.slice(0, 4) })
  try {
    assert.equal(again.prepare("SELECT value FROM settings WHERE key = 'claude_access'").pluck().get(), 'on')
  } finally {
    again.close()
  }
  // the backup is still a v3 database, encrypted with the same key (the way back to 0.10.1)
  const bak = openDatabase(`${file}.bak-3`, key)
  try {
    assert.equal(currentVersion(bak), 3)
    assert.ok(!tables(bak).includes('settings'))
  } finally {
    bak.close()
  }
})

test('the migration list: 1..12 without a gap or a repeat; 6 the signature image, 7 the partial unread index, 8 the folder order, 9 the folder role, 10 the chosen role, 11 the archive mode, 12 the kept folders', () => {
  assert.deepEqual(MIGRATIONS.map(m => m.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.match(MIGRATIONS[5].name, /signature image/)
  assert.match(MIGRATIONS[6].name, /partial index of the unread rows/)
  assert.match(MIGRATIONS[6].up.toString(), /CREATE INDEX idx_messages_unread ON messages \(account_id, folder\) WHERE instr\(flags, '\\\\Seen'\) = 0/)
  assert.match(MIGRATIONS[7].name, /manual order among siblings/)
  assert.match(MIGRATIONS[7].up.toString(), /ALTER TABLE folders ADD COLUMN sort_order INTEGER'/)
  assert.match(MIGRATIONS[8].name, /role the sync decided/)
  assert.match(MIGRATIONS[8].up.toString(), /ALTER TABLE folders ADD COLUMN role TEXT'/)
  assert.match(MIGRATIONS[9].name, /role the user chose/)
  assert.match(MIGRATIONS[9].up.toString(), /ALTER TABLE folders ADD COLUMN role_manual INTEGER NOT NULL DEFAULT 0'/)
  assert.match(MIGRATIONS[10].name, /archive mode/)
  assert.match(MIGRATIONS[10].up.toString(), /ALTER TABLE accounts ADD COLUMN archive_mode TEXT'/)
  assert.match(MIGRATIONS[11].name, /kept without a subscription/)
  assert.match(MIGRATIONS[11].up.toString(), /ALTER TABLE folders ADD COLUMN kept INTEGER DEFAULT 0'/)
  assert.match(MIGRATIONS[11].up.toString(), /UPDATE folders SET kept = NULL WHERE is_local = 0'/)
})

test('a schema 7 database migrates to the latest (8, 9, 10, 11, 12): the .bak-7 is made, every folder has no manual order, the folder trees and the account list are byte for byte the old ones', t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'mail.sqlite')
  const key = Buffer.alloc(32, 7)
  const old = openDatabase(file, key)
  migrate(old, MIGRATIONS.slice(0, 7))
  const account = (name, type, order) => Number(old.prepare("INSERT INTO accounts (name, email, type, in_host, in_port, in_security, in_user, body_index_days, sort_order, created_at) VALUES (?, 'r@example.invalid', ?, 'h', 993, 'tls', 'u', 1095, ?, 0)").run(name, type, order).lastInsertRowid)
  // the account rows in an order that is not the id order, as the creation gives it
  const slash = account('Perjeles', 'imap', 1)
  const dotted = account('Pontos', 'imap', 0)
  const pop3 = account('Helyi', 'pop3', 2)
  const folder = old.prepare('INSERT INTO folders (account_id, path, delimiter, special_use, is_local) VALUES (?, ?, ?, ?, ?)')
  for (const [p, su] of [['Zöldség', null], ['Archive', '\\Archive'], ['Junk', '\\Junk'], ['INBOX', null], ['Trash', '\\Trash'], ['Sent', '\\Sent'], ['Drafts', '\\Drafts'], ['Ügyfelek/Bp', null], ['Ügyfelek', null], ['alma', null], ['Ábel', null], ['Régi/2019', null], ['Régi/2020', null]]) folder.run(slash, p, '/', su, 0)
  for (const p of ['INBOX', 'INBOX.Sent', 'INBOX.Trash', 'INBOX.spam', 'INBOX.Drafts', 'INBOX.Számlák', 'INBOX.Számlák.2025']) folder.run(dotted, p, '.', null, 0)
  for (const [p, su] of [['INBOX', '\\Inbox'], ['Drafts', '\\Drafts'], ['Sent', '\\Sent'], ['Trash', '\\Trash'], ['Saját', null]]) folder.run(pop3, p, '/', su, 1)
  old.prepare("INSERT INTO messages (account_id, folder, uid, flags, body_state) VALUES (?, 'Ügyfelek', 1, '', 0)").run(slash)
  // the folder query of schema 7 (MailIndex.folders without the new column)
  const oldFolders = old.prepare(`SELECT f.path, f.delimiter, f.special_use, f.is_local, f.synced_at, COUNT(m.id) AS count,
      COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND instr(m.flags, '\\Seen') = 0 THEN 1 ELSE 0 END), 0) AS unread
    FROM folders f LEFT JOIN messages m ON m.account_id = f.account_id AND m.folder = f.path
    WHERE f.account_id = ? GROUP BY f.path ORDER BY f.path`)
  const ids = [slash, dotted, pop3]
  const treesBefore = ids.map(id => JSON.stringify(buildFolderTree(oldFolders.all(id))))
  const rowsBefore = ids.map(id => oldFolders.all(id))
  const accountsBefore = JSON.stringify(old.prepare('SELECT * FROM accounts ORDER BY sort_order, id').all())
  old.close()

  const { db, migration } = openMailDatabase(file, { key })
  try {
    assert.deepEqual(migration, { from: 7, to: 12, backup: backupPath(file, 7) })
    assert.ok(fs.existsSync(`${file}.bak-7`), 'the pre-migration copy')
    assert.equal(db.prepare('SELECT COUNT(*) FROM folders WHERE sort_order IS NOT NULL').pluck().get(), 0, 'no manual order anywhere')
    assert.equal(db.prepare('SELECT COUNT(*) FROM folders').pluck().get(), 25)
    const index = new MailIndex(db)
    for (const [i, id] of ids.entries()) {
      assert.deepEqual(index.folders(id), rowsBefore[i].map(r => ({ ...r, sort_order: null, role: null, role_manual: 0, kept: r.is_local ? 0 : null })), 'the rows: the old ones plus sort_order and role NULL, role_manual 0, kept undecided (NULL) on the server folders, 0 on the local ones')
      assert.equal(JSON.stringify(buildFolderTree(index.folders(id))), treesBefore[i], `the tree of account ${id} byte for byte`)
    }
    const accountsNow = db.prepare('SELECT * FROM accounts ORDER BY sort_order, id').all()
    assert.ok(accountsNow.every(a => a.archive_mode === null), 'migration 11: no archive mode chosen')
    assert.equal(JSON.stringify(accountsNow.map(({ archive_mode, ...a }) => a)), accountsBefore, 'the account list byte for byte (the old columns)')
    assert.deepEqual(db.prepare('SELECT name FROM accounts ORDER BY sort_order, id').pluck().all(), ['Pontos', 'Perjeles', 'Helyi'])
  } finally {
    db.close()
  }
  const bak = openDatabase(`${file}.bak-7`, key)
  try {
    assert.equal(currentVersion(bak), 7, 'the backup is the schema 7 state')
    assert.ok(!bak.prepare("SELECT name FROM pragma_table_info('folders')").pluck().all().includes('sort_order'))
  } finally {
    bak.close()
  }
})

test('a 0.12.0 database (schema 5, encrypted) migrates to the latest: the .bak-5 is made, 6 to 12 are applied, the data stays', t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'mail.sqlite')
  const key = Buffer.alloc(32, 9)
  const old = openDatabase(file, key)
  migrate(old, MIGRATIONS.slice(0, 5))
  const acc = Number(old.prepare("INSERT INTO accounts (name, email, type, in_host, in_port, in_security, in_user, body_index_days, created_at) VALUES ('régi', 'r@example.invalid', 'pop3', 'h', 995, 'tls', 'u', 1095, 0)").run().lastInsertRowid)
  old.prepare("INSERT INTO folders (account_id, path, delimiter, special_use, uidvalidity, synced_at) VALUES (?, 'INBOX', '/', NULL, '1', 1)").run(acc)
  for (let i = 0; i < 6; i++) old.prepare("INSERT INTO messages (account_id, folder, uid, from_addr, to_addrs, cc_addrs, subject, date, idate, flags, size, has_attachments, body_state) VALUES (?, 'INBOX', ?, 'a@example.invalid', 'b@example.invalid', '', 's', 0, 0, ?, 1, 0, 0)").run(acc, i + 1, i % 2 ? '\\Seen' : '')
  old.close()
  const { db, migration } = openMailDatabase(file, { key })
  try {
    assert.deepEqual(migration, { from: 5, to: 12, backup: backupPath(file, 5) })
    assert.ok(fs.existsSync(`${file}.bak-5`), 'the pre-migration copy')
    assert.ok(db.prepare("SELECT name FROM pragma_table_info('accounts')").pluck().all().includes('signature_image'), 'migration 6')
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_unread'").pluck().get(), 'idx_messages_unread', 'migration 7')
    assert.equal(db.prepare("SELECT COUNT(*) FROM messages WHERE account_id = ? AND folder = 'INBOX' AND instr(flags, '\\Seen') = 0").pluck().get(acc), 3, 'the data stays, counted through the new index')
    assert.equal(db.prepare('SELECT sort_order FROM folders WHERE account_id = ?').pluck().get(acc), null, 'migration 8')
    assert.equal(db.prepare('SELECT role FROM folders WHERE account_id = ?').pluck().get(acc), null, 'migration 9')
    assert.equal(db.prepare('SELECT role_manual FROM folders WHERE account_id = ?').pluck().get(acc), 0, 'migration 10')
    assert.equal(db.prepare('SELECT archive_mode FROM accounts WHERE id = ?').pluck().get(acc), null, 'migration 11')
    assert.ok(db.prepare("SELECT name FROM pragma_table_info('folders')").pluck().all().includes('kept'), 'migration 12')
  } finally {
    db.close()
  }
  const bak = openDatabase(`${file}.bak-5`, key)
  try {
    assert.equal(currentVersion(bak), 5, 'the backup is the 0.12.0 state')
  } finally {
    bak.close()
  }
})
