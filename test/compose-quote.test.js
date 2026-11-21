// the quote of a reply draft Claude makes is the original's visible part as the
// composer's own HTML. Measured against the real composer sanitizer (sanitize.js sanitizeCompose, DOMPurify on
// jsdom): the same tags in the same order and the same text; from a hostile original nothing active remains.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'
import { visibleComposeHtml } from '../core/mime/visible-text.js'
import { SAMPLES as COLOR_SAMPLES } from './helpers/color-samples.js'

const purify = createDOMPurify(new JSDOM('').window)
// tags in order + the text, from a serialized fragment (attribute order and quoting do not matter; href, color and
// style are compared)
const shape = html => {
  const doc = new JSDOM(`<body>${html}</body>`).window.document
  const out = []
  const walk = n => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out.push(`#${c.data}`)
      else if (c.nodeType === 1) {
        const attr = name => (c.getAttribute(name) !== null ? ` ${name}=${c.getAttribute(name)}` : '')
        out.push(`<${c.localName}${attr('href')}${attr('color')}${attr('style')}>`)
        walk(c)
        out.push(`</${c.localName}>`)
      }
    }
  }
  walk(doc.body)
  // adjacent text nodes merged
  return out.reduce((a, x) => (x.startsWith('#') && a.length && a[a.length - 1].startsWith('#') ? [...a.slice(0, -1), a[a.length - 1] + x.slice(1)] : [...a, x]), [])
}

const SAME = {
  'paragraphs and breaks': '<p>Első sor<br>második</p><p>Harmadik &amp; negyedik</p>',
  'bold, italic, underline, strike': '<p><b>b</b> <strong>s</strong> <i>i</i> <em>e</em> <u>u</u> <s>x</s></p>',
  'lists': '<ul><li>egy</li><li>kettő</li></ul><ol><li>a</li></ol>',
  'headings and blockquote': '<h1>Cím</h1><h2>Al</h2><h3>Kicsi</h3><blockquote>idézet</blockquote>',
  'links: http, mailto kept, others plain': '<p><a href="https://example.invalid/x?a=1&amp;b=2">web</a> <a href="mailto:a@example.invalid">levél</a> <a href="javascript:alert(1)">js</a> <a href="ftp://x">ftp</a></p>',
  'a table: a line per row, the cells one space apart': '<table><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></table>',
  'a table with thead / tbody / tfoot, a caption, header cells, links in a cell': '<table><caption>Cím</caption><thead><tr><th>Név</th><th>Ár</th></tr></thead><tbody><tr><td><a href="https://example.invalid/">Termék</a></td><td>1000 Ft</td></tr></tbody><tfoot><tr><td>Össz</td><td>1000</td></tr></tfoot></table>',
  'a nested table and an empty cell': '<table><tr><td><table><tr><td>be1</td><td>be2</td></tr></table></td><td></td><td>jobb</td></tr></table>',
  'a table among paragraphs': '<p>Előtte</p><table><tr><td>a</td><td>b</td></tr></table><p>Utána</p>',
  'font and center unwrapped': '<center><font color="red" size="2">piros</font></center>',
  'div and span kept, attributes gone': '<div class="x" style="color:red" id="i"><span title="t">szöveg</span></div>',
  'pre and code': '<pre>  két  szóköz\n  sor</pre><code>x = 1</code>',
  'nbsp and entities': '<p>a&nbsp;b &lt;c&gt; &quot;d&quot;</p>',
}
for (const [name, html] of Object.entries(SAME)) {
  test(`quote = sanitizeCompose: ${name}`, () => {
    // the composer's starting body asks for the table rows (Composer.jsx writeBody), so the quote is measured so too
    assert.deepEqual(shape(visibleComposeHtml(html)), shape(sanitizeCompose(purify, html, { tableRows: true })))
  })
}

