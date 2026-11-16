// SPDX-License-Identifier: GPL-3.0-or-later
// The message parse without mailparser's quadratic HTML -> text on the main thread: every fixture and the normal sample
// messages give the old preview, old-rule text, search text, reader view and reply quote byte for byte; an HTML over
// MAIN_HTML_LIMIT is parsed fast and gets its preview from the worker (our linear converter), later; the cap is exact.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { simpleParser } from 'mailparser'
import { tempDir, onCleanup } from './helpers/tmp.js'
import { memoryIndex, addAccount, addMessage, sealedStore } from './helpers/fixtures.js'
import { writeNormal } from './helpers/bomb-samples.js'
import { newsletterHtml } from './helpers/newsletter.js'
import {
  INDEX_PARSE, PREVIEW_PARSE, SEARCH_PARSE, LATE_PARSE, MAIN_HTML_LIMIT, bodyFromSource, oldTextOf, previewOf, searchTextOf, htmlTooLong, latePreviewOf,
  makePreview,
} from '../core/mime/text.js'
import { parseMessage } from '../core/mime/message.js'
import { searchResultHere, searchTextHere, SearchTextService } from '../core/mime/search-text-service.js'
import { quoteHtml, forwardHtml } from '../core/smtp/compose.js'
import { hu } from '../app/renderer/i18n/hu.js'
import { createSearchRefiner, createFtsReindex, FLAG, FLAG_DONE } from '../app/main/search-index.js'
import { FakePop3Server } from './helpers/fake-pop3.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { MessageReader } from '../app/main/reader.js'
import { openSettings } from '../app/main/settings.js'

const eml = (type, body, extraHeaders = '') =>
  Buffer.from(`From: Teszt <t@example.invalid>\r\nTo: m@example.invalid\r\nSubject: PM1\r\nDate: Mon, 16 Nov 2026 01:00:00 +0100\r\nMessage-ID: <pm1@example.invalid>\r\nMIME-Version: 1.0\r\n${extraHeaders}Content-Type: ${type}\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`)
const html = body => eml('text/html; charset=utf-8', body)
const table = (cells, chars, fill = 'x') => `<html><body><table>${Array.from({ length: cells }, () => `<tr><td>${fill.repeat(chars)}</td></tr>`).join('')}</table></body></html>`
const multipart = (kind, parts) =>
  Buffer.from(
    `From: Teszt <t@example.invalid>\r\nTo: m@example.invalid\r\nSubject: PM1 ${kind}\r\nDate: Mon, 16 Nov 2026 01:00:00 +0100\r\nMIME-Version: 1.0\r\nContent-Type: multipart/${kind}; boundary="B"\r\n\r\n` +
      parts.map(([type, body]) => `--B\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`).join('') +
      '--B--\r\n',
  )

// the samples whose output must not change: every repository fixture, the generated normal messages (bomb-samples writeNormal), and generated ones
function samples() {
  const out = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.eml')) out.push([path.relative('test/fixtures', p), fs.readFileSync(p)])
    }
  }
  walk('test/fixtures')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm1-normal-'))
  try {
    for (const [file] of writeNormal(dir)) out.push([`normal/${file}`, fs.readFileSync(path.join(dir, file))])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  out.push(['html-only newsletter', html(`<html><body>${newsletterHtml({ blocks: 300, rules: 20 })}</body></html>`)])
  out.push(['html-only table 200 x 1000', html(table(200, 1000))])
  out.push(['html-only words table', html(table(500, 30, 'ab cd '))])
  out.push(['alternative', multipart('alternative', [['text/plain', 'Szia,\r\nez a sima rész.'], ['text/html', '<p>Szia, <b>ez</b> a HTML rész.</p>']])])
  out.push(['mixed text + html', multipart('mixed', [['text/plain', 'Elöl a sima szöveg.'], ['text/html', '<table><tr><td>cella egy</td><td>cella kettő</td></tr></table>']])])
  out.push(['plain', eml('text/plain; charset=utf-8', 'Csak sima szöveg,\r\nkét sorban.')])
  out.push(['html at the cap', html(`<p>${'y'.repeat(MAIN_HTML_LIMIT - 7)}</p>`)])
  return out
}

