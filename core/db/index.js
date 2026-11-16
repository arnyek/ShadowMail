// SPDX-License-Identifier: GPL-3.0-or-later
// SQLite access. better-sqlite3-multiple-ciphers 13.x (a better-sqlite3 build with encryption) is a
// Node-API addon: the same prebuilt binary loads in plain Node (tests) and in Electron (app).
//
// The mail database is encrypted: SQLCipher scheme, opened with a raw 32-byte key
// derived from the vault's DEK (no second password KDF). PRAGMA key must be the first statement; a read
// right after it tells a wrong key (SQLITE_NOTADB) from everything else. The -wal file and the
// migration backups (VACUUM INTO) are encrypted with the same key (measured).
import { addrKey } from './addr-key.js'
import Database from 'better-sqlite3-multiple-ciphers'
import { MIGRATIONS } from './schema.js'
import { migrate } from './migrate.js'

export class DatabaseKeyError extends Error {
  constructor() {
    super('the database cannot be opened with this key')
    this.name = 'DatabaseKeyError'
    this.code = 'db_key'
  }
}

/** key: a 32-byte Buffer (the encrypted mail database) or null (in-memory test databases). */
export function openDatabase(file, key = null) {
  const db = new Database(file)
  try {
    if (key) {
      if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('database key must be 32 bytes')
      db.pragma("cipher = 'sqlcipher'")
      db.pragma(`key = "x'${key.toString('hex')}'"`)
      try {
        db.prepare('SELECT count(*) FROM sqlite_master').get()
      } catch (err) {
        if (err && err.code === 'SQLITE_NOTADB') throw new DatabaseKeyError()
        throw err
      }
    }
    // SQLite's temporary files (a big sort, e.g. "select all" on a large folder sorted by subject) are NOT
    // encrypted and go to the system temp folder, outside the data folder: kept in memory
    db.pragma('temp_store = MEMORY')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    // the address key in SQL, the same rule as in JS (core/db/addr-key.js); NOCASE folds ASCII only
    db.function('addr_key', { deterministic: true }, addrKey)
    return db
  } catch (err) {
    db.close()
    throw err
  }
}

// Opens the mail database and brings its schema up to date (backup first, see migrate.js).
export function openMailDatabase(file, { key = null, migrations = MIGRATIONS } = {}) {
  const db = openDatabase(file, key)
  try {
    const migration = migrate(db, migrations, { file })
    return { db, migration }
  } catch (err) {
    db.close()
    throw err
  }
}

export function sqliteVersion(db) {
  return db.prepare('SELECT sqlite_version() AS v').get().v
}
