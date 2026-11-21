// SPDX-License-Identifier: GPL-3.0-or-later
// "Összes mentése" (app/main/motw.js saveAllMarked, app/main/ipc/reader.js mail:saveAllAttachments): every offered
// attachment into one chosen folder, byte for byte, never over a file ("name (2).ext"), every name cleaned and kept
// right in the folder, each file marked; one failure does not stop the rest. The IPC: the main process's own folder
// dialog, Cancel writes nothing, the log has counts and codes only, "Megnyitás a mappában" shows the first saved file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { saveAllMarked } from '../app/main/motw.js'
import { registerReaderIpc, READER_CHANNELS } from '../app/main/ipc/reader.js'
import { offeredAttachments } from '../app/main/reader.js'
import { parseMessage, isBrowserActiveName } from '../core/mime/message.js'
import { tempDir } from './helpers/tmp.js'

const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const files = names => names.map((filename, i) => ({ filename, content: Buffer.from(`${filename} #${i} ${'x'.repeat(i * 100)}`) }))
const listing = dir => fs.readdirSync(dir).sort()

test('three files: each byte for byte under its own name, each marked once', async t => {
  const dir = tempDir(t)
  const marked = []
  const input = files(['szamla.pdf', 'kép.jpg', 'jegyzet.txt'])
  const out = await saveAllMarked({ folder: dir, files: input, mark: f => marked.push(f) })
  assert.deepEqual(out.map(f => [f.name, f.ok]), [['szamla.pdf', true], ['kép.jpg', true], ['jegyzet.txt', true]])
  for (const f of input) assert.equal(sha(fs.readFileSync(path.join(dir, f.filename))), sha(f.content))
  assert.deepEqual(marked, out.map(f => f.path))
})

test('saved again into the same folder: "name (2).ext", the first ones untouched byte for byte; a third time (3)', async t => {
  const dir = tempDir(t)
  const first = files(['a.pdf', 'b.txt', 'README'])
  await saveAllMarked({ folder: dir, files: first, mark: () => {} })
  const before = Object.fromEntries(listing(dir).map(n => [n, sha(fs.readFileSync(path.join(dir, n)))]))
  const second = first.map(f => ({ ...f, content: Buffer.from('another content') }))
  const out = await saveAllMarked({ folder: dir, files: second, mark: () => {} })
  assert.deepEqual(out.map(f => f.name), ['a (2).pdf', 'b (2).txt', 'README (2)'])
  for (const [n, h] of Object.entries(before)) assert.equal(sha(fs.readFileSync(path.join(dir, n))), h, `${n} untouched`)
  assert.equal(fs.readFileSync(path.join(dir, 'a (2).pdf'), 'utf8'), 'another content')
  const third = await saveAllMarked({ folder: dir, files: first.slice(0, 1), mark: () => {} })
  assert.equal(third[0].name, 'a (3).pdf')
})

test('two attachments of one message with the same name: "a.pdf" and "a (2).pdf"', async t => {
  const dir = tempDir(t)
  const out = await saveAllMarked({ folder: dir, files: files(['a.pdf', 'a.pdf']), mark: () => {} })
  assert.deepEqual(out.map(f => f.name), ['a.pdf', 'a (2).pdf'])
  assert.deepEqual(listing(dir), ['a (2).pdf', 'a.pdf'])
})

test('names: "..\\..\\x.txt", "../x.txt", "CON.txt", an empty one, 300 characters: cleaned, all right in the folder, nothing outside', async t => {
  const parent = tempDir(t)
  const dir = path.join(parent, 'cel')
  fs.mkdirSync(dir)
  const out = await saveAllMarked({ folder: dir, files: files(['..\\..\\x.txt', '../x.txt', 'CON.txt', '', `${'h'.repeat(300)}.pdf`]), fallback: 'melleklet', mark: () => {} })
  assert.ok(out.every(f => f.ok), JSON.stringify(out))
  assert.deepEqual(out.slice(0, 4).map(f => f.name), ['.._.._x.txt', '.._x.txt', '_CON.txt', 'melleklet'])
  assert.ok(out[4].name.length <= 150 && out[4].name.endsWith('.pdf'), out[4].name)
  for (const f of out) assert.equal(path.dirname(f.path), dir)
  assert.deepEqual(listing(parent), ['cel'], 'nothing written beside the folder')
})

test('a name that would leave the folder (a cleaner that lets it through) is left out: bad_name, nothing outside', async t => {
  const parent = tempDir(t)
  const dir = path.join(parent, 'cel')
  fs.mkdirSync(dir)
  const out = await saveAllMarked({ folder: dir, files: files(['../kint.txt', 'sub/x.txt', 'jo.txt']), clean: n => n, mark: () => {} })
  assert.deepEqual(out.map(f => [f.ok, f.error ?? null]), [[false, 'bad_name'], [false, 'bad_name'], [true, null]])
  assert.deepEqual(listing(parent), ['cel'])
  assert.deepEqual(listing(dir), ['jo.txt'])
})

