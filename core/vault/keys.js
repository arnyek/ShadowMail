// SPDX-License-Identifier: GPL-3.0-or-later
// Keys derived from the vault's DEK: HKDF-SHA256 with a label per use, so the database key
// and the mail-file key are independent, and neither is the DEK itself.
import crypto from 'node:crypto'

export const DB_KEY_LABEL = 'shadowmail/db/v1'
export const STORE_KEY_LABEL = 'shadowmail/store/v1'

/** A 32-byte key for one use (label) from the 32-byte DEK. */
export function deriveSubkey(dek, label) {
  if (!Buffer.isBuffer(dek) || dek.length !== 32) throw new Error('DEK must be 32 bytes')
  return Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.alloc(0), Buffer.from(label, 'utf8'), 32))
}
