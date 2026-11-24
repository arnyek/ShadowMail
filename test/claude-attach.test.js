// Files Claude asks to attach (MCP): the composer's own checks for a local path or a message's attachment.
// Every item is read before any joins the session; the bytes are the ones read then, a later change on the disk
// does not count; the session's 25 MB limit holds with what is in it already.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { simpleParser } from 'mailparser'
import { memoryIndex, addAccount, addMessage, sealedStore } from './helpers/fixtures.js'
import { tempDir } from './helpers/tmp.js'
import { Composer, claudePathProblem, CLAUDE_ATTACH_MAX, MAX_ATTACHMENTS_BYTES } from '../app/main/compose.js'
import { CAPS } from '../app/main/mcp/tools.js'
import { Contacts } from '../core/db/contacts.js'
import { parseMessage } from '../core/mime/message.js'
import { ActionError } from '../app/main/sync-manager.js'

const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const FIXTURE = fs.readFileSync(new URL('./fixtures/mail/cid-and-attachments.eml', import.meta.url))

function setup(t) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type: 'pop3', email: 'sajat@example.invalid', smtp_host: '127.0.0.1', smtp_port: 2525, smtp_security: 'none', smtp_user: 'u' })
  index.ensureLocalFolders(row.id, [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Trash', specialUse: '\\Trash' }])
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: 'x', smtp: 'y' }),
  }
  const dataDir = tempDir(t)
  const storeDir = path.join(dataDir, 'store')
  // the message whose attachments are offered: its source from a reader, as the app's MessageReader gives it
  const msgId = addMessage(index, row.id, { uid: 1, subject: 'Számla és logó', messageId: '<m1@x>' })
  const sources = new Map([[msgId, FIXTURE]])
  const reader = {
    source: async id => {
      const r = index.get(id)
      if (!r) throw new ActionError('not_found')
      if (!sources.has(id)) throw new ActionError('not_downloaded')
      return { row: r, source: sources.get(id) }
    },
  }
  const sent = []
  const composer = new Composer({
    index, store, contacts: new Contacts(db), storeDir, sealed: sealedStore(storeDir), dataDir, reader,
    withConnection: async () => assert.fail('no server'),
    send: async ({ envelope, raw }) => (sent.push(raw), { accepted: envelope.to, rejected: [] }),
  })
  const files = tempDir(t)
  const file = (name, content) => {
    const p = path.join(files, name)
    fs.writeFileSync(p, content)
    return p
  }
  return { db, index, row, composer, dataDir, storeDir, files, file, msgId, sources, sent }
}
const fails = async (promise, code, item) => {
  const err = await promise.then(() => assert.fail(`expected ${code}`), e => e)
  assert.equal(err.code, code, String(err.stack))
  if (item !== undefined) assert.equal(err.item, item, 'the bad item is named')
}

test('the path rule: only a full local path (a drive and a root on Windows; no UNC, device path, stream or control character)', () => {
  for (const ok of ['D:\\Munka\\Dokumentumok\\ajánlat 2026.pdf', 'c:/x/y.txt', 'D:\\a', 'D:\\Munka\\OneDrive\\Ügyfelek\\é.docx']) assert.equal(claudePathProblem(ok, 'win32'), null, ok)
  for (const bad of ['ajanlat.pdf', '.\\a.txt', '..\\a.txt', 'C:a.txt', 'C:', '\\a.txt', '/a.txt', '\\\\server\\share\\a.txt', '//server/share/a.txt', '\\\\.\\C:\\a.txt', '\\\\?\\C:\\a.txt', '\\\\?\\UNC\\server\\a', 'C:\\a\\b.txt:titok', 'C:\\a\\b.txt::$DATA', 'C:\\a\u0000b.txt', 'C:\\a\nb.txt', '', null, 42, {}])
    assert.equal(claudePathProblem(bad, 'win32'), 'bad_path', JSON.stringify(bad))
  for (const ok of ['/srv/munka/ajánlat.pdf', '/a', '/tmp/x:y']) assert.equal(claudePathProblem(ok, 'linux'), null, ok)
  for (const bad of ['a.pdf', './a', '../a', '~/a', 'C:\\a.txt', '\\\\server\\a', '', '/a\u0000b']) assert.equal(claudePathProblem(bad, 'linux'), 'bad_path', JSON.stringify(bad))
  assert.equal(CLAUDE_ATTACH_MAX, CAPS.attachments, 'the composer\'s count is the MCP tools\' cap')
})

