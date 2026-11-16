// SPDX-License-Identifier: GPL-3.0-or-later
// Accounts: validation of the editor's form, storage, and deletion with all data.
// Passwords go to the vault only; nothing here returns one except passwordsFor() (main process use).
import fs from 'node:fs'
import path from 'node:path'
import { VaultError } from '../vault/vault.js'

import { SECURITY, ACCOUNT_TYPES, MAX_INDEX_YEARS, yearsToDays, daysToYears } from './defaults.js'
import { SIGNATURE_LIMITS, SIGNATURE_TYPES } from './signature-image.js'

export { SECURITY, ACCOUNT_TYPES, DEFAULT_INDEX_YEARS, MAX_INDEX_YEARS, defaultPort, newAccountDefaults, yearsToDays, daysToYears } from './defaults.js'

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:.]+\]?$/
const CONTROL_RE = /[\r\n\0]/
const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/

const str = v => (typeof v === 'string' ? v.trim() : v)
const isPort = v => Number.isInteger(v) && v >= 1 && v <= 65535

/**
 * Checks the editor form. Returns { values, errors } where errors maps a field to a code
 * (the UI shows hu.accountErrors[code]). `existing` is the stored row when editing.
 */
export function validateAccount(input, existing = null, { hasIncoming = false, hasSmtp = false } = {}) {
  const errors = {}
  const v = {}
  const req = (field, max) => {
    const value = str(input[field])
    if (typeof value !== 'string' || value === '') errors[field] = 'required'
    else if (value.length > max) errors[field] = 'too_long'
    return value
  }

  v.name = req('name', 100)
  v.email = req('email', 254)
  if (!errors.email && !EMAIL_RE.test(v.email)) errors.email = 'bad_email'
  v.display_name = typeof input.display_name === 'string' && input.display_name.trim() ? input.display_name.trim().slice(0, 100) : null

  v.type = input.type
  if (!ACCOUNT_TYPES.includes(v.type)) errors.type = 'bad_type'
  else if (existing && existing.type !== v.type) errors.type = 'type_locked' // stored messages depend on it

  v.in_host = req('in_host', 253)
  if (!errors.in_host && !HOST_RE.test(v.in_host)) errors.in_host = 'bad_host'
  v.in_security = input.in_security
  if (!SECURITY.includes(v.in_security)) errors.in_security = 'bad_security'
  v.in_port = input.in_port
  if (!isPort(v.in_port)) errors.in_port = 'bad_port'
  v.in_user = req('in_user', 256)
  // no control characters: CR/LF would end an IMAP/POP3/SMTP command and start another
  if (!errors.in_user && CONTROL_RE.test(v.in_user)) errors.in_user = 'bad_chars'

  v.smtp_host = req('smtp_host', 253)
  if (!errors.smtp_host && !HOST_RE.test(v.smtp_host)) errors.smtp_host = 'bad_host'
  v.smtp_security = input.smtp_security
  if (!SECURITY.includes(v.smtp_security)) errors.smtp_security = 'bad_security'
  v.smtp_port = input.smtp_port
  if (!isPort(v.smtp_port)) errors.smtp_port = 'bad_port'
  const smtpUser = str(input.smtp_user)
  v.smtp_user = smtpUser ? smtpUser.slice(0, 256) : null // empty = same as in_user
  if (v.smtp_user && CONTROL_RE.test(v.smtp_user)) errors.smtp_user = 'bad_chars'
  v.smtp_same_password = input.smtp_same_password === false ? 0 : 1
  v.tls_verify = input.tls_verify === false ? 0 : 1

  const years = input.index_years
  if (years === 'all') v.body_index_days = 0
  else if (Number.isInteger(years) && years >= 1 && years <= MAX_INDEX_YEARS) v.body_index_days = yearsToDays(years)
  else errors.index_years = 'bad_index_years'

  v.sync_interval_min = input.sync_interval_min === undefined ? 5 : input.sync_interval_min
  if (!Number.isInteger(v.sync_interval_min) || v.sync_interval_min < 1 || v.sync_interval_min > 1440) errors.sync_interval_min = 'bad_interval'
  v.save_sent_to_server = input.save_sent_to_server === false ? 0 : 1

  const del = input.pop3_delete_after_days
  v.pop3_delete_after_days = del === null || del === undefined || del === '' ? null : del
  if (v.pop3_delete_after_days !== null && (!Number.isInteger(v.pop3_delete_after_days) || v.pop3_delete_after_days < 0 || v.pop3_delete_after_days > 3650)) {
    errors.pop3_delete_after_days = 'bad_days'
  }
  if (v.type !== 'pop3') v.pop3_delete_after_days = null

  v.signature = typeof input.signature === 'string' && input.signature !== '' ? input.signature : null
  if (v.signature && v.signature.length > 10_000) errors.signature = 'too_long'

  // passwords: required when there is none yet; '' / missing on edit = keep the stored one
  const inPw = input.in_password
  if (inPw !== undefined && inPw !== null && inPw !== '' && (typeof inPw !== 'string' || inPw.length > 1024 || CONTROL_RE.test(inPw))) errors.in_password = 'bad_password'
  if (!inPw && !hasIncoming) errors.in_password = 'required'
  const smtpPw = input.smtp_password
  if (!v.smtp_same_password) {
    if (smtpPw !== undefined && smtpPw !== null && smtpPw !== '' && (typeof smtpPw !== 'string' || smtpPw.length > 1024 || CONTROL_RE.test(smtpPw))) errors.smtp_password = 'bad_password'
    if (!smtpPw && !hasSmtp) errors.smtp_password = 'required'
  }
  return { values: v, errors, passwords: { incoming: inPw || null, smtp: v.smtp_same_password ? null : smtpPw || null } }
}

