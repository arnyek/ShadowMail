// SPDX-License-Identifier: GPL-3.0-or-later
// The signature in the body (core/smtp/signature.js) and what the composer's sanitizer lets through of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'
import { signatureHtml, accountSignatureHtml, accountImageSrc, unwrapSignature, SIGNATURE_ATTR } from '../core/smtp/signature.js'

const purify = createDOMPurify(new JSDOM('').window)
// the markup before the image signature (Composer.jsx and tools.js, both the same)
const oldEscape = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const oldSignature = sig => (sig ? `<p><br></p><p>-- <br>${oldEscape(sig).replace(/\r?\n/g, '<br>')}</p>` : '<p><br></p>')

test('a text-only signature: the marked block, and unwrapped exactly the old markup; no signature: an empty block', () => {
  for (const sig of ['Üdv,\nKép Elek', 'a <b> & c', '']) {
    const html = signatureHtml(sig)
    assert.ok(html.includes(`<div ${SIGNATURE_ATTR}="">`))
    assert.equal(unwrapSignature(html), oldSignature(sig))
  }
})

test('the image under the text; an image alone after "-- "; the account forms', () => {
  assert.equal(signatureHtml('Elek', 'sig-img://account/3'), `<p><br></p><div ${SIGNATURE_ATTR}=""><p>-- <br>Elek</p><p><img src="sig-img://account/3" alt=""></p></div>`)
  assert.equal(signatureHtml('', 'sig-img://account/3'), `<p><br></p><div ${SIGNATURE_ATTR}=""><p>-- <br><img src="sig-img://account/3" alt=""></p></div>`)
  assert.equal(accountSignatureHtml({ id: 3, signature: 'Elek', hasImage: true }), signatureHtml('Elek', accountImageSrc(3)))
  assert.equal(accountSignatureHtml({ id: 3, signature: 'Elek', has_signature_image: 0 }), signatureHtml('Elek'))
  assert.equal(accountSignatureHtml(null), signatureHtml(''))
})

test('unwrap: the text before and after stays, nested divs inside the block, a block the user emptied, two blocks', () => {
  const body = `<p>Hello</p>${signatureHtml('Elek')}<blockquote><div>quote</div></blockquote>`
  assert.equal(unwrapSignature(body), `<p>Hello</p>${oldSignature('Elek')}<blockquote><div>quote</div></blockquote>`)
  assert.equal(unwrapSignature(`<div ${SIGNATURE_ATTR}=""><div>a</div><div>b</div></div>x`), '<div>a</div><div>b</div>x')
  assert.equal(unwrapSignature(`a<div ${SIGNATURE_ATTR}=""></div>b`), 'ab')
  assert.equal(unwrapSignature(`<div ${SIGNATURE_ATTR}="">1</div><div ${SIGNATURE_ATTR}="">2</div>`), '12')
  assert.equal(unwrapSignature('<p>no block</p>'), '<p>no block</p>')
})

test('the sanitizer keeps the signature block and its sig-img image; drops a foreign http, cid: or data: image and a stray marker', () => {
  const sig = signatureHtml('Elek', 'sig-img://account/3')
  assert.equal(sanitizeCompose(purify, sig), sig)
  assert.ok(sanitizeCompose(purify, '<p><img src="sig-img://session/abc_1-2"></p>').includes('<img src="sig-img://session/abc_1-2" alt="">'))
  for (const bad of ['<img src="http://tracker.example/x.png">', '<img src="cid:x">', '<img src="data:image/png;base64,AAAA">', '<img src="sig-img://account/3/../x">', '<img src="sig-img://other/3">', '<img>']) {
    const out = sanitizeCompose(purify, `<p>a${bad}b</p>`)
    assert.equal(out, '<p>ab</p>', bad)
  }
  assert.equal(sanitizeCompose(purify, `<p ${SIGNATURE_ATTR}="">x</p>`), '<p>x</p>')
  assert.equal(sanitizeCompose(purify, '<a href="sig-img://account/3">x</a>'), '<a>x</a>')
  assert.equal(sanitizeCompose(purify, '<a href="https://example.invalid/">x</a>'), '<a href="https://example.invalid/">x</a>')
})

test('unwrap stays linear: 20 000 nested divs in the block, and 2 MB of text after it, each in well under a second', () => {
  const deep = `<div ${SIGNATURE_ATTR}="">${'<div>'.repeat(20000)}x${'</div>'.repeat(20000)}</div>`
  let t0 = performance.now()
  assert.equal(unwrapSignature(deep), `${'<div>'.repeat(20000)}x${'</div>'.repeat(20000)}`)
  assert.ok(performance.now() - t0 < 300, `${Math.round(performance.now() - t0)} ms`)
  const long = `${signatureHtml('Elek')}${'<div>a</div>'.repeat(200000)}`
  t0 = performance.now()
  assert.equal(unwrapSignature(long), `<p><br></p><p>-- <br>Elek</p>${'<div>a</div>'.repeat(200000)}`)
  assert.ok(performance.now() - t0 < 300, `${Math.round(performance.now() - t0)} ms`)
})