// the OLD code of each output, from the old parse (INDEX_PARSE / parseMessage's old options, conversion on, no cap)
const OLD_MESSAGE_PARSE = { keepCidLinks: true, skipImageLinks: true, skipTextLinks: true, skipTextToHtml: true }
async function oldOutputs(source) {
  const p = await simpleParser(source, INDEX_PARSE)
  const m = await simpleParser(source, OLD_MESSAGE_PARSE)
  const mHtml = typeof m.html === 'string' && m.html ? m.html : null
  return {
    oldText: oldTextOf(p),
    preview: previewOf(p),
    search: searchTextOf(p),
    readerPin: { text: oldTextOf({ text: m.text || '', html: mHtml }), preview: previewOf({ text: m.text || '', html: mHtml }) },
    view: { html: mHtml, text: mHtml ? null : typeof m.text === 'string' ? m.text : '' },
    messageText: typeof m.text === 'string' ? m.text : '',
  }
}

// which samples are over the cap (an HTML part longer than MAIN_HTML_LIMIT characters): mailparser's own skip decides
const overCap = async source => htmlTooLong(await simpleParser(source, PREVIEW_PARSE))

test('byte for byte: every fixture and normal sample: search text, reader view, reply quote; within the cap also the preview and the old-rule text; over it the worker preview', async t => {
  const all = samples()
  assert.ok(all.length >= 30, `${all.length} samples`)
  const over = []
  for (const [name, source] of all) {
    const old = await oldOutputs(source)
    const big = await overCap(source)
    if (big) over.push(name)
    const withWorker = await bodyFromSource(source, { oldText: true })
    const without = await bodyFromSource(source, { oldText: false })
    // whatever the size: the search text, the reader view and the quote are the old ones
    assert.equal(without.text, old.search, `${name}: search text (no worker)`)
    assert.equal(await searchTextHere(source), old.search, `${name}: the worker's search text`)
    const view = await parseMessage(source)
    assert.deepEqual({ html: view.html, text: view.html ? null : view.text }, old.view, `${name}: reader view`)
    // the quote and the forward of the new parse = of the same message with the OLD text field (the conversion's result)
    for (const make of [quoteHtml, forwardHtml]) assert.equal(make(view, hu.outgoingQuote, 'hu-HU'), make({ ...view, text: old.messageText }, hu.outgoingQuote, 'hu-HU'), `${name}: ${make.name}`)
    const pin = await parseMessage(source, { htmlText: true })
    const late = (await searchResultHere(source)).preview
    if (!big) {
      assert.equal(withWorker.text, old.oldText, `${name}: old-rule text`)
      assert.equal(withWorker.preview, old.preview, `${name}: preview (worker path)`)
      assert.equal(without.preview, old.preview, `${name}: preview (no worker)`)
      assert.equal(pin.htmlTextLate, false, `${name}: within the cap`)
      assert.deepEqual({ text: oldTextOf(pin), preview: previewOf(pin) }, old.readerPin, `${name}: reader pin of a row not indexed`)
      // the worker's preview (its parse has the inline images as data: URIs, so its HTML can be longer) goes only into a
      // row without one: within the cap the main thread always made one
      assert.ok(late === null || typeof withWorker.preview === 'string', `${name}: a late preview only where the main thread wrote one`)
    } else {
      // over the cap (DECISION 3789 (b)): nothing on the main thread, the worker's preview with our converter, not empty
      assert.deepEqual([withWorker.text, withWorker.preview], ['', null], `${name}: over the cap: no old text, no preview on the main thread`)
      assert.equal(pin.htmlTextLate, true, `${name}: over the cap (reader pin)`)
      assert.ok(typeof late === 'string' && late.length > 0, `${name}: the worker's preview is not empty`)
      assert.equal(late, previewOf(await simpleParser(source, SEARCH_PARSE)), `${name}: the worker's preview is the old rule with our converter`)
    }
  }
  t.diagnostic(`over the cap: ${over.join(', ') || 'none'}`)
  // the generated long HTML (writeNormal) (0.59 MB, HTML only) is the one normal sample over the cap
  assert.deepEqual(over, ['normal/c-long-html.eml'])
})

