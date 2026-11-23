// The body sanitizer on the hostile set (test/fixtures/hostile/*.eml), with jsdom in
// place of the renderer's DOM. What runs and what loads in the real frame is measured in Electron
// (test/e2e, not part of npm test); this test pins down what the sanitizer lets through.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { parseMessage } from '../core/mime/message.js'
import { sanitizeMail, sanitizeCompose, tableToLines, INSERT_WRAP_NODES } from '../app/renderer/src/sanitize.js'

const window = new JSDOM('').window
const purify = createDOMPurify(window)
const hostileDir = new URL('./fixtures/hostile/', import.meta.url)
const HOSTILE = fs.readdirSync(hostileDir).filter(f => f.endsWith('.eml')).sort()

const FORBIDDEN_TAGS = ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'link', 'meta', 'base', 'svg', 'math', 'video', 'audio', 'source', 'picture']

function inspect(html) {
  const doc = new JSDOM(`<!doctype html><body>${html}</body>`).window.document
  const problems = []
  for (const tag of FORBIDDEN_TAGS) if (doc.getElementsByTagName(tag).length) problems.push(`<${tag}>`)
  for (const el of doc.body.querySelectorAll('*')) {
    for (const { name, value } of [...el.attributes]) {
      if (/^on/i.test(name)) problems.push(`${el.tagName} ${name}`)
      if (/javascript:|vbscript:|file:|data:text/i.test(value)) problems.push(`${el.tagName} ${name}=${value}`)
      if (['action', 'formaction', 'background', 'poster', 'srcdoc', 'ping'].includes(name)) problems.push(`${el.tagName} ${name}`)
      // anything loadable must point nowhere outside: no http(s) in src/srcset, href only on links
      if ((name === 'src' || name === 'srcset') && /(https?:)?\/\//i.test(value)) problems.push(`${el.tagName} ${name}=${value}`)
      if (name === 'href' && !['A', 'AREA'].includes(el.tagName)) problems.push(`${el.tagName} href`)
    }
  }
  return { doc, problems }
}

for (const file of HOSTILE) {
  test(`hostile/${file}: nothing that runs or loads survives (images off)`, async () => {
    const parsed = await parseMessage(fs.readFileSync(new URL(file, hostileDir)))
    assert.ok(parsed.html, 'the fixture has an HTML body')
    const { html } = sanitizeMail(purify, parsed.html, { messageId: 1, imagesAllowed: false })
    const { problems, doc } = inspect(html)
    assert.deepEqual(problems, [], html)
    for (const a of doc.querySelectorAll('a')) {
      assert.equal(a.getAttribute('target'), '_blank')
      assert.equal(a.getAttribute('rel'), 'noopener noreferrer')
      if (a.hasAttribute('href')) assert.match(a.getAttribute('href'), /^(https?:|mailto:)/)
    }
    // hostile hosts may only remain inside CSS (style), which the frame's CSP and the net guard hold back
    const outsideCss = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/style="[^"]*"/gi, '')
    assert.doesNotMatch(outsideCss.replace(/<a [^>]*>/gi, ''), /hostile\.invalid/, outsideCss)
  })
}

test('javascript:, file: and data: links lose their href, the web link keeps it', async () => {
  const parsed = await parseMessage(fs.readFileSync(new URL('javascript-link.eml', hostileDir)))
  const { doc } = inspect(sanitizeMail(purify, parsed.html, { messageId: 1 }).html)
  assert.equal(doc.getElementById('js').hasAttribute('href'), false)
  assert.equal(doc.getElementById('file').hasAttribute('href'), false)
  assert.equal(doc.getElementById('data').hasAttribute('href'), false)
  assert.equal(doc.getElementById('web').getAttribute('href'), 'https://www.example.com/')
})

