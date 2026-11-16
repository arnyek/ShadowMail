// SPDX-License-Identifier: GPL-3.0-or-later
// data\vault.json: the DEK sealed under the master password and under the recovery
// code, OUTSIDE the database, because the database can only be opened with a key derived from the DEK.
//
//   { format: 'shadowmail-vault', version: 2, created_at, changed_at,
//     password: { kdf: 'scrypt', kdfParams, salt, nonce, ciphertext, tag },               (base64)
//     recovery: { kdf: 'scrypt', kdfParams, salt, nonce, ciphertext, tag, confirmed },
//     mac }
//
// Each slot seals the same DEK with AES-256-GCM under KEK = scrypt(secret, salt), AAD
// "shadowmail/vault/dek/v1|password" or "...|recovery"; the recovery secret is the normalized code
// (recovery-code.js). A wrong password or code is a GCM tag failure. mac = HMAC-SHA256 under
// HKDF(DEK, "shadowmail/vault-meta/v1") over every other field: "confirmed" or the
// dates cannot be changed unnoticed. The file is written atomically (temporary file, fsync, rename); a
// damaged or incomplete file is "vault_corrupt" and nothing is written.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DEFAULT_KDF_PARAMS, KDF_NAME, KEY_BYTES, NONCE_BYTES, SALT_BYTES, deriveKey, open, randomBytes, seal } from './crypto.js'
import { deriveSubkey } from './keys.js'
import { normalizeRecoveryCode } from './recovery-code.js'

export const VAULT_FORMAT = 'shadowmail-vault'
export const VAULT_VERSION = 2
const AAD = { password: 'shadowmail/vault/dek/v1|password', recovery: 'shadowmail/vault/dek/v1|recovery' }
const META_KEY_LABEL = 'shadowmail/vault-meta/v1'
const TAG_BYTES = 16
const MAC_BYTES = 32
const MAX_FILE_BYTES = 64 * 1024

export class VaultError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The parameters come from the data file: a tampered file must not make unlock hang or eat all memory.
// Allowed: N a power of two 2^12..2^20, r 1..32, p 1..4, maxmem up to 1 GiB.
export function checkedKdfParams(p) {
  const pow2 = n => Number.isInteger(n) && n >= 2 ** 12 && n <= 2 ** 20 && (n & (n - 1)) === 0
  const ok = p && typeof p === 'object' && pow2(p.N) && Number.isInteger(p.r) && p.r >= 1 && p.r <= 32 && Number.isInteger(p.p) && p.p >= 1 && p.p <= 4 &&
    Number.isInteger(p.maxmem) && p.maxmem > 0 && p.maxmem <= 1024 ** 3 &&
    // scrypt needs 128 * N * r bytes: more than maxmem would fail inside Node as an internal error
    128 * p.N * p.r <= p.maxmem
  if (!ok) throw new VaultError('unsupported_kdf')
  return { N: p.N, r: p.r, p: p.p, maxmem: p.maxmem }
}

// base64 of exactly n bytes, or vault_corrupt
function bytes(v, n) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) throw new VaultError('vault_corrupt')
  const b = Buffer.from(v, 'base64')
  if (b.length !== n) throw new VaultError('vault_corrupt')
  return b
}

const b64 = b => Buffer.from(b).toString('base64')

function checkedSlot(raw) {
  if (!raw || typeof raw !== 'object') throw new VaultError('vault_corrupt')
  if (raw.kdf !== KDF_NAME) throw new VaultError('unsupported_kdf')
  return {
    kdfParams: checkedKdfParams(raw.kdfParams),
    salt: bytes(raw.salt, SALT_BYTES),
    nonce: bytes(raw.nonce, NONCE_BYTES),
    ciphertext: bytes(raw.ciphertext, KEY_BYTES),
    tag: bytes(raw.tag, TAG_BYTES),
  }
}

// every field but the mac, in a fixed order: what the mac covers
function metaBytes(v) {
  const slot = s => s && { kdf: s.kdf, kdfParams: s.kdfParams && { N: s.kdfParams.N, r: s.kdfParams.r, p: s.kdfParams.p, maxmem: s.kdfParams.maxmem }, salt: s.salt, nonce: s.nonce, ciphertext: s.ciphertext, tag: s.tag }
  const recovery = v.recovery ? { ...slot(v.recovery), confirmed: v.recovery.confirmed === true } : null
  return Buffer.from(JSON.stringify({ format: v.format, version: v.version, created_at: v.created_at ?? null, changed_at: v.changed_at ?? null, password: slot(v.password), recovery }), 'utf8')
}

