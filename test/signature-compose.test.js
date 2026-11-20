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

test('a pasted image: the sanitizer keeps it only for ITS OWN composer session; another session\'s, a malformed one and an inl-img link go', () => {
  const sid = '0123abcd-0000-4000-8000-00000000abcd'
  const other = '0123abcd-0000-4000-8000-00000000ffff'
  const id = 'c'.repeat(24)
  const own = `<p>a<img src="inl-img://session/${sid}/${id}" alt="x" width="10">b</p>`
  assert.equal(sanitizeCompose(purify, own, { sessionId: sid }), `<p>a<img src="inl-img://session/${sid}/${id}" alt="" width="10">b</p>`, 'its size menu width stays')
  for (const html of [own.replace(sid, other), `<p>a<img src="inl-img://session/${sid}/xyz">b</p>`, `<p>a<img src="inl-img://other/${sid}/${id}">b</p>`]) {
    assert.equal(sanitizeCompose(purify, html, { sessionId: sid }), '<p>ab</p>', html)
  }
  assert.equal(sanitizeCompose(purify, own), '<p>ab</p>', 'without a session id no pasted image survives')
  assert.equal(sanitizeCompose(purify, `<a href="inl-img://session/${sid}/${id}">x</a>`, { sessionId: sid }), '<a>x</a>')
  assert.ok(sanitizeCompose(purify, '<p><img src="sig-img://account/3"></p>', { sessionId: sid }).includes('sig-img://account/3'), 'the signature image stays')
})

test('a width stays only on a pasted image of this session, and only as a whole number of pixels', () => {
  const sid = '0123abcd-0000-4000-8000-00000000abcd'
  const src = `inl-img://session/${sid}/${'d'.repeat(24)}`
  const img = w => `<p><img src="${src}" alt="" width="${w}"></p>`
  for (const w of ['320', '1', '99999']) assert.equal(sanitizeCompose(purify, img(w), { sessionId: sid }), img(w), w)
  // (DOMPurify trims an attribute's value: " 320" comes through as "320")
  assert.equal(sanitizeCompose(purify, img(' 320'), { sessionId: sid }), img('320'))
  for (const w of ['0', '-5', '50%', '320px', '1e3', '100000', '3 20', '']) assert.equal(sanitizeCompose(purify, img(w), { sessionId: sid }), `<p><img src="${src}" alt=""></p>`, `width "${w}"`)
  assert.equal(sanitizeCompose(purify, '<p><img src="sig-img://account/3" width="320"></p>', { sessionId: sid }), '<p><img src="sig-img://account/3" alt=""></p>', 'not on the signature image')
  assert.equal(sanitizeCompose(purify, '<p width="320">a</p><div width="5">b</div>', { sessionId: sid }), '<p>a</p><div>b</div>', 'not on any other element')
})
