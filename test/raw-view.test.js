// the raw message view (core/mime/raw-view.js) and its IPC (mail:source, mail:saveSource)
// on the real MessageReader with the fake IMAP server: the source comes without \Seen, the save writes the whole
// message, byte for byte, marked; the log has no content.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rawView, headerEnd, authenticationResults, sourceFileName, MAX_SOURCE_CHARS } from '../core/mime/raw-view.js'
import { safeFileName } from '../core/mime/message.js'
import { hu } from '../app/renderer/i18n/hu.js'
import { en } from '../app/renderer/i18n/en.js'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { MessageReader } from '../app/main/reader.js'
import { registerReaderIpc, READER_CHANNELS } from '../app/main/ipc/reader.js'

const NOW = Date.UTC(2026, 10, 13, 9)
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('headers and text: CRLF and LF, a message without a header block, a broken UTF-8 byte -> U+FFFD', async () => {
  const crlf = await rawView(Buffer.from('From: a@example.invalid\r\nSubject: CRLF\r\n\r\nbody line\r\n'))
  assert.equal(crlf.headers, 'From: a@example.invalid\r\nSubject: CRLF\r\n')
  assert.ok(crlf.text.endsWith('body line\r\n'))
  assert.deepEqual([crlf.truncated, crlf.size], [false, Buffer.byteLength('From: a@example.invalid\r\nSubject: CRLF\r\n\r\nbody line\r\n')])
  const lf = await rawView(Buffer.from('From: a@example.invalid\nSubject: LF\n folded\n\nbody\n'))
  assert.equal(lf.headers, 'From: a@example.invalid\nSubject: LF\n folded\n')
  assert.equal(lf.summary.subject, 'LF folded')
  const none = await rawView(Buffer.from('Just a body, no header\r\nsecond line\r\n'))
  assert.deepEqual([none.headers, none.summary.from, none.summary.subject, none.summary.auth], ['', null, null, null])
  assert.ok(none.text.startsWith('Just a body'))
  assert.equal(headerEnd(Buffer.from('\r\nbody')), 0, 'an empty first line: no header block')
  const broken = await rawView(Buffer.concat([Buffer.from('Subject: x\r\n\r\nA'), Buffer.from([0xc3, 0x28, 0xff]), Buffer.from('B')]))
  assert.ok(broken.text.endsWith('A�(�B'), JSON.stringify(broken.text.slice(-6)))
})

test('a 3 MB message: truncated, size in bytes, text exactly 2 097 152 characters; never half an emoji', async () => {
  const big = Buffer.concat([Buffer.from('Subject: nagy\r\n\r\n'), Buffer.alloc(3 * 1024 * 1024, 0x61)])
  const v = await rawView(big)
  assert.deepEqual([v.truncated, v.size, v.text.length, MAX_SOURCE_CHARS], [true, big.length, 2_097_152, 2_097_152])
  // an emoji across the cut: one character less, not a lone surrogate
  const head = Buffer.from('Subject: e\r\n\r\n')
  const pad = Buffer.alloc(MAX_SOURCE_CHARS - head.length - 1, 0x62)
  const e = await rawView(Buffer.concat([head, pad, Buffer.from('😀😀')]))
  assert.equal(e.truncated, true)
  assert.ok(!/[\ud800-\udbff]$/.test(e.text), 'no lone high surrogate at the end')
})

test('summary: decoded fields; the TOPMOST Authentication-Results counts; none -> null; =?UTF-8?B?...?= subject', async () => {
  const raw = [
    'Authentication-Results: mx.fogado.invalid;',
    '  spf=pass smtp.mailfrom=example.invalid;',
    '  dkim=fail header.d=example.invalid; dmarc=none',
    'Authentication-Results: kozbenso.invalid; spf=fail; dkim=pass; dmarc=pass',
    'From: =?UTF-8?B?S292w6FjcyBBbm5h?= <anna@example.invalid>',
    'To: Béla <bela@example.invalid>',
    'Cc: cili@example.invalid',
    'Date: Fri, 13 Nov 2026 09:00:00 +0100',
    `Subject: =?UTF-8?B?${Buffer.from('Árvíztűrő tükörfúrógép').toString('base64')}?=`,
    'Message-ID: <abc@example.invalid>',
    '',
    'x',
  ].join('\r\n')
  const v = await rawView(Buffer.from(raw))
  assert.deepEqual(v.summary.auth, { by: 'mx.fogado.invalid', spf: 'pass', dkim: 'fail', dmarc: 'none' }, 'the receiving server\'s (topmost) line')
  assert.equal(v.summary.subject, 'Árvíztűrő tükörfúrógép')
  assert.match(v.summary.from, /"?Kovács Anna"? <anna@example\.invalid>/)
  assert.match(v.summary.to, /bela@example\.invalid/)
  assert.equal(v.summary.cc, 'cili@example.invalid')
  assert.equal(v.summary.date, '2026-11-13T08:00:00.000Z')
  assert.equal(v.summary.messageId, '<abc@example.invalid>')
  assert.equal((await rawView(Buffer.from('From: a@example.invalid\r\n\r\nx'))).summary.auth, null)
  assert.deepEqual(authenticationResults('Authentication-Results: x; spf=bogus; dkim=PASS'), { by: 'x', spf: null, dkim: 'pass', dmarc: null })
})