function macOf(dek, v) {
  const key = deriveSubkey(dek, META_KEY_LABEL)
  try {
    return crypto.createHmac('sha256', key).update(metaBytes(v)).digest()
  } finally {
    key.fill(0)
  }
}

export class VaultFile {
  /**
   * @param file      path of vault.json
   * @param kdfParams scrypt parameters for NEW slots (tests use a cheaper N)
   * @param failDelayMs pause after a wrong password or code (plan: 1 s)
   * @param hooks.beforeRename (tmpFile) => void, called between the fsync and the rename (tests: a forced failure)
   */
  constructor(file, { kdfParams = DEFAULT_KDF_PARAMS, failDelayMs = 1000, now = () => Date.now(), hooks = {} } = {}) {
    this.file = file
    this.kdfParams = kdfParams
    this.failDelayMs = failDelayMs
    this.now = now
    this.hooks = hooks
  }

  exists() {
    return fs.existsSync(this.file)
  }

  /** The raw, structurally checked file. Throws no_vault or vault_corrupt; never writes. */
  #readRaw() {
    let raw
    try {
      const st = fs.statSync(this.file)
      if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new VaultError('vault_corrupt')
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (err) {
      if (err instanceof VaultError) throw err
      if (err && err.code === 'ENOENT') throw new VaultError('no_vault')
      throw err
    }
    let v
    try {
      v = JSON.parse(raw)
    } catch {
      throw new VaultError('vault_corrupt')
    }
    // our format with another integer version: an honest error, not "damaged"; no conversion
    if (v && typeof v === 'object' && v.format === VAULT_FORMAT && Number.isInteger(v.version) && v.version !== VAULT_VERSION)
      throw new VaultError(v.version < VAULT_VERSION ? 'vault_old_version' : 'vault_newer_version')
    if (!v || typeof v !== 'object' || v.format !== VAULT_FORMAT || v.version !== VAULT_VERSION) throw new VaultError('vault_corrupt')
    checkedSlot(v.password)
    if (v.recovery !== null) {
      checkedSlot(v.recovery)
      if (typeof v.recovery.confirmed !== 'boolean') throw new VaultError('vault_corrupt')
    }
    bytes(v.mac, MAC_BYTES)
    return v
  }

  /** The checked file (slots as Buffers). */
  read() {
    const v = this.#readRaw()
    return { raw: v, password: checkedSlot(v.password), recovery: v.recovery ? { ...checkedSlot(v.recovery), confirmed: v.recovery.confirmed } : null }
  }

  /** 'vault_old_version' | 'vault_newer_version' for a vault.json of another version, else null. Never throws, never writes. */
  versionProblem() {
    try {
      this.#readRaw()
      return null
    } catch (err) {
      return err instanceof VaultError && (err.code === 'vault_old_version' || err.code === 'vault_newer_version') ? err.code : null
    }
  }

  /** Whether the recovery code was confirmed on the code screen (false also for no slot). Never throws. */
  recoveryConfirmed() {
    try {
      const v = this.#readRaw()
      return Boolean(v.recovery && v.recovery.confirmed)
    } catch {
      return false
    }
  }

