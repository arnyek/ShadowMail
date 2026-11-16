import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from './helpers/tmp.js'
import { openDatabase, sqliteVersion } from '../core/db/index.js'

test('openDatabase creates mail.sqlite in WAL mode and reports the SQLite version', t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'mail.sqlite')
  const db = openDatabase(file)
  try {
    assert.match(sqliteVersion(db), /^3\.\d+\.\d+$/)
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  } finally {
    db.close()
  }
  assert.ok(fs.existsSync(file))
})

test('FTS5 with the unicode61 tokenizer is available (needed by the search index)', () => {
  const db = openDatabase(':memory:')
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize = 'unicode61 remove_diacritics 2')")
    db.prepare('INSERT INTO t(body) VALUES (?)').run('Számlával kapcsolatos kérdés')
    assert.equal(db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH 'szamlaval'").get().n, 1)
  } finally {
    db.close()
  }
})
