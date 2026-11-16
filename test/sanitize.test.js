// The body sanitizer on the hostile set (test/fixtures/hostile/*.eml), with jsdom in
// place of the renderer's DOM. What runs and what loads in the real frame is measured in Electron
// (test/e2e, not part of npm test); this test pins down what the sanitizer lets through.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { parseMessage } from '../core/mime/message.js'
import { sanitizeMail, sanitizeCompose } from '../app/renderer/src/sanitize.js'

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