  async #slot(secret, dek, aad) {
    const salt = randomBytes(SALT_BYTES)
    const kek = await deriveKey(secret, salt, this.kdfParams)
    try {
      const s = seal(kek, dek, aad)
      return { kdf: KDF_NAME, kdfParams: { ...this.kdfParams }, salt: b64(salt), nonce: b64(s.nonce), ciphertext: b64(s.ciphertext), tag: b64(s.tag) }
    } finally {
      kek.fill(0)
    }
  }

  // the DEK from one slot; the mac checked with it. Wrong secret: errorCode after the delay.
  async #openSlot(secret, which, errorCode) {
    const v = this.read()
    const slot = v[which]
    if (!slot) throw new VaultError(errorCode)
    const kek = await deriveKey(secret, slot.salt, slot.kdfParams)
    let dek
    try {
      dek = open(kek, slot, AAD[which])
    } catch {
      await sleep(this.failDelayMs)
      throw new VaultError(errorCode)
    } finally {
      kek.fill(0)
    }
    if (!crypto.timingSafeEqual(macOf(dek, v.raw), Buffer.from(v.raw.mac, 'base64'))) {
      dek.fill(0)
      throw new VaultError('vault_corrupt')
    }
    return dek
  }

  #recoverySecret(code) {
    const canon = normalizeRecoveryCode(code)
    if (!canon) throw new VaultError('bad_recovery_code')
    return canon
  }

  /**
   * A new vault.json for this DEK, with the password slot and an unconfirmed recovery slot. replace: the
   * reset's switch (reset.js) writes it over the old one, atomically; otherwise an existing one is kept.
   */
  async create(password, dek, code) {
    if (this.exists()) throw new VaultError('vault_exists')
    this.install(await this.build(password, dek, code), { exclusive: true })
  }

  /**
   * The bytes of a new vault.json for this DEK (password slot, unconfirmed recovery slot, mac), not written.
   * The reset (reset.js) keeps a durable copy of them before it installs them: its positive switch mark.
   */
  async build(password, dek, code) {
    const now = this.now()
    const v = {
      format: VAULT_FORMAT,
      version: VAULT_VERSION,
      created_at: now,
      changed_at: now,
      password: await this.#slot(password, dek, AAD.password),
      recovery: { ...(await this.#slot(this.#recoverySecret(code), dek, AAD.recovery)), confirmed: false },
    }
    return this.#serialize(dek, v)
  }

  /** The DEK with the master password, or wrong_password after the delay. */
  openDek(password) {
    return this.#openSlot(password, 'password', 'wrong_password')
  }

  /** The DEK with the recovery code, or wrong_recovery_code after the delay. */
  openDekWithRecovery(code) {
    let secret
    try {
      secret = this.#recoverySecret(code)
    } catch (err) {
      // a code that cannot be one waits like a wrong one: no shortcut to tell them apart
      return sleep(this.failDelayMs).then(() => Promise.reject(new VaultError('wrong_recovery_code')))
    }
    return this.#openSlot(secret, 'recovery', 'wrong_recovery_code')
  }

  /** Rewrites the slots for this DEK: a new password slot and/or a new (unconfirmed) recovery slot. */
  async rewrite(dek, { password = null, code = null, confirmed = null } = {}) {
    const v = this.#readRaw()
    // what is rewritten must be what this DEK sealed: a tampered field is not carried over
    if (!crypto.timingSafeEqual(macOf(dek, v), Buffer.from(v.mac, 'base64'))) throw new VaultError('vault_corrupt')
    if (password !== null) v.password = await this.#slot(password, dek, AAD.password)
    if (code !== null) v.recovery = { ...(await this.#slot(this.#recoverySecret(code), dek, AAD.recovery)), confirmed: false }
    if (confirmed !== null) {
      if (!v.recovery) throw new VaultError('no_recovery')
      v.recovery.confirmed = confirmed
    }
    v.changed_at = this.now()
    this.install(this.#serialize(dek, v))
  }

  /** Re-seals the DEK under a new password; the recovery slot stays. */
  async change(oldPassword, newPassword) {
    const dek = await this.openDek(oldPassword)
    try {
      await this.rewrite(dek, { password: newPassword })
    } finally {
      dek.fill(0)
    }
  }

  #serialize(dek, v) {
    delete v.mac
    v.mac = b64(macOf(dek, v))
    return Buffer.from(JSON.stringify(v, null, 2), 'utf8')
  }

  // temporary file in the same folder, fsync, rename over the old one, fsync the folder (best effort:
  // Windows cannot open a folder for fsync). A failure before the rename leaves the old file as it was.
  install(bytes, { exclusive = false } = {}) {
    const dir = path.dirname(this.file)
    const tmp = path.join(dir, `.vault.json.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`)
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try {
      try {
        fs.writeSync(fd, bytes)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      if (this.hooks.beforeRename) this.hooks.beforeRename(tmp)
      if (exclusive && fs.existsSync(this.file)) throw new VaultError('vault_exists')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      throw err
    }
    try {
      const dfd = fs.openSync(dir, 'r')
      try {
        fs.fsyncSync(dfd)
      } finally {
        fs.closeSync(dfd)
      }
    } catch {
      // not supported here (Windows)
    }
  }
}