test('the cap is exact: an HTML part of MAIN_HTML_LIMIT characters is converted by mailparser as before, one more is not', async () => {
  const at = html('y'.repeat(MAIN_HTML_LIMIT))
  const over = html('y'.repeat(MAIN_HTML_LIMIT + 1))
  const pAt = await simpleParser(at, PREVIEW_PARSE)
  const pOver = await simpleParser(over, PREVIEW_PARSE)
  assert.equal(htmlTooLong(pAt), false)
  assert.equal(pAt.text, (await simpleParser(at, INDEX_PARSE)).text, 'at the cap: the old conversion')
  assert.equal(htmlTooLong(pOver), true)
  assert.equal(pOver.text, '')
  // the worker's late preview: only over the cap, the old rule with our converter
  assert.equal(latePreviewOf(await simpleParser(at, LATE_PARSE)), null)
  assert.equal(latePreviewOf(await simpleParser(over, LATE_PARSE)), 'y'.repeat(200))
})

// a multipart/mixed with a text/plain part and HTML parts of the given lengths (mailparser converts every HTML part)
const mixedHtml = lengths => multipart('mixed', [['text/plain', 'Elöl a sima rész.'], ...lengths.map((n, i) => ['text/html', `<p>${String(i).repeat(n - 7)}</p>`])])
test('the cap is on the SUM of the converted HTML parts: at the cap mailparser converts every part as before, one character more none', async () => {
  const half = MAIN_HTML_LIMIT / 2
  const at = mixedHtml([half, half])
  const over = mixedHtml([half, half + 1])
  const pAt = await simpleParser(at, PREVIEW_PARSE)
  const pOver = await simpleParser(over, PREVIEW_PARSE)
  assert.equal(htmlTooLong(pAt), false)
  assert.equal(pAt.text, (await simpleParser(at, INDEX_PARSE)).text, 'at the cap: the old conversion, byte for byte')
  assert.equal((await bodyFromSource(at, { oldText: true })).preview, (await oldOutputs(at)).preview)
  assert.equal(htmlTooLong(pOver), true, 'one more: over (each part alone is under the cap)')
  assert.equal(pOver.text, 'Elöl a sima rész.\n\n', 'no HTML part converted, the text/plain part stays')
  assert.deepEqual(await bodyFromSource(over, { oldText: true }), { text: '', preview: null, state: 1 }, 'the main thread leaves it to the worker')
  const view = await parseMessage(over, { htmlText: true })
  assert.equal(view.htmlTextLate, true, 'the reader pin path: the same cap')
  assert.equal((await parseMessage(at, { htmlText: true })).htmlTextLate, false)
  // the worker: the old rule with our converter, the text/plain part first, then every HTML part, in mailparser's order
  const late = latePreviewOf(await simpleParser(over, LATE_PARSE))
  assert.equal(late, makePreview(['Elöl a sima rész.', '0'.repeat(half - 7), '1'.repeat(half + 1 - 7)].join(' ')))
  assert.equal(latePreviewOf(await simpleParser(at, LATE_PARSE)), null)
  // an alternative's HTML is never converted (the text part is the text): no cap, however long
  const alt = multipart('alternative', [['text/plain', 'Sima.'], ['text/html', `<p>${'z'.repeat(MAIN_HTML_LIMIT * 2)}</p>`]])
  assert.equal(htmlTooLong(await simpleParser(alt, PREVIEW_PARSE)), false)
  assert.equal((await bodyFromSource(alt, { oldText: true })).preview, (await oldOutputs(alt)).preview)
})

