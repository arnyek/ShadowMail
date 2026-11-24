// the local search looks in the VISIBLE text of a message (searchTextOf),
// the list preview keeps the old rule byte for byte (the preheader stays in the preview).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { simpleParser } from 'mailparser'
import { bodyFromSource, searchTextOf, htmlToPlain, normalizeText, makePreview, BODY_MAX_CHARS } from '../core/mime/text.js'
import { messageText } from '../core/pop3/local-search.js'
import { memoryIndex, addAccount, addMessage } from './helpers/fixtures.js'

const FIXTURES = new URL('./fixtures/', import.meta.url)
const HIDDEN = /IGNORE PREVIOUS INSTRUCTIONS|attacker@example\.invalid/i
const hostile = fs.readdirSync(new URL('hostile/', FIXTURES)).filter(f => f.startsWith('injection-'))

// the earlier rule (before the visible text), kept here to compare the preview against: text/plain first, HTML -> htmlToPlain
async function oldBody(source, maxChars = BODY_MAX_CHARS) {
  if (!source || !source.length) return { text: '', preview: null, state: 2 }
  try {
    const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true })
    let text = parsed.text
    if (!text && parsed.html) text = htmlToPlain(parsed.html)
    const normalized = normalizeText(text, maxChars)
    return { text: normalized, preview: makePreview(normalized), state: 1 }
  } catch {
    return { text: '', preview: null, state: 2 }
  }
}

const allFixtures = () => {
  const out = []
  const walk = d => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (f.name.endsWith('.eml')) out.push(p)
    }
  }
  walk(fileURLToPath(FIXTURES)) // a URL path is "/C:/..." on Windows
  return out
}

const mail = ({ subject = 'Tárgy', plain = null, html = null }) => {
  const head = `From: Feladó <f@example.invalid>\r\nTo: t@example.invalid\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\n`
  if (plain !== null && html !== null) {
    return Buffer.from(`${head}Content-Type: multipart/alternative; boundary="A"\r\n\r\n--A\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${plain}\r\n--A\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--A--\r\n`, 'utf8')
  }
  if (html !== null) return Buffer.from(`${head}Content-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`, 'utf8')
  return Buffer.from(`${head}Content-Type: text/plain; charset=utf-8\r\n\r\n${plain}\r\n`, 'utf8')
}

test('the five hiding methods (hostile/injection-*.eml): the search text has the visible words, never the hidden ones', async () => {
  assert.equal(hostile.length, 5)
  for (const f of hostile) {
    const b = await bodyFromSource(fs.readFileSync(new URL(`hostile/${f}`, FIXTURES)))
    assert.equal(b.state, 1, f)
    assert.ok(b.text.includes('Látható szöveg: a számla mellékelve.'), `${f}: the visible text`)
    assert.ok(!HIDDEN.test(b.text), `${f}: the hidden text is not searchable`)
  }
})

test('the local index: a hidden word gives 0 hits, a visible one is found; the snippet holds no hidden word', async t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db).id
  let uid = 1
  for (const f of hostile) {
    const source = fs.readFileSync(new URL(`hostile/${f}`, FIXTURES))
    const id = addMessage(index, acc, { uid: uid++, subject: f })
    const b = await bodyFromSource(source)
    index.setBodies([{ id, text: b.text, state: b.state, preview: b.preview }])
  }
  for (const q of ['attacker', 'IGNORE PREVIOUS INSTRUCTIONS', 'instructions']) assert.deepEqual(index.search({ query: q, limit: 50 }), [], q)
  const hits = index.search({ query: 'mellékelve', limit: 50 })
  assert.equal(hits.length, 5)
  assert.ok(hits.every(h => h.snip && !HIDDEN.test(h.snip) && h.snip.includes('«')), JSON.stringify(hits.map(h => h.snip)))
})

test('multipart/alternative whose text/plain says something else than the visible HTML: the text/plain word is not searchable', async () => {
  const src = mail({ plain: 'csakaszovegreszben van ez a szó', html: '<p>A látható rész: árajánlat</p><div style="display:none">rejtettkulcsszo</div>' })
  const b = await bodyFromSource(src)
  assert.equal(b.text, 'A látható rész: árajánlat')
  assert.ok(!b.text.includes('csakaszovegreszben') && !b.text.includes('rejtettkulcsszo'))
  // the preview keeps the old rule: the text/plain
  assert.equal(b.preview, (await oldBody(src)).preview)
  assert.equal(b.preview, 'csakaszovegreszben van ez a szó')
})

test('HTML too complex to filter (cut: complex): no body (not the text/plain); the subject stays searchable in the index', async t => {
  const classes = Array.from({ length: 12 }, (_, i) => `c${i}`)
  const rules = []
  for (let m = 1; m < 4096; m++) rules.push(`${classes.filter((_, i) => m & (1 << i)).map(c => `.${c}`).join('')}{color:red}`)
  const html = `<style>${rules.join('')}</style>${`<p class="${classes.join(' ')}">x</p>`.repeat(2000)}`
  const src = mail({ subject: 'Bonyolultlevel', plain: 'szovegreszszava', html })
  const b = await bodyFromSource(src)
  assert.equal(b.text, '')
  assert.equal(b.state, 1)
  const { db, index } = memoryIndex(t)
  const id = addMessage(index, addAccount(db).id, { uid: 1, subject: 'Bonyolultlevel' })
  index.setBodies([{ id, text: b.text, state: b.state, preview: b.preview }])
  assert.deepEqual(index.search({ query: 'szovegreszszava', limit: 5 }), [])
  assert.equal(index.search({ query: 'Bonyolultlevel', limit: 5 }).length, 1)
})