test('local files: read now, byte for byte, with the real path and the SHA-256; an accented name kept', async t => {
  const s = setup(t)
  const a = s.file('ajánlat é.pdf', Buffer.from('%PDF-1.4 ajánlat'))
  const b = s.file('jegyzet.txt', 'első sor\n')
  const sid = s.composer.open()
  const got = await s.composer.claudeAttach(sid, [{ path: a }, { path: b }])
  assert.deepEqual(got.map(x => [x.filename, x.size, x.sha256, x.source]), [
    ['ajánlat é.pdf', fs.statSync(a).size, sha(fs.readFileSync(a)), { path: fs.realpathSync(a) }],
    ['jegyzet.txt', fs.statSync(b).size, sha(fs.readFileSync(b)), { path: fs.realpathSync(b) }],
  ])
  assert.deepEqual(s.composer.attachmentDigests(sid), got.map(x => ({ filename: x.filename, size: x.size, sha256: x.sha256 })), 'the session holds them, the approval binds to these digests')
  assert.deepEqual(s.composer.attachmentList(sid).map(x => x.id), got.map(x => x.id))
})

test('a link: the real path is the one shown and checked', async t => {
  const s = setup(t)
  const real = s.file('valodi.txt', 'x')
  const link = path.join(s.files, 'link.txt')
  try {
    fs.symlinkSync(real, link)
  } catch {
    t.skip('no symlinks here')
    return
  }
  const sid = s.composer.open()
  const [got] = await s.composer.claudeAttach(sid, [{ path: link }])
  assert.deepEqual([got.filename, got.source.path], ['valodi.txt', fs.realpathSync(real)])
})

test('refused, nothing joins the session: relative, UNC, device path, folder, missing file, the data folder, a hard link to its top-level file, a link into it', async t => {
  const s = setup(t)
  const secret = path.join(s.dataDir, 'mail.sqlite')
  fs.writeFileSync(secret, 'db')
  fs.mkdirSync(s.storeDir, { recursive: true })
  const cached = path.join(s.storeDir, 'x.eml')
  fs.writeFileSync(cached, 'eml')
  const sid = s.composer.open()
  await fails(s.composer.claudeAttach(sid, [{ path: 'jegyzet.txt' }]), 'bad_path', 1)
  await fails(s.composer.claudeAttach(sid, [{ path: './jegyzet.txt' }]), 'bad_path', 1)
  await fails(s.composer.claudeAttach(sid, [{ path: '\\\\server\\share\\a.txt' }]), 'bad_path', 1)
  await fails(s.composer.claudeAttach(sid, [{ path: '\\\\.\\C:\\a.txt' }]), 'bad_path', 1)
  await fails(s.composer.claudeAttach(sid, [{ path: '\\\\?\\C:\\a.txt' }]), 'bad_path', 1)
  await fails(s.composer.claudeAttach(sid, [{ path: s.files }]), 'not_a_file', 1)
  await fails(s.composer.claudeAttach(sid, [{ path: path.join(s.files, 'nincs-ilyen.pdf') }]), 'not_found', 1)
  await fails(s.composer.claudeAttach(sid, [{ path: path.join(s.files, 'nincs', 'ilyen.pdf') }]), 'not_found', 1)
  await fails(s.composer.claudeAttach(sid, [{ path: secret }]), 'forbidden_path', 1)
  await fails(s.composer.claudeAttach(sid, [{ path: cached }]), 'forbidden_path', 1)
  const hard = path.join(s.files, 'masolat.sqlite')
  let linked = true
  try {
    fs.linkSync(secret, hard)
  } catch {
    linked = false
  }
  if (linked) await fails(s.composer.claudeAttach(sid, [{ path: hard }]), 'forbidden_path', 1)
  const soft = path.join(s.files, 'adatbazis.lnk')
  let soft_ok = true
  try {
    fs.symlinkSync(secret, soft)
  } catch {
    soft_ok = false
  }
  if (soft_ok) await fails(s.composer.claudeAttach(sid, [{ path: soft }]), 'forbidden_path', 1)
  assert.deepEqual(s.composer.attachmentList(sid), [], 'none joined')
  assert.ok(linked, 'the hard link case ran')
})