test('the walk of html-total.js is mailparser\'s own: with mailparser\'s converter it gives its text byte for byte on every sample', async () => {
  const { convert } = await import('html-to-text')
  // mailparser 3.14.3: htmlToText(html, { limits: { maxDepth: 1000 } })
  const same = h => convert(h, { limits: { maxDepth: 1000 } })
  const forced = { ...INDEX_PARSE, htmlTotal: { cap: -1, linear: same } }
  let n = 0
  for (const [name, source] of [...samples(), ['mixed text + 2 html', mixedHtml([300, 500])], ['nested', multipart('mixed', [['text/html', '<p>egy</p>'], ['text/plain', 'kettő'], ['text/html', '<p>három</p>']])]]) {
    if (await overCap(source)) continue
    const old = await simpleParser(source, INDEX_PARSE)
    const walked = await simpleParser(source, forced)
    if (!old.html || !old.text) continue
    assert.equal(walked.text, old.text, name)
    n++
  }
  assert.ok(n >= 10, `${n} samples with HTML and text`)
})

const timed = async fn => {
  const t0 = performance.now()
  const r = await fn()
  return [r, performance.now() - t0]
}

test('the big table messages (4 MB of 1000-character cells, 5.3 MB of tiny cells): fast on the main thread, the worker makes a non-empty preview', async t => {
  for (const [name, source] of [['4000 x 1000', html(table(4000, 1000))], ['200 000 x 10', html(table(200_000, 10))]]) {
    const [body, msBody] = await timed(() => bodyFromSource(source, { oldText: true }))
    assert.deepEqual([body.text, body.preview, body.state], ['', null, 1], `${name}: no old text, no preview on the main thread`)
    const [view, msView] = await timed(() => parseMessage(source))
    assert.ok(view.html && view.text === '', `${name}: the reader view gets the HTML`)
    const [pin, msPin] = await timed(() => parseMessage(source, { htmlText: true }))
    assert.equal(pin.htmlTextLate, true, `${name}: over the cap`)
    const [late, msWorker] = await timed(() => searchResultHere(source))
    assert.ok(late.preview && late.preview.length === 200, `${name}: the late preview is not empty`)
    t.diagnostic(`${name}: bodyFromSource ${msBody.toFixed(0)} ms, parseMessage ${msView.toFixed(0)} ms, with htmlText ${msPin.toFixed(0)} ms, the worker's work ${msWorker.toFixed(0)} ms`)
    // the conditions are measured by a tool in a process of their own; here a loose bound that no load turns
    // around (the old code: 3 s and 89 s)
    for (const [what, ms] of [['bodyFromSource', msBody], ['parseMessage', msView], ['parseMessage htmlText', msPin]]) assert.ok(ms < 1500, `${name}: ${what} ${ms.toFixed(0)} ms`)
    assert.ok(msWorker < 6000, `${name}: the worker's work ${msWorker.toFixed(0)} ms`)
  }
})

test('the refiner writes the late preview into an indexed row without one, and never over a preview', async t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db)
  const big = html(table(2000, 300))
  const add = (uid, body) => {
    addMessage(index, acc.id, { uid, messageId: `<m${uid}@x>`, subject: 's', date: 1 })
    const id = index.getByUid(acc.id, 'INBOX', uid).id
    index.setBodies([{ id, text: body.text, state: body.state, preview: body.preview }])
    return id
  }
  const bigId = add(1, await bodyFromSource(big, { oldText: true }))
  assert.equal(index.get(bigId).preview, null, 'no preview until the worker')
  const keepId = add(2, { text: 'régi', state: 1, preview: 'a meglévő előnézet' })
  const service = new SearchTextService({ inline: true })
  const settings = { set: () => {} }
  const refiner = createSearchRefiner({ service, index, settings })
  await refiner.refineMany([{ id: bigId, accountId: acc.id, local: false, source: big }, { id: keepId, accountId: acc.id, local: false, source: big }])
  // inline: the text is made at once, written in a microtask after the queueing
  for (let i = 0; i < 100 && index.get(bigId).preview === null; i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(index.get(bigId).preview, 'x'.repeat(200), 'the late preview')
  assert.equal(index.get(keepId).preview, 'a meglévő előnézet', 'an existing preview stays')
  assert.equal(index.setLatePreview(bigId, 'más'), false, 'written once only')
})

