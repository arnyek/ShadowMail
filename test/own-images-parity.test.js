// SPDX-License-Identifier: GPL-3.0-or-later
// A saved draft's own images through the main process's mirror (core/mime/visible-text.js visibleComposeHtml with
// ownImagesOf, what Claude's send_draft sends) and through the composer's sanitizer (app/renderer/src/sanitize.js
// sanitizeCompose rich, with the composer's session): byte for byte the same; without ownImagesOf the mirror is as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'
import { visibleComposeHtml } from '../core/mime/visible-text.js'

const purify = createDOMPurify(new JSDOM('').window)
const SID = '0c9f2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const OTHER = '11111111-2222-3333-4444-555555555555'
const ID = '0123456789abcdef01234567'
const pasted = (sid = SID, id = ID) => `inl-img://session/${sid}/${id}`
const composer = html => sanitizeCompose(purify, html, { rich: true, sessionId: SID })
const mirror = html => visibleComposeHtml(html, { rich: true, ownImagesOf: SID })

// the draft as the composer reopens it (compose.js prepare, mode draft): a pasted image with its width, the signature
// block with the session's own signature image
const DRAFT = `<p>Szia <b>x</b></p><p><img src="${pasted()}" width="300" alt=""></p><p><br></p><div data-sm-signature=""><p>-- <br>Kovács Árpád</p><p><img src="sig-img://session/${SID}" alt=""></p></div>`

const SAMPLES = {
  'the draft: a pasted image and the signature image': DRAFT,
  'a pasted image without width, with an odd alt': `<p>a <img src="${pasted()}" alt="valami"> b</p>`,
  'a pasted image with a bad width (0, text, too long)': `<p><img src="${pasted()}" width="0"><img src="${pasted(SID, 'a'.repeat(24))}" width="12px"><img src="${pasted(SID, 'b'.repeat(24))}" width="123456"></p>`,
  'a pasted image with a padded width': `<p><img src="${pasted()}" width=" 320 "></p>`,
  'the account\'s signature image': `<div data-sm-signature=""><p><img src="sig-img://account/12" alt=""></p></div>`,
  'a width on a signature image goes': `<p><img src="sig-img://session/${SID}" width="200"></p>`,
  'another session\'s pasted image goes': `<p>x<img src="${pasted(OTHER)}" width="300">y</p>`,
  'foreign images go: http, https, data, cid, file, protocol-relative': `<p>1<img src="http://evil.invalid/t.gif">2<img src="https://evil.invalid/t.png">3<img src="data:image/png;base64,AAAA">4<img src="cid:x@y">5<img src="file:///C:/x.png">6<img src="//evil.invalid/x"></p>`,
  'a bad inl-img id or session form goes': `<p><img src="inl-img://session/${SID}/XYZ"><img src="inl-img://session/abc/${ID}"><img src="inl-img://session/${SID}/${ID}/x"></p>`,
  'a signature marker on another tag goes': `<p data-sm-signature="">x</p><span data-sm-signature="">y</span>`,
  'the marker with a value and an alignment': `<div data-sm-signature="x" align="center"><p>--</p></div>`,
  'the marker with a scheme-like or padded value': `<div data-sm-signature=" https://x "><p>a</p></div><div data-sm-signature="  "><p>b</p></div><div data-sm-signature="java script:x"><p>c</p></div>`,
  'an image inside a link and a table cell': `<p><a href="https://example.invalid/"><img src="${pasted()}" width="100"> link</a></p><table><tr><td><img src="sig-img://session/${SID}"></td></tr></table>`,
  'onerror and other attributes on an own image go': `<p><img src="${pasted()}" width="50" onerror="alert(1)" style="width:9999px" class="x" title="t" height="9"></p>`,
}

for (const [name, html] of Object.entries(SAMPLES)) {
  test(`own images: the mirror = the composer's sanitizer, byte for byte: ${name}`, () => {
    const out = composer(html)
    assert.equal(mirror(html), out)
    assert.equal(mirror(out), out, 'a second cleaning (mirror) changes nothing')
    assert.equal(composer(out), out, 'a second cleaning (sanitizer) changes nothing')
  })
}

test('own images: the draft keeps both images and the marker; foreign ones never pass', () => {
  const out = mirror(DRAFT)
  assert.match(out, new RegExp(`<img src="${pasted()}" alt="" width="300">`))
  assert.match(out, new RegExp(`<div data-sm-signature=""><p>-- <br>Kovács Árpád</p><p><img src="sig-img://session/${SID}" alt=""></p></div>`))
  const foreign = mirror(SAMPLES['foreign images go: http, https, data, cid, file, protocol-relative'] + SAMPLES['another session\'s pasted image goes'])
  assert.doesNotMatch(foreign, /<img/)
})

test('without ownImagesOf the mirror is as before: no image, no marker (rich and plain)', () => {
  assert.doesNotMatch(visibleComposeHtml(DRAFT, { rich: true }), /<img|data-sm-signature/)
  assert.doesNotMatch(visibleComposeHtml(DRAFT), /<img|data-sm-signature/)
  assert.equal(visibleComposeHtml(DRAFT, { rich: true }), '<p>Szia <b>x</b></p><p></p><p><br></p><div><p>-- <br>Kovács Árpád</p><p></p></div>')
})

test('ownImagesOf only with rich and a session id', () => {
  assert.throws(() => visibleComposeHtml(DRAFT, { ownImagesOf: SID }), TypeError)
  assert.throws(() => visibleComposeHtml(DRAFT, { rich: true, ownImagesOf: '' }), TypeError)
  assert.throws(() => visibleComposeHtml(DRAFT, { rich: true, ownImagesOf: 42 }), TypeError)
})
