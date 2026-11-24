// SPDX-License-Identifier: GPL-3.0-or-later
// Claude's html body (MCP create_draft, create_reply_draft, update_draft, send_message): ownHtml cleans it with the main
// process's mirror of the composer's sanitizer. The same bytes as the composer's own cleaning of that HTML; what is
// not the toolbar's goes; nothing left or a cut input is an error; text keeps its old path byte for byte.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'
import { ownHtml, HTML_TEXT, MAX_DRAFT_TEXT } from '../app/main/mcp/tools.js'
import { complexNewsletterHtml } from './helpers/newsletter.js'

const purify = createDOMPurify(new JSDOM('').window)
const composer = html => sanitizeCompose(purify, html, { tableRows: true })
const errOf = fn => {
  try {
    fn()
  } catch (e) {
    return e.code
  }
  return null
}

// what Claude writes: the composer's own formatting
const KEPT = {
  'bold, italic, underline, strike': '<p><b>félkövér</b>, <strong>erős</strong>, <i>dőlt</i>, <em>hang</em>, <u>aláhúzott</u>, <s>áthúzott</s></p>',
  'lists': '<ul><li>egy</li><li>kettő <b>b</b></li></ul><ol><li>első</li><li>második</li></ol>',
  'quote and headings': '<h1>Cím</h1><h2>Alcím</h2><h3>Kisebb</h3><blockquote><p>idézet</p></blockquote>',
  'code': '<pre><code>const a = 1 &lt; 2</code></pre><p>inline <code>x()</code></p>',
  'links': '<p><a href="https://example.invalid/a?b=1&amp;c=2">link</a> és <a href="mailto:anna@example.invalid">levél</a> és <a href="HTTP://EXAMPLE.INVALID/">nagy</a></p>',
  'line breaks and divs': '<div>első sor<br>második sor</div><p></p><div><span>span</span></div>',
}
// what goes: every attribute but the href, styles, scripts, images, frames, other link targets
const DROPPED = {
  'style, class, id, on*': '<p style="color:red" class="x" id="y" onclick="alert(1)">szöveg</p>',
  'script, style element, iframe, img, form': '<p>a</p><script>alert(1)</script><style>p{}</style><iframe src="https://evil.invalid/"></iframe><img src="https://evil.invalid/t.gif"><form><input value="x"></form><p>b</p>',
  'javascript:, data:, vbscript: and protocol-less hrefs': '<p><a href="javascript:alert(1)">j</a> <a href="data:text/html,x">d</a> <a href=" vbscript:x">v</a> <a href="//evil.invalid">p</a> <a href="/rel">r</a></p>',
  // (a table stands outside the paragraph: a DOM parser closes the p before it, htmlparser2 does not, an old difference
  // of the two parsers that well-formed HTML never meets)
  'unknown tags unwrapped, text kept': '<p><font color="red">piros</font> <mark>jel</mark> <sup>2</sup></p><table><tr><td>a</td><td>b</td></tr></table>',
}

for (const [name, html] of Object.entries({ ...KEPT, ...DROPPED })) {
  test(`html: the same bytes as the composer's own cleaning: ${name}`, () => {
    const out = ownHtml({ html })
    assert.equal(out, composer(html))
    assert.equal(ownHtml({ html: out }), out, 'a second cleaning changes nothing')
  })
}

test('html: the toolbar\'s tags stay, every other attribute, style, image, script and bad link goes', () => {
  for (const html of Object.values(KEPT)) assert.match(ownHtml({ html }), /<(b|ul|h1|pre|a|div)\b/)
  const kept = ownHtml({ html: Object.values(KEPT).join('') })
  for (const tag of ['b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'blockquote', 'pre', 'code', 'a', 'br', 'div', 'span']) assert.match(kept, new RegExp(`<${tag}[ >]`), tag)
  assert.match(kept, /<a href="https:\/\/example\.invalid\/a\?b=1&amp;c=2">link<\/a>/)
  assert.match(kept, /<a href="mailto:anna@example\.invalid">/)
  const dropped = ownHtml({ html: Object.values(DROPPED).join('') })
  assert.doesNotMatch(dropped, /style=|class=|id=|onclick|<script|<style|<iframe|<img|<form|<input|javascript:|data:|vbscript:|evil\.invalid|<font|<table/)
  assert.match(dropped, /szöveg/)
  assert.match(dropped, /piros/)
})

test('html: hidden text is dropped (display:none, the hidden attribute)', () => {
  const out = ownHtml({ html: '<p>látható</p><p style="display:none">REJTETT1</p><div hidden>REJTETT2</div><span style="font-size:0">REJTETT3</span>' })
  assert.match(out, /látható/)
  assert.doesNotMatch(out, /REJTETT/)
})

test('text and html: never both; text keeps its old path byte for byte; nothing visible or cut: an error', () => {
  assert.equal(errOf(() => ownHtml({ text: 'a', html: '<p>b</p>' })), 'bad_arguments')
  assert.equal(ownHtml({ text: 'Szia,\n<b>nem HTML</b> & "x"' }), '<p>Szia,<br>&lt;b&gt;nem HTML&lt;/b&gt; &amp; &quot;x&quot;</p>')
  assert.equal(ownHtml({}), '<p></p>', 'neither: the old empty paragraph')
  for (const html of ['', '   ', '<p></p>', '<p> &nbsp; </p>', '<img src="https://x.invalid/a.png">', '<script>x</script>', '<p style="display:none">csak rejtett</p>', '<a href="https://x.invalid/"></a>'])
    assert.equal(errOf(() => ownHtml({ html })), 'empty_html', JSON.stringify(html))
  // past MAX_DEPTH open elements the mirror cuts the rest ('tags'): refused, never half sent
  assert.equal(errOf(() => ownHtml({ html: `${'<div>'.repeat(5000)}x${'</div>'.repeat(5000)}` })), 'too_complex')
  // over the work ceiling ('complex': every rule in one class list, the case the ancestor-key index cannot narrow): refused too
  assert.equal(errOf(() => ownHtml({ html: complexNewsletterHtml() })), 'too_complex')
  assert.match(HTML_TEXT.too_complex, /semmi nem íródott/)
  assert.match(HTML_TEXT.empty_html, /semmi nem íródott/)
})

test('html: linear on 100 000 characters of deep, unclosed or many tags (cut ones refused)', () => {
  const N = MAX_DRAFT_TEXT
  const cases = {
    'nested b, never closed': '<b>x'.repeat(N / 4).slice(0, N),
    'unclosed paragraphs': '<p>a'.repeat(N / 4).slice(0, N),
    'nested lists': `${'<ul><li>'.repeat(900)}x`.padEnd(N, 'y'),
    'many links': '<a href="https://a.invalid/">l</a>'.repeat(Math.floor(N / 34)),
    'unclosed tags with attributes': '<div class="x" style="y">'.repeat(Math.floor(N / 25)),
  }
  for (const [name, html] of Object.entries(cases)) {
    assert.ok(html.length <= N, name)
    const t0 = performance.now()
    let code = null
    try {
      ownHtml({ html })
    } catch (e) {
      code = e.code
    }
    const ms = performance.now() - t0
    // an absolute bound loose enough for a loaded suite (measured on a quiet machine: see the card); a quadratic walk
    // would take far longer
    assert.ok(ms < 3000, `${name}: ${Math.round(ms)} ms`)
    assert.ok(code === null || code === 'too_complex' || code === 'empty_html', `${name}: ${code}`)
  }
})