test('a result inside a comment or a quoted property value (the sender writes those) is never read', () => {
  const cases = [
    ['Authentication-Results: mx.google.com; dkim=fail header.i=@attacker.example; spf=softfail (google.com: domain of " dmarc=pass"@attacker.example does not designate 1.2.3.4 as permitted sender) smtp.mailfrom=" dmarc=pass"@attacker.example; dmarc=fail (p=REJECT) header.from=bank.example\r\n',
      { by: 'mx.google.com', spf: 'softfail', dkim: 'fail', dmarc: 'fail' }],
    ['Authentication-Results: mx.real; dkim=none ( spf=pass ); spf=fail; dmarc=fail', { by: 'mx.real', spf: 'fail', dkim: 'none', dmarc: 'fail' }],
    ['Authentication-Results: mx.real; spf=fail smtp.mailfrom="x;dkim=pass"@a.example; dkim=fail', { by: 'mx.real', spf: 'fail', dkim: 'fail', dmarc: null }],
    ['Authentication-Results: mx.real (nested (spf=pass) comment); spf=fail', { by: 'mx.real', spf: 'fail', dkim: null, dmarc: null }],
    ['Authentication-Results: mx.real; dkim/1=pass header.d=x', { by: 'mx.real', spf: null, dkim: 'pass', dmarc: null }],
    ['Authentication-Results: mx.real; none', { by: 'mx.real', spf: null, dkim: null, dmarc: null }],
    // a ';' inside a comment: only removing the comment keeps "dmarc=pass" from becoming a resinfo of its own
    ['Authentication-Results: mx.real; spf=fail (looked up; dmarc=pass by the sender); dmarc=fail', { by: 'mx.real', spf: 'fail', dkim: null, dmarc: 'fail' }],
  ]
  for (const [h, want] of cases) assert.deepEqual(authenticationResults(h), want, h)
})

test('the header block is capped like the text', async () => {
  const lines = Array.from({ length: 120_000 }, (_, i) => `X-Line-${i}: ${'v'.repeat(20)}`).join('\r\n')
  const v = await rawView(Buffer.from(`${lines}\r\nSubject: sok\r\n\r\nbody`))
  assert.deepEqual([v.headersTruncated, v.headers.length], [true, MAX_SOURCE_CHARS])
  assert.equal((await rawView(Buffer.from('Subject: kicsi\r\n\r\nx'))).headersTruncated, false)
})

test('the .eml file name: Windows-forbidden characters -> _, at most 100 characters, no subject -> level.eml', () => {
  const SFN = (subject, safe) => sourceFileName(subject, safe, hu.sourceFileFallback)
  assert.equal(SFN('a/b:c?', safeFileName), 'a_b_c_.eml')
  assert.equal(SFN('', safeFileName), 'level.eml')
  assert.equal(SFN('   ', safeFileName), 'level.eml')
  assert.equal(SFN('x'.repeat(300), safeFileName), `${'x'.repeat(100)}.eml`)
  assert.equal(SFN('CON', safeFileName), '_CON.eml')
  assert.equal(SFN('vége...', safeFileName), 'vége.eml')
  // zero-width and direction marks do not hide part of the name
  assert.equal(SFN('x\u200bpdf\u200e\u200f\ufeff', safeFileName), 'xpdf.eml')
  // the 100-character cut never splits a pair: an emoji on the edge goes whole; a lone half elsewhere is U+FFFD
  assert.equal(SFN(`${'a'.repeat(99)}\u{1F600} tail`, safeFileName), `${'a'.repeat(99)}.eml`)
  assert.equal(SFN(`${'a'.repeat(98)}\u{1F600} tail`, safeFileName), `${'a'.repeat(98)}\u{1F600}.eml`)
  assert.equal(SFN('x\ud800y\udc00z', safeFileName), 'x\ufffdy\ufffdz.eml')
  for (const n of [97, 98, 99, 100]) assert.ok(SFN(`${'a'.repeat(n)}\u{1F600}\u{1F600}`, safeFileName).isWellFormed(), String(n))
})