test('a bundle with one bad item (2 good + 1 bad, in any place) adds none, and names the bad one', async t => {
  const s = setup(t)
  const a = s.file('a.txt', 'a')
  const b = s.file('b.txt', 'b')
  const sid = s.composer.open()
  await fails(s.composer.claudeAttach(sid, [{ path: a }, { path: b }, { path: 'rossz.txt' }]), 'bad_path', 3)
  await fails(s.composer.claudeAttach(sid, [{ path: a }, { path: path.join(s.files, 'nincs.txt') }, { path: b }]), 'not_found', 2)
  await fails(s.composer.claudeAttach(sid, [{ messageId: s.msgId, attachment: 9 }, { path: a }, { path: b }]), 'not_found', 1)
  assert.deepEqual(s.composer.attachmentList(sid), [])
})

test('the shape: only { path } or { messageId, attachment }, at most 50 in one call', async t => {
  const s = setup(t)
  const a = s.file('a.txt', 'a')
  const sid = s.composer.open()
  for (const bad of [[], null, 'a', [{}], [{ path: a, extra: 1 }], [{ path: a, messageId: 1 }], [{ messageId: '1', attachment: 1 }], [{ messageId: s.msgId, attachment: 0 }], [{ messageId: s.msgId, attachment: 1.5 }], [[a]], [a]])
    await fails(s.composer.claudeAttach(sid, bad), 'bad_request')
  await fails(s.composer.claudeAttach(sid, Array.from({ length: CLAUDE_ATTACH_MAX + 1 }, () => ({ path: a }))), 'too_many')
  assert.deepEqual(s.composer.attachmentList(sid), [])
  assert.equal((await s.composer.claudeAttach(sid, Array.from({ length: CLAUDE_ATTACH_MAX }, () => ({ path: a })))).length, CLAUDE_ATTACH_MAX)
})

test('25 MB with what the session holds already: over it too_large, nothing joins; a huge file is not read', async t => {
  const s = setup(t)
  const big = s.file('nagy.bin', Buffer.alloc(20 * 1024 * 1024, 1))
  const more = s.file('meg.bin', Buffer.alloc(6 * 1024 * 1024, 2))
  const sid = s.composer.open()
  s.composer.addFiles(sid, [big])
  await fails(s.composer.claudeAttach(sid, [{ path: more }]), 'too_large', 1)
  // two that fit one by one, not together
  const sid2 = s.composer.open()
  await fails(s.composer.claudeAttach(sid2, [{ path: big }, { path: more }]), 'too_large', 2)
  assert.deepEqual(s.composer.attachmentList(sid2), [])
  // a sparse 2 GB file: refused by its size, before any reading
  const sparse = path.join(s.files, 'ritka.bin')
  const fd = fs.openSync(sparse, 'w')
  fs.ftruncateSync(fd, 2 * 1024 * 1024 * 1024)
  fs.closeSync(fd)
  const t0 = performance.now()
  await fails(s.composer.claudeAttach(s.composer.open(), [{ path: sparse }]), 'too_large', 1)
  assert.ok(performance.now() - t0 < 2000, 'not read')
  // exactly the limit fits
  const exact = s.file('pont.bin', Buffer.alloc(MAX_ATTACHMENTS_BYTES - 20 * 1024 * 1024, 3))
  assert.equal((await s.composer.claudeAttach(sid, [{ path: exact }])).length, 1)
})