test('a plain text message is searched as before (its text/plain), capped at BODY_MAX_CHARS', async () => {
  const src = mail({ plain: `első sor\r\n\r\n\r\n\r\nmásodik   sor ${'x'.repeat(BODY_MAX_CHARS)}` })
  const [b, old] = [await bodyFromSource(src), await oldBody(src)]
  assert.equal(b.text, old.text)
  assert.equal(b.text.length, BODY_MAX_CHARS)
  assert.equal(searchTextOf({ text: 'a\r\n b', html: false }), 'a\n b')
})

test('the preview is byte for byte the old one on every fixture of the repo', async () => {
  const files = allFixtures()
  assert.ok(files.length >= 20, `${files.length} fixtures`)
  for (const f of files) {
    const src = fs.readFileSync(f)
    assert.equal((await bodyFromSource(src)).preview, (await oldBody(src)).preview, path.basename(f))
  }
})

test('the preview is byte for byte the old one on 1200 generated messages (plain, HTML, alternative, hidden preheader)', async () => {
  const words = ['számla', 'árvíztűrő', 'tükörfúrógép', 'ajánlat', 'hírlevél', 'kedvezmény', 'Bence', 'határidő']
  const w = i => words[i % words.length]
  let changed = 0
  for (let i = 0; i < 1200; i++) {
    const kind = i % 4
    const pre = `<div style="display:none;font-size:0;max-height:0">rejtett előnézet ${i} ${w(i + 3)}</div>`
    const html = `<html><body>${kind === 3 ? pre : ''}<table><tr><td><p>${w(i)} ${i}</p><p style="color:#fff">fehér ${w(i + 1)}</p><a href="https://example.invalid/${i}">link ${w(i + 2)}</a></td></tr></table></body></html>`
    const src = kind === 0 ? mail({ plain: `${w(i)} ${i}\r\n${'sor '.repeat(i % 60)}` }) : kind === 1 ? mail({ html }) : mail({ plain: `szöveg ${w(i)} ${i}`, html })
    const [b, old] = [await bodyFromSource(src), await oldBody(src)]
    assert.equal(b.preview, old.preview, `message ${i}`)
    if (b.text !== old.text) changed++
  }
  // the search text did change where the visible text differs (HTML messages), the preview never
  assert.ok(changed > 0)
})

test('POP3 "régi levelek szövegében is" (messageText): a hidden word is not in it, a visible one is', async () => {
  for (const f of hostile) {
    const text = await messageText(fs.readFileSync(new URL(`hostile/${f}`, FIXTURES)))
    assert.ok(!HIDDEN.test(text), f)
    assert.ok(text.includes('Látható szöveg'), f)
  }
})

// a complex HTML is filtered once more on its first 128 KB
import { complexNewsletterHtml } from './helpers/newsletter.js'
import { visibleTextInfo } from '../core/mime/visible-text.js'
import { retryWhenLoaded } from './helpers/load-retry.js'
import { htmlHead, COMPLEX_RETRY_BYTES } from '../core/mime/text.js'

test('a 404 KB HTML over the work ceiling: its first 128 KB is searched (the visible word yes, the hidden no)', async t => {
  const html = complexNewsletterHtml({ hidden: 'rejtettpreheader', visible: 'lathatotermek' })
  assert.equal(visibleTextInfo(html).cut, 'complex', 'the whole is over the ceiling (precondition)')
  // the 128 KB retry rests on visible-text.js's wall-clock net: again only on a loaded machine (load-retry.js)
  await retryWhenLoaded(t, async () => {
    const text = searchTextOf({ html })
    assert.ok(text.includes('lathatotermek'), 'the visible word of the first 128 KB')
    assert.ok(!text.includes('rejtettpreheader'), 'the hidden preheader is not')
    assert.ok(text.length > 1000)
  })
})

test('complex in its first 128 KB too: no body; an HTML that fits in 128 KB is not filtered twice', () => {
  const classes = Array.from({ length: 12 }, (_, i) => `c${i}`)
  const rules = []
  for (let m = 1; m < 4096; m++) rules.push(`${classes.filter((_, i) => m & (1 << i)).map(c => `.${c}`).join('')}{color:red}`)
  const html = `<style>${rules.join('')}</style>${`<p class="${classes.join(' ')}">x</p>`.repeat(200)}`
  assert.ok(Buffer.byteLength(html) > COMPLEX_RETRY_BYTES)
  assert.equal(searchTextOf({ html, text: 'szovegresz' }), '')
  let calls = 0
  const visible = h => (calls++, { text: '', cut: 'complex' })
  assert.equal(searchTextOf({ html: '<p>kicsi</p>', text: 'x' }, { visible }), '')
  assert.equal(calls, 1, 'a short HTML: one filter, no retry')
})

test('htmlHead cuts at a UTF-8 character start, never in the middle of one', () => {
  for (const ch of ['é', 'ő', '€', '😀']) {
    for (let pad = 0; pad < 4; pad++) {
      const html = 'a'.repeat(pad) + ch.repeat(100)
      const head = htmlHead(html, 50)
      assert.ok(Buffer.byteLength(head) <= 50, `${ch} ${pad}`)
      assert.ok(!head.includes('\ufffd'), `${ch} ${pad}: no broken character`)
      assert.ok(html.startsWith(head), `${ch} ${pad}: a prefix`)
    }
  }
  assert.equal(htmlHead('rövid', 50), null)
})