test('IPC on the fake IMAP: mail:source leaves the message unread; mail:saveSource writes it byte for byte, marked; no content in the log', async t => {
  const { db, index } = memoryIndex(t)
  const storeDir = path.join(tempDir(t), 'store')
  const row = addAccount(db, { name: 'Forras', email: 'en@example.invalid', in_port: 49733 })
  const imap = new FakeImapServer().addMailbox('INBOX')
  imap.addMessage('INBOX', { from: 'titok-felado@example.invalid', to: 'en@example.invalid', subject: 'Titkos-targy-H1', messageId: '<titok-mid@x>', date: NOW - DAY, body: 'titkos szoveg' })
  const store = { list: () => db.prepare('SELECT * FROM accounts').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id), passwordsFor: () => ({ incoming: 'x' }) }
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), notify: () => {}, connect: async () => imap.connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  for (let i = 0; i < 200 && index.countFolder(row.id, 'INBOX') < 1; i++) await sleep(10)
  const reader = new MessageReader({ index, sealed: sealedStore(storeDir), withConnection: (id, fn) => manager.withConnection(id, fn) })
  const handlers = new Map()
  const logs = []
  const saveTo = tempDir(t)
  const dialogCalls = []
  registerReaderIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    reader,
    tmpDir: tempDir(t),
    dialog: { showSaveDialog: async opts => (dialogCalls.push(opts), { canceled: false, filePath: path.join(saveTo, opts.defaultPath) }) },
    shell: {},
    isTrustedSender: e => e.trusted,
    log: m => logs.push(m),
  })
  for (const c of ['mail:source', 'mail:saveSource']) assert.ok(READER_CHANNELS.includes(c) && handlers.has(c), c)
  const call = (c, ...a) => handlers.get(c)({ trusted: true }, ...a)
  const id = db.prepare('SELECT id FROM messages').get().id
  const v = await call('mail:source', id)
  assert.equal(v.ok, true)
  assert.match(v.headers, /Subject: Titkos-targy-H1/)
  assert.match(v.text, /titkos szoveg/)
  assert.equal(v.summary.subject, 'Titkos-targy-H1')
  assert.ok(!/\\Seen/.test(index.get(id).flags), 'unread in the index')
  const onServer = [...imap.mailboxes.get('INBOX').messages.values()][0]
  assert.ok(!onServer.flags.has('\\Seen'), 'unread on the server')
  const saved = await call('mail:saveSource', id)
  assert.deepEqual(saved, { ok: true, saved: true })
  assert.equal(dialogCalls[0].defaultPath, 'Titkos-targy-H1.eml')
  const file = path.join(saveTo, 'Titkos-targy-H1.eml')
  assert.equal(Buffer.compare(fs.readFileSync(file), sealedStore(storeDir).read(index.get(id).store_path)), 0, 'byte for byte the sealed store\'s message')
  for (const bad of [0, -1, 'x', null, 1.5]) assert.deepEqual(await call('mail:source', bad), { ok: false, error: 'bad_request' })
  assert.deepEqual(await call('mail:source', 99999), { ok: false, error: 'not_found' })
  const log = logs.join('\n')
  for (const word of ['Titkos-targy-H1', 'titok-felado', 'titok-mid', 'titkos szoveg']) assert.ok(!log.includes(word), word)
  assert.ok(logs.some(l => /^source view: message \d+, \d+ bytes$/.test(l)) && logs.some(l => /^source saved: message \d+, \d+ bytes$/.test(l)), log)
})

test('the .eml file name without a subject is the interface language\'s: message.eml in English; no fallback throws', () => {
  assert.equal(sourceFileName('', safeFileName, en.sourceFileFallback), 'message.eml')
  assert.equal(sourceFileName(' \u200b ', safeFileName, en.sourceFileFallback), 'message.eml')
  assert.equal(sourceFileName('Invoice: 2026/11', safeFileName, en.sourceFileFallback), 'Invoice_ 2026_11.eml')
  assert.equal(sourceFileName('', safeFileName, hu.sourceFileFallback), 'level.eml')
  assert.throws(() => sourceFileName('x', safeFileName), TypeError)
})
