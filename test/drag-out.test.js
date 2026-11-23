// SPDX-License-Identifier: GPL-3.0-or-later
// Messages dragged out of the list as .eml files, the main process's side: the file names, the files byte for byte
// = MessageReader.source (without \Seen on the server), the limits, the wait for a message that is not stored here yet,
// the Mark-of-the-Web and its fallback folder, the 10-minute removal, the lock, the drop of our own files back on a
// folder, the log (counts, never a subject or a file name), and the IPC's checks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager, ActionError } from '../app/main/sync-manager.js'
import { sourceFileName } from '../core/mime/raw-view.js'
import { safeFileName } from '../core/mime/message.js'
import { MessageReader } from '../app/main/reader.js'
import { createDragOut, DragError, uniqueNames, envelopeBitmap, DRAG_MAX_FILES, DRAG_MAX_BYTES, DRAG_FETCH_MS, DRAG_KEEP_MS } from '../app/main/drag-out.js'
import { registerDragOutIpc, DRAG_OUT_CHANNELS } from '../app/main/ipc/drag-out.js'
import { emptyTmpDir } from '../app/main/ipc/reader.js'
import { DRAG_OUT_MAX, DRAG_OUT_MAX_BYTES } from '../app/renderer/src/drag-out.js'

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 3000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const plain = (n, extra = {}) => ({ from: `k${n}@example.invalid`, to: 'en@example.invalid', subject: `Levél ${n}`, messageId: `<m${n}@x>`, date: NOW - DAY, body: `Szöveg ${n}`, ...extra })

// a manual clock: setTimer / clearTimer record, fire(t) runs one
function clock() {
  const timers = new Set()
  return {
    timers,
    setTimer: (fn, ms) => {
      const t = { fn, ms }
      timers.add(t)
      return t
    },
    clearTimer: t => timers.delete(t),
    fire: t => {
      timers.delete(t)
      t.fn()
    },
    keepTimers: () => [...timers].filter(t => t.ms === DRAG_KEEP_MS),
  }
}

async function setup(t, { delayMs = 0 } = {}) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db)
  const server = new FakeImapServer().addMailbox('INBOX')
  const store = { list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) }
  const manager = new SyncManager({ store, index, notify: () => {}, connect: () => server.connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  const dir = tempDir(t)
  const delay = { ms: delayMs }
  const reader = new MessageReader({
    index,
    sealed: sealedStore(path.join(dir, 'store')),
    withConnection: async (id, fn) => {
      if (delay.ms) await sleep(delay.ms)
      return manager.withConnection(id, fn)
    },
    onChange: c => manager.notifyChange(c),
  })
  const sync = async () => {
    manager.startAll()
    await until(() => manager.entries.get(row.id).idle.connected)
  }
  const byUid = uid => index.getByUid(row.id, 'INBOX', uid)
  const tmpDir = path.join(dir, 'tmp')
  const fallbackDir = path.join(dir, 'fallback')
  fs.mkdirSync(tmpDir)
  return { db, index, row, server, reader, sync, byUid, tmpDir, fallbackDir, delay }
}

const drags = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.startsWith('drag-')) : [])
const filesOf = dir => drags(dir).flatMap(d => fs.readdirSync(path.join(dir, d)).map(f => path.join(dir, d, f)))

test('limits and timing: 50 messages, 100 MB, a 2 s wait, 10 minutes; the page shares the 50', () => {
  assert.equal(DRAG_MAX_FILES, 50)
  assert.equal(DRAG_OUT_MAX, DRAG_MAX_FILES, 'the renderer and the main process use the same limit')
  assert.equal(DRAG_MAX_BYTES, 100 * 1024 * 1024)
  assert.equal(DRAG_OUT_MAX_BYTES, DRAG_MAX_BYTES)
  assert.equal(DRAG_FETCH_MS, 2000)
  assert.equal(DRAG_KEEP_MS, 10 * 60 * 1000)
})

test('names: one drag, the same name again (letter case ignored) gets -2, -3; a taken -2 is skipped', () => {
  assert.deepEqual(uniqueNames(['Ajánlat.eml', 'ajánlat.eml', 'AJÁNLAT.eml', 'Más.eml']), ['Ajánlat.eml', 'ajánlat-2.eml', 'AJÁNLAT-3.eml', 'Más.eml'])
  assert.deepEqual(uniqueNames(['a.eml', 'a-2.eml', 'A.eml']), ['a.eml', 'a-2.eml', 'A-3.eml'])
  assert.deepEqual(uniqueNames(['x.eml']), ['x.eml'])
})

