// The signature image's IPC: the main process's dialog, the checks, the store, the preview; the replies carry numbers
// for the refusals, and the log carries only the type, the size and the code: never the file's name or path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { tempDir } from './helpers/tmp.js'
import { openMailDatabase } from '../core/db/index.js'
import { AccountStore } from '../core/accounts/model.js'
import { registerAccountIpc, SIGNATURE_READ_MAX } from '../app/main/ipc/accounts.js'
import { addAccount } from './helpers/fixtures.js'

function chunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
function png(w, h, extra = []) {
  const b = Buffer.alloc(13)
  b.writeUInt32BE(w, 0)
  b.writeUInt32BE(h, 4)
  b[8] = 8
  b[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', b), ...extra, chunk('IDAT', zlib.deflateSync(Buffer.alloc(h * (1 + w * 3)))), chunk('IEND')])
}

function setup(t, { dialog: withDialog = true } = {}) {
  const { db } = openMailDatabase(':memory:')
  t.after(() => db.close())
  const store = new AccountStore(db, { hasSecret: () => false })
  const { id } = addAccount(db, { signature: 'Szia' })
  const dir = tempDir(t)
  const handlers = new Map()
  const logs = []
  let nextFile = null
  const dialogCalls = []
  registerAccountIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    store,
    index: null,
    isTrustedSender: () => true,
    log: m => logs.push(m),
    dialog: withDialog ? { showOpenDialog: async (...a) => (dialogCalls.push(a), nextFile ? { canceled: false, filePaths: [nextFile] } : { canceled: true, filePaths: [] }) } : null,
    getWindow: () => null,
    decodeImage: bytes => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }),
  })
  const call = (ch, ...a) => handlers.get(ch)({}, ...a)
  const choose = (name, bytes) => {
    nextFile = path.join(dir, name)
    fs.writeFileSync(nextFile, bytes)
  }
  return { store, id, call, choose, logs, dialogCalls, cancel: () => (nextFile = null), dir }
}

test('a chosen PNG: stored without its metadata, the account says so, the preview is a data: URL of the stored bytes', async t => {
  const s = setup(t)
  s.choose('Kovács logó, privát.png', png(300, 80, [chunk('tEXt', Buffer.from('Author\0Kovacs Anna'))]))
  const res = await s.call('accounts:signatureImagePick', s.id)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(res.image, { type: 'image/png', width: 300, height: 80, bytes: s.store.signatureImage(s.id).bytes.length })
  assert.equal(res.account.has_signature_image, 1)
  assert.ok(!s.store.signatureImage(s.id).bytes.includes('Kovacs Anna'))
  const opts = s.dialogCalls[0].at(-1)
  assert.deepEqual(opts.filters[0].extensions, ['png', 'jpg', 'jpeg'])
  const preview = await s.call('accounts:signatureImage', s.id)
  assert.equal(preview.image.dataUrl, `data:image/png;base64,${s.store.signatureImage(s.id).bytes.toString('base64')}`)
  assert.ok(s.logs.some(l => /signature image stored: image\/png \d+ B, 300x80, 1 metadata/.test(l)), s.logs.join(' | '))
  assert.ok(!s.logs.join('\n').includes('logó') && !s.logs.join('\n').includes(s.dir), 'no file name, no path in the log')
})

test('the refusals carry the numbers; nothing is stored; the log has the code and the size only', async t => {
  const s = setup(t)
  s.choose('nagy.png', png(1920, 1080))
  const big = await s.call('accounts:signatureImagePick', s.id)
  assert.deepEqual({ ...big, bytes: undefined }, { ok: false, error: 'too_large', width: 1920, height: 1080, bytes: undefined, maxWidth: 800, maxHeight: 400, maxBytes: 150 * 1024 })
  s.choose('szoveg.png', Buffer.from('this is text, named .png'))
  assert.deepEqual(await s.call('accounts:signatureImagePick', s.id), { ok: false, error: 'unsupported_image' })
  s.choose('ures.png', Buffer.alloc(0))
  assert.deepEqual(await s.call('accounts:signatureImagePick', s.id), { ok: false, error: 'unsupported_image' })
  // over the read limit: refused by its size, not read
  s.choose('huge.png', Buffer.alloc(0))
  fs.truncateSync(path.join(s.dir, 'huge.png'), SIGNATURE_READ_MAX + 1) // a sparse file: its size, no bytes to read
  const tooBig = await s.call('accounts:signatureImagePick', s.id)
  assert.equal(tooBig.error, 'too_large')
  assert.equal(tooBig.bytes, SIGNATURE_READ_MAX + 1)
  assert.equal(s.store.signatureImage(s.id), null, 'nothing stored')
  assert.ok(s.logs.every(l => !l.includes('.png') && !l.includes(s.dir)), s.logs.join(' | '))
  assert.ok(s.logs.some(l => l.includes('refused, too_large (') && l.includes('1920x1080')))
})

test('cancel, remove, an unknown account, a page without a dialog', async t => {
  const s = setup(t)
  s.cancel()
  assert.deepEqual(await s.call('accounts:signatureImagePick', s.id), { ok: true, canceled: true })
  s.choose('a.png', png(10, 10))
  await s.call('accounts:signatureImagePick', s.id)
  const removed = await s.call('accounts:signatureImageRemove', s.id)
  assert.equal(removed.account.has_signature_image, 0)
  assert.deepEqual(await s.call('accounts:signatureImage', s.id), { ok: true, image: null })
  for (const ch of ['accounts:signatureImagePick', 'accounts:signatureImageRemove', 'accounts:signatureImage']) {
    assert.equal((await s.call(ch, 9999)).error, 'not_found', ch)
    assert.equal((await s.call(ch, 'x')).error, 'not_found', ch)
  }
  const n = setup(t, { dialog: false })
  assert.equal((await n.call('accounts:signatureImagePick', n.id)).error, 'not_available')
})
