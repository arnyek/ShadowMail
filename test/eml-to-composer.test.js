// SPDX-License-Identifier: GPL-3.0-or-later
// An .eml dropped on "Új levél": the main process reads it (readEml), prepares a NEW message from it (Composer.prepareEml:
// recipients, subject, body with its embedded images, attachments; From = the chosen account; nothing of the file's
// identity) and opens a composer (compose:open { mode: 'eml' }). Sent to a local SMTP server: a new Message-ID, no
// reply headers, the attachment and the image byte for byte. A hostile body is cleaned by the composer's sanitizer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { memoryIndex, addAccount, sealedStore } from './helpers/fixtures.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { pngFile, headerDecode } from './helpers/inline-images.js'
import { Composer } from '../app/main/compose.js'
import { registerComposeIpc, readEml, EML_MAX_BYTES } from '../app/main/ipc/compose.js'
import { ActionError } from '../app/main/sync-manager.js'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'
import { Contacts } from '../core/db/contacts.js'
import { People } from '../core/db/people.js'
import { openDroppedEml, carriesFiles, EML_DROP_MAX } from '../app/renderer/src/eml-drop.js'
import { hu } from '../app/renderer/i18n/hu.js'
import { en } from '../app/renderer/i18n/en.js'

const USER = 'kuldo@example.invalid'
const PASS = 'Helyes-Jelszo-123'
const PNG = pngFile(40, 30, { seed: 7 })
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(5000)])
const b64 = buf => buf.toString('base64').replace(/.{76}/g, '$&\r\n')

/** The template: To / Cc / Bcc, an accented subject, HTML with an embedded PNG (cid), a PDF; and every header that must NOT come over. */
function templateEml({ html = '<p>Szia <b>mindenki</b>!</p><p><img src="cid:kep1@minta" alt=""></p>', extra = '' } = {}) {
  return Buffer.from(
    'From: Régi Feladó <regi@example.invalid>\r\n' +
      'Reply-To: valasz@example.invalid\r\n' +
      'To: Első Címzett <elso@example.invalid>, masodik@example.invalid\r\n' +
      'Cc: Másolat Kati <cc@example.invalid>\r\n' +
      'Bcc: rejtett@example.invalid\r\n' +
      'Subject: =?UTF-8?B?' + Buffer.from('Sablon: árvíztűrő tükörfúrógép').toString('base64') + '?=\r\n' +
      'Message-ID: <regi-azonosito@example.invalid>\r\n' +
      'In-Reply-To: <elozo@example.invalid>\r\n' +
      'References: <elso-level@example.invalid> <elozo@example.invalid>\r\n' +
      'X-Mailer: ShadowMail\r\n' +
      'X-ShadowMail-Forward-Of: <eredeti@example.invalid>\r\n' +
      extra +
      'Date: Fri, 20 Nov 2026 10:00:00 +0100\r\n' +
      'MIME-Version: 1.0\r\n' +
      'Content-Type: multipart/mixed; boundary="M"\r\n\r\n' +
      '--M\r\nContent-Type: multipart/related; boundary="R"\r\n\r\n' +
      `--R\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html}\r\n` +
      `--R\r\nContent-Type: image/png\r\nContent-ID: <kep1@minta>\r\nContent-Disposition: inline; filename="kep.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(PNG)}\r\n--R--\r\n` +
      `--M\r\nContent-Type: application/pdf; name="szamla.pdf"\r\nContent-Disposition: attachment; filename="szamla.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(PDF)}\r\n--M--\r\n`,
  )
}

async function startSmtp(t) {
  const received = []
  const server = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN'],
    logger: false,
    onAuth: (auth, session, cb) => (auth.username === USER && auth.password === PASS ? cb(null, { user: USER }) : cb(new Error('bad'))),
    onData(stream, session, cb) {
      const chunks = []
      stream.on('data', c => chunks.push(c))
      stream.on('end', () => {
        received.push({ from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map(r => r.address), raw: Buffer.concat(chunks) })
        cb()
      })
    },
  })
  server.on('error', () => {})
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  onCleanup(t, () => new Promise(r => server.close(r)))
  return { port: server.server.address().port, received }
}