test('a linked HTML-only message: within the cap the preview keeps mailparser\'s "[http..." link targets, over it (our converter) it has none', async () => {
  const linked = n => html(`<html><body>${Array.from({ length: n }, (_, i) => `<p><a href="https://example.invalid/${i}">Termék ${i}</a> leírás ${i}</p>`).join('')}</body></html>`)
  const small = linked(50)
  const big = linked(8000)
  assert.ok((await overCap(big)) && !(await overCap(small)))
  const smallPreview = (await bodyFromSource(small, { oldText: true })).preview
  assert.match(smallPreview, /\[http/, 'within the cap: the old preview, with the link targets')
  assert.equal(smallPreview, (await oldOutputs(small)).preview)
  assert.equal((await bodyFromSource(big, { oldText: true })).preview, null, 'over the cap: none on the main thread')
  const late = (await searchResultHere(big)).preview
  assert.ok(late.startsWith('Termék 0 leírás 0 Termék 1'), late)
  assert.doesNotMatch(late, /\[http/, 'over the cap: no link target')
})

test('the parse options: INDEX_PARSE is unchanged (shared), the new ones add only their own keys', () => {
  assert.deepEqual(INDEX_PARSE, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true })
  assert.deepEqual(PREVIEW_PARSE, { ...INDEX_PARSE, maxHtmlLengthToParse: MAIN_HTML_LIMIT, htmlTotal: { cap: MAIN_HTML_LIMIT } })
  assert.deepEqual(SEARCH_PARSE, { ...INDEX_PARSE, skipHtmlToText: true })
  assert.deepEqual(Object.keys(LATE_PARSE).sort(), [...Object.keys(SEARCH_PARSE), 'htmlTotal'].sort())
  assert.equal(LATE_PARSE.htmlTotal.cap, MAIN_HTML_LIMIT)
  assert.equal(MAIN_HTML_LIMIT, 256 * 1024)
  for (const o of [PREVIEW_PARSE, SEARCH_PARSE, LATE_PARSE, LATE_PARSE.htmlTotal, PREVIEW_PARSE.htmlTotal]) assert.ok(Object.isFrozen(o))
  void tempDir
})

// A POP3 message over the cap whose worker item is lost gets its preview later.
const NOW = Date.UTC(2026, 10, 16, 9, 0, 0)
const until = async (fn, ms = 60_000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise(r => setTimeout(r, 10))
  }
}
// a POP3 account with one table message over the cap (searchable word "kesoszo") and one normal message, downloaded
// with the refiner made by makeRefiner({ db, index, settings, sealed }); the row of the big one has no preview and an
// empty search body until the worker. The account's re-index flag is set to done before the download.
async function pop3Late(t, makeRefiner) {
  const server = await new FakePop3Server().listen()
  onCleanup(t, () => server.close())
  const big = html(table(2000, 150, 'kesoszo '))
  assert.ok(await overCap(big))
  server.add(big)
  server.add(eml('text/plain; charset=utf-8', 'Kis levél, rendes előnézettel.'))
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type: 'pop3', ...server.account() })
  const store = { list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id), passwordsFor: () => ({ incoming: server.pass }) }
  const storeDir = path.join(tempDir(t), 'store')
  const settings = openSettings(db)
  settings.set(FLAG(row.id), FLAG_DONE)
  const searchText = makeRefiner({ db, index, settings, sealed: sealedStore(storeDir) })
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [20, 20] }, searchText })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => manager.status()[0].lastFinished && index.stats(row.id).bodies === 2)
  await manager.stopAll()
  // the big one by its size (the download order is not the id order)
  const ids = db.prepare('SELECT id FROM messages ORDER BY size DESC').all().map(r => r.id)
  return { db, index, row, store, storeDir, settings, big, bigId: ids[0], smallId: ids[1] }
}
const ftsBody = (db, id) => db.prepare('SELECT body FROM messages_fts WHERE rowid = ?').get(id).body

