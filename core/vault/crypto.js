// SPDX-License-Identifier: GPL-3.0-or-later
// Primitives of the vault: scrypt key derivation and AES-256-GCM, Node built-ins only.
import crypto from 'node:crypto'

export const KDF_NAME = 'scrypt'
// N = 2^17, r = 8 needs 128 * N * r = 128 MiB; maxmem leaves room for it.
export const DEFAULT_KDF_PARAMS = Object.freeze({ N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })
export const KEY_BYTES = 32
export const SALT_BYTES = 16
export const NONCE_BYTES = 12

// Same characters typed on another machine may arrive in another Unicode form (e.g. "ő" as o + accent).
export function normalizePassword(password) {
  return String(password).normalize('NFC')
}

export function deriveKey(password, salt, params) {
  const { N, r, p, maxmem } = params
  return new Promise((resolve, reject) => {
    crypto.scrypt(normalizePassword(password), salt, KEY_BYTES, { N, r, p, maxmem }, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

export function randomBytes(n) {
  return crypto.randomBytes(n)
}

/** AES-256-GCM. aad binds the ciphertext to its context (it is authenticated, not encrypted). */
export function seal(key, plaintext, aad) {
  const nonce = crypto.randomBytes(NONCE_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { nonce, ciphertext, tag: cipher.getAuthTag() }
}

/** Throws when the key, the aad, the nonce, the tag or a single ciphertext byte is wrong. */
export function open(key, { nonce, ciphertext, tag }, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  const head = decipher.update(ciphertext)
  try {
    return Buffer.concat([head, decipher.final()])
  } finally {
    head.fill(0) // the DEK passes through here; the result is the caller's to wipe
  }
}