async function setup(t) {
  const smtp = await startSmtp(t)
  const { db, index } = memoryIndex(t)
  const smtpCols = { smtp_host: '127.0.0.1', smtp_port: smtp.port, smtp_security: 'none', smtp_user: USER, save_sent_to_server: 0, tls_verify: 1 }
  const first = addAccount(db, { type: 'pop3', email: 'elso-fiok@example.invalid', display_name: 'Első Fiók', ...smtpCols })
  const second = addAccount(db, { type: 'pop3', email: USER, display_name: 'Kovács Árpád', ...smtpCols })
  for (const row of [first, second]) index.ensureLocalFolders(row.id, [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Trash', specialUse: '\\Trash' }])
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: PASS, smtp: PASS }),
  }
  const dataDir = tempDir(t)
  const storeDir = path.join(dataDir, 'store')
  const contacts = new Contacts(db, { people: new People(db, { now: () => Date.UTC(2026, 10, 27, 9, 0, 0) }) })
  const composer = new Composer({ index, store, contacts, storeDir, sealed: sealedStore(storeDir), dataDir, withConnection: async () => {}, requestSync: () => {}, now: () => Date.UTC(2026, 10, 27, 9, 0, 0) })
  composer.decodeImage = headerDecode
  return { db, index, store, composer, smtp, first, second, dir: tempDir(t) }
}

const purify = createDOMPurify(new JSDOM('').window)
// what the composer page writes into its editor from the form (Composer.jsx: a saved body, rich)
const asComposer = (sid, html) => sanitizeCompose(purify, html, { sessionId: sid, rich: true })

// --- readEml --------------------------------------------------------------------------------------------------------

test('readEml: an .eml (or message/rfc822 under another name) is read; a wrong name, a relative path, a folder, a missing, empty or non-message file each has its code', t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'sablon.EML')
  fs.writeFileSync(file, templateEml())
  assert.ok(readEml(file).equals(templateEml()))
  const other = path.join(dir, 'level.msg')
  fs.writeFileSync(other, templateEml())
  assert.ok(readEml(other, 'message/rfc822').equals(templateEml()), 'the type decides when the name does not')
  const code = fn => {
    try {
      fn()
    } catch (err) {
      assert.ok(err instanceof ActionError, String(err))
      return err.code
    }
    return 'no error'
  }
  assert.equal(code(() => readEml(other)), 'not_eml')
  assert.equal(code(() => readEml(other, 'text/plain')), 'not_eml')
  assert.equal(code(() => readEml('sablon.eml')), 'not_eml', 'a relative path')
  assert.equal(code(() => readEml('')), 'not_eml')
  assert.equal(code(() => readEml(null)), 'not_eml')
  fs.mkdirSync(path.join(dir, 'mappa.eml'))
  assert.equal(code(() => readEml(path.join(dir, 'mappa.eml'))), 'not_eml', 'a folder')
  assert.equal(code(() => readEml(path.join(dir, 'nincs.eml'))), 'eml_unreadable', 'missing')
  fs.writeFileSync(path.join(dir, 'ures.eml'), '')
  assert.equal(code(() => readEml(path.join(dir, 'ures.eml'))), 'eml_unreadable', 'empty')
  fs.writeFileSync(path.join(dir, 'kep.eml'), PNG)
  assert.equal(code(() => readEml(path.join(dir, 'kep.eml'))), 'eml_unreadable', 'a PNG renamed')
  fs.writeFileSync(path.join(dir, 'szoveg.eml'), 'Kedves Anna,\r\nez nem levél.\r\n')
  assert.equal(code(() => readEml(path.join(dir, 'szoveg.eml'))), 'eml_unreadable', 'text without a header')
})

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const MBOX_LINE = 'From - Thu Nov 27 10:00:00 2026'
// the same message behind each accepted prefix: a UTF-8 BOM, an mbox "From " line (LF or CRLF), both
const PREFIXES = {
  bom: BOM,
  'mbox line (LF)': Buffer.from(`${MBOX_LINE}\n`),
  'mbox line (CRLF)': Buffer.from(`${MBOX_LINE}\r\n`),
  'BOM + mbox line': Buffer.concat([BOM, Buffer.from(`${MBOX_LINE}\r\n`)]),
  'a 990-byte mbox line': Buffer.from(`From ${'x'.repeat(984)}\n`),
}