// the composer's colours (core/smtp/text-colors.js): the mirror keeps what sanitizeCompose keeps, with the option and
// without it (Claude's quote: no colour at all; the MCP send_draft of the user's own saved draft: the palette stays)
for (const [name, html] of Object.entries(COLOR_SAMPLES)) {
  for (const colors of [false, true]) {
    test(`quote = sanitizeCompose, colors ${colors ? 'on' : 'off'}: ${name}`, () => {
      const mirror = visibleComposeHtml(html, { colors })
      assert.deepEqual(shape(mirror), shape(sanitizeCompose(purify, html, { tableRows: true, colors })))
      if (!colors) assert.ok(!/<font|style=|color=/.test(mirror), mirror)
    })
  }
}

test('the mirror\'s colours: escaped, a font with nothing left unwrapped, the default is without colours', () => {
  const html = '<p><font color="#c62828" style="background-color: rgb(255, 245, 157);">x</font><font face="Arial">y</font></p>'
  assert.equal(visibleComposeHtml(html), '<p>xy</p>')
  assert.equal(visibleComposeHtml(html, { colors: true }), '<p><font color="#c62828" style="background-color: rgb(255, 245, 157);">x</font>y</p>')
  // an attribute value that tries to break out is no palette value: nothing of it is written
  assert.equal(visibleComposeHtml('<p><font color="#c62828&quot; onclick=&quot;x">x</font></p>', { colors: true }), '<p>x</p>')
})

test('quote from a hostile original: no script, style, image, handler, javascript: link, frame, svg or hidden text', () => {
  const X = 'INJECTX'
  const html = [
    '<p>Látható</p>',
    `<script>alert('${X}')</script>`,
    `<style>.h{display:none}</style><p class="h">${X}1</p>`,
    '<img src="https://track.example.invalid/p.gif" onerror="alert(1)">',
    `<a href="javascript:alert(1)" onclick="x()">kattints</a>`,
    '<a href="java\u0000script:alert(2)">nul</a> <a href="https:\u0000//example.invalid/x">nulhttps</a>',
    `<iframe src="https://example.invalid">${X}2</iframe>`,
    `<svg><text>${X}3</text></svg>`,
    `<div style="display:none">${X}4</div>`,
    `<span style="font-size:0">${X}5</span>`,
    `<p style="color:#fff">${X}6</p>`,
    '<form action="https://evil.invalid"><input value="v"><button>Gomb</button></form>',
  ].join('')
  const out = visibleComposeHtml(html)
  assert.ok(out.includes('Látható') && out.includes('kattints') && out.includes('Gomb'))
  assert.ok(!out.includes(X), out)
  assert.ok(!out.includes('\u0000'), 'no NUL in a href')
  for (const bad of ['<script', '<style', '<img', 'onerror', 'onclick', 'javascript:', '<iframe', '<svg', 'style=', '<form', '<input', 'track.example']) {
    assert.ok(!out.toLowerCase().includes(bad), `${bad} in ${out}`)
  }
})

test('an <a> inside an <a> is unwrapped (its text stays), so no second, unlisted link goes out', () => {
  const two = visibleComposeHtml('<p>Kerem: <a href="https://netbank.otp.hu/">OTP <a href="https://phish6.evil.invalid/login">belepes</a></a></p>')
  assert.equal(two, '<p>Kerem: <a href="https://netbank.otp.hu/">OTP belepes</a></p>')
  const three = visibleComposeHtml('<a href="https://a.invalid/">a <a href="https://b.invalid/">b <a href="https://c.invalid/">c</a></a></a> <a href="https://d.invalid/">d</a>')
  assert.equal((three.match(/<a /g) || []).length, 2, three)
  assert.ok(!three.includes('b.invalid') && !three.includes('c.invalid') && three.includes('a b c') && three.includes('d.invalid'), three)
})

test('Claude\'s quote of a table: text written right in a table or a row is kept where it stands, as sanitize.js tableToLines does', () => {
  // htmlparser2 keeps it in the table (a browser would move it out, so this is no parity sample)
  const out = visibleComposeHtml('<table>kint<tr><td>a</td>sor<td>b</td></tr><tbody>\n <tr><td>c</td></tr>lent</tbody></table>')
  const lines = [...new JSDOM(`<body>${out}</body>`).window.document.body.querySelectorAll('div > div')].map(d => d.textContent)
  assert.deepEqual(lines, ['kint', 'a sor b', 'c', 'lent'])
})
