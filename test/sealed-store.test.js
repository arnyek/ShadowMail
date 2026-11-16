// The sealed mail files: one module for every read and write under data/store.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { tempDir } from './helpers/tmp.js'
import { memoryIndex, addAccount, addMessage } from './helpers/fixtures.js'
import { SealedStore, SEALED_MAGIC, storeRel } from '../core/store/sealed-file.js'
import { MessageReader } from '../app/main/reader.js'
import { searchOldPop3 } from '../core/pop3/local-search.js'
import { hu } from '../app/renderer/i18n/hu.js'

const WORD = 'Zsiraffakutyaszoveg'
const MSGID = '<egyedi-uzenet-azonosito-pecset@example.invalid>'
const eml = Buffer.from(`Message-ID: ${MSGID}\r\nFrom: ${WORD} <${WORD.toLowerCase()}@example.invalid>\r\nSubject: ${WORD} targy\r\n\r\n${WORD} a torzsben, árvíztűrő\r\n`)
const isCorrupt = err => err && err.code === 'store_corrupt'

test('write -> read gives the same bytes; the file holds neither the unique word nor the Message-ID', t => {
  const dir = tempDir(t)
  const store = new SealedStore(dir, crypto.randomBytes(32))
  store.write('1/pop3-abc.eml', eml)
  assert.deepEqual(store.read('1/pop3-abc.eml'), eml)
  const raw = fs.readFileSync(path.join(dir, '1', 'pop3-abc.eml'))
  assert.ok(raw.subarray(0, SEALED_MAGIC.length).equals(SEALED_MAGIC))
  for (const needle of [WORD, WORD.toLowerCase(), MSGID, 'árvíztűrő']) {
    assert.equal(raw.includes(Buffer.from(needle, 'utf8')), false, needle)
    assert.equal(raw.includes(Buffer.from(needle, 'utf16le')), false, `${needle} (utf16)`)
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, '1')), ['pop3-abc.eml'], 'no temporary file left')
})

test('one changed byte, another relative path (AAD) or another key: store_corrupt', async t => {
  const dir = tempDir(t)
  const key = crypto.randomBytes(32)
  const store = new SealedStore(dir, key)
  store.write('1/a.eml', eml)
  const file = path.join(dir, '1', 'a.eml')
  const good = fs.readFileSync(file)
  for (const at of [0, SEALED_MAGIC.length + 3, Math.floor(good.length / 2), good.length - 1]) {
    const bad = Buffer.from(good)
    bad[at] ^= 0x01
    fs.writeFileSync(file, bad)
    assert.throws(() => store.read('1/a.eml'), isCorrupt, `byte ${at}`)
  }
  fs.writeFileSync(file, good.subarray(0, 20))
  assert.throws(() => store.read('1/a.eml'), isCorrupt, 'truncated')
  fs.writeFileSync(file, good)
  // the same bytes under another name: the AAD (the path) does not match
  fs.mkdirSync(path.join(dir, '2'))
  fs.copyFileSync(file, path.join(dir, '2', 'a.eml'))
  assert.throws(() => store.read('2/a.eml'), isCorrupt)
  assert.throws(() => new SealedStore(dir, crypto.randomBytes(32)).read('1/a.eml'), isCorrupt)
  await assert.rejects(new SealedStore(dir, crypto.randomBytes(32)).readAsync('1/a.eml'), isCorrupt)
  assert.deepEqual(store.read('1/a.eml'), eml)
  // a plain (unsealed) .eml of an earlier build is not read as mail either
  fs.writeFileSync(file, eml)
  assert.throws(() => store.read('1/a.eml'), isCorrupt)
})

test('paths: "\\\\" and "/" are the same AAD; ".." and empty paths are refused (an absolute path is read inside the store)', t => {
  const dir = tempDir(t)
  const store = new SealedStore(dir, crypto.randomBytes(32))
  assert.equal(storeRel('1\\a.eml'), '1/a.eml')
  store.write('1\\a.eml', eml)
  assert.deepEqual(store.read('1/a.eml'), eml)
  for (const bad of ['../kivul.eml', '1/../../kivul.eml', '', './']) assert.throws(() => store.file(bad), /bad store path|outside/)
  assert.throws(() => new SealedStore(dir, Buffer.alloc(16)), /32 bytes/)
})