test('external images: removed while off and counted; kept once allowed (protocol-relative -> https)', async () => {
  const parsed = await parseMessage(fs.readFileSync(new URL('external-image.eml', hostileDir)))
  const off = sanitizeMail(purify, parsed.html, { messageId: 1, imagesAllowed: false })
  assert.equal(off.externalImages, 2)
  assert.equal(inspect(off.html).doc.getElementById('ext').hasAttribute('src'), false)
  const on = sanitizeMail(purify, parsed.html, { messageId: 1, imagesAllowed: true })
  const doc = new JSDOM(on.html).window.document
  assert.deepEqual([...doc.querySelectorAll('img')].map(i => i.getAttribute('src')), [
    'https://images.hostile.invalid/photo.jpg',
    'https://images2.hostile.invalid/photo2.jpg',
  ])
  assert.ok([...doc.querySelectorAll('img')].every(i => i.getAttribute('referrerpolicy') === 'no-referrer'))
})

test('srcset: dropped while images are off, kept only if every candidate is http(s) once allowed', () => {
  const html = '<img id="a" src="data:image/png;base64,iVBORw0KGgo=" srcset="https://x.invalid/a.png 1x, https://x.invalid/b.png 2x"><img id="b" srcset="https://x.invalid/c.png 1x, cid:y 2x">'
  const off = new JSDOM(sanitizeMail(purify, html, { messageId: 1 }).html).window.document
  assert.equal(off.getElementById('a').hasAttribute('srcset'), false)
  assert.equal(off.getElementById('a').getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=')
  const on = new JSDOM(sanitizeMail(purify, html, { messageId: 1, imagesAllowed: true }).html).window.document
  assert.ok(on.getElementById('a').hasAttribute('srcset'))
  assert.equal(on.getElementById('b').hasAttribute('srcset'), false)
})

test('cid: images point to cid-img://m<id>/<cid>, other schemes on images are removed', async () => {
  const parsed = await parseMessage(fs.readFileSync(new URL('./fixtures/mail/cid-and-attachments.eml', import.meta.url)))
  const { html, externalImages } = sanitizeMail(purify, parsed.html, { messageId: 42 })
  const doc = new JSDOM(html).window.document
  assert.equal(doc.getElementById('cidimg').getAttribute('src'), 'cid-img://m42/logo%40sender.invalid')
  assert.equal(externalImages, 1)
  const odd = new JSDOM(sanitizeMail(purify, '<img id="f" src="file:///C:/x.png"><img id="s" src="data:image/svg+xml;base64,PHN2Zz4=">', { messageId: 1 }).html).window.document
  assert.equal(odd.getElementById('f').hasAttribute('src'), false)
  assert.equal(odd.getElementById('s').hasAttribute('src'), false, 'SVG data URIs are not kept')
})

test('the sanitizer leaves no hook behind (a second call with other options is not affected)', () => {
  const a = sanitizeMail(purify, '<img src="https://x.invalid/a.png">', { messageId: 1, imagesAllowed: true })
  const b = sanitizeMail(purify, '<img src="https://x.invalid/a.png">', { messageId: 1, imagesAllowed: false })
  assert.match(a.html, /src="https:\/\/x\.invalid\/a\.png"/)
  assert.doesNotMatch(b.html, /x\.invalid/)
})

test('composer paste: only the toolbar\'s own formatting survives', () => {
  const dirty = '<div style="color:red" class="x" onclick="alert(1)"><h1>Cím</h1><p>Szöveg <b>vastag</b> <i>dőlt</i> <u>alá</u></p>' +
    '<img src="https://tracker.invalid/p.png"><script>alert(1)</script><style>p{}</style><table><tr><td>cella</td></tr></table>' +
    '<a href="javascript:alert(1)">rossz</a> <a href="https://example.com/" target="_blank">jó</a> <a href="mailto:a@example.invalid">levél</a>' +
    '<form action="https://x.invalid"><input value="v"></form><iframe src="https://x.invalid"></iframe><ul><li>pont</li></ul><blockquote>idézet</blockquote></div>'
  const doc = new JSDOM(`<body>${sanitizeCompose(purify, dirty)}</body>`).window.document
  for (const tag of ['img', 'script', 'style', 'table', 'form', 'input', 'iframe']) assert.equal(doc.getElementsByTagName(tag).length, 0, tag)
  for (const el of doc.body.querySelectorAll('*')) assert.deepEqual([...el.attributes].map(a => a.name).filter(n => n !== 'href'), [], el.outerHTML)
  assert.deepEqual([...doc.querySelectorAll('a[href]')].map(a => a.getAttribute('href')), ['https://example.com/', 'mailto:a@example.invalid'])
  for (const tag of ['h1', 'p', 'b', 'i', 'u', 'ul', 'li', 'blockquote']) assert.equal(doc.getElementsByTagName(tag).length, 1, tag)
  assert.match(doc.body.textContent, /cella/, 'the text of removed tags stays')
})

// a web page's table pasted into the composer (Chromium's clipboard shape: no space or line between the cells)
const COPIED_TABLE = '<table class="bevitel" style="color: rgb(0, 0, 0);"><tbody><tr><th>Kedvezményezett neve:</th><td>Példa Kft</td></tr>' +
  '<tr><th>Számlaszáma:</th><td>11111111-22222222</td></tr><tr><th>Összeg:</th><td class="bold">1000 HUF</td></tr></tbody></table><br class="Apple-interchange-newline">'
const linesOf = html => [...new JSDOM(`<body>${html}</body>`).window.document.body.querySelectorAll('div > div')].map(d => d.textContent)

test('composer paste, a copied table (tableRows): one row a line, the cells one space apart, the header cells bold', () => {
  const out = sanitizeCompose(purify, COPIED_TABLE, { tableRows: true })
  assert.equal(out, '<div><div><b>Kedvezményezett neve:</b> Példa Kft</div><div><b>Számlaszáma:</b> 11111111-22222222</div><div><b>Összeg:</b> 1000 HUF</div></div><br>')
})

test('composer, a table without tableRows (the starting body, a reply\'s quote): the old shape, byte for byte', () => {
  assert.equal(sanitizeCompose(purify, COPIED_TABLE), 'Kedvezményezett neve:Példa KftSzámlaszáma:11111111-22222222Összeg:1000 HUF<br>')
  // and a tableRows call before leaves no hook behind
  sanitizeCompose(purify, COPIED_TABLE, { tableRows: true })
  assert.equal(sanitizeCompose(purify, '<table><tr><td>a</td><td>b</td></tr></table>'), 'ab')
})

test('a copied table: thead / tfoot / caption, empty and spanning cells, a nested table, inline formatting in a cell', () => {
  const html = '<table><caption>Cím <i>dőlt</i></caption><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td colspan="2">egész</td></tr>' +
    '<tr><td></td><td>jobb</td></tr><tr><td><table><tr><td>be1</td><td>be2</td></tr></table></td><td><b>v</b> <a href="https://example.com/">link</a></td></tr></tbody>' +
    '<tfoot><tr><td>láb</td></tr></tfoot></table>'
  const out = sanitizeCompose(purify, html, { tableRows: true })
  const doc = new JSDOM(`<body>${out}</body>`).window.document
  const rows = [...doc.body.firstElementChild.children].map(d => d.textContent)
  assert.deepEqual(rows, ['Cím dőlt', 'A B', 'egész', ' jobb', 'be1 be2 v link', 'láb'])
  assert.equal(doc.querySelectorAll('table, tr, td, th, caption, thead, tbody, tfoot').length, 0)
  assert.deepEqual([...doc.querySelectorAll('div div div div')].map(d => d.textContent), ['be1 be2'], 'the nested row is a line inside its row')
  assert.equal(doc.querySelector('a').getAttribute('href'), 'https://example.com/')
  assert.equal(doc.querySelectorAll('i').length, 1)
  for (const el of doc.body.querySelectorAll('*')) assert.deepEqual([...el.attributes].map(a => a.name).filter(n => n !== 'href'), [], el.outerHTML)
})

test('a table\'s rows: what stands in no cell (text right in the table, in a row group or a row, an element) is kept where it stands; whitespace, comments and columns are not lines', () => {
  // the parsers here move such text out of a table, so the DOM is built by hand (in the app a deep nested table's
  // innermost text was lost in a reply's quote before this)
  const doc = new JSDOM('').window.document
  const el = (name, ...kids) => {
    const e = doc.createElement(name)
    e.append(...kids)
    return e
  }
  const table = el('table', el('colgroup', el('col')), '\n  ', 'fent', el('tbody', el('tr', el('td', 'a'), 'sor', el('th', 'b')), doc.createComment('x'), 'kint', el('tr', el('td', 'c')), el('i', 'dőlt')), el('tfoot', el('tr', el('td', 'láb'))), ' ')
  tableToLines(table)
  assert.deepEqual([...table.firstElementChild.children].map(d => d.textContent), ['fent', 'a sor b', 'kint', 'c', 'dőlt', 'láb'])
  assert.equal(table.querySelector('b').textContent, 'b')
  // through the sanitizer: a table nested 200 deep keeps its innermost text
  const deep = sanitizeCompose(purify, `${'<table><tr><td>'.repeat(200)}legbelso${'</td></tr></table>'.repeat(200)}`, { tableRows: true })
  assert.match(deep, /legbelso/)
})

test('a copied table is still sanitized: a script, an outside image, a handler or a style in a cell does not survive', () => {
  const html = '<table><tr><th onclick="x()" style="color:red">K<script>alert(1)</script></th><td><img src="https://tracker.invalid/p.png" onerror="x()">' +
    '<a href="javascript:alert(1)">rossz</a><iframe src="https://x.invalid"></iframe></td></tr></table>'
  const out = sanitizeCompose(purify, html, { tableRows: true })
  assert.doesNotMatch(out, /script|alert|tracker|onerror|onclick|style|iframe|javascript/i, out)
  assert.deepEqual(linesOf(out), ['K rossz'])
})

test('a big copied table is linear: 4000 rows take at most 6 times 1000 rows (best of 3; a quadratic walk is 16 times)', () => {
  const row = '<tr><th>Címke:</th><td>érték 1</td><td>érték 2</td><td>érték 3</td><td>érték 4</td></tr>'
  const best = n => {
    const html = `<table>${row.repeat(n)}</table>`
    let min = Infinity
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      const out = sanitizeCompose(purify, html, { tableRows: true })
      min = Math.min(min, performance.now() - t0)
      assert.equal((out.match(/<div><b>Címke:<\/b> érték 1 érték 2 érték 3 érték 4<\/div>/g) || []).length, n)
    }
    return min
  }
  const small = best(1000)
  const big = best(4000)
  assert.ok(big <= small * 6, `1000 rows ${Math.round(small)} ms, 4000 rows ${Math.round(big)} ms`)
})