test('readEml: a leading UTF-8 BOM and one mbox "From " line are cut off; the bytes returned are the message itself', t => {
  const dir = tempDir(t)
  for (const [name, prefix] of Object.entries(PREFIXES)) {
    const file = path.join(dir, `elotag-${Object.keys(PREFIXES).indexOf(name)}.eml`)
    fs.writeFileSync(file, Buffer.concat([prefix, templateEml()]))
    const got = readEml(file)
    assert.ok(got.equals(templateEml()), name)
  }
})

test('readEml: a "From " line followed by an empty line, two "From " lines, a "From " line without its end in the first 1000 bytes, only a BOM are eml_unreadable', t => {
  const dir = tempDir(t)
  const bad = {
    'an empty line after the mbox line': Buffer.concat([Buffer.from(`${MBOX_LINE}\r\n\r\n`), templateEml()]),
    'two mbox lines': Buffer.concat([Buffer.from(`${MBOX_LINE}\n${MBOX_LINE}\n`), templateEml()]),
    'an mbox line ending past 1000 bytes': Buffer.concat([Buffer.from(`From ${'x'.repeat(1200)}\n`), templateEml()]),
    'an mbox line with no end at all': Buffer.from(`From ${'x'.repeat(2000)}`),
    'only a BOM': BOM,
    'a BOM and an empty line': Buffer.concat([BOM, Buffer.from('\r\n'), templateEml()]),
    'a BOM after the mbox line': Buffer.concat([Buffer.from(`${MBOX_LINE}\n`), BOM, templateEml()]),
    'an mbox line in lower case': Buffer.concat([Buffer.from(`from - Thu Nov 27 10:00:00 2026\n`), templateEml()]),
  }
  for (const [name, bytes] of Object.entries(bad)) {
    const file = path.join(dir, `rossz-${Object.keys(bad).indexOf(name)}.eml`)
    fs.writeFileSync(file, bytes)
    let got = 'no error'
    try {
      readEml(file)
    } catch (err) {
      assert.ok(err instanceof ActionError, String(err))
      got = err.code
    }
    assert.equal(got, 'eml_unreadable', name)
  }
})

test('a prefixed .eml prepares the very composer of the plain one: recipients, subject, body; neither the BOM nor the "From " line comes over', async t => {
  const s = await setup(t)
  const dir = tempDir(t)
  // the session id and the image id differ per composer
  const norm = (form, sid) => ({ ...form, draftHtml: form.draftHtml.replaceAll(sid, 'SID').replace(/\/[0-9a-f]{24}/g, '/IMG') })
  const plainSid = s.composer.open()
  const plain = norm(await s.composer.prepareEml(plainSid, { source: templateEml(), accountId: s.second.id }), plainSid)
  // and a text-only one, whose body is the message's text
  const textEml = Buffer.from('To: x@example.invalid\r\nSubject: sima\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nElső sor\r\n')
  const textSid = s.composer.open()
  const text = norm(await s.composer.prepareEml(textSid, { source: textEml }), textSid)
  for (const [name, prefix] of Object.entries(PREFIXES)) {
    for (const [base, want] of [[templateEml(), plain], [textEml, text]]) {
      const file = path.join(dir, 'elotag.eml')
      fs.writeFileSync(file, Buffer.concat([prefix, base]))
      const sid = s.composer.open()
      const form = norm(await s.composer.prepareEml(sid, { source: readEml(file), accountId: base === textEml ? undefined : s.second.id }), sid)
      assert.deepEqual(form, want, name)
      const all = JSON.stringify(form)
      assert.ok(!all.includes('Thu Nov 27') && !all.includes('xxxx') && !all.includes(String.fromCharCode(0xfeff)), `${name}: no prefix in the form`)
    }
  }
})

