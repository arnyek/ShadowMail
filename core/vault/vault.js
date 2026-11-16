// SPDX-License-Identifier: GPL-3.0-or-later
// The vault: a master password protects the whole data folder, and the protection
// travels with it (no machine binding, unlike DPAPI).
//
//   KEK = scrypt(master password, salt)          derived on every unlock, never stored
//   DEK = 32 random bytes                        sealed under the KEK in data\vault.json (vault-file.js)
//   database key = HKDF(DEK, "shadowmail/db/v1") the encrypted mail.sqlite opens with it (keys.js)
//   account secret = AES-256-GCM under the DEK, aad "<account_id>|<kind>", inside the encrypted database
//
// The DEK lives only in this object (main process memory). Nothing here returns it; subkey() returns a
// derived key for the main process (the database), and the IPC layer exposes no call that would hand a
// key or a decrypted password to the renderer. Changing the master password re-seals the same DEK:
// the database, the mail files and the account secrets do not change.
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_KDF_PARAMS, KEY_BYTES, normalizePassword, open, randomBytes, seal } from './crypto.js'
import { VaultError, VaultFile, checkedKdfParams } from './vault-file.js'
import { DB_KEY_LABEL, deriveSubkey } from './keys.js'
import { generateRecoveryCode, normalizeRecoveryCode, normalizeRecoveryGroup } from './recovery-code.js'
import { resetDataFolder, settleReset, pendingResets, discardPendingResets } from './reset.js'

export { VaultError, checkedKdfParams }
export const MIN_PASSWORD_CHARS = 10
export const MAX_PASSWORD_CHARS = 1024
export const WRONG_PASSWORD_DELAY_MS = 1000
export const SECRET_KINDS = Object.freeze(['incoming', 'smtp'])
const secretAad = (accountId, kind) => `${accountId}|${kind}`

/** Throws VaultError(bad_password | password_too_short | password_too_long). Counts characters, not bytes. */
export function checkNewPassword(password) {
  if (typeof password !== 'string') throw new VaultError('bad_password')
  const chars = [...normalizePassword(password)].length
  if (chars < MIN_PASSWORD_CHARS) throw new VaultError('password_too_short')
  if (chars > MAX_PASSWORD_CHARS) throw new VaultError('password_too_long')
}

function checkGivenPassword(password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 4 * MAX_PASSWORD_CHARS) {
    throw new VaultError('bad_password')
  }
}

/** Deletes <db file>.bak-* (core/db/migrate.js backupPath) next to a file database. Returns how many went. */
export function removeMigrationBackups(dbFile) {
  if (!dbFile || dbFile === ':memory:' || !path.isAbsolute(path.resolve(dbFile))) return 0
  const dir = path.dirname(path.resolve(dbFile))
  const prefix = `${path.basename(dbFile)}.bak-`
  let n = 0
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    fs.rmSync(path.join(dir, name), { force: true })
    n++
  }
  return n
}

export class Vault {
  #dek = null
  #listeners = new Set()
  #busy = false
  #pendingCode = null // the code last handed out, until its screen confirms it; never stored

  /**
   * @param file path of data\vault.json
   * @param opts.kdfParams scrypt parameters for NEW vaults / password changes (tests use a cheaper N)
   * @param opts.failDelayMs pause after a wrong password (plan: 1 s)
   * @param opts.hooks passed to VaultFile (tests: a forced failure while writing)
   */
  constructor(file, { kdfParams = DEFAULT_KDF_PARAMS, failDelayMs = WRONG_PASSWORD_DELAY_MS, now = () => Date.now(), hooks = {}, resetHooks = {}, log = () => {} } = {}) {
    this.file = new VaultFile(file, { kdfParams, failDelayMs, now, hooks })
    this.resetHooks = resetHooks // tests: a forced failure after a reset step (reset.js)
    this.now = now
    this.log = log
    this.db = null // the opened mail database, attached by the caller after unlock (account secrets live there)
  }

  exists() {
    return this.file.exists()
  }

  isUnlocked() {
    return this.#dek !== null
  }

  status() {
    // recoveryConfirmed: false -> the page shows the "make a new recovery code" bar
    // resetPending: a reset folder is left that the start could not settle (the lock screen offers the way out)
    return {
      exists: this.exists(),
      unlocked: this.isUnlocked(),
      recoveryConfirmed: this.isUnlocked() ? this.file.recoveryConfirmed() : null,
      resetPending: !this.isUnlocked() && pendingResets(path.dirname(this.file.file)).length > 0,
      // a vault.json of an older or newer version: the lock screen explains instead of asking the password
      vaultProblem: !this.isUnlocked() && this.exists() ? this.file.versionProblem() : null,
    }
  }

