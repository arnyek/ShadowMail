// SPDX-License-Identifier: GPL-3.0-or-later
// The hook of core/mime/html-total.js on mailparser's internal getTextContent (decision 3825): it is on, in the main
// thread AND in the worker; without its own option the output is mailparser's own, byte for byte; its walk follows
// mailparser's order (a message mixing alternative, an embedded message, a delivery status, several text and HTML parts);
// if it cannot be put on, the app goes the old way. Run these before any mailparser version change (CLAUDE.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { simpleParser } from 'mailparser'
import { convert } from 'html-to-text'
import { htmlTotalActive, htmlTotalInternals, exceedsNestingDepth, MAX_NESTING_DEPTH } from '../core/mime/html-total.js'
import { INDEX_PARSE, SEARCH_PARSE, LATE_PARSE, MAIN_HTML_LIMIT, LATE_DEPTH_LIMIT, latePlain, bodyFromSource, htmlTooLong, latePreviewOf, makePreview, previewOf } from '../core/mime/text.js'
import { parseMessage } from '../core/mime/message.js'
import { SearchTextService } from '../core/mime/search-text-service.js'

const CRLF = '\r\n'
const head = (subject, ct) => [`From: A <a@example.invalid>`, 'To: b@example.invalid', `Subject: ${subject}`, 'Date: Mon, 16 Nov 2026 01:00:00 +0100', 'MIME-Version: 1.0', `Content-Type: ${ct}`, '']
const part = (ct, body) => [`Content-Type: ${ct}`, '', body]
// mixed: text, HTML, an alternative (text + HTML), an embedded message (its parts show the meta lines), a delivery
// status, then text and HTML again; `extra` HTML parts at the end
const complex = (extra = []) =>
  Buffer.from(
    [
      ...head('vegyes', 'multipart/mixed; boundary="M"'),
      '--M', ...part('text/plain; charset=utf-8', 'Első sima rész.'),
      '--M', ...part('text/html; charset=utf-8', '<p>Első <b>HTML</b> rész.</p>'),
      '--M', 'Content-Type: multipart/alternative; boundary="A"', '',
      '--A', ...part('text/plain; charset=utf-8', 'Alternatív sima.'),
      '--A', ...part('text/html; charset=utf-8', '<p>Alternatív HTML, nem alakul át.</p>'),
      '--A--',
      '--M', 'Content-Type: message/rfc822', 'Content-Disposition: inline', '', // inline: mailparser shows it (as an attachment it would not)
      'From: Belso <c@example.invalid>', 'To: d@example.invalid', 'Subject: beagyazott', 'Date: Sun, 15 Nov 2026 10:00:00 +0100', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="R"', '',
      '--R', ...part('text/plain; charset=utf-8', 'Beágyazott sima.'),
      '--R', ...part('text/html; charset=utf-8', '<p>Beágyazott HTML.</p>'),
      '--R--',
      '--M', ...part('message/delivery-status', 'Reporting-MTA: dns; mx.example.invalid\r\n\r\nFinal-Recipient: rfc822; x@example.invalid\r\nAction: failed\r\nStatus: 5.1.1'),
      '--M', ...part('text/plain; charset=utf-8', 'Második sima rész.'),
      '--M', ...part('text/html; charset=utf-8', '<table><tr><td>Második</td><td>HTML</td></tr></table>'),
      ...extra.flatMap(h => ['--M', ...part('text/html; charset=utf-8', h)]),
      '--M--', '',
    ].join(CRLF),
  )
const mixed2 = (a, b) => Buffer.from([...head('ketto', 'multipart/mixed; boundary="M"'), '--M', ...part('text/plain; charset=utf-8', 'Sima elöl.'), '--M', ...part('text/html; charset=utf-8', `<p>${'a'.repeat(a - 7)}</p>`), '--M', ...part('text/html; charset=utf-8', `<p>${'b'.repeat(b - 7)}</p>`), '--M--', ''].join(CRLF))

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
  out.push(['complex', complex()], ['mixed 2 small', mixed2(300, 500)])
  return out
}
const MESSAGE_PARSE = { keepCidLinks: true, skipImageLinks: true, skipTextLinks: true, skipTextToHtml: true }
const outputOf = p => ({ text: p.text, html: p.html, textAsHtml: p.textAsHtml, error: p.textConversionError ? String(p.textConversionError.message) : null })

test('the hook is on mailparser\'s parser (red if it cannot be put on: the app would go the slow per-part way)', () => {
  assert.equal(htmlTotalActive, true)
  assert.equal(htmlTotalInternals.proto.getTextContent, htmlTotalInternals.hooked)
  assert.equal(typeof htmlTotalInternals.original, 'function')
})