test('readEml: over 25 MB is eml_too_large with the numbers, and the file is not read; exactly 25 MB is read', t => {
  const dir = tempDir(t)
  const big = path.join(dir, 'nagy.eml')
  const fd = fs.openSync(big, 'w')
  fs.writeSync(fd, 'Subject: nagy\r\n\r\n')
  fs.ftruncateSync(fd, EML_MAX_BYTES + 1)
  fs.closeSync(fd)
  assert.equal(EML_MAX_BYTES, 25 * 1024 * 1024)
  let err
  try {
    readEml(big)
  } catch (e) {
    err = e
  }
  assert.equal(err.code, 'eml_too_large')
  assert.deepEqual(err.detail, { bytes: EML_MAX_BYTES + 1, max: EML_MAX_BYTES })
  fs.truncateSync(big, EML_MAX_BYTES)
  assert.equal(readEml(big).length, EML_MAX_BYTES)
})

// --- Composer.prepareEml --------------------------------------------------------------------------------------------

test('prepareEml: To, Cc, Bcc, subject and body from the file, the image as the session\'s own, the PDF attached; From = the chosen account; no reply headers', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  const form = await s.composer.prepareEml(sid, { source: templateEml(), accountId: s.second.id })
  assert.equal(form.accountId, s.second.id)
  assert.equal(form.to, 'Első Címzett <elso@example.invalid>, masodik@example.invalid')
  assert.equal(form.cc, 'Másolat Kati <cc@example.invalid>')
  assert.equal(form.bcc, 'rejtett@example.invalid')
  assert.equal(form.subject, 'Sablon: árvíztűrő tükörfúrógép')
  assert.equal(form.inReplyTo, null)
  assert.deepEqual(form.references, [])
  assert.ok(!('quote' in form) && !('body' in form), 'a saved body: draftHtml only')
  const img = form.draftHtml.match(/inl-img:\/\/session\/([^/]+)\/([0-9a-f]{24})/)
  assert.ok(img, form.draftHtml)
  assert.equal(img[1], sid)
  assert.ok(s.composer.inlineImageOf(sid, img[2]).bytes.equals(PNG))
  assert.ok(!form.draftHtml.includes('cid:'))
  assert.deepEqual(s.composer.attachmentList(sid).map(a => a.filename), ['szamla.pdf'], 'the image is not attached again')
  assert.equal(s.composer.messageIdOf(sid), null)
  const init = s.composer.initial(sid)
  assert.deepEqual(init.form, form)
})

test('prepareEml: without a chosen account (or an unknown one) the first account sends; no account at all is no_account', async t => {
  const s = await setup(t)
  const a = s.composer.open()
  assert.equal((await s.composer.prepareEml(a, { source: templateEml() })).accountId, s.first.id)
  const b = s.composer.open()
  assert.equal((await s.composer.prepareEml(b, { source: templateEml(), accountId: 9999 })).accountId, s.first.id)
  const empty = new Composer({ index: s.index, store: { list: () => [], getRow: () => null }, contacts: null, storeDir: s.dir, withConnection: async () => {} })
  await assert.rejects(empty.prepareEml(empty.open(), { source: templateEml() }), { code: 'no_account' })
})