  /** The opened (encrypted) mail database: the account secrets are read from and written to it. */
  attach(db) {
    this.db = db
  }

  // An interrupted reset is settled before the vault does anything; one that cannot be settled stops it,
  // so no unlock or recovery can build on a half state
  #settleReset() {
    this.#refuseNewer()
    const dataDir = path.dirname(this.file.file)
    if (!pendingResets(dataDir).length) return
    if (settleReset(dataDir, this.log) > 0) throw new VaultError('reset_pending')
  }

  // a newer version's data folder is not touched at all: no settle, no reset, no write
  #refuseNewer() {
    if (this.exists() && this.file.versionProblem() === 'vault_newer_version') throw new VaultError('vault_newer_version')
  }

  #issue(code) {
    this.#pendingCode = code
    return { code }
  }

  // One key derivation at a time: scrypt is deliberately expensive.
  async #exclusive(fn) {
    if (this.#busy) throw new VaultError('busy')
    this.#busy = true
    try {
      return await fn()
    } finally {
      this.#busy = false
    }
  }

  /** First start: writes vault.json and leaves the vault unlocked. -> { code } the recovery code, shown once */
  create(password) {
    checkNewPassword(password)
    return this.#exclusive(async () => {
      if (this.exists()) throw new VaultError('vault_exists')
      const dek = randomBytes(KEY_BYTES)
      const code = generateRecoveryCode()
      try {
        await this.file.create(password, dek, code)
      } catch (err) {
        dek.fill(0)
        throw err
      }
      this.#setDek(dek)
      return this.#issue(code)
    })
  }

  /**
   * Forgotten master password WITH the recovery code: the DEK from the recovery slot, the
   * password slot under the new password; nothing is lost. The used code stops working: a new one comes.
   * Only from the lock screen. -> { code }
   */
  recover(code, newPassword) {
    checkNewPassword(newPassword)
    return this.#exclusive(async () => {
      if (!this.exists()) throw new VaultError('no_vault')
      if (this.isUnlocked()) throw new VaultError('unlocked')
      this.#settleReset()
      const dek = await this.file.openDekWithRecovery(code)
      const next = generateRecoveryCode()
      try {
        await this.file.rewrite(dek, { password: newPassword, code: next })
      } catch (err) {
        dek.fill(0)
        throw err
      }
      this.#setDek(dek)
      return this.#issue(next)
    })
  }

  /** Settings, "Új helyreállító kód": the master password is asked again; the old code stops working. -> { code } */
  newRecoveryCode(password) {
    checkGivenPassword(password)
    return this.#exclusive(async () => {
      this.#requireDek()
      const dek = await this.file.openDek(password)
      try {
        const code = generateRecoveryCode()
        await this.file.rewrite(dek, { code })
        return this.#issue(code)
      } finally {
        dek.fill(0)
      }
    })
  }

  /**
   * The code screen's check: group n (1..5) of the code just handed out, typed back. Checked here, in the
   * main process; then the bar about an unconfirmed code goes.
   */
  confirmRecovery(n, typed) {
    return this.#exclusive(async () => {
      const dek = this.#requireDek()
      const code = this.#pendingCode && normalizeRecoveryCode(this.#pendingCode)
      if (!code) throw new VaultError('no_pending_code')
      const want = Number.isInteger(n) && n >= 1 && n <= 5 ? code.slice((n - 1) * 5, n * 5) : null
      if (!want || normalizeRecoveryGroup(typed) !== want) throw new VaultError('wrong_group')
      await this.file.rewrite(dek, { confirmed: true })
      this.#pendingCode = null
    })
  }

  /** Whether this code is the one just handed out (saving it to a file is allowed only for that one). */
  isPendingCode(code) {
    return Boolean(this.#pendingCode) && normalizeRecoveryCode(code) === normalizeRecoveryCode(this.#pendingCode)
  }

  unlock(password) {
    checkGivenPassword(password)
    return this.#exclusive(async () => {
      if (!this.exists()) throw new VaultError('no_vault')
      this.#settleReset()
      this.#setDek(await this.file.openDek(password))
    })
  }

  /** Wipes the key; the onLock listeners close the database and stop what used it. */
  lock() {
    if (this.#dek) this.#dek.fill(0)
    this.#dek = null
    this.#pendingCode = null
    for (const fn of this.#listeners) {
      try {
        fn()
      } catch {
        // a failing listener must not keep the key in memory or stop the others
      }
    }
    this.db = null
  }

  /** Called on lock (e.g. to stop the sync and close the database). Returns an unsubscribe function. */
  onLock(fn) {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  /** Re-seals the same DEK under the new password: only vault.json changes. */
  change(oldPassword, newPassword) {
    checkGivenPassword(oldPassword)
    checkNewPassword(newPassword)
    return this.#exclusive(() => this.file.change(oldPassword, newPassword))
  }

  /**
   * Forgotten master password WITHOUT the recovery code: a full reset of the data folder
   * (reset.js). Only from the lock screen (the database is closed). Leaves the vault unlocked with the
   * new password and an empty database. -> { code } the new recovery code
   */
  async reset(newPassword) {
    checkNewPassword(newPassword)
    return this.#exclusive(async () => {
      if (!this.exists()) throw new VaultError('no_vault')
      if (this.isUnlocked()) throw new VaultError('unlocked')
      this.#settleReset()
      const { dek, code } = await resetDataFolder({
        dataDir: path.dirname(this.file.file),
        vaultFile: this.file,
        password: newPassword,
        now: this.now,
        hooks: this.resetHooks,
        log: this.log,
      })
      this.#setDek(dek)
      return this.#issue(code)
    })
  }

  /**
   * Finishes an interrupted reset that cannot be decided ('reset_pending'): only in that state, from the
   * lock screen. The leftover reset folders go, then a plain reset (b) runs. -> { code } the new recovery code
   */
  async finishReset(newPassword) {
    checkNewPassword(newPassword)
    return this.#exclusive(async () => {
      if (!this.exists()) throw new VaultError('no_vault')
      if (this.isUnlocked()) throw new VaultError('unlocked')
      this.#refuseNewer()
      const dataDir = path.dirname(this.file.file)
      if (!pendingResets(dataDir).length || settleReset(dataDir, this.log) === 0) throw new VaultError('not_available')
      discardPendingResets(dataDir, this.log)
      const { dek, code } = await resetDataFolder({
        dataDir,
        vaultFile: this.file,
        password: newPassword,
        now: this.now,
        hooks: this.resetHooks,
        log: this.log,
      })
      this.#setDek(dek)
      return this.#issue(code)
    })
  }

  /** A key derived from the DEK for one use (keys.js labels); never the DEK itself. */
  subkey(label) {
    return deriveSubkey(this.#requireDek(), label)
  }

  databaseKey() {
    return this.subkey(DB_KEY_LABEL)
  }

  #setDek(dek) {
    if (this.#dek) this.#dek.fill(0)
    this.#dek = dek
  }

  #requireDek() {
    if (!this.#dek) throw new VaultError('locked')
    return this.#dek
  }

  #requireDb() {
    if (!this.db) throw new VaultError('locked')
    return this.db
  }

  static #checkSecretTarget(accountId, kind) {
    if (!Number.isInteger(accountId) || accountId < 1) throw new VaultError('bad_account')
    if (!SECRET_KINDS.includes(kind)) throw new VaultError('bad_secret_kind')
  }

  setSecret(accountId, kind, plaintext) {
    Vault.#checkSecretTarget(accountId, kind)
    if (typeof plaintext !== 'string') throw new VaultError('bad_secret')
    const sealed = seal(this.#requireDek(), Buffer.from(plaintext, 'utf8'), secretAad(accountId, kind))
    this.#requireDb()
      .prepare(`INSERT INTO account_secrets (account_id, kind, nonce, ciphertext, tag) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (account_id, kind) DO UPDATE SET nonce = excluded.nonce, ciphertext = excluded.ciphertext, tag = excluded.tag`)
      .run(accountId, kind, sealed.nonce, sealed.ciphertext, sealed.tag)
  }

  /** The decrypted secret for the main process (e.g. the IMAP login), or null when none is stored. */
  getSecret(accountId, kind) {
    Vault.#checkSecretTarget(accountId, kind)
    const dek = this.#requireDek()
    const row = this.#requireDb().prepare('SELECT nonce, ciphertext, tag FROM account_secrets WHERE account_id = ? AND kind = ?').get(accountId, kind)
    if (!row) return null
    try {
      return open(dek, row, secretAad(accountId, kind)).toString('utf8')
    } catch {
      throw new VaultError('secret_corrupt')
    }
  }

  hasSecret(accountId, kind) {
    Vault.#checkSecretTarget(accountId, kind)
    return Boolean(this.#requireDb().prepare('SELECT 1 FROM account_secrets WHERE account_id = ? AND kind = ?').get(accountId, kind))
  }

  deleteSecret(accountId, kind) {
    Vault.#checkSecretTarget(accountId, kind)
    this.#requireDb().prepare('DELETE FROM account_secrets WHERE account_id = ? AND kind = ?').run(accountId, kind)
  }
}