test('without its own option the hook is mailparser\'s own: every sample, every option set, byte for byte as the method unhooked', async () => {
  const { proto, original, hooked } = htmlTotalInternals
  let n = 0
  for (const [name, source] of samples()) {
    for (const [label, opts] of [['index', INDEX_PARSE], ['search', SEARCH_PARSE], ['message', MESSAGE_PARSE], ['capped per part', { ...INDEX_PARSE, maxHtmlLengthToParse: MAIN_HTML_LIMIT }]]) {
      const withHook = outputOf(await simpleParser(source, opts))
      proto.getTextContent = original
      let without
      try {
        without = outputOf(await simpleParser(source, opts))
      } finally {
        proto.getTextContent = hooked
      }
      assert.deepEqual(withHook, without, `${name} (${label})`)
      n++
    }
  }
  assert.ok(n >= 40, `${n} parses compared`)
})

test('the walk follows mailparser: with its own converter, the text of a message mixing alternative, embedded message, delivery status, text and HTML is mailparser\'s byte for byte', async () => {
  const source = complex()
  const old = await simpleParser(source, INDEX_PARSE)
  // the sample really goes through every branch of the walk
  assert.match(old.text, /Subject: beagyazott/, 'the embedded message\'s meta lines (showMeta)')
  assert.match(old.text, /Status: 5\.1\.1/, 'the delivery status')
  assert.match(old.text, /ELSŐ HTML|Első HTML/i, 'a converted HTML part')
  assert.doesNotMatch(old.text, /nem alakul át/, 'the alternative\'s HTML is not converted')
  const same = h => convert(h, { limits: { maxDepth: 1000 } }) // mailparser 3.14.3's call
  const forced = await simpleParser(source, { ...INDEX_PARSE, htmlTotal: { cap: -1, linear: same } })
  assert.equal(forced.text, old.text)
  assert.equal(htmlTooLong(forced), true)
})