test('prepareEml: a text-only message becomes paragraphs (escaped); an image the HTML does not show is attached', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  const plain = Buffer.from('To: x@example.invalid\r\nSubject: sima\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nElső sor <b>nem</b> HTML\r\nmásodik sor\r\n')
  const form = await s.composer.prepareEml(sid, { source: plain })
  assert.equal(form.draftHtml, '<p>Első sor &lt;b&gt;nem&lt;/b&gt; HTML<br>második sor<br></p>')
  assert.equal(form.bcc, '')
  const sid2 = s.composer.open()
  await s.composer.prepareEml(sid2, { source: templateEml({ html: '<p>kép nélkül</p>' }) })
  assert.deepEqual(s.composer.attachmentList(sid2).map(a => a.filename).sort(), ['kep.png', 'szamla.pdf'])
})

test('prepareEml: attachments over the session\'s 25 MB -> too_large, nothing kept in the session', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  const big = crypto.randomBytes(25 * 1024 * 1024 + 1)
  const source = Buffer.from(
    'To: x@example.invalid\r\nSubject: nagy\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="M"\r\n\r\n' +
      `--M\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p><img src="cid:kep1@minta"></p>\r\n` +
      `--M\r\nContent-Type: image/png\r\nContent-ID: <kep1@minta>\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(PNG)}\r\n` +
      `--M\r\nContent-Type: application/octet-stream; name="nagy.bin"\r\nContent-Disposition: attachment; filename="nagy.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(big)}\r\n--M--\r\n`,
  )
  await assert.rejects(s.composer.prepareEml(sid, { source }), { code: 'too_large' })
  assert.deepEqual(s.composer.attachmentList(sid), [])
  assert.equal(s.composer.initial(sid).form, null)
})

// --- sent ------------------------------------------------------------------------------------------------------------

test('sent from the composer: a NEW Message-ID, no In-Reply-To / References / Reply-To / X- header of the file, From = the chosen account; the PDF and the image byte for byte; Bcc gets it but is not in the headers', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  const form = await s.composer.prepareEml(sid, { source: templateEml(), accountId: s.second.id })
  const res = await s.composer.sendNow(sid, { accountId: form.accountId, to: form.to, cc: form.cc, bcc: form.bcc, subject: form.subject, html: asComposer(sid, form.draftHtml) })
  assert.equal(res.sent, true)
  const [got] = s.smtp.received
  assert.equal(got.from, USER)
  assert.deepEqual(got.to.sort(), ['cc@example.invalid', 'elso@example.invalid', 'masodik@example.invalid', 'rejtett@example.invalid'])
  const head = got.raw.toString('latin1').split('\r\n\r\n')[0]
  assert.ok(!/^Message-ID: <regi-azonosito@/im.test(head), head)
  assert.match(head, /^Message-ID: </im)
  for (const h of ['In-Reply-To', 'References', 'Reply-To', 'Bcc', 'X-ShadowMail-Forward-Of']) assert.ok(!new RegExp(`^${h}:`, 'im').test(head), `${h} in\n${head}`)
  assert.ok(!head.includes('regi@example.invalid') && !head.includes('valasz@example.invalid') && !head.includes('elozo@example.invalid'))
  const parsed = await simpleParser(got.raw, { keepCidLinks: true })
  assert.equal(parsed.from.value[0].address, USER)
  assert.equal(parsed.subject, 'Sablon: árvíztűrő tükörfúrógép')
  const pdf = parsed.attachments.find(a => a.filename === 'szamla.pdf')
  assert.ok(pdf && pdf.content.equals(PDF), 'the PDF byte for byte')
  const inline = parsed.attachments.filter(a => a.cid)
  assert.equal(inline.length, 1)
  assert.ok(inline[0].content.equals(PNG), 'the image byte for byte')
  assert.ok(parsed.html.includes(`cid:${inline[0].cid}`))
})