test('two calls at once on one session cannot pass 25 MB together: one is refused, the session holds at most 25 MB', async t => {
  const s = setup(t)
  const a = s.file('a.bin', Buffer.alloc(15 * 1024 * 1024, 1))
  const b = s.file('b.bin', Buffer.alloc(15 * 1024 * 1024, 2))
  const sid = s.composer.open()
  const got = await Promise.allSettled([s.composer.claudeAttach(sid, [{ path: a }]), s.composer.claudeAttach(sid, [{ path: b }])])
  assert.deepEqual(got.map(x => x.status).sort(), ['fulfilled', 'rejected'], JSON.stringify(got.map(x => x.status)))
  assert.equal(got.find(x => x.status === 'rejected').reason.code, 'too_large')
  assert.equal(s.composer.attachmentList(sid).length, 1)
  assert.ok(s.composer.attachmentList(sid).reduce((n, x) => n + x.size, 0) <= MAX_ATTACHMENTS_BYTES)
  // a big file read in pieces: byte for byte
  const big = Buffer.alloc(3 * 65536 + 17)
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255
  const [x] = await s.composer.claudeAttach(s.composer.open(), [{ path: s.file('darabok.bin', big) }])
  assert.equal(x.sha256, sha(big))
})

test('a message\'s attachment: the n-th of its not embedded ones (as read_message lists them), byte for byte; a wrong number or message: not_found', async t => {
  const s = setup(t)
  const offered = (await parseMessage(FIXTURE)).attachments.filter(x => !x.inline)
  assert.deepEqual(offered.map(x => x.filename), ['szamla.pdf', 'telepito.exe', 'szamla.pdf.html'], 'the embedded logo is not counted')
  const sid = s.composer.open()
  const got = await s.composer.claudeAttach(sid, [{ messageId: s.msgId, attachment: 2 }, { messageId: s.msgId, attachment: 1 }])
  assert.deepEqual(got.map(x => [x.filename, x.size, x.sha256, x.source]), [
    ['telepito.exe', offered[1].content.length, sha(offered[1].content), { messageId: s.msgId, subject: 'Számla és logó', attachment: 2 }],
    ['szamla.pdf', offered[0].content.length, sha(offered[0].content), { messageId: s.msgId, subject: 'Számla és logó', attachment: 1 }],
  ])
  await fails(s.composer.claudeAttach(sid, [{ messageId: s.msgId, attachment: 4 }]), 'not_found', 1)
  await fails(s.composer.claudeAttach(sid, [{ messageId: 99999, attachment: 1 }]), 'not_found', 1)
  // a message not downloaded and no server: unreadable, nothing joins
  const otherId = addMessage(s.index, s.row.id, { uid: 2, subject: 'Másik', messageId: '<m2@x>' })
  await fails(s.composer.claudeAttach(sid, [{ messageId: otherId, attachment: 1 }]), 'unreadable', 1)
  assert.equal(s.composer.attachmentList(sid).length, 2)

  // sent on: the parts go out with the original's bytes and type
  await s.composer.sendNow(sid, { accountId: s.row.id, to: 'anna@example.invalid', cc: '', bcc: '', subject: 'Továbbítom', html: '<p>x</p>' }, { addPeople: false })
  const out = await simpleParser(s.sent[0])
  assert.deepEqual(out.attachments.map(x => [x.filename, x.contentType, sha(x.content)]), [
    ['telepito.exe', offered[1].contentType, sha(offered[1].content)],
    ['szamla.pdf', offered[0].contentType, sha(offered[0].content)],
  ])
})

test('the bytes are the ones read at the request: a change on the disk afterwards does not reach what is saved or sent', async t => {
  const s = setup(t)
  const p = s.file('ajanlat.txt', 'REGI tartalom')
  const sid = s.composer.open()
  const [got] = await s.composer.claudeAttach(sid, [{ path: p }])
  fs.writeFileSync(p, 'UJ, MASIK tartalom, hosszabb')
  assert.deepEqual(s.composer.attachmentDigests(sid), [{ filename: 'ajanlat.txt', size: 13, sha256: got.sha256 }])
  await s.composer.sendNow(sid, { accountId: s.row.id, to: 'anna@example.invalid', cc: '', bcc: '', subject: 'x', html: '<p>x</p>' }, { addPeople: false })
  const out = await simpleParser(s.sent[0])
  assert.deepEqual(out.attachments.map(x => x.content.toString()), ['REGI tartalom'])
})