test('a message over the cap whose worker item is dropped by a lock: the re-index after the next unlock writes its preview too', async t => {
  // the lock came while the sync was finishing its batch: the refiner is stopped, the local message is lost
  const s = await pop3Late(t, ({ index, settings, sealed }) => {
    const r = createSearchRefiner({ service: new SearchTextService({ inline: true }), index, settings, sealed })
    r.stop()
    return r
  })
  const settings = s.settings
  assert.equal(settings.get(FLAG(s.row.id)), '', 'the lost local message cleared its account flag')
  assert.equal(s.index.get(s.bigId).preview, null, 'over the cap: no preview on the main thread')
  assert.equal(ftsBody(s.db, s.bigId), '', 'and no search body')
  const smallPreview = s.index.get(s.smallId).preview
  assert.ok(smallPreview)
  const svc = new SearchTextService()
  onCleanup(t, () => svc.stop())
  await createFtsReindex({ index: s.index, store: s.store, sealed: sealedStore(s.storeDir), settings, service: svc }).run()
  assert.equal(settings.get(FLAG(s.row.id)), FLAG_DONE)
  assert.equal(s.index.get(s.bigId).preview, (await searchResultHere(s.big)).preview, 'the late preview, from the re-index')
  assert.equal(s.index.search({ query: 'kesoszo' }).length, 1, 'and the search body')
  assert.equal(s.index.get(s.smallId).preview, smallPreview, 'a row with a preview keeps it')
})

test('a message over the cap whose worker item failed: opening it gives it to the worker again, and the preview is written', async t => {
  // a worker that fails this message once (a crash, an unreadable file): { failed }, the row keeps no preview
  let calls = 0
  const failing = { admit: async () => true, release: () => {}, stop: () => {}, compute: async () => (calls++, { failed: 'exit_1' }) }
  const s = await pop3Late(t, ({ index, settings, sealed }) => createSearchRefiner({ service: failing, index, settings, sealed }))
  assert.ok(calls >= 1)
  assert.equal(s.index.get(s.bigId).preview, null)
  const svc = new SearchTextService()
  onCleanup(t, () => svc.stop())
  const refiner = createSearchRefiner({ service: svc, index: s.index, settings: s.settings, sealed: sealedStore(s.storeDir) })
  const reader = new MessageReader({ index: s.index, sealed: sealedStore(s.storeDir), withConnection: async () => { throw new Error('no connection for POP3') }, searchText: refiner })
  await reader.open(s.bigId)
  await until(() => s.index.get(s.bigId).preview !== null)
  assert.equal(s.index.get(s.bigId).preview, (await searchResultHere(s.big)).preview, 'the late preview, after the open')
  assert.equal(s.index.search({ query: 'kesoszo' }).length, 1, 'and the search body')
})

test('over 1000 MIME parts (EMAXLEN) with an HTML over the cap: the main thread fails it as the old parse did (state 2), not only the worker', async () => {
  const big = table(2000, 150, 'kesoszo ')
  const parts = [['text/html', big], ...Array.from({ length: 1100 }, (_, i) => ['application/octet-stream', `x${i}`])]
  const src = multipart('mixed', parts)
  const main = await bodyFromSource(src, { oldText: true })
  assert.deepEqual(main, { text: '', preview: null, state: 2 }, 'the main thread: failed, as before')
  await assert.rejects(simpleParser(src, INDEX_PARSE), { code: 'EMAXLEN' }, 'the old parse threw too')
  await assert.rejects(searchResultHere(src), { code: 'EMAXLEN' }, 'and the worker')
})