test('a hostile body (script, onerror, external image, style, javascript: link, iframe, form) -> nothing of it in the composer nor in the message sent', async t => {
  const s = await setup(t)
  const sid = s.composer.open()
  const hostile =
    '<style>p{color:red}</style><script>alert(1)</script><p onclick="alert(2)">Szia<img src="x" onerror="alert(3)"></p>' +
    '<p><img src="https://evil.example/pixel.gif"><img src="//evil.example/x.png"></p><p><a href="javascript:alert(4)">katt</a></p>' +
    '<iframe src="https://evil.example/"></iframe><form action="https://evil.example/"><input name="p"></form><p style="background:url(https://evil.example/bg)">bg</p>'
  const form = await s.composer.prepareEml(sid, { source: templateEml({ html: hostile }) })
  const shown = asComposer(sid, form.draftHtml)
  const bad = /<script|onerror|onclick|evil\.example|javascript:|<style|<iframe|<form|<input|alert\(/i
  assert.ok(!bad.test(shown), shown)
  assert.ok(shown.includes('Szia') && shown.includes('katt'))
  await s.composer.sendNow(sid, { accountId: form.accountId, to: form.to, cc: form.cc, bcc: form.bcc, subject: form.subject, html: shown })
  const raw = s.smtp.received[0].raw.toString('utf8')
  assert.ok(!bad.test(raw), 'nothing in the message sent')
})

// --- compose:open { mode: 'eml' } ---------------------------------------------------------------------------------

function ipcSetup(t, s) {
  const handlers = new Map()
  const wins = []
  const logged = []
  registerComposeIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    composer: s.composer,
    store: s.store,
    contacts: { suggest: () => [] },
    openWindow: id => {
      const win = { id, on: () => {}, isDestroyed: () => false, destroy() {}, show() {} }
      wins.push(win)
      return win
    },
    dialog: {},
    windowOf: () => ({ isDestroyed: () => false }),
    isTrustedSender: e => e.ok,
    log: m => logged.push(m),
  })
  const call = (...args) => handlers.get('compose:open')({ ok: true }, ...args)
  return { call, wins, logged }
}

test('compose:open eml: one composer per file, prefilled; the log has the size only, never the name or the path', async t => {
  const s = await setup(t)
  const ipc = ipcSetup(t, s)
  const file = path.join(s.dir, 'Titkos Ügyfél ajánlat.eml')
  fs.writeFileSync(file, templateEml())
  const res = await ipc.call({ mode: 'eml', path: file, type: 'message/rfc822', accountId: s.second.id })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(ipc.wins.length, 1)
  assert.equal(s.composer.initial(res.sessionId).form.accountId, s.second.id)
  assert.equal(s.composer.initial(res.sessionId).form.bcc, 'rejtett@example.invalid')
  assert.deepEqual(ipc.logged, [`compose: eml opened (${templateEml().length} bytes)`])
  assert.equal((await ipc.call({ mode: 'eml', path: file })).ok, true, 'without a type and an account')
})

test('compose:open eml: wrong keys or values are bad_request; a not-eml, too large or broken file is its own error, no composer, a log line without the name or path', async t => {
  const s = await setup(t)
  const ipc = ipcSetup(t, s)
  const file = path.join(s.dir, 'jo.eml')
  fs.writeFileSync(file, templateEml())
  for (const req of [
    { mode: 'eml' },
    { mode: 'eml', path: file, extra: 1 },
    { mode: 'eml', path: file, accountId: 'x' },
    { mode: 'eml', path: file, accountId: 0 },
    { mode: 'eml', path: file, type: 5 },
    { mode: 'eml', path: file, messageId: 3 },
  ]) assert.equal((await ipc.call(req)).error, 'bad_request', JSON.stringify(req))
  const name = n => path.join(s.dir, n)
  fs.writeFileSync(name('Bizalmas jelentés.pdf'), PDF)
  fs.writeFileSync(name('Sérült Kovács.eml'), PNG)
  const fd = fs.openSync(name('Óriás Nagy.eml'), 'w')
  fs.ftruncateSync(fd, EML_MAX_BYTES + 10)
  fs.closeSync(fd)
  assert.equal((await ipc.call({ mode: 'eml', path: name('Bizalmas jelentés.pdf') })).error, 'not_eml')
  assert.equal((await ipc.call({ mode: 'eml', path: name('Sérült Kovács.eml') })).error, 'eml_unreadable')
  const big = await ipc.call({ mode: 'eml', path: name('Óriás Nagy.eml') })
  assert.equal(big.error, 'eml_too_large')
  assert.deepEqual(big.detail, { bytes: EML_MAX_BYTES + 10, max: EML_MAX_BYTES })
  assert.equal(ipc.wins.length, 0)
  assert.equal(s.composer.sessions.size, 0, 'no session left behind')
  assert.deepEqual(ipc.logged, ['compose: eml not opened (not_eml)', 'compose: eml not opened (eml_unreadable)', `compose: eml not opened (eml_too_large, ${EML_MAX_BYTES + 10} bytes)`])
  const all = ipc.logged.join('\n')
  for (const bit of ['Bizalmas', 'Sérült', 'Óriás', s.dir, '.eml', '.pdf']) assert.ok(!all.includes(bit), bit)
})

