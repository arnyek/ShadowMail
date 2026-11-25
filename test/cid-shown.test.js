// The cid: images the reader's frame shows (imgCidRefsIn): only real <img> elements, as an HTML parser reads them. An
// "<img src=cid:..>" that is only text (a comment, an attribute value, a textarea, a script ...) shows nothing, so its
// part is offered as a file; so is a part of a type the frame does not serve (an SVG). The set is checked against the
// frame's own sanitizer (sanitizeMail on jsdom): what it hides, the frame shows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { imgCidRefsIn } from '../core/mime/cid.js'
import { offeredAttachments } from '../app/main/reader.js'
import { sanitizeMail } from '../app/renderer/src/sanitize.js'

const purify = createDOMPurify(new JSDOM('').window)
const SCR = 'scr' + 'ipt'

/** The cid: references the frame shows: the <img src> the sanitizer turned into cid-img://m7/<cid>. */
function frameRefs(html) {
  const out = sanitizeMail(purify, html, { messageId: 7 }).html
  const doc = new JSDOM(`<!doctype html><body>${out}</body>`).window.document
  const refs = new Set()
  for (const img of doc.querySelectorAll('img')) {
    const m = /^cid-img:\/\/m7\/(.*)$/.exec(img.getAttribute('src') || '')
    if (m) refs.add(decodeURIComponent(m[1]))
  }
  return refs
}

const IMG = '<img src="cid:a@x">'
// the image's tag only as text: the frame shows nothing
const HIDDEN = {
  comment: `<!-- ${IMG} --><p>t</p>`,
  'attribute value': `<a title='${IMG}' href="https://e.invalid">t</a>`,
  'double-quoted attribute': `<p title="&lt;img src=&quot;cid:a@x&quot;&gt;">t</p>`,
  textarea: `<textarea>${IMG}</textarea>`,
  title: `<title>${IMG}</title><p>t</p>`,
  [SCR]: `<${SCR}>var s = '${IMG}'</${SCR}><p>t</p>`,
  style: `<style>/* ${IMG} */</style><p>t</p>`,
  noscript: `<noscript>${IMG}</noscript><p>t</p>`,
  template: `<template>${IMG}</template><p>t</p>`,
  xmp: `<xmp>${IMG}</xmp>`,
  'svg foreign content': `<svg><foreignObject>${IMG}</foreignObject></svg><p>t</p>`,
  video: `<video>${IMG}</video><p>t</p>`,
  'srcset only': '<img srcset="cid:a@x 1x">',
  'escaped text': '<p>&lt;img src="cid:a@x"&gt;</p>',
}
// a real image: the frame shows it
const SHOWN = {
  plain: IMG,
  'no quotes': '<img src=cid:a@x>',
  'upper case': '<IMG SRC="CID:a@x">',
  'in < >': '<img src="cid:<a@x>">',
  spaces: '<img src="  cid:a@x  ">',
  'in a table': `<table><tr><td>${IMG}</td></tr></table>`,
  'after a closed comment': `<!-- x -->${IMG}`,
  'after a closed noscript': `<noscript><p>n</p></noscript>${IMG}`,
  'after a closed template and video': `<template><p>t</p></template><video></video>${IMG}`,
  'in a form (its content stays)': `<form>${IMG}</form>`,
  'in a picture (its content stays)': `<picture>${IMG}</picture>`,
  entity: '<img src="cid&#58;a@x">',
}

test('an <img src=cid:> that is only text shows nothing and hides nothing; the frame agrees', () => {
  for (const [name, html] of Object.entries(HIDDEN)) {
    assert.deepEqual([...imgCidRefsIn(html)], [], name)
    assert.deepEqual([...frameRefs(html)], [], `${name}: the frame shows nothing either`)
  }
})

test('a real <img src=cid:> is counted, as the frame shows it', () => {
  for (const [name, html] of Object.entries(SHOWN)) {
    assert.deepEqual([...imgCidRefsIn(html)], [...frameRefs(html)], name)
    assert.deepEqual([...imgCidRefsIn(html)], ['a@x'], name)
  }
})

const parsedWith = (html, part) => ({ html, attachments: [{ index: 0, filename: 'a', inline: true, cid: '<a@x>', ...part }, { index: 1, filename: 'b.pdf', inline: false, contentType: 'application/pdf' }] })
const offered = parsed => offeredAttachments(parsed).map(a => a.index)

test('the attachments: the part an <img> only as text names is offered; a shown PNG is not', () => {
  for (const [name, html] of Object.entries(HIDDEN)) assert.deepEqual(offered(parsedWith(html, { contentType: 'image/png' })), [0, 1], name)
  assert.deepEqual(offered(parsedWith(IMG, { contentType: 'image/png' })), [1])
})

test('the attachments: an <img>-referred part of a type the frame does not serve (SVG) is offered', () => {
  assert.deepEqual(offered(parsedWith(IMG, { contentType: 'image/svg+xml' })), [0, 1])
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) assert.deepEqual(offered(parsedWith(IMG, { contentType: type })), [1], type)
})

test('never more than the frame shows: generated pages of wrappers, positions and quoting', () => {
  const wrappers = [x => x, ...Object.values(HIDDEN).map(h => x => h.replace(IMG, x)), x => `<div>${x}</div>`, x => `<table><tr><td>${x}</td></tr></table>`, x => `<p>${x}`, x => `<ul><li>${x}</ul>`, x => `<!--${x}-->`, x => `<a title="${x}">t</a>`]
  const imgs = ['<img src="cid:a@x">', '<img src=cid:b@x>', '<img src="cid:<c@x>">', '<img alt=">" src="cid:d@x">', "<img src='cid:e@x'>"]
  let checked = 0
  let rnd = 7
  const next = n => ((rnd = (rnd * 1103515245 + 12345) % 2147483648), rnd % n)
  for (let i = 0; i < 400; i++) {
    let html = ''
    for (let k = 0; k < 3; k++) html += wrappers[next(wrappers.length)](wrappers[next(wrappers.length)](imgs[next(imgs.length)]))
    const ours = imgCidRefsIn(html)
    const frame = frameRefs(html)
    for (const ref of ours) assert.ok(frame.has(ref), `hidden but not shown: ${ref} in ${html}`)
    checked++
  }
  assert.equal(checked, 400)
})

test('linear: 4x the images take at most ~4x the time (best of 3)', () => {
  const page = n => Array.from({ length: n }, (_, i) => `<p><img src="cid:i${i}@x"><!-- <img src="cid:c${i}@x"> --></p>`).join('')
  const best = html => {
    let ms = Infinity
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      imgCidRefsIn(html)
      ms = Math.min(ms, performance.now() - t0)
    }
    return ms
  }
  const small = page(20_000)
  const big = page(80_000)
  assert.equal(imgCidRefsIn(big).size, 80_000)
  const ratio = best(big) / best(small)
  assert.ok(ratio < 7, `80 000 images ${ratio.toFixed(1)}x the time of 20 000`)
})
