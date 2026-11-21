// SPDX-License-Identifier: GPL-3.0-or-later
// The original's embedded images in a reply's and a forward's quote (Composer.prepare): the PNG / JPEG parts the
// original's HTML refers to with an <img src="cid:..."> become this session's images (cleaned and turned upright like a pasted image,
// within the 10 MB, pixel and 25 MB limits), in the order the HTML refers to them; one part referred to twice is one
// image; a cid: elsewhere (a background, a link, a CSS url(), the text) is left alone. What is not taken stays a cid: reference the editor drops: a reply leaves it out, a forward attaches it, and
// a forward does not attach a taken image again. Claude's quote (safeQuote) and a body left out (omitBody) are as
// before. Sent: our own inline parts. A draft of such a reply opened again: the images back in the new session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { memoryIndex, addAccount, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { pngFile, jpegFile, headerDecode, JPEG_SCAN_DATA } from './helpers/inline-images.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { MessageReader } from '../app/main/reader.js'
import { Composer } from '../app/main/compose.js'
import { Contacts } from '../core/db/contacts.js'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'

const ME = 'teszt@example.invalid'
const NOW = Date.UTC(2026, 10, 20, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const t0 = performance.now()
  while (!(await fn())) {
    if (performance.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const purify = createDOMPurify(new JSDOM('').window)
const INL = /inl-img:\/\/session\/([0-9a-f-]{36})\/([0-9a-f]{24})/g
const srcsOf = html => [...html.matchAll(INL)].map(m => ({ sid: m[1], id: m[2] }))
// the app's upright-turner stands in: a clean image of the turned size
const fakeUpright = (bytes, type, orientation) => {
  const { width, height } = headerDecode(bytes)
  const [w, h] = orientation >= 5 ? [height, width] : [width, height]
  return type === 'image/png' ? pngFile(w, h) : jpegFile(w, h)
}
// a JPEG whose kept scan is `n` bytes (the cleaning keeps the scan byte for byte): a big image without a big decode
const bigJpeg = (w, h, n) => {
  const base = jpegFile(w, h)
  const at = base.indexOf(JPEG_SCAN_DATA)
  return Buffer.concat([base.subarray(0, at), Buffer.alloc(n, 0x11), base.subarray(at + JPEG_SCAN_DATA.length)])
}
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(40)])
const PDF = Buffer.from('%PDF-1.4\n% egy melléklet\n%%EOF\n')

const original = ({ html, attachments }) =>
  new MailComposer({ from: 'Kovács Árpád <arpad@sender.invalid>', to: ME, subject: 'Képes levél', messageId: '<kepes@sender.invalid>', date: new Date(NOW), html, text: 'Szia!', attachments }).compile().build()

async function setup(t, mail, { decoder = true } = {}) {
  const received = []
  const smtp = new SMTPServer({
    disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN'], logger: false,
    onAuth: (a, _s, cb) => cb(null, { user: a.username }),
    onData(stream, session, cb) {
      const chunks = []
      stream.on('data', c => chunks.push(c))
      stream.on('end', () => (received.push(Buffer.concat(chunks)), cb()))
    },
  })
  smtp.on('error', () => {})
  await new Promise(r => smtp.listen(0, '127.0.0.1', r))
  onCleanup(t, () => new Promise(r => smtp.close(r)))
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { email: ME, display_name: 'Teszt Elek', smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none', smtp_user: ME })
  const imap = new FakeImapServer().addMailbox('INBOX').addMailbox('Drafts', { specialUse: '\\Drafts' }).addMailbox('Sent', { specialUse: '\\Sent' })
  const uid = imap.addMessage('INBOX', { from: 'arpad@sender.invalid', to: ME, subject: 'x', messageId: '<kepes@sender.invalid>', date: NOW, body: 'x', source: await original(mail) })
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: 'jelszo', smtp: 'jelszo' }),
  }
  const storeDir = path.join(tempDir(t), 'store')
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), notify: () => {}, connect: () => imap.connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => manager.entries.get(row.id).idle.connected)
  const reader = new MessageReader({ index, sealed: sealedStore(storeDir), withConnection: (id, fn) => manager.withConnection(id, fn) })
  const composer = new Composer({
    index, store, contacts: new Contacts(db), storeDir, sealed: sealedStore(storeDir), reader,
    decodeImage: decoder ? headerDecode : null, uprightImage: fakeUpright,
    withConnection: (id, fn) => manager.withConnection(id, fn),
    requestSync: (id, f) => manager.requestSync(id, f),
    now: () => NOW,
  })
  const messageId = index.getByUid(row.id, 'INBOX', uid).id
  const prepare = async (mode, extra = {}) => {
    const sid = composer.open()
    return { sid, form: await composer.prepare(sid, { mode, messageId, ...extra }) }
  }
  // what the composer sends: its own sanitizer over the text (the editor keeps only this session's images)
  const send = (sid, form, html = `<p>Válaszom.</p>${form.quote}`) =>
    composer.sendNow(sid, { accountId: form.accountId, to: form.to || 'Valaki <valaki@example.invalid>', cc: form.cc || '', bcc: '', subject: form.subject, html: sanitizeCompose(purify, html, { sessionId: sid }), inReplyTo: form.inReplyTo, references: form.references })
  return { db, index, row, imap, composer, prepare, send, received }
}