// (an .eml of at most 25 MB cannot carry attachments over 25 MB: the size check of prepareEml is for its direct callers)
test('compose:open eml: an error of the preparation that is not ours is eml_unreadable; the session closed, its message (it may quote the file) not logged', async t => {
  const s = await setup(t)
  const ipc = ipcSetup(t, s)
  const file = path.join(s.dir, 'Kovács Béla szerződés.eml')
  fs.writeFileSync(file, templateEml())
  s.composer.prepareEml = async () => {
    throw new Error(`parse failed in ${file}: Kovács Béla`)
  }
  const res = await ipc.call({ mode: 'eml', path: file })
  assert.equal(res.error, 'eml_unreadable')
  assert.equal(ipc.wins.length, 0)
  assert.equal(s.composer.sessions.size, 0)
  assert.deepEqual(ipc.logged, [`compose: eml not opened (eml_unreadable, ${templateEml().length} bytes)`])
  s.composer.prepareEml = async () => {
    throw new ActionError('too_large')
  }
  assert.equal((await ipc.call({ mode: 'eml', path: file })).error, 'too_large', 'our own code goes as it is')
})

// --- the page's side ------------------------------------------------------------------------------------------------

test('a drop: the first 5 files open one after the other, the rest is counted; errors in order, a rejected call is internal', async t => {
  const order = []
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const res = await openDroppedEml(files, async f => {
    order.push(f)
    if (f === 'b') return { ok: false, error: 'not_eml' }
    if (f === 'd') throw new Error('gone')
    return { ok: true, sessionId: f }
  })
  assert.equal(EML_DROP_MAX, 5)
  assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(res, { opened: 3, errors: [{ error: 'not_eml', detail: undefined }, { error: 'internal', detail: undefined }], skipped: 2 })
  assert.deepEqual(await openDroppedEml([], async () => ({ ok: true })), { opened: 0, errors: [], skipped: 0 })
  assert.equal(carriesFiles({ types: ['Files'] }), true)
  assert.equal(carriesFiles({ types: ['application/x-shadowmail-ids'] }), false)
  assert.equal(carriesFiles(null), false)
})

test('the texts: every code has its own sentence in both languages; the size in MB', () => {
  for (const d of [hu, en]) {
    for (const code of ['not_eml', 'eml_unreadable', 'too_large', 'no_account']) assert.ok(d.emlDrop.error(code, {}).includes(d.emlDrop.errors[code]), code)
    assert.match(d.emlDrop.error('eml_too_large', { bytes: 30 * 1024 * 1024, max: EML_MAX_BYTES }), /30[,.]0 MB.*25 MB/)
    assert.match(d.emlDrop.error('eml_too_large', { bytes: EML_MAX_BYTES + 100, max: EML_MAX_BYTES }), /25[,.]1 MB/, 'just over the limit never reads as the limit')
    assert.match(d.emlDrop.tooMany(2, 5), /5.*2|2.*5/)
  }
})
