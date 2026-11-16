// SPDX-License-Identifier: GPL-3.0-or-later
// Forgotten master password without a recovery code: a full reset. Every local data
// goes (accounts and their passwords, the index, POP3 mail, local folders, local-only drafts and sent
// copies); IMAP mail comes again from the server once the account is added again. Without its key the
// old data cannot be read (crypto-erase), so removing the files is enough.
//
// Safe against an interruption; the switch is the atomic rename of the new vault.json, and it is decided
// by POSITIVE marks, both written durably (fsync) before anything moves:
//   1. data\reset-trash-<t>\new\mail.sqlite: the new, empty database under the new key; the new
//      vault.json's bytes -> vault.json.new, the old one's -> vault.json.old
//   2. the old mail.sqlite*, the migration backups and store\ -> reset-trash-<t>\old\ (renamed)
//   3. the new vault.json installed (THE SWITCH)
//   4. the new database into data\
//   5. reset-trash-<t> removed (a failure there is only a log line)
// settleReset (the same code at start, before any unlock, and right away when a step fails in the running
// process): vault.json == vault.json.new -> switched, the new state is completed; == vault.json.old -> not
// switched, the old data goes back; neither and old\ is empty -> nothing had moved, the folder goes;
// neither and old\ holds data -> nothing is deleted, the folder stays, and the vault refuses to work
// ('reset_pending') until it is settled.
import fs from 'node:fs'
import path from 'node:path'
import { KEY_BYTES, randomBytes } from './crypto.js'
import { DB_KEY_LABEL, deriveSubkey } from './keys.js'
import { generateRecoveryCode } from './recovery-code.js'
import { openMailDatabase } from '../db/index.js'

const TRASH_PREFIX = 'reset-trash-'
const isOldData = name => name === 'store' || name === 'mail.sqlite' || name.startsWith('mail.sqlite-') || name.startsWith('mail.sqlite.bak-')

function fsyncPath(p) {
  try {
    const fd = fs.openSync(p, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // a folder cannot be opened for fsync on Windows
  }
}

function writeDurable(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600)
  try {
    fs.writeSync(fd, bytes)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fsyncPath(path.dirname(file))
}

export const pendingResets = dataDir => {
  try {
    return fs.readdirSync(dataDir).filter(n => n.startsWith(TRASH_PREFIX))
  } catch {
    return []
  }
}

/**
 * @param dataDir    the data folder
 * @param vaultFile  VaultFile of data\vault.json
 * @param password   the new master password (already checked)
 * @param hooks.afterStep (n) => void after steps 1..4 (tests: a forced failure)
 * @returns { dek, code } the new DEK (the caller keeps it, unlocked) and the new recovery code
 */
export async function resetDataFolder({ dataDir, vaultFile, password, now = () => Date.now(), hooks = {}, log = () => {} }) {
  const step = n => hooks.afterStep && hooks.afterStep(n)
  const trash = path.join(dataDir, `${TRASH_PREFIX}${now()}`)
  const dek = randomBytes(KEY_BYTES)
  const code = generateRecoveryCode()
  try {
    fs.mkdirSync(path.join(trash, 'new'), { recursive: true })
    fs.mkdirSync(path.join(trash, 'old'))
    // 1
    const key = deriveSubkey(dek, DB_KEY_LABEL)
    try {
      const { db } = openMailDatabase(path.join(trash, 'new', 'mail.sqlite'), { key })
      db.pragma('wal_checkpoint(TRUNCATE)')
      db.close()
    } finally {
      key.fill(0)
    }
    const fresh = await vaultFile.build(password, dek, code)
    writeDurable(path.join(trash, 'vault.json.new'), fresh)
    writeDurable(path.join(trash, 'vault.json.old'), fs.readFileSync(vaultFile.file))
    step(1)
    // 2
    for (const name of fs.readdirSync(dataDir)) if (isOldData(name)) fs.renameSync(path.join(dataDir, name), path.join(trash, 'old', name))
    fsyncPath(dataDir)
    step(2)
    // 3: the switch
    vaultFile.install(fresh)
    step(3)
    // 4
    for (const name of fs.readdirSync(path.join(trash, 'new'))) fs.renameSync(path.join(trash, 'new', name), path.join(dataDir, name))
    step(4)
  } catch (err) {
    dek.fill(0)
    // right away, in this process: before the switch the old data goes back, after it the new state is
    // completed, so a recovery or an unlock that follows sees one consistent state
    settleReset(dataDir, log)
    throw err
  }
  // 5
  removeTrash(trash, log)
  return { dek, code }
}

function removeTrash(dir, log) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (err) {
    log(`reset: a leftover folder could not be removed (${(err && err.code) || 'error'}); removed at the next start`)
  }
}

const readOrNull = f => {
  try {
    return fs.readFileSync(f)
  } catch {
    return null
  }
}

/**
 * Finishes or undoes interrupted resets (at start after the single-instance lock, before every vault
 * operation, and when a reset step fails). -> the number of reset folders it could NOT settle.
 */
export function settleReset(dataDir, log = () => {}) {
  let unsettled = 0
  for (const name of pendingResets(dataDir)) {
    const trash = path.join(dataDir, name)
    const current = readOrNull(path.join(dataDir, 'vault.json'))
    const marksNew = readOrNull(path.join(trash, 'vault.json.new'))
    const marksOld = readOrNull(path.join(trash, 'vault.json.old'))
    const sub = s => {
      const dir = path.join(trash, s)
      try {
        return fs.readdirSync(dir)
      } catch {
        return []
      }
    }
    try {
      if (current && marksNew && current.equals(marksNew)) {
        // switched: the new, empty database completes it; the old data goes with the folder
        if (!fs.existsSync(path.join(dataDir, 'mail.sqlite'))) for (const n of sub('new')) fs.renameSync(path.join(trash, 'new', n), path.join(dataDir, n))
        log('reset: an interrupted reset was completed')
      } else if (current && marksOld && current.equals(marksOld)) {
        // not switched: the old data goes back where it was
        for (const n of sub('old')) if (!fs.existsSync(path.join(dataDir, n))) fs.renameSync(path.join(trash, 'old', n), path.join(dataDir, n))
        log('reset: an interrupted reset was undone, the old data is back')
      } else if (sub('old').length === 0) {
        // nothing had moved yet (cut in step 1): only the folder goes
      } else {
        log('reset: an interrupted reset cannot be decided; nothing is deleted')
        unsettled++
        continue
      }
    } catch (err) {
      log(`reset: an interrupted reset could not be finished (${(err && err.code) || 'error'})`)
      unsettled++
      continue // the folder stays for the next try: nothing is lost
    }
    removeTrash(trash, log)
  }
  return unsettled
}

/** At start (main.js, after the single-instance lock). */
export const recoverInterruptedReset = settleReset

/**
 * The way out of 'reset_pending'. The interrupted operation was the user's own full reset, so with
 * a new confirmation the leftover reset folders go (old data included); the caller then runs a plain
 * reset, which takes the rest of the old data (mail.sqlite*, .bak-*, store\) the usual way. Throws when
 * a folder cannot be removed: what is left stays pending, and the button stays.
 */
export function discardPendingResets(dataDir, log = () => {}) {
  const names = pendingResets(dataDir)
  for (const name of names) fs.rmSync(path.join(dataDir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  fsyncPath(dataDir)
  log(`reset: ${names.length} undecidable reset folder(s) discarded on the user's request`)
  return names.length
}
