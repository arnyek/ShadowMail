// SPDX-License-Identifier: GPL-3.0-or-later
// The mail files under data\store: every downloaded or saved .eml is sealed.
//
//   file = "SMEML1" | nonce (12) | ciphertext | tag (16)        AES-256-GCM
//   key  = HKDF(DEK, "shadowmail/store/v1")                      (core/vault/keys.js)
//   AAD  = the path relative to data\store, with "/" separators   (so a file cannot be swapped for another)
//
// Every read and write of a store file goes through this module; deleting (rmSync) may stay where it is.
// A store file must not be renamed afterwards (the AAD is its path): a code path that moves one writes it
// again under the new name. A damaged file (header, tag) is "store_corrupt": that message cannot be
// opened, the list and the search go on.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const SEALED_MAGIC = Buffer.from('SMEML1', 'latin1')
const NONCE_BYTES = 12
const TAG_BYTES = 16

export class StoreLockedError extends Error {
  constructor() {
    super('the store is locked')
    this.name = 'StoreLockedError'
    this.code = 'locked'
  }
}

export class StoreCorruptError extends Error {
  constructor(rel) {
    super(`store file damaged: ${rel}`)
    this.name = 'StoreCorruptError'
    this.code = 'store_corrupt'
  }
}

/** The AAD form of a store path: relative, "/" separators, no "." or ".." parts. */
export function storeRel(rel) {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean)
  if (!parts.length || parts.some(p => p === '.' || p === '..')) throw new Error('bad store path')
  return parts.join('/')
}

export class SealedStore {
  #key

  /**
   * @param dir data\store
   * @param key 32 bytes (vault.subkey(STORE_KEY_LABEL)); copied, the caller may wipe its own
   */
  constructor(dir, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('store key must be 32 bytes')
    this.dir = path.resolve(dir)
    this.#key = Buffer.from(key)
  }

  /** Lock and quit: the key is wiped; every later read or write answers 'locked'. */
  close() {
    if (this.#key) this.#key.fill(0)
    this.#key = null
  }

  #requireKey() {
    if (!this.#key) throw new StoreLockedError()
    return this.#key
  }

  /** Removes a store file (a message gone from the server); a missing one is fine. */
  remove(rel) {
    fs.rmSync(this.file(rel), { force: true })
  }

  /**
   * After an unlock, in the background: temporary files of an interrupted write go,
   * and a plain .eml of an earlier (unsealed) development build is sealed in place under its own path. -> { removed, sealed }
   */
  async sweep() {
    const out = { removed: 0, sealed: 0 }
    let names = []
    try {
      names = await fs.promises.readdir(this.dir, { recursive: true })
    } catch {
      return out
    }
    for (const name of names) {
      const rel = storeRel(name)
      const file = path.join(this.dir, name)
      try {
        if (/\.\d+\.[0-9a-f]+\.tmp$/.test(name)) {
          await fs.promises.rm(file, { force: true })
          out.removed++
        } else if (name.endsWith('.eml')) {
          const fd = await fs.promises.open(file, 'r')
          let head
          try {
            head = Buffer.alloc(SEALED_MAGIC.length)
            head = head.subarray(0, (await fd.read(head, 0, head.length, 0)).bytesRead)
          } finally {
            await fd.close()
          }
          if (!head.equals(SEALED_MAGIC)) {
            this.write(rel, await fs.promises.readFile(file))
            out.sealed++
          }
        }
      } catch {
        // a folder, a file another program holds, or the lock came meanwhile: the next unlock tries again
      }
    }
    return out
  }

  /** The absolute path of a store file; a path outside the store folder is refused. */
  file(rel) {
    const r = storeRel(rel)
    const file = path.resolve(this.dir, ...r.split('/'))
    if (!file.startsWith(this.dir + path.sep)) throw new Error('outside the store')
    return file
  }

  seal(rel, plain) {
    const nonce = crypto.randomBytes(NONCE_BYTES)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.#requireKey(), nonce)
    cipher.setAAD(Buffer.from(storeRel(rel), 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
    return Buffer.concat([SEALED_MAGIC, nonce, ciphertext, cipher.getAuthTag()])
  }

  open(rel, sealed) {
    const min = SEALED_MAGIC.length + NONCE_BYTES + TAG_BYTES
    if (!Buffer.isBuffer(sealed) || sealed.length < min || !sealed.subarray(0, SEALED_MAGIC.length).equals(SEALED_MAGIC)) throw new StoreCorruptError(rel)
    const nonce = sealed.subarray(SEALED_MAGIC.length, SEALED_MAGIC.length + NONCE_BYTES)
    const tag = sealed.subarray(sealed.length - TAG_BYTES)
    const ciphertext = sealed.subarray(SEALED_MAGIC.length + NONCE_BYTES, sealed.length - TAG_BYTES)
    const key = this.#requireKey() // locked: 'locked', not a damaged file
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAAD(Buffer.from(storeRel(rel), 'utf8'))
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()])
    } catch {
      throw new StoreCorruptError(rel)
    }
  }

  /** Writes the sealed file atomically: temporary file, fsync, rename, folder fsync (best effort on Windows). */
  write(rel, plain) {
    const file = this.file(rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    const fd = fs.openSync(tmp, 'w')
    try {
      try {
        fs.writeSync(fd, this.seal(rel, plain))
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, file)
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      throw err
    }
    try {
      const dfd = fs.openSync(path.dirname(file), 'r')
      try {
        fs.fsyncSync(dfd)
      } finally {
        fs.closeSync(dfd)
      }
    } catch {
      // a folder cannot be opened for fsync on Windows
    }
  }

  /** The plain bytes; ENOENT as from fs, store_corrupt for a damaged file. */
  read(rel) {
    return this.open(rel, fs.readFileSync(this.file(rel)))
  }

  async readAsync(rel) {
    return this.open(rel, await fs.promises.readFile(this.file(rel)))
  }
}