export class AccountError extends Error {
  constructor(code, fields = {}) {
    super(code)
    this.name = 'AccountError'
    this.code = code
    this.fields = fields
  }
}

const COLUMNS = [
  'name', 'email', 'display_name', 'type', 'in_host', 'in_port', 'in_security', 'in_user',
  'smtp_host', 'smtp_port', 'smtp_security', 'smtp_user', 'smtp_same_password', 'tls_verify',
  'body_index_days', 'sync_interval_min', 'save_sent_to_server', 'pop3_delete_after_days', 'signature',
]

export class AccountStore {
  /**
   * @param db     the mail database
   * @param vault  core Vault; saving a password needs it unlocked
   * @param opts.storeDir  data/store: downloaded messages per account, removed with the account
   */
  constructor(db, vault, { storeDir = null, now = () => Date.now() } = {}) {
    this.db = db
    this.vault = vault
    this.storeDir = storeDir
    this.now = now
  }

  // Every column but the signature image's bytes, plus whether there is one: an account row goes to the sync, the
  // composer and (without secrets) the renderer, the image bytes only through signatureImage().
  #columns() {
    if (!this.selectColumns) {
      const names = this.db.prepare("SELECT name FROM pragma_table_info('accounts')").all().map(c => c.name).filter(n => n !== 'signature_image')
      const hasImage = names.includes('signature_image_type') ? ', signature_image IS NOT NULL AS has_signature_image' : ''
      this.selectColumns = `${names.map(n => `"${n}"`).join(', ')}${hasImage}`
    }
    return this.selectColumns
  }

  #row(id) {
    return this.db.prepare(`SELECT ${this.#columns()} FROM accounts WHERE id = ?`).get(id)
  }

  // What the renderer may see: the row without anything secret, plus "is a password stored" flags.
  #public(row) {
    if (!row) return null
    return {
      ...row,
      index_years: daysToYears(row.body_index_days),
      has_incoming_password: this.vault.hasSecret(row.id, 'incoming'),
      has_smtp_password: this.vault.hasSecret(row.id, 'smtp'),
    }
  }

  list() {
    return this.db.prepare(`SELECT ${this.#columns()} FROM accounts ORDER BY sort_order, id`).all().map(r => this.#public(r))
  }

  get(id) {
    if (!Number.isInteger(id)) return null
    return this.#public(this.#row(id))
  }

  getRow(id) {
    return Number.isInteger(id) ? this.#row(id) : null
  }

  /** The account's signature image: { type, bytes } or null (no account, no image). */
  signatureImage(id) {
    if (!Number.isInteger(id)) return null
    const r = this.db.prepare('SELECT signature_image AS bytes, signature_image_type AS type FROM accounts WHERE id = ?').get(id)
    return r && r.bytes && SIGNATURE_TYPES.includes(r.type) ? { type: r.type, bytes: Buffer.from(r.bytes) } : null
  }

  /**
   * Stores an image prepared by prepareSignatureImage (type from its header, metadata removed, within the limits);
   * the limits are checked again here. Throws AccountError('not_found') or AccountError('invalid').
   */
  setSignatureImage(id, { type, bytes }) {
    if (!SIGNATURE_TYPES.includes(type) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > SIGNATURE_LIMITS.maxBytes) throw new AccountError('invalid')
    const res = this.db.prepare('UPDATE accounts SET signature_image = ?, signature_image_type = ? WHERE id = ?').run(bytes, type, id)
    if (!res.changes) throw new AccountError('not_found')
  }

  /** Removes the account's signature image (none: nothing changes). Throws AccountError('not_found'). */
  removeSignatureImage(id) {
    const res = this.db.prepare('UPDATE accounts SET signature_image = NULL, signature_image_type = NULL WHERE id = ?').run(id)
    if (!res.changes) throw new AccountError('not_found')
  }

  /**
   * Creates (no id) or updates (id) an account. Throws AccountError('invalid', fields) or
   * VaultError('locked'). Returns { account, limitChanged }.
   */
  save(input) {
    const id = input.id === undefined || input.id === null ? null : input.id
    const existing = id === null ? null : this.getRow(id)
    if (id !== null && !existing) throw new AccountError('not_found')
    const flags = existing
      ? { hasIncoming: this.vault.hasSecret(id, 'incoming'), hasSmtp: this.vault.hasSecret(id, 'smtp') }
      : {}
    const { values, errors, passwords } = validateAccount(input, existing, flags)
    if (Object.keys(errors).length) throw new AccountError('invalid', errors)
    if (!this.vault.isUnlocked()) throw new VaultError('locked')

    const saved = this.db.transaction(() => {
      let accountId = id
      if (existing) {
        this.db.prepare(`UPDATE accounts SET ${COLUMNS.map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...values, id })
      } else {
        const sort = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM accounts').get().n
        accountId = Number(
          this.db
            .prepare(`INSERT INTO accounts (${COLUMNS.join(', ')}, sort_order, created_at) VALUES (${COLUMNS.map(c => '@' + c).join(', ')}, @sort_order, @created_at)`)
            .run({ ...values, sort_order: sort, created_at: this.now() }).lastInsertRowid,
        )
      }
      if (passwords.incoming) this.vault.setSecret(accountId, 'incoming', passwords.incoming)
      if (values.smtp_same_password) this.vault.deleteSecret(accountId, 'smtp')
      else if (passwords.smtp) this.vault.setSecret(accountId, 'smtp', passwords.smtp)
      return accountId
    })()

    return {
      account: this.get(saved),
      limitChanged: Boolean(existing) && existing.body_index_days !== values.body_index_days,
    }
  }

  /**
   * The accounts' new order (the left sidebar, the composer's From list, the settings list: all read list()). `ids`
   * must be exactly the existing ids, each once; they get sort_order 0..n-1 in one transaction. Throws
   * AccountError('bad_request') for a malformed list, AccountError('order_mismatch') for a missing, foreign or
   * repeated id; then nothing is written.
   */
  reorder(ids) {
    if (!Array.isArray(ids) || !ids.every(id => Number.isInteger(id) && id > 0)) throw new AccountError('bad_request')
    this.reorderTx ??= this.db.transaction(list => {
      const existing = new Set(this.db.prepare('SELECT id FROM accounts').all().map(r => r.id))
      if (list.length !== existing.size || new Set(list).size !== list.length || !list.every(id => existing.has(id))) {
        throw new AccountError('order_mismatch')
      }
      const set = this.db.prepare('UPDATE accounts SET sort_order = ? WHERE id = ?')
      list.forEach((id, i) => set.run(i, id))
    })
    this.reorderTx(ids)
  }

  /** Deletes the account, its folders, messages (and search rows), secrets and downloaded files. */
  remove(id) {
    if (!this.getRow(id)) throw new AccountError('not_found')
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id) // ON DELETE CASCADE + FTS trigger
    if (this.storeDir) {
      const dir = path.join(this.storeDir, String(id)) // id is an integer: no path tricks possible
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Main process only (connection test, sync, send): the decrypted passwords. Needs an unlocked vault. */
  passwordsFor(id) {
    const row = this.getRow(id)
    if (!row) throw new AccountError('not_found')
    const incoming = this.vault.getSecret(id, 'incoming')
    const smtp = row.smtp_same_password ? incoming : this.vault.getSecret(id, 'smtp')
    return { incoming, smtp }
  }
}