test('insert (a paste): no bare span on either way, many top-level nodes in one bare div; without it the output as before', () => {
  const ins = (html, o = {}) => sanitizeCompose(purify, html, { insert: true, ...o })
  const span = '<p><span>a<span>b</span></span><span style="color: red;">c</span><b>d</b></p>'
  // the plain way: every span is bare; without insert they stay (the old output), with it they are unwrapped
  assert.equal(sanitizeCompose(purify, span), '<p><span>a<span>b</span></span><span>c</span><b>d</b></p>')
  assert.equal(ins(span), '<p>abc<b>d</b></p>')
  // the rich way keeps the styled one
  assert.equal(ins(span, { rich: true }), '<p>ab<span style="color: red;">c</span><b>d</b></p>')
  const blocks = n => '<p>x</p>'.repeat(n)
  assert.equal(INSERT_WRAP_NODES, 50)
  for (const rich of [false, true]) {
    assert.equal(ins(blocks(49), { rich }), blocks(49))
    assert.equal(ins(blocks(50), { rich }), `<div>${blocks(50)}</div>`)
    // text nodes are top-level nodes too
    const mixed = '<b>a</b> '.repeat(25)
    assert.equal(ins(mixed, { rich }), `<div>${mixed}</div>`)
    // one big block is one node: no wrapper
    assert.equal(ins(`<div>${blocks(500)}</div>`, { rich }), `<div>${blocks(500)}</div>`)
    assert.equal(ins('', { rich }), '')
    // without insert: never wrapped
    assert.equal(sanitizeCompose(purify, blocks(50), { rich }), blocks(50))
  }
})