test('a damaged POP3 file: opening it says so in Hungarian, the old-text search counts it skipped and goes on', async t => {
  const dir = tempDir(t)
  const store = new SealedStore(dir, crypto.randomBytes(32))
  const { db, index } = memoryIndex(t)
  const pop = addAccount(db, { type: 'pop3' })
  const rows = []
  for (const [i, rel] of [[1, `${pop.id}/jo.eml`], [2, `${pop.id}/serult.eml`]]) {
    store.write(rel, Buffer.from(`Subject: level ${i}\r\nDate: ${new Date(Date.UTC(2020, 0, 1)).toUTCString()}\r\n\r\ntolgyfa ${i}\r\n`))
    const id = addMessage(index, pop.id, { uid: 100 + i, messageId: `<m${i}@x>`, subject: `level ${i}`, date: Date.UTC(2020, 0, 1), flags: '\\Seen' })
    // a POP3 row: no UID, the UIDL and the stored file
    db.prepare('UPDATE messages SET uid = NULL, pop3_uidl = ?, store_path = ?, body_state = 3 WHERE id = ?').run(`u${i}`, rel, id) // 3: beyond the limit, the old-text search reads its file
    rows.push(id)
  }
  const damaged = path.join(dir, String(pop.id), 'serult.eml')
  const b = fs.readFileSync(damaged)
  b[b.length - 1] ^= 0xff
  fs.writeFileSync(damaged, b)
  const reader = new MessageReader({ index, sealed: store, withConnection: () => assert.fail('no connection for POP3') })
  await assert.rejects(reader.open(rows[1]), err => err.code === 'store_corrupt')
  assert.match(hu.readerErrors.store_corrupt, /sérült/)
  assert.ok((await reader.open(rows[0])).subject.startsWith('level'))
  const res = await searchOldPop3({ db, sealed: store, accountIds: [pop.id], query: 'tolgyfa' })
  assert.equal(res.skipped, 1)
  assert.equal(res.done, res.total)
})

test('close(): the key is wiped, read and write answer "locked"', async t => {
  const dir = tempDir(t)
  const store = new SealedStore(dir, crypto.randomBytes(32))
  store.write('1/a.eml', eml)
  store.close()
  assert.throws(() => store.read('1/a.eml'), err => err.code === 'locked')
  await assert.rejects(store.readAsync('1/a.eml'), err => err.code === 'locked')
  assert.throws(() => store.write('1/b.eml', eml), err => err.code === 'locked')
  assert.deepEqual(fs.readdirSync(path.join(dir, '1')), ['a.eml'], 'no file and no temporary file from the refused write')
})

test('sweep(): leftover temporary files go, a plain .eml of an earlier build is sealed in place', async t => {
  const dir = tempDir(t)
  const store = new SealedStore(dir, crypto.randomBytes(32))
  store.write('1/kesz.eml', eml)
  fs.writeFileSync(path.join(dir, '1', 'felbe.eml.1234.ab12cd34.tmp'), 'SMEML1...')
  fs.writeFileSync(path.join(dir, '1', 'regi.eml'), eml) // plain, as an earlier build wrote it
  const res = await store.sweep()
  assert.deepEqual(res, { removed: 1, sealed: 1 })
  assert.deepEqual(fs.readdirSync(path.join(dir, '1')).sort(), ['kesz.eml', 'regi.eml'])
  assert.deepEqual(store.read('1/regi.eml'), eml, 'readable, and now sealed')
  assert.equal(fs.readFileSync(path.join(dir, '1', 'regi.eml')).includes(Buffer.from(WORD)), false)
  assert.deepEqual(await store.sweep(), { removed: 0, sealed: 0 }, 'nothing left to do')
  store.remove('1/regi.eml')
  store.remove('1/nincs-ilyen.eml')
  assert.deepEqual(fs.readdirSync(path.join(dir, '1')), ['kesz.eml'])
})

test('the vault lock closes a store opened from it, whoever holds it', async t => {
  const { createVaultedDatabase, openSealedStore } = await import('../core/vault/vaulted-db.js')
  const dir = tempDir(t)
  const { db, vault } = await createVaultedDatabase(dir, 'Teszt-jelszo-hosszu-pecset', { kdfParams: { N: 2 ** 12, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, failDelayMs: 0 })
  const store = openSealedStore(vault, dir)
  store.write('1/1.eml', eml)
  db.close()
  vault.lock()
  assert.throws(() => store.read('1/1.eml'), err => err.code === 'locked')
  assert.throws(() => store.write('1/2.eml', eml), err => err.code === 'locked')
})