test('main thread and worker: text/plain + two HTML parts each under the cap, over it in all: the late way in both (each thread hooked by its own import)', async t => {
  const half = MAIN_HTML_LIMIT / 2
  const over = mixed2(half, half + 1)
  const at = mixed2(half, half)
  // the main thread: nothing converted, the worker's
  assert.deepEqual(await bodyFromSource(over, { oldText: true }), { text: '', preview: null, state: 1 })
  assert.equal((await parseMessage(over, { htmlText: true })).htmlTextLate, true)
  assert.notEqual((await bodyFromSource(at, { oldText: true })).preview, null, 'at the cap: made here')
  // the worker thread (its own module graph and mailparser instance): only the hook makes this preview
  const svc = new SearchTextService()
  t.after(() => svc.stop())
  const expected = makePreview(['Sima elöl.', 'a'.repeat(half - 7), 'b'.repeat(half + 1 - 7)].join(' '))
  assert.ok(await svc.admit(over.length))
  const r = await svc.compute(over)
  assert.equal(r.preview, expected, 'the worker: the text/plain part, then both HTML parts by our converter')
  assert.ok(await svc.admit(at.length))
  assert.equal((await svc.compute(at)).preview, null, 'at the cap: none from the worker')
  // the CommonJS copy is another instance, not hooked: nothing of the app may load mailparser that way
  const cjs = createRequire(import.meta.url)('mailparser')
  assert.notEqual(cjs.MailParser.prototype.getTextContent, htmlTotalInternals.hooked)
  // every file under app/ and core/ that could load it (a walk, not git grep: the Windows build tests a git archive, no repo)
  const root = fileURLToPath(new URL('..', import.meta.url))
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
  const users = ['app', 'core'].flatMap(d => walk(path.join(root, d))).filter(f => /require\(['"]mailparser|createRequire/.test(fs.readFileSync(f, 'utf8')))
  for (const f of users) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /require\(['"]mailparser/, `${path.relative(root, f)} loads mailparser as CommonJS`)
})

test('if the hook cannot be put on (a frozen prototype): no error, the old way: per-part cap on the main thread, the worker preview by length', async () => {
  // a child process: mailparser's prototype frozen before the app's modules load
  const script = `
    import { MailParser } from 'mailparser'
    Object.freeze(MailParser.prototype)
    const { htmlTotalActive } = await import('./core/mime/html-total.js')
    const { bodyFromSource, MAIN_HTML_LIMIT } = await import('./core/mime/text.js')
    const { searchResultHere } = await import('./core/mime/search-text-service.js')
    const half = MAIN_HTML_LIMIT / 2
    const p = (ch, n) => '--M\\r\\nContent-Type: text/html; charset=utf-8\\r\\n\\r\\n<p>' + ch.repeat(n - 7) + '</p>\\r\\n'
    const mixed = Buffer.from('MIME-Version: 1.0\\r\\nContent-Type: multipart/mixed; boundary="M"\\r\\n\\r\\n--M\\r\\nContent-Type: text/plain\\r\\n\\r\\nSima.\\r\\n' + p('a', half) + p('b', half + 1) + '--M--\\r\\n')
    const only = Buffer.from('Content-Type: text/html; charset=utf-8\\r\\n\\r\\n<p>' + 'y'.repeat(MAIN_HTML_LIMIT) + '</p>')
    const m = await bodyFromSource(mixed, { oldText: true })
    const o = await bodyFromSource(only, { oldText: true })
    const w = await searchResultHere(only)
    console.log(JSON.stringify({ htmlTotalActive, mixedLate: m.preview === null, onlyLate: o.preview === null, workerPreview: w.preview }))
  `
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }))
  assert.equal(out.htmlTotalActive, false)
  assert.equal(out.mixedLate, false, 'the per-part cap: each part under it, converted here (the old, slow way)')
  assert.equal(out.onlyLate, true, 'one part over the cap: still the worker\'s')
  assert.equal(out.workerPreview, 'y'.repeat(200), 'and the worker makes its preview by the old rule')
  // the same fallback rule, in this process
  const p = await simpleParser(Buffer.from(`Content-Type: text/html\r\n\r\n<p>${'z'.repeat(MAIN_HTML_LIMIT)}</p>`), SEARCH_PARSE)
  assert.equal(latePreviewOf(p, false), 'z'.repeat(200))
  assert.equal(latePreviewOf(await simpleParser(mixed2(10, 10), LATE_PARSE), true), null)
})

// a nested HTML-only message: `depth` levels of `tag` around a word (decision 3842)
const nested = (depth, tag = 'div', extra = '') => `<p>ELEJE</p>${extra}${`<${tag}>`.repeat(depth)}MELYSZO${`</${tag}>`.repeat(depth)}`
const htmlOnly = html => Buffer.from(['MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html].join(CRLF))
const mailparserSaysTooDeep = async html => /nested deeper/.test(String((await simpleParser(htmlOnly(html), INDEX_PARSE)).textConversionError?.message || ''))

test('the nesting guard is mailparser\'s own decision: 999, 1000 and 1001 levels, with void and self-closing elements, comments and stray end tags', async () => {
  assert.equal(MAX_NESTING_DEPTH, 1000)
  const cases = [
    ...[999, 1000, 1001].map(d => [`div ${d}`, nested(d)]),
    ['span 1001 among void elements', nested(1001, 'span', '<br><img src="x"><hr>'.repeat(50))],
    ['p 5000 (closed by the parser itself)', nested(5000, 'p')],
    ['td 5000', nested(5000, 'td')],
    ['div 1001 in a comment', `<!--${nested(1001)}-->`],
    ['div 1001 with stray end tags', `${'</b>'.repeat(100)}${nested(1001)}`],
    ['div 1000 + one more inside a closed one', `${nested(1000)}<div><div></div></div>`],
    ['b 600 + i 600', `${'<b>'.repeat(600)}${'<i>'.repeat(600)}x`],
  ]
  for (const [name, html] of cases) assert.equal(exceedsNestingDepth(html), await mailparserSaysTooDeep(html), name)
  assert.equal(exceedsNestingDepth(nested(1000)), false)
  assert.equal(exceedsNestingDepth(nested(1001)), true)
})

test('a part the late way cannot convert is \'\': too deep, or the converter throws; the other parts and their order stay', () => {
  const { linearPart } = htmlTotalInternals
  assert.equal(linearPart(nested(1001), () => 'never'), '', 'too deep: not even tried')
  assert.equal(linearPart('<p>x</p>', () => { throw new RangeError('Maximum call stack size exceeded') }), '')
  assert.equal(linearPart(nested(1000), h => h.length > 0 ? 'ok' : ''), 'ok', 'at the limit: converted')
  // the HTML-only late way: tried up to LATE_DEPTH_LIMIT levels, a throw gives '', deeper not tried
  assert.equal(latePlain(nested(3000), () => { throw new RangeError('Maximum call stack size exceeded') }), '')
  assert.equal(latePlain(nested(LATE_DEPTH_LIMIT), () => 'tried'), 'tried')
  assert.equal(latePlain(nested(LATE_DEPTH_LIMIT + 1), () => 'tried'), '')
})

test('the real worker: a mixed message over the sum with a 3000 / 10 000 / 60 000 level deep HTML part never fails, its preview keeps the text part and the big part', async t => {
  const svc = new SearchTextService()
  t.after(() => svc.stop())
  const filler = `<html><body><p>KERESETTSZO</p><table>${'<tr><td>cella</td><td>adat</td></tr>'.repeat(7000)}</table></body></html>`
  for (const depth of [3000, 10_000, 60_000]) {
    const deep = '<div>'.repeat(depth) + 'MELYSZO' + '</div>'.repeat(depth)
    const src = Buffer.from([...head('mely', 'multipart/mixed; boundary="M"'), '--M', ...part('text/plain', 'Simaszoveg'), '--M', ...part('text/html', deep), '--M', ...part('text/html', filler), '--M--', ''].join(CRLF))
    assert.ok(await svc.admit(src.length))
    const r = await svc.compute(src)
    assert.ok(r && !r.failed, `${depth}: ${JSON.stringify(r && r.failed)}`)
    assert.match(r.preview, /^Simaszoveg KERESETTSZO cellaadat/, `${depth}: the deep part is '', the others stay`)
  }
  // an HTML-only message over the cap, very deep: the worker does not fail either (the old code had no preview there)
  const only = htmlOnly(nested(60_000) + filler)
  assert.ok(await svc.admit(only.length))
  const r = await svc.compute(only)
  assert.ok(r && !r.failed)
  assert.equal(typeof r.preview, 'string')
})

test('the late way of an HTML-only message over the cap, very deep: at most 2 s a message in the real worker, then a normal message goes right with no restart', async t => {
  const svc = new SearchTextService({ log: () => {} })
  t.after(() => svc.stop())
  const filler = `<html><body><p>KERESETTSZO</p><table>${'<tr><td>cella</td><td>adat</td></tr>'.repeat(7000)}</table></body></html>`
  const times = []
  for (const depth of [10_000, 60_000, 200_000]) {
    const src = htmlOnly(nested(depth) + filler)
    assert.ok(await svc.admit(src.length))
    const t0 = performance.now()
    const r = await svc.compute(src)
    const ms = performance.now() - t0
    times.push(`${depth}: ${ms.toFixed(0)} ms`)
    assert.ok(r && !r.failed, `${depth}: ${JSON.stringify(r)}`)
    assert.ok(ms <= 2000, `${depth}: ${ms.toFixed(0)} ms`)
    if (depth > LATE_DEPTH_LIMIT) assert.equal(r.preview, '', `${depth}: over LATE_DEPTH_LIMIT not converted (the old code had no preview there)`)
  }
  t.diagnostic(times.join(', '))
  const normal = htmlOnly('<p>Rendes level szovege</p>')
  assert.ok(await svc.admit(normal.length))
  assert.equal((await svc.compute(normal)).text, 'Rendes level szovege')
  assert.equal(svc.restarts, 0, 'no worker restart')
  assert.equal(svc.broken, false)
})

test('3000 levels + a big table, HTML-only over the cap: the worker\'s late preview is the old code\'s (mailparser leaves it without text, our converter makes it)', async t => {
  const filler = `<html><body><p>KERESETTSZO</p><table>${'<tr><td>cella</td><td>adat</td></tr>'.repeat(7000)}</table></body></html>`
  const src = htmlOnly(nested(3000) + filler)
  // the old code's preview: the old parse (conversion on, no cap) and the old rule (previewOf) on this thread
  const old = previewOf(await simpleParser(src, INDEX_PARSE))
  assert.match(old, /KERESETTSZO cellaadat/, `the old code had a preview at 3000 levels here: ${old.slice(0, 40)}`)
  const svc = new SearchTextService()
  t.after(() => svc.stop())
  assert.ok(await svc.admit(src.length))
  assert.equal((await svc.compute(src)).preview, old)
})

test('under the late limit, the worst case: 9999 levels and the 5.34 MB table in one HTML-only message: the worker converts it in seconds, no failure', async t => {
  // decision 3855: <= 2 s on Linux (tools/pm1-deep-table.mjs, 3 runs: max ~1 s); here a loose bound for a loaded suite,
  // the quadratic way it guards against took 32 s
  const svc = new SearchTextService()
  t.after(() => svc.stop())
  const table = `<html><body><table>${'<tr><td>xxxxxxxxxx</td></tr>'.repeat(200_000)}</table></body></html>`
  const src = htmlOnly(nested(LATE_DEPTH_LIMIT - 1) + table)
  assert.ok(await svc.admit(src.length))
  const t0 = performance.now()
  const r = await svc.compute(src)
  const ms = performance.now() - t0
  t.diagnostic(`9999 levels + 5.34 MB table: worker ${ms.toFixed(0)} ms`)
  assert.ok(r && !r.failed)
  assert.equal(typeof r.preview, 'string')
  assert.ok(ms <= 6000, `${ms.toFixed(0)} ms`)
})