// two referred PNG / JPEG (the PNG twice, its Content-ID in another case than the reference), an image no one refers
// to, a PDF, and a reference to a cid no part has
const A = pngFile(40, 20, { seed: 1 })
const B = jpegFile(120, 60, { exif: 6 })
const C = pngFile(30, 30, { seed: 2 })
const MAIN = {
  html: '<p>Nézd:</p><p><img src="cid:logo.a@x"></p><p><img src="cid:fotó@x"></p><p>Újra: <img src="cid:LOGO.A@x"> és <img src="cid:nincs@x"></p>',
  attachments: [
    { filename: 'logo.png', content: A, contentType: 'image/png', cid: 'Logo.A@x' },
    { filename: 'foto.jpg', content: B, contentType: 'image/jpeg', cid: 'fotó@x' },
    { filename: 'nem-hivatkozott.png', content: C, contentType: 'image/png', cid: 'unused@x' },
    { filename: 'szerzodes.pdf', content: PDF, contentType: 'application/pdf' },
  ],
}

test('reply: the two referred images in the quote as this session\'s images (the one referred twice is one image), no attachment; a cid no part has stays', async t => {
  const s = await setup(t, MAIN)
  const { sid, form } = await s.prepare('reply')
  const srcs = srcsOf(form.quote)
  assert.equal(srcs.length, 3, form.quote)
  assert.ok(srcs.every(x => x.sid === sid))
  assert.equal(srcs[0].id, srcs[2].id, 'cid:LOGO.A@x is <Logo.A@x>: the same image')
  assert.notEqual(srcs[0].id, srcs[1].id)
  assert.ok(s.composer.inlineImageOf(sid, srcs[0].id).bytes.equals(A), 'the PNG byte for byte (nothing to clean)')
  const photo = s.composer.inlineImageOf(sid, srcs[1].id)
  assert.ok(!photo.bytes.includes(Buffer.from('GPS', 'latin1')) && !photo.bytes.includes(Buffer.from('Exif', 'latin1')), 'no Exif / GPS')
  assert.deepEqual(headerDecode(photo.bytes), { width: 60, height: 120 }, 'turned upright (Orientation 6)')
  assert.deepEqual(form.quote.match(/cid:[^"]+/g), ['cid:nincs@x'], 'only the reference without a part is left')
  assert.deepEqual(s.composer.attachmentList(sid), [])
})

test('forward: the same images in the quote; attached only the PDF and the image no one refers to (a taken image not twice)', async t => {
  const s = await setup(t, MAIN)
  const { sid, form } = await s.prepare('forward')
  assert.equal(new Set(srcsOf(form.quote).map(x => x.id)).size, 2)
  assert.deepEqual(s.composer.attachmentList(sid).map(a => a.filename).sort(), ['nem-hivatkozott.png', 'szerzodes.pdf'])
})

test('sent: a reply with the quote\'s images is multipart/related with our own cids, the HTML refers to them; an image deleted from the quote does not go', async t => {
  const s = await setup(t, MAIN)
  const { sid, form } = await s.prepare('reply')
  assert.equal((await s.send(sid, form)).sent, true)
  const raw = s.received[0]
  assert.match(raw.toString('latin1'), /multipart\/related/i)
  const got = await simpleParser(raw, { keepCidLinks: true })
  const parts = got.attachments.filter(a => a.cid)
  assert.equal(parts.length, 2)
  assert.ok(parts.every(p => /^img-[0-9a-f]{24}@shadowmail$/.test(p.cid) && got.html.includes(`cid:${p.cid}`)), got.html)
  assert.ok(!/inl-img|cid:logo|cid:fot|cid:nincs/i.test(got.html), got.html)
  assert.ok(!raw.toString('latin1').includes('GPS 47'))
  // a second reply, the photo deleted from the quote
  const second = await s.prepare('reply')
  const photoSrc = `inl-img://session/${second.sid}/${srcsOf(second.form.quote)[1].id}`
  const html = `<p>Csak a logó.</p>${second.form.quote.replace(`<img src="${photoSrc}">`, '')}`
  await s.send(second.sid, second.form, html)
  const parts2 = (await simpleParser(s.received[1], { keepCidLinks: true })).attachments.filter(a => a.cid)
  assert.equal(parts2.length, 1)
  assert.ok(parts2[0].content.equals(A))
})

test('sent: a forward has each taken image once, embedded; the PDF and the unreferred image as attachments', async t => {
  const s = await setup(t, MAIN)
  const { sid, form } = await s.prepare('forward')
  await s.send(sid, form)
  const got = await simpleParser(s.received[0], { keepCidLinks: true })
  const inline = got.attachments.filter(a => a.cid && got.html.includes(`cid:${a.cid}`))
  const attached = got.attachments.filter(a => !inline.includes(a))
  assert.equal(inline.length, 2)
  assert.deepEqual(attached.map(a => a.filename).sort(), ['nem-hivatkozott.png', 'szerzodes.pdf'])
  assert.equal(got.attachments.filter(a => a.content.equals(A)).length, 1, 'the logo once')
})

test('a draft of such a reply saved and opened again: the images are back in the new session', async t => {
  const s = await setup(t, MAIN)
  const { sid, form } = await s.prepare('reply')
  await s.composer.saveDraft(sid, { accountId: form.accountId, to: form.to, cc: '', bcc: '', subject: form.subject, html: sanitizeCompose(purify, `<p>Félkész.</p>${form.quote}`, { sessionId: sid }), inReplyTo: form.inReplyTo, references: form.references })
  const drafts = [...s.imap.mailboxes.get('Drafts').messages.values()]
  assert.equal(drafts.length, 1)
  const row = { id: 9999, account_id: s.row.id, folder: 'Drafts', message_id: null }
  s.composer.reader = { source: async () => ({ row, source: drafts[0].source }) }
  const sid2 = s.composer.open()
  const f = await s.composer.prepare(sid2, { mode: 'draft', messageId: 9999 })
  const srcs = srcsOf(f.draftHtml)
  assert.equal(new Set(srcs.map(x => x.id)).size, 2, f.draftHtml)
  assert.ok(srcs.every(x => x.sid === sid2))
  assert.ok(srcs.some(x => s.composer.inlineImageOf(sid2, x.id).bytes.equals(A)))
})

test('not taken: a GIF, an 11 MB JPEG, a damaged PNG: a reply leaves them out, a forward attaches them', async t => {
  const png = pngFile(20, 20)
  const mail = {
    html: '<p><img src="cid:gif@x"><img src="cid:big@x"><img src="cid:broken@x"><img src="cid:ok@x"></p>',
    attachments: [
      { filename: 'anim.gif', content: GIF, contentType: 'image/gif', cid: 'gif@x' },
      { filename: 'nagy.jpg', content: bigJpeg(100, 100, 11 * 1024 * 1024), contentType: 'image/jpeg', cid: 'big@x' },
      { filename: 'serult.png', content: png.subarray(0, png.length - 5), contentType: 'image/png', cid: 'broken@x' },
      { filename: 'jo.png', content: png, contentType: 'image/png', cid: 'ok@x' },
    ],
  }
  const s = await setup(t, mail)
  const reply = await s.prepare('reply')
  assert.equal(srcsOf(reply.form.quote).length, 1, 'only the good PNG')
  const kept = sanitizeCompose(purify, reply.form.quote, { sessionId: reply.sid })
  assert.equal((kept.match(/<img/g) || []).length, 1, 'the editor drops the three others')
  assert.deepEqual(s.composer.attachmentList(reply.sid), [])
  const fwd = await s.prepare('forward')
  assert.deepEqual(s.composer.attachmentList(fwd.sid).map(a => a.filename).sort(), ['anim.gif', 'nagy.jpg', 'serult.png'])
})

test('the 25 MB of the session: the images up to it are taken in the HTML\'s order, the next one is not (a forward attaches it)', async t => {
  const MB = 1024 * 1024
  const mail = {
    html: '<p><img src="cid:k3@x"><img src="cid:k1@x"><img src="cid:k2@x"></p>',
    attachments: [1, 2, 3].map(i => ({ filename: `kep${i}.jpg`, content: bigJpeg(100 + i, 100, 9 * MB), contentType: 'image/jpeg', cid: `k${i}@x` })),
  }
  const s = await setup(t, mail)
  const reply = await s.prepare('reply')
  const srcs = srcsOf(reply.form.quote)
  assert.equal(srcs.length, 2, 'k3 and k1 (the HTML\'s order), not k2')
  assert.deepEqual(srcs.map(x => headerDecode(s.composer.inlineImageOf(reply.sid, x.id).bytes).width), [103, 101])
  assert.match(reply.form.quote, /cid:k2@x/)
  const fwd = await s.prepare('forward')
  assert.deepEqual(s.composer.attachmentList(fwd.sid).map(a => a.filename), ['kep2.jpg'])
})

test('a cid of another message or no part: not taken; a reference with a %-encoded Content-ID is', async t => {
  const mail = {
    html: '<p><img src="cid:m%C3%A1sik@x"><img src="cid:valami-mas@y"></p>',
    attachments: [{ filename: 'masik.png', content: A, contentType: 'image/png', cid: 'másik@x' }],
  }
  const s = await setup(t, mail)
  const { form } = await s.prepare('reply')
  assert.equal(srcsOf(form.quote).length, 1)
  assert.match(form.quote, /cid:valami-mas@y/)
})

test('Claude\'s quote (safeQuote) and a body left out (omitBody): the quote and the attachments as before (no image taken)', async t => {
  const s = await setup(t, MAIN)
  const old = await setup(t, MAIN, { decoder: false })
  for (const extra of [{ safeQuote: true }, { omitBody: '[Idézet nélkül]' }]) {
    for (const mode of ['reply', 'forward']) {
      const now = await s.prepare(mode, extra)
      const before = await old.prepare(mode, extra)
      assert.equal(now.form.quote, before.form.quote, `${mode} ${JSON.stringify(extra)}`)
      assert.ok(!/inl-img/.test(now.form.quote))
      assert.deepEqual(s.composer.attachmentList(now.sid).map(a => [a.filename, a.size]), old.composer.attachmentList(before.sid).map(a => [a.filename, a.size]))
    }
  }
  // without a decoder (as before this change): no image is taken anywhere, a forward attaches everything
  const fwd = await old.prepare('forward')
  assert.equal(srcsOf(fwd.form.quote).length, 0)
  assert.deepEqual(old.composer.attachmentList(fwd.sid).map(a => a.filename).sort(), ['foto.jpg', 'logo.png', 'nem-hivatkozott.png', 'szerzodes.pdf'])
})

test('forward: a part referred to only outside an <img src> (a table background, a link, a CSS url()) is attached as before, not taken', async t => {
  const BG = pngFile(50, 50, { seed: 9 })
  const LOGO = pngFile(60, 20, { seed: 8 })
  const mail = {
    html: '<table><tr><td background="cid:bg@x">Hírlevél</td></tr></table><p><a href="cid:logo@x">logó</a></p><div style="background:url(cid:bg@x)">x</div>',
    attachments: [
      { filename: 'hatter.png', content: BG, contentType: 'image/png', cid: 'bg@x' },
      { filename: 'logo.png', content: LOGO, contentType: 'image/png', cid: 'logo@x' },
    ],
  }
  const s = await setup(t, mail)
  const { sid, form } = await s.prepare('forward')
  assert.equal(srcsOf(form.quote).length, 0, form.quote)
  assert.deepEqual(s.composer.attachmentList(sid).map(a => a.filename).sort(), ['hatter.png', 'logo.png'])
  await s.send(sid, form)
  const got = await simpleParser(s.received[0], { keepCidLinks: true })
  assert.ok(got.attachments.some(a => a.content.equals(BG)) && got.attachments.some(a => a.content.equals(LOGO)), 'both parts go out')
  // a reply takes nothing and attaches nothing (as before)
  const reply = await s.prepare('reply')
  assert.equal(srcsOf(reply.form.quote).length, 0)
  assert.deepEqual(s.composer.attachmentList(reply.sid), [])
})

test('a cid: written as text, or in another attribute of an <img>, stays as it is; only the src is taken', async t => {
  const LOGO = pngFile(60, 20, { seed: 8 })
  const mail = {
    html: '<p>A kép azonosítója: cid:logo@x</p><p><img alt="src=cid:logo@x" data-x="cid:logo@x" src="cid:logo@x"></p>',
    attachments: [{ filename: 'logo.png', content: LOGO, contentType: 'image/png', cid: 'logo@x' }],
  }
  const s = await setup(t, mail)
  const { sid, form } = await s.prepare('reply')
  const srcs = srcsOf(form.quote)
  assert.equal(srcs.length, 1, form.quote)
  assert.match(form.quote, /A kép azonosítója: cid:logo@x/)
  assert.match(form.quote, /alt="src=cid:logo@x" data-x="cid:logo@x" src="inl-img:\/\/session\//)
  await s.send(sid, form)
  const got = await simpleParser(s.received[0], { keepCidLinks: true })
  assert.ok(!got.html.includes('inl-img://') && !got.text.includes('inl-img://'), got.html)
  assert.match(got.text, /cid:logo@x/)
  assert.equal(got.attachments.filter(a => a.cid).length, 1)
})

test('an <img> src with single quotes, without quotes, with spaces around the =, or in upper case is taken', async t => {
  const parts = [1, 2, 3, 4].map(i => ({ filename: `k${i}.png`, content: pngFile(10 + i, 10, { seed: i }), contentType: 'image/png', cid: `k${i}@x` }))
  const mail = { html: `<p><img src='cid:k1@x'><img src=cid:k2@x><IMG SRC = "cid:k3@x"><img width="5" src="CID:k4@x" /></p>`, attachments: parts }
  const s = await setup(t, mail)
  const { sid, form } = await s.prepare('forward')
  assert.equal(new Set(srcsOf(form.quote).map(x => x.id)).size, 4, form.quote)
  assert.ok(!/cid:/i.test(form.quote), form.quote)
  assert.deepEqual(s.composer.attachmentList(sid), [])
})

test('the <img> search is linear: 40 000 unclosed <img tags and quotes after a real image, no > after them', async t => {
  const LOGO = pngFile(60, 20, { seed: 8 })
  // no > after the junk: each unclosed <img would have to read to the end of the HTML to fail
  const junk = '<img a '.repeat(40000) + '<img a="'.repeat(40000)
  const s = await setup(t, { html: `<p><img src="cid:logo@x"></p><p>${junk}`, attachments: [{ filename: 'logo.png', content: LOGO, contentType: 'image/png', cid: 'logo@x' }] })
  const t0 = performance.now()
  const { form } = await s.prepare('reply')
  const ms = performance.now() - t0
  assert.ok(ms < 2000, `${Math.round(ms)} ms`)
  assert.equal(srcsOf(form.quote).length, 1)
})

test('two parts whose Content-IDs differ only in case: each reference gets its own image in the quote', async t => {
  const SMALL = pngFile(30, 10, { seed: 5 })
  const BIG = pngFile(40, 10, { seed: 6 })
  const mail = {
    html: '<p><img src="cid:pair@x"><img src="cid:PAIR@x"></p>',
    attachments: [
      { filename: 'kis.png', content: SMALL, contentType: 'image/png', cid: 'pair@x' },
      { filename: 'nagy.png', content: BIG, contentType: 'image/png', cid: 'PAIR@x' },
    ],
  }
  const s = await setup(t, mail)
  const { sid, form } = await s.prepare('forward')
  const srcs = srcsOf(form.quote)
  assert.equal(srcs.length, 2, form.quote)
  assert.ok(s.composer.inlineImageOf(sid, srcs[0].id).bytes.equals(SMALL))
  assert.ok(s.composer.inlineImageOf(sid, srcs[1].id).bytes.equals(BIG))
  assert.deepEqual(s.composer.attachmentList(sid), [], 'both taken, none attached again')
})
