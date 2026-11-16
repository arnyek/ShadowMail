// SPDX-License-Identifier: GPL-3.0-or-later
// The vault and the encrypted mail database together: the database opens only with the key the
// unlocked vault derives. Used by the main process after vault:create / vault:unlock, and by the seeds
// of the tests (e2e, live, tools) to write a data folder the app can open.
import fs from 'node:fs'
import path from 'node:path'
import { Vault } from './vault.js'
import { openMailDatabase } from '../db/index.js'
import { databasePath } from '../paths.js'
import { STORE_KEY_LABEL } from './keys.js'
import { SealedStore } from '../store/sealed-file.js'

export const vaultPath = dataDir => path.join(dataDir, 'vault.json')

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1')

/**
 * What the data folder holds, read only:
 *   'new'          no vault.json and no mail.sqlite (first start)
 *   'vaulted'      vault.json is there (it may still be damaged: unlock says so)
 *   'legacy_plain' no vault.json, an unencrypted mail.sqlite or mail.sqlite.bak-N: an earlier development build
 *   'no_vault'     no vault.json, an encrypted mail.sqlite (or backup): the vault file is missing
 */
export function dataFolderState(dataDir) {
  if (fs.existsSync(vaultPath(dataDir))) return 'vaulted'
  // the database and its migration backups (mail.sqlite.bak-N): a plain backup of an earlier build left
  // alone, the database itself gone, is the same case
  const db = databasePath(dataDir)
  let names = []
  try {
    names = fs.readdirSync(path.dirname(db))
  } catch {
    return 'new'
  }
  const base = path.basename(db)
  const files = names.filter(n => n === base || n.startsWith(`${base}.bak-`)).map(n => path.join(path.dirname(db), n))
  if (!files.length) return 'new'
  return files.some(isPlainSqlite) ? 'legacy_plain' : 'no_vault'
}

function isPlainSqlite(file) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const head = Buffer.alloc(SQLITE_HEADER.length)
      return head.subarray(0, fs.readSync(fd, head, 0, head.length, 0)).equals(SQLITE_HEADER)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false // unreadable: treated like an encrypted one, the app touches nothing
  }
}

/**
 * Opens (and migrates) the encrypted database with the unlocked vault's key; the vault gets it attached.
 * create: only right after vault:create may a new, empty database come; otherwise a missing mail.sqlite
 * is 'db_missing' (an unlock must not silently start an empty mailbox).
 */
export function openUnlockedDatabase(vault, dataDir, { create = false } = {}) {
  if (!create && !fs.existsSync(databasePath(dataDir))) throw Object.assign(new Error('the database is missing'), { code: 'db_missing' })
  const key = vault.databaseKey()
  try {
    const opened = openMailDatabase(databasePath(dataDir), { key })
    vault.attach(opened.db)
    return opened
  } finally {
    key.fill(0)
  }
}

/** data\store sealed with the unlocked vault's store key: the app's session and the test seeds. */
export function openSealedStore(vault, dataDir) {
  const key = vault.subkey(STORE_KEY_LABEL)
  try {
    const store = new SealedStore(path.join(dataDir, 'store'), key)
    // the vault's lock wipes the store key too, whoever holds the store
    const off = vault.onLock(() => {
      store.close()
      off()
    })
    return store
  } finally {
    key.fill(0)
  }
}

/** Seeds and tests: a new data folder with vault.json and the encrypted, migrated mail.sqlite. */
export async function createVaultedDatabase(dataDir, password, opts = {}) {
  const vault = new Vault(vaultPath(dataDir), opts)
  await vault.create(password)
  const { db, migration } = openUnlockedDatabase(vault, dataDir, { create: true })
  return { vault, db, migration }
}

/** Seeds and tests: an existing data folder, unlocked. */
export async function openVaultedDatabase(dataDir, password, opts = {}) {
  const vault = new Vault(vaultPath(dataDir), opts)
  await vault.unlock(password)
  const { db, migration } = openUnlockedDatabase(vault, dataDir)
  return { vault, db, migration }
}