test('the drag picture: 32 x 32 BGRA, an envelope of opaque grey and white on a clear ground, no half alpha', () => {
  const px = envelopeBitmap(32)
  assert.equal(px.length, 32 * 32 * 4)
  const alphas = new Set()
  let dark = 0
  let light = 0
  for (let i = 0; i < px.length; i += 4) {
    alphas.add(px[i + 3])
    if (px[i + 3] && px[i] === 0x55) dark++
    if (px[i + 3] && px[i] === 0xff) light++
  }
  assert.deepEqual([...alphas].sort((a, b) => a - b), [0, 255])
  assert.ok(dark > 60 && light > 200, JSON.stringify({ dark, light }))
})

test('prepare: the whole source byte for byte = reader.source, named after the subject, in data/tmp/drag-*, marked; \\Seen untouched; the log has counts only', async t => {
  const s = await setup(t)
  const u1 = s.server.addMessage('INBOX', plain(1, { subject: 'Ajánlat: 2026/11 <végleges>?' }))
  const u2 = s.server.addMessage('INBOX', plain(2, { subject: '' }))
  const u3 = s.server.addMessage('INBOX', plain(3, { subject: `Hosszú ${'tárgy '.repeat(40)}` }))
  const u4 = s.server.addMessage('INBOX', plain(4, { subject: 'Ajánlat: 2026/11 <VÉGLEGES>?' }))
  const u5 = s.server.addMessage('INBOX', plain(5, { subject: 'Rejtett\u200b\u202ejel' }))
  await s.sync()
  const ids = [u1, u2, u3, u4, u5].map(u => s.byUid(u).id)
  const marked = []
  const lines = []
  let word = 'level'
  const out = createDragOut({ reader: s.reader, tmpDir: s.tmpDir, fallbackDir: s.fallbackDir, icon: 'ICON', fallback: () => word, mark: f => marked.push(f), log: l => lines.push(l) })
  const res = await out.prepare(ids)
  assert.equal(res.count, 5)
  assert.match(res.token, /^[0-9a-f]{32}$/)
  const [sub] = drags(s.tmpDir)
  assert.equal(drags(s.tmpDir).length, 1, 'one folder per drag')
  const names = fs.readdirSync(path.join(s.tmpDir, sub))
  // the "Save as .eml" name (sourceFileName: Windows-safe, 100 characters, invisible marks out), plus this drag's -2
  const subjects = [u1, u2, u3, u4, u5].map(u => s.byUid(u).subject)
  const expected = uniqueNames(subjects.map(x => sourceFileName(x, safeFileName, 'level')))
  assert.deepEqual([...names].sort(), [...expected].sort())
  assert.ok(names.includes('level.eml'), names.join(' | '))
  assert.ok(expected[3].endsWith('-2.eml'), 'the same subject in another letter case: -2')
  assert.ok(names.every(n => n.length <= 104 && !/[\u200b<>:"/\\|?*]/.test(n)), names.join(' | '))
  let bytes = 0
  for (const id of ids) {
    const { source } = await s.reader.source(id)
    bytes += source.length
    assert.ok(filesOf(s.tmpDir).some(f => fs.readFileSync(f).equals(source)), `message ${id} byte for byte`)
  }
  assert.equal(res.bytes, bytes)
  assert.deepEqual(marked.sort(), filesOf(s.tmpDir).sort(), 'every file marked')
  for (const u of [u1, u2, u3, u4, u5]) assert.equal(s.server.mailboxes.get('INBOX').messages.get(u).flags.has('\\Seen'), false, 'still unread on the server')
  assert.ok(lines.includes(`drag out: 5 message(s), ${bytes} bytes`), lines.join('\n'))
  const text = lines.join('\n')
  for (const n of names) assert.ok(!text.includes(n.replace(/\.eml$/, '')), 'no file name in the log')
  assert.ok(!/Ajánlat|Levél|Hosszú|Rejtett/.test(text), 'no subject in the log')
  // the fallback word is read at each drag (the language may change)
  word = 'message'
  await out.prepare([ids[1]])
  assert.ok(filesOf(s.tmpDir).some(f => path.basename(f) === 'message.eml'))
})

test('not stored yet: at most the wait, then not_yet; the download goes on and is stored, the next drag is at once', async t => {
  const s = await setup(t)
  const u = s.server.addMessage('INBOX', plain(1))
  await s.sync()
  const id = s.byUid(u).id
  s.delay.ms = 300
  const lines = []
  const out = createDragOut({ reader: s.reader, tmpDir: s.tmpDir, fallbackDir: s.fallbackDir, icon: 'I', fallback: () => 'level', fetchMs: 100, log: l => lines.push(l) })
  const t0 = performance.now()
  await assert.rejects(out.prepare([id]), err => err.code === 'not_yet')
  assert.ok(performance.now() - t0 < 280, 'it does not wait for the download')
  assert.equal(drags(s.tmpDir).length, 0, 'no drag folder')
  assert.equal(out.size(), 0)
  assert.ok(lines.some(l => l === 'drag out failed: not_yet (1 message(s))'), lines.join('\n'))
  await until(() => s.byUid(u).store_path)
  const fulls = () => s.server.fetchLog.filter(f => f.kind === 'full').length
  assert.equal(fulls(), 1)
  const t1 = performance.now()
  const res = await out.prepare([id])
  assert.ok(performance.now() - t1 < 100, 'from the store, without the connection')
  assert.equal(fulls(), 1, 'not downloaded again')
  assert.equal(res.count, 1)
  assert.equal(s.server.mailboxes.get('INBOX').messages.get(u).flags.has('\\Seen'), false)
})

test('a failing source: its code, no folder; a late failure after the wait is no unhandled rejection', async t => {
  const c = clock()
  const reader = {
    source: async id => {
      if (id === 2) throw new ActionError('gone')
      return { row: { subject: 'x' }, source: Buffer.from('x') }
    },
  }
  const dir = tempDir(t)
  const out = createDragOut({ reader, tmpDir: dir, fallbackDir: dir, icon: 'I', fallback: () => 'level', setTimer: c.setTimer, clearTimer: c.clearTimer })
  await assert.rejects(out.prepare([1, 2]), err => err.code === 'gone')
  assert.equal(drags(dir).length, 0)
  let late
  const slow = { source: () => new Promise((_, rej) => (late = () => rej(new Error('late')))) }
  const out2 = createDragOut({ reader: slow, tmpDir: dir, fallbackDir: dir, icon: 'I', fallback: () => 'level', setTimer: c.setTimer, clearTimer: c.clearTimer })
  const p = out2.prepare([1])
  c.fire([...c.timers].find(x => x.ms === DRAG_FETCH_MS))
  await assert.rejects(p, err => err.code === 'not_yet')
  late()
  await sleep(10) // an unhandled rejection would fail the run here
})

test('limits: exactly 100 MB goes, one byte more is too_large with the numbers; nothing written', async t => {
  const big = n => ({ row: { subject: `s${n}` }, source: Buffer.alloc(n) })
  const half = 50 * 1024 * 1024
  const sizes = { 1: half, 2: half, 3: half + 1 }
  const reader = { source: async id => big(sizes[id]) }
  const written = []
  const fsp = { mkdir: async () => {}, writeFile: async f => written.push(f), rm: async () => {} }
  const out = createDragOut({ reader, tmpDir: '/nowhere/tmp', fallbackDir: '/nowhere/fb', icon: 'I', fallback: () => 'level', fsp, mark: () => {} })
  const ok = await out.prepare([1, 2])
  assert.equal(ok.bytes, DRAG_MAX_BYTES)
  assert.equal(written.length, 2)
  written.length = 0
  await assert.rejects(out.prepare([1, 3]), err => err.code === 'too_large' && err.details.bytes === DRAG_MAX_BYTES + 1 && err.details.max === DRAG_MAX_BYTES)
  assert.equal(written.length, 0)
  out.dispose()
})

test('Mark-of-the-Web: not possible in data/tmp -> the system temp fallback; not there either -> motw_failed, nothing left', async t => {
  const dir = tempDir(t)
  const tmpDir = path.join(dir, 'tmp')
  const fallbackDir = path.join(dir, 'fb')
  const reader = { source: async () => ({ row: { subject: 'Tárgy' }, source: Buffer.from('Subject: x\r\n\r\ny\r\n') }) }
  const onlyFallback = f => {
    if (f.startsWith(tmpDir)) throw Object.assign(new Error('not NTFS'), { code: 'ENOTSUP' })
  }
  const out = createDragOut({ reader, tmpDir, fallbackDir, icon: 'I', fallback: () => 'level', mark: onlyFallback })
  const res = await out.prepare([1])
  assert.equal(drags(tmpDir).length, 0, 'the unmarked copy is removed')
  assert.equal(filesOf(fallbackDir).length, 1)
  const calls = []
  const wc = { startDrag: item => calls.push(item) }
  out.start(res.token, wc)
  assert.deepEqual(calls[0].files, filesOf(fallbackDir))
  const never = () => {
    throw new Error('no')
  }
  const out2 = createDragOut({ reader, tmpDir, fallbackDir: path.join(dir, 'fb2'), icon: 'I', fallback: () => 'level', mark: never })
  await assert.rejects(out2.prepare([1]), err => err.code === 'motw_failed')
  assert.equal(drags(tmpDir).length, 0)
  assert.equal(drags(path.join(dir, 'fb2')).length, 0)
  assert.equal(out2.size(), 0)
  out.dispose()
})

test('start: the native drag with the files and the picture; the folder goes 10 minutes after the drag (the timer starts again at the drop)', async t => {
  const dir = tempDir(t)
  const c = clock()
  const reader = { source: async id => ({ row: { subject: `T${id}` }, source: Buffer.from(`m${id}`) }) }
  const out = createDragOut({ reader, tmpDir: dir, fallbackDir: dir, icon: 'ICON', fallback: () => 'level', mark: () => {}, setTimer: c.setTimer, clearTimer: c.clearTimer })
  const res = await out.prepare([4, 5])
  assert.equal(c.keepTimers().length, 1, 'armed at the preparation (a drag that never starts goes the same way)')
  const first = c.keepTimers()[0]
  const calls = []
  out.start(res.token, { startDrag: item => calls.push(item) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].icon, 'ICON')
  assert.deepEqual(calls[0].files.map(f => path.basename(f)), ['T4.eml', 'T5.eml'])
  assert.equal(c.keepTimers().length, 1)
  assert.notEqual(c.keepTimers()[0], first, 'started again after startDrag returned')
  assert.throws(() => out.start('0'.repeat(32), { startDrag: () => {} }), err => err.code === 'not_found')
  // the 10 minutes pass
  c.fire(c.keepTimers()[0])
  await until(() => drags(dir).length === 0)
  assert.equal(out.size(), 0)
  assert.throws(() => out.start(res.token, { startDrag: () => {} }), err => err.code === 'not_found', 'gone with its folder')
})

test('lock: the timers stop (dispose) and emptyTmpDir takes the drag folders', async t => {
  const dir = tempDir(t)
  const c = clock()
  const reader = { source: async () => ({ row: { subject: 'x' }, source: Buffer.from('x') }) }
  const out = createDragOut({ reader, tmpDir: dir, fallbackDir: dir, icon: 'I', fallback: () => 'level', mark: () => {}, setTimer: c.setTimer, clearTimer: c.clearTimer })
  await out.prepare([1])
  await out.prepare([1])
  assert.equal(drags(dir).length, 2)
  assert.equal(c.keepTimers().length, 2)
  out.dispose()
  emptyTmpDir(dir)
  assert.equal(c.keepTimers().length, 0)
  assert.equal(drags(dir).length, 0)
  assert.equal(out.size(), 0)
})

test('the real timer is unref-ed: a waiting drag does not keep the process alive', async t => {
  const dir = tempDir(t)
  let timer = null
  const reader = { source: async () => ({ row: { subject: 'x' }, source: Buffer.from('x') }) }
  const out = createDragOut({ reader, tmpDir: dir, fallbackDir: dir, icon: 'I', fallback: () => 'level', mark: () => {}, setTimer: (fn, ms) => (timer = setTimeout(fn, ms)) })
  await out.prepare([1])
  assert.equal(timer.hasRef(), false)
  out.dispose()
  clearTimeout(timer)
})

test('drop: our own files -> their message ids (also a part of them); a foreign or mixed set, or an unknown token -> not_own', async t => {
  const dir = tempDir(t)
  const reader = { source: async id => ({ row: { subject: `T${id}` }, source: Buffer.from(`m${id}`) }) }
  const out = createDragOut({ reader, tmpDir: dir, fallbackDir: dir, icon: 'I', fallback: () => 'level', mark: () => {}, platform: 'linux' })
  const res = await out.prepare([7, 8, 9])
  const files = []
  out.start(res.token, { startDrag: item => files.push(...item.files) })
  assert.deepEqual(out.drop(res.token, files), { ids: [7, 8, 9] })
  assert.deepEqual(out.drop(res.token, [files[1]]), { ids: [8] })
  assert.deepEqual(out.drop(res.token, [path.join(path.dirname(files[0]), '.', path.basename(files[0]))]), { ids: [7] }, 'the same path written another way')
  const foreign = path.join(dir, 'T7.eml')
  assert.throws(() => out.drop(res.token, [foreign]), err => err.code === 'not_own')
  assert.throws(() => out.drop(res.token, [files[0], foreign]), err => err.code === 'not_own')
  assert.throws(() => out.drop(res.token, []), err => err.code === 'not_own')
  assert.throws(() => out.drop('f'.repeat(32), files), err => err.code === 'not_own')
  // Windows paths ignore letter case
  const win = createDragOut({ reader, tmpDir: dir, fallbackDir: dir, icon: 'I', fallback: () => 'level', mark: () => {}, platform: 'win32' })
  const r2 = await win.prepare([3])
  const f2 = []
  win.start(r2.token, { startDrag: item => f2.push(...item.files) })
  assert.deepEqual(win.drop(r2.token, [f2[0].toUpperCase()]), { ids: [3] })
  assert.throws(() => out.drop(res.token, [files[0].toUpperCase()]), err => err.code === 'not_own', 'elsewhere letter case counts')
  out.dispose()
  win.dispose()
})

test('the list rows say whether the source is stored here and how big it is: a sync row not, an opened one yes', async t => {
  const s = await setup(t)
  const u1 = s.server.addMessage('INBOX', plain(1))
  const u2 = s.server.addMessage('INBOX', plain(2))
  await s.sync()
  const list = () => new Map(s.index.listFolder({ accountId: s.row.id, folder: 'INBOX' }).map(r => [r.id, r]))
  const [r1, r2] = [s.byUid(u1), s.byUid(u2)]
  assert.deepEqual([list().get(r1.id).stored, list().get(r2.id).stored], [0, 0], 'synced only: not stored')
  assert.ok(Number.isInteger(list().get(r1.id).size) && list().get(r1.id).size === s.index.get(r1.id).size, 'the stored size (the server\'s RFC822.SIZE)')
  await s.reader.open(r2.id)
  assert.equal(list().get(r2.id).stored, 1, 'opened: stored')
})

test('fetch: the messages a drag could not take out, downloaded and stored without \\Seen; a failure gives its code', async t => {
  const s = await setup(t)
  const u1 = s.server.addMessage('INBOX', plain(1))
  const u2 = s.server.addMessage('INBOX', plain(2))
  await s.sync()
  const [id1, id2] = [s.byUid(u1).id, s.byUid(u2).id]
  const lines = []
  const out = createDragOut({ reader: s.reader, tmpDir: s.tmpDir, fallbackDir: s.fallbackDir, icon: 'I', fallback: () => 'level', mark: () => {}, log: l => lines.push(l) })
  assert.deepEqual(await out.fetch([id1, id2]), { stored: [id1, id2], error: null })
  assert.ok(s.byUid(u1).store_path && s.byUid(u2).store_path, 'both stored')
  for (const u of [u1, u2]) assert.equal(s.server.mailboxes.get('INBOX').messages.get(u).flags.has('\\Seen'), false)
  assert.equal(drags(s.tmpDir).length, 0, 'no file written by a fetch')
  assert.ok(lines.includes('drag out: 2 of 2 message(s) fetched for the next drag'), lines.join('\n'))
  // the next drag is at once, from the store
  const fulls = s.server.fetchLog.filter(f => f.kind === 'full').length
  await out.prepare([id1, id2])
  assert.equal(s.server.fetchLog.filter(f => f.kind === 'full').length, fulls)
  const bad = createDragOut({ reader: { source: async id => { if (id === 9) throw new ActionError('gone'); return { row: {}, source: Buffer.from('x') } } }, tmpDir: s.tmpDir, fallbackDir: s.tmpDir, icon: 'I', fallback: () => 'level' })
  assert.deepEqual(await bad.fetch([8, 9]), { stored: [8], error: 'gone' })
  out.dispose()
})

test('a subject cut through an emoji at 100 characters: the file as it is on disk dropped back is still ours', async t => {
  const dir = tempDir(t)
  const subject = `${'a'.repeat(99)}\u{1F600} tail`
  const reader = { source: async () => ({ row: { subject }, source: Buffer.from('m') }) }
  const out = createDragOut({ reader, tmpDir: dir, fallbackDir: dir, icon: 'I', fallback: () => 'level', mark: () => {} })
  const res = await out.prepare([4])
  const given = []
  out.start(res.token, { startDrag: item => given.push(...item.files) })
  const onDisk = path.join(path.dirname(given[0]), fs.readdirSync(path.dirname(given[0]))[0])
  assert.equal(onDisk, given[0], 'the name given is the name on disk')
  assert.deepEqual(out.drop(res.token, [onDisk]), { ids: [4] })
  out.dispose()
})

test('IPC: the shapes (bad_request), an untrusted page, the error details; the channels', async () => {
  assert.deepEqual([...DRAG_OUT_CHANNELS], ['mail:dragOut', 'mail:dragStart', 'mail:dragDrop', 'mail:dragFetch'])
  const handlers = new Map()
  const seen = []
  const dragOut = {
    prepare: async ids => {
      seen.push(['prepare', ids])
      if (ids[0] === 13) throw new DragError('too_large', { bytes: 5, max: 4 })
      return { token: 'a'.repeat(32), count: ids.length, bytes: 1 }
    },
    start: (token, wc) => (seen.push(['start', token, wc]), {}),
    drop: (token, paths) => (seen.push(['drop', token, paths]), { ids: [1] }),
    fetch: async ids => (seen.push(['fetch', ids]), { stored: ids, error: null }),
  }
  let trusted = true
  registerDragOutIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, dragOut, isTrustedSender: () => trusted })
  const ipc = (c, ...args) => handlers.get(c)({ sender: 'WC' }, ...args)
  const fifty = Array.from({ length: 50 }, (_, i) => i + 1)
  assert.deepEqual(await ipc('mail:dragOut', [1, 2, 2]), { ok: true, token: 'a'.repeat(32), count: 2, bytes: 1 })
  assert.deepEqual(seen.at(-1), ['prepare', [1, 2]], 'a repeated id once')
  assert.equal((await ipc('mail:dragOut', fifty)).ok, true)
  for (const bad of [undefined, null, 5, '1', {}, [], [...fifty, 51], [0], [-1], [1.5], ['1'], [1, null]])
    assert.deepEqual(await ipc('mail:dragOut', bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
  assert.deepEqual(await ipc('mail:dragOut', [13]), { ok: false, error: 'too_large', bytes: 5, max: 4 })
  assert.deepEqual(await ipc('mail:dragStart', 'b'.repeat(32)), { ok: true })
  assert.deepEqual(seen.at(-1), ['start', 'b'.repeat(32), 'WC'], 'the asking page starts the drag')
  for (const bad of [undefined, 1, 'B'.repeat(32), 'b'.repeat(31), 'g'.repeat(32), ['b'.repeat(32)]]) assert.deepEqual(await ipc('mail:dragStart', bad), { ok: false, error: 'bad_request' })
  assert.deepEqual(await ipc('mail:dragDrop', 'c'.repeat(32), ['/x/a.eml']), { ok: true, ids: [1] })
  assert.deepEqual(await ipc('mail:dragDrop', 'c'.repeat(32), []), { ok: true, ids: [1] }, 'an empty list goes to drop (which says not_own)')
  for (const [tok, paths] of [['c'.repeat(32), null], ['c'.repeat(32), '/x'], ['c'.repeat(32), [1]], ['c'.repeat(32), ['']], ['c'.repeat(32), Array(51).fill('/x')], ['nope', ['/x']]])
    assert.deepEqual(await ipc('mail:dragDrop', tok, paths), { ok: false, error: 'bad_request' })
  assert.deepEqual(await ipc('mail:dragFetch', [3, 3, 4]), { ok: true, stored: [3, 4], error: null })
  for (const bad of [undefined, [], [...fifty, 51], [0], ['3'], 3]) assert.deepEqual(await ipc('mail:dragFetch', bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
  trusted = false
  const before = seen.length
  for (const c of DRAG_OUT_CHANNELS) assert.deepEqual(await ipc(c, [1], ['/x']), { ok: false, error: 'untrusted_sender' })
  assert.equal(seen.length, before, 'nothing reached the drag')
})