test('a folder that cannot be written to: not_writable for each, nothing left; a write that fails half way is removed, the rest saved', async t => {
  const dir = tempDir(t)
  const denied = {
    open: async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    },
    rm: fs.promises.rm,
  }
  const out = await saveAllMarked({ folder: dir, files: files(['a.txt', 'b.txt']), fsp: denied, mark: () => {} })
  assert.deepEqual(out.map(f => f.error), ['not_writable', 'not_writable'])
  // the second file's write fails (disk full): it is removed, the first and the third stay
  const half = {
    open: async (p, flags) => {
      const h = await fs.promises.open(p, flags)
      if (path.basename(p) !== 'b.txt') return h
      return { writeFile: async () => (await h.writeFile('half'), Promise.reject(Object.assign(new Error('full'), { code: 'ENOSPC' }))), close: () => h.close() }
    },
    rm: fs.promises.rm,
  }
  const res = await saveAllMarked({ folder: dir, files: files(['a.txt', 'b.txt', 'c.txt']), fsp: half, mark: () => {} })
  assert.deepEqual(res.map(f => f.ok ? 'ok' : f.error), ['ok', 'disk_full', 'ok'])
  assert.deepEqual(listing(dir), ['a.txt', 'c.txt'])
})

test('a mark that fails is logged without a name, the file stays', async t => {
  const dir = tempDir(t)
  const log = []
  const out = await saveAllMarked({ folder: dir, files: files(['titkos-szamla.pdf']), mark: () => {
    throw Object.assign(new Error('no ads'), { code: 'EINVAL' })
  }, log: l => log.push(l) })
  assert.equal(out[0].ok, true)
  assert.ok(fs.existsSync(out[0].path))
  assert.deepEqual(log, ['mark of the web failed on a saved file (EINVAL)'])
})

test('the offered list: a reference in another case, %-encoded or in < > hides its image; a longer cid is no reference', () => {
  const parsed = {
    html: '<p><img src="CID:Logo@X"><img src="cid:k%C3%A9p@x"><img src="cid:<bg@x>"><img src="cid:icon@xy"></p>',
    attachments: [
      { index: 0, filename: 'logo.png', inline: true, cid: 'logo@x' },
      { index: 1, filename: 'kep.png', inline: true, cid: '<KÉP@x>' },
      { index: 2, filename: 'bg.png', inline: true, cid: 'bg@x' },
      { index: 3, filename: 'icon.png', inline: true, cid: 'icon@x' },
    ],
  }
  // icon@x is referred to only as icon@xy: before this the substring match hid it (and the image showed nowhere)
  assert.deepEqual(offeredAttachments(parsed).map(a => a.filename), ['icon.png'])
})

test('the offered list: of two parts whose Content-IDs differ only in case, only the ones a reference shows are left out', () => {
  const parts = [
    { index: 0, filename: 'kis.png', inline: true, cid: 'pair@x' },
    { index: 1, filename: 'nagy.png', inline: true, cid: 'PAIR@x' },
  ]
  // each referred to as written: both shown, none offered
  assert.deepEqual(offeredAttachments({ html: '<img src="cid:pair@x"><img src="cid:PAIR@x">', attachments: parts }).map(a => a.filename), [])
  // only the lower one referred to: the upper one is shown nowhere, so it is offered (it did not go missing)
  assert.deepEqual(offeredAttachments({ html: '<img src="cid:pair@x">', attachments: parts }).map(a => a.filename), ['nagy.png'])
  // a reference written neither way shows the first: the other is offered
  assert.deepEqual(offeredAttachments({ html: '<img src="cid:Pair@X">', attachments: parts }).map(a => a.filename), ['nagy.png'])
})

test('the offered list: the embedded images the body shows are not in it, an unreferenced inline part is', () => {
  const parsed = {
    html: '<p><img src="cid:logo@x"></p>',
    attachments: [
      { index: 0, filename: 'logo.png', inline: true, cid: 'logo@x' },
      { index: 1, filename: 'a.pdf', inline: false },
      { index: 2, filename: 'kep.png', inline: true, cid: 'unused@x' },
    ],
  }
  assert.deepEqual(offeredAttachments(parsed).map(a => a.filename), ['a.pdf', 'kep.png'])
})

function fakeIpc() {
  const handlers = new Map()
  return { handle: (ch, fn) => handlers.set(ch, fn), call: (ch, ...args) => handlers.get(ch)({}, ...args) }
}

test('IPC: the folder dialog (directory, create, not in recents), Cancel writes nothing, the result, the folder shown, the log', async t => {
  const dir = tempDir(t)
  const ipc = fakeIpc()
  const log = []
  const shown = []
  let dialogOpts = null
  let answer = { canceled: true, filePaths: [] }
  const parts = [
    { index: 1, filename: 'szamla.pdf', content: Buffer.from('pdf'), executable: false },
    { index: 2, filename: 'telepito.exe', content: Buffer.from('MZ'), executable: true },
  ]
  registerReaderIpc({
    ipcMain: ipc,
    reader: { offeredAttachments: id => (id === 7 ? parts : []) },
    tmpDir: tempDir(t),
    dialog: { showOpenDialog: async (_win, opts) => ((dialogOpts = opts), answer) },
    shell: { showItemInFolder: p => shown.push(p) },
    getWindow: () => ({}),
    isTrustedSender: () => true,
    log: l => log.push(l),
  })
  assert.ok(READER_CHANNELS.includes('mail:saveAllAttachments') && READER_CHANNELS.includes('mail:showSavedAttachments'))
  assert.deepEqual(await ipc.call('mail:saveAllAttachments', 7), { ok: true, saved: false })
  assert.ok(dialogOpts.properties.includes('openDirectory') && dialogOpts.properties.includes('createDirectory'), JSON.stringify(dialogOpts))
  assert.deepEqual(listing(dir), [], 'Cancel: nothing written')
  assert.deepEqual(await ipc.call('mail:showSavedAttachments'), { ok: false, error: 'not_found' }, 'nothing saved yet')
  answer = { canceled: false, filePaths: [dir] }
  const res = await ipc.call('mail:saveAllAttachments', 7)
  assert.deepEqual(res, { ok: true, saved: true, files: [{ name: 'szamla.pdf', ok: true }, { name: 'telepito.exe', ok: true }], executable: 1, browserActive: 0 })
  assert.equal(fs.readFileSync(path.join(dir, 'telepito.exe'), 'utf8'), 'MZ', 'a program is saved too')
  assert.deepEqual(await ipc.call('mail:showSavedAttachments'), { ok: true })
  assert.deepEqual(shown, [path.join(dir, 'szamla.pdf')])
  assert.deepEqual(log, ['attachments saved: 2 of 2'])
  assert.ok(!log.join().includes('szamla') && !log.join().includes(dir), 'no file name, no folder in the log')
  assert.deepEqual(await ipc.call('mail:saveAllAttachments', 8), { ok: false, error: 'not_found' }, 'no attachment')
  for (const bad of [0, -1, '7', null, 1.5]) assert.deepEqual(await ipc.call('mail:saveAllAttachments', bad), { ok: false, error: 'bad_request' }, String(bad))
})

// a message with every kind of attachment, as the reader parses it: the save-only flags come from parseMessage
// (isExecutableName / isBrowserActiveName), the same ones the single Save refuses to open
const mixedMail = names => {
  const parts = names.map(name => [
    '--b1',
    'Content-Type: application/octet-stream',
    `Content-Disposition: attachment; filename="${name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(`content of ${name}`).toString('base64'),
  ].join('\r\n'))
  return Buffer.from([
    'From: a@example.invalid', 'To: b@example.invalid', 'Subject: files', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"', '', '--b1', 'Content-Type: text/plain', '', 'see attached',
    ...parts, '--b1--', '',
  ].join('\r\n'))
}

test('IPC: the web-page-like files saved are counted (the parser\'s own save-only rule), apart from the programs', async t => {
  const names = ['szamla.pdf', 'oldal.html', 'rajz.svg', 'adat.XML', 'telepito.exe', 'jegyzet.txt']
  const parsed = await parseMessage(mixedMail(names))
  const parts = offeredAttachments(parsed)
  assert.deepEqual(parts.map(p => p.filename), names)
  assert.deepEqual(parts.map(p => p.browserActive), names.map(isBrowserActiveName), 'the flag is the parser\'s, from the one list')
  const dir = tempDir(t)
  const ipc = fakeIpc()
  let ro = null
  registerReaderIpc({
    ipcMain: ipc,
    reader: { offeredAttachments: id => (id === 7 ? parts : id === 8 ? parts.filter(p => p.filename.endsWith('.pdf')) : id === 9 ? parts.filter(p => p.filename === 'oldal.html' || p.filename === 'szamla.pdf') : []) },
    tmpDir: tempDir(t),
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [ro || dir] }) },
    shell: { showItemInFolder: () => {} },
    getWindow: () => ({}),
    isTrustedSender: () => true,
    log: () => {},
  })
  const res = await ipc.call('mail:saveAllAttachments', 7)
  assert.equal(res.files.filter(f => f.ok).length, 6)
  assert.equal(res.browserActive, 3, '.html, .svg and .XML')
  assert.equal(res.executable, 1, 'the program line is unchanged')
  assert.equal(fs.readFileSync(path.join(dir, 'oldal.html'), 'utf8'), 'content of oldal.html', 'saved, byte for byte')
  const none = await ipc.call('mail:saveAllAttachments', 8)
  assert.equal(none.browserActive, 0, 'no web-page-like file: zero')
  // a file that could not be written is not counted: it is not among the saved ones
  ro = path.join(dir, 'missing-folder')
  const failed = await ipc.call('mail:saveAllAttachments', 9)
  assert.ok(failed.files.every(f => !f.ok), JSON.stringify(failed.files))
  assert.equal(failed.browserActive, 0)
})
