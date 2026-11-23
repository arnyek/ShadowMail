// SPDX-License-Identifier: GPL-3.0-or-later
// The composer's rich allow-list (core/smtp/rich-style.js) and the sanitizer's rich mode (sanitize.js sanitizeCompose
// `rich`): every kept CSS property and attribute kept, every dropped one dropped, the limits on both sides, the output
// form; the hostile sets (the table XSS set of the table paste, style payloads) leave nothing active on both ways (the
// sanitizer and the main process's mirror), stable on a second cleaning. Without `rich` nothing of this is kept.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { cleanStyle, cleanAttr, isColor, richAttrs, RICH_ATTRS, RICH_PROPERTIES, RICH_EXTRA_TAGS, MAX_STYLE, MAX_VALUE, FORBIDDEN_VALUE } from '../core/smtp/rich-style.js'
import { sanitizeCompose, COMPOSE_TAGS, RICH_TAGS } from '../app/renderer/src/sanitize.js'
import { visibleComposeHtml } from '../core/mime/visible-text.js'

const purify = createDOMPurify(new JSDOM('').window)
const rich = html => sanitizeCompose(purify, html, { rich: true })
const plain = html => sanitizeCompose(purify, html)
const mirror = html => visibleComposeHtml(html, { rich: true })
const kept = (decl, tag = 'span') => cleanStyle(decl, tag) === `${decl.replace(/;?\s*$/, '')};`
const dropped = (decl, tag = 'span') => cleanStyle(decl, tag) === ''

// one value each that stays: every property of the allow-list has one
const KEEP = {
  color: 'rgb(198, 40, 40)',
  'background-color': '#fff59d',
  'font-family': '"Times New Roman", Times, serif',
  'font-size': '14pt',
  'font-weight': '700',
  'font-style': 'italic',
  'font-variant': 'small-caps',
  'font-variant-caps': 'small-caps',
  'text-decoration': 'underline dotted #ff0000',
  'text-decoration-line': 'underline line-through',
  'text-decoration-style': 'wavy',
  'text-decoration-color': 'blue',
  'text-transform': 'uppercase',
  'letter-spacing': '1px',
  'word-spacing': '-2px',
  'line-height': '1.15',
  'text-align': 'center',
  'text-indent': '18pt',
  'vertical-align': 'super',
  'text-shadow': '1px 1px 2px #888888',
  margin: '0cm 0cm 0cm 36pt',
  padding: '4px 8px',
  border: 'solid windowtext 1.0pt',
  'border-width': '1px 2px',
  'border-style': 'solid dashed',
  'border-color': '#999999 red',
  'border-collapse': 'collapse',
  'border-spacing': '2px 4px',
  'border-radius': '4px',
  'list-style-type': 'lower-roman',
  'list-style-position': 'inside',
  width: '50%',
  'min-width': '120px',
  'max-width': '600px',
}
for (const s of ['top', 'right', 'bottom', 'left']) {
  KEEP[`margin-${s}`] = '6pt'
  KEEP[`padding-${s}`] = '0.5em'
  KEEP[`border-${s}`] = '1px solid #cccccc'
  KEEP[`border-${s}-width`] = 'thin'
  KEEP[`border-${s}-style`] = 'double'
  KEEP[`border-${s}-color`] = 'hsl(120, 50%, 50%)'
}

test('every property of the allow-list has a kept value (on a table cell, where width is allowed too)', () => {
  assert.deepEqual(Object.keys(KEEP).sort(), [...RICH_PROPERTIES].sort(), 'the sample covers the list')
  for (const [prop, value] of Object.entries(KEEP)) assert.ok(kept(`${prop}: ${value}`, 'td'), `${prop}: ${value} -> ${cleanStyle(`${prop}: ${value}`, 'td')}`)
})

// what goes, by reason (the module's header lists them)
const DROP = {
  'code and loading': [
    'background-image: url(https://evil.invalid/x.png)', 'background: url(https://evil.invalid/x.png)', 'color: url(x)', 'color: URL(x)',
    'background: #fff url(x)', 'background-color: image-set("x.png" 1x)', 'width: expression(alert(1))', 'color: expression(alert(1))',
    'color: u\\72l(x)', 'color: \\72 ed', 'col\\6fr: red', 'behavior: url(x.htc)', 'color: @import', '-moz-binding: url(x)',
    'color: /* x */ red', 'color: red /*', 'color: <script>', 'color: "red"', 'font-family: "a" onclick="x"', 'color: red !ie', 'color: {red}',
    'color: javascript:alert(1)', 'color: var(--x)', 'color: calc(1)', 'color: attr(x)', 'font-size: calc(10px + 2px)',
  ],
  'breaking out, covering': ['position: fixed', 'position: absolute', 'top: 0', 'right: 0', 'bottom: 0', 'left: -9999px', 'z-index: 99', 'transform: scale(2)', 'float: left', 'clear: both', 'display: none', 'display: block', 'overflow: hidden', 'clip: rect(0 0 0 0)', 'clip-path: inset(50%)'],
  'cutting, empty bands': ['height: 1px', 'min-height: 900px', 'max-height: 0'],
  'freezing and turning the text': ['white-space: nowrap', 'white-space: pre', 'word-break: keep-all', 'overflow-wrap: anywhere', 'direction: rtl', 'unicode-bidi: bidi-override'],
  'no formatting, or not portable': [
    'mso-list: l0 level1 lfo1', 'mso-fareast-font-family: Symbol', '-webkit-text-stroke-width: 0px', '-moz-user-select: none', 'animation: x 1s', 'transition: all 1s',
    'filter: blur(2px)', 'mix-blend-mode: multiply', 'backdrop-filter: blur(1px)', 'opacity: 0.5', 'visibility: hidden', 'cursor: pointer', 'pointer-events: none',
    'user-select: none', 'content: "x"', 'background-position: 0 0', 'background-repeat: no-repeat', 'background-size: cover', 'font: 12px Arial',
    'orphans: 2', 'widows: 2', 'text-decoration-thickness: initial', 'font-variant-ligatures: normal',
  ],
  'a value outside its kind or range': [
    'font-size: 2.9px', 'font-size: 2pt', 'font-size: 97px', 'font-size: 73pt', 'font-size: 6.1em', 'font-size: 601%', 'font-size: -1px', 'font-size: 12',
    'margin: -1px', 'margin-left: -18pt', 'margin: 0 -1px', 'margin: 201px', 'padding: -1px', 'padding: 201px', 'letter-spacing: 21px', 'letter-spacing: -6px',
    'line-height: 0.4', 'line-height: 6', 'text-indent: 201px', 'text-indent: -201px', 'vertical-align: 21px', 'border: 11px solid red', 'border-width: 1px 2px 3px 4px 5px',
    'text-shadow: 21px 0 red', 'text-shadow: 1px 1px 21px red', 'text-shadow: 1px 1px red, 1px 1px red, 1px 1px red, 1px 1px red', 'border-radius: 101px',
    'color: rgb(1, 2)', 'color: rgb(a, b, c)', 'color: #12', 'color: chucknorris', 'font-weight: 1001', 'font-style: sideways', 'text-align: middle',
    'list-style-type: "→"', 'list-style-type: symbols(x)', 'font-family: ""', 'border-spacing: 51px', 'text-decoration: underline underline',
    `color: ${'a'.repeat(MAX_VALUE + 1)}`,
  ],
}
for (const [reason, list] of Object.entries(DROP)) {
  test(`what goes (${reason}): every declaration alone, and next to a kept one it takes nothing with it`, () => {
    for (const decl of list) {
      assert.ok(dropped(decl, 'td'), `${decl} -> ${cleanStyle(decl, 'td')}`)
      assert.equal(cleanStyle(`color: red; ${decl}; font-weight: bold`, 'td'), 'color: red; font-weight: bold;', decl)
    }
  })
}

test('the first layer: every code and loading value is refused by FORBIDDEN_VALUE itself (not only by its property check)', () => {
  for (const v of ['url(x)', 'URL(x)', 'image-set("x" 1x)', 'expression(1)', 'u\\72l(x)', '@import x', '/* x */', 'a */', '<b>', '{x}', 'a!b', 'a&b', 'a;b', '"x"', "'x'", '`x`', 'a\u0000b', 'a\u007fb']) assert.ok(FORBIDDEN_VALUE.test(v), v)
  for (const v of ['rgb(1, 2, 3)', '#fff', '1px solid red', 'Times New Roman', '-18pt', '1.5', 'small-caps']) assert.ok(!FORBIDDEN_VALUE.test(v), v)
})

test('the limits on both sides: the last kept value and the first dropped one', () => {
  const pairs = [
    ['font-size: 3px', 'font-size: 2.99px'], ['font-size: 96px', 'font-size: 96.01px'], ['font-size: 72pt', 'font-size: 72.1pt'], ['font-size: 6em', 'font-size: 6.01em'],
    ['margin: 0', 'margin: -0.01px'], ['margin: 200px', 'margin: 200.1px'], ['padding: 50%', 'padding: 51%'],
    ['letter-spacing: 20px', 'letter-spacing: 20.1px'], ['letter-spacing: -1px', 'letter-spacing: -1.1px'], ['line-height: 0.5', 'line-height: 0.49'], ['line-height: 5', 'line-height: 5.01'],
    ['text-indent: 200px', 'text-indent: 200.1px'], ['vertical-align: -20px', 'vertical-align: -21px'],
    ['border: 10px solid red', 'border: 10.1px solid red'], ['text-shadow: 20px -20px 20px red', 'text-shadow: 20px -20px 20.1px red'],
    ['border-radius: 100px', 'border-radius: 100.5px'], ['border-spacing: 50px', 'border-spacing: 50.5px'],
  ]
  for (const [ok, no] of pairs) {
    assert.ok(kept(ok, 'td'), ok)
    assert.ok(dropped(no, 'td'), no)
  }
  // width: 100% / 1200 px, on a table, a column and a cell only
  for (const tag of ['table', 'col', 'td', 'th']) {
    assert.ok(kept('width: 100%', tag) && kept('width: 1200px', tag) && kept('max-width: 900pt', tag), tag)
    assert.ok(dropped('width: 100.1%', tag) && dropped('width: 1201px', tag) && dropped('width: 901pt', tag), tag)
  }
  for (const tag of ['p', 'div', 'span', 'img', 'hr', 'li', 'font']) assert.ok(dropped('width: 50%', tag) && dropped('min-width: 10px', tag) && dropped('max-width: 10px', tag), tag)
  // MAX_VALUE characters kept, one more not (ten family names, the longest list)
  const names = n => [...Array(9).fill('a'.repeat(19)), 'a'.repeat(n)].join(',')
  assert.equal(names(20).length, MAX_VALUE)
  assert.ok(kept(`font-family: ${names(20)}`) && dropped(`font-family: ${names(21)}`), 'the value length')
})

test('the output form: "prop: value;" one space apart, the source order, the last of a repeated one at its place, !important off, whitespace one space, background as background-color', () => {
  assert.equal(cleanStyle('COLOR:red;font-weight :  bold  ', 'span'), 'color: red; font-weight: bold;')
  assert.equal(cleanStyle('color: red; margin: 0; color: blue; margin-top: 4px', 'span'), 'margin: 0; color: blue; margin-top: 4px;')
  assert.equal(cleanStyle('margin-top: 9px; margin: 0', 'span'), 'margin-top: 9px; margin: 0;')
  assert.equal(cleanStyle('color: red !important; color: green ! IMPORTANT', 'span'), 'color: green;')
  assert.equal(cleanStyle('color:\trgb( 4 ,\n 5 , 6 )', 'span'), 'color: rgb( 4 , 5 , 6 );')
  assert.equal(cleanStyle('background: #ffff00; background-color: red', 'span'), 'background-color: red;')
  assert.equal(cleanStyle('background-color: red; background: #ffff00', 'span'), 'background-color: #ffff00;')
  assert.equal(cleanStyle('background: #fff no-repeat', 'span'), '')
  assert.equal(cleanStyle('color: red; color: url(x)', 'span'), 'color: red;', 'an invalid later one leaves the earlier valid one, as the browser does')
  assert.equal(cleanStyle('constructor: red; __proto__: red; hasOwnProperty: red; toString: x', 'span'), '')
  assert.equal(cleanStyle(';;: ;color:; :red', 'span'), '')
  assert.equal(cleanStyle('color: red', 'br'), '')
  assert.equal(cleanStyle('color: red', 'img'), '')
  // at most MAX_STYLE characters: the declarations past it go, whole
  // long colour values (leading zeros: still a colour) take the whole allow-list over the limit
  const longColor = `rgb(${'0'.repeat(60)}4, 5, 6)`
  const long = { ...Object.fromEntries(Object.entries(KEEP).map(([p, v]) => [p, isColor(v) ? longColor : v])), 'font-family': [...Array(9).fill('a'.repeat(19)), 'a'.repeat(20)].join(','), 'text-shadow': '1px 1px 2px #888888, 2px 2px 3px #777777, 3px 3px 4px #666666' }
  const decls = Object.entries(long).map(([p, v]) => `${p}: ${v};`)
  const whole = decls.join(' ')
  assert.ok(whole.length > MAX_STYLE, `the sample is over the limit (${whole.length})`)
  const out = cleanStyle(decls.join(''), 'td')
  assert.ok(out.length <= MAX_STYLE && out.length > MAX_STYLE - 60, out.length)
  assert.ok(whole.startsWith(out + ' '), 'the first ones kept, whole; the rest out')
})

test('colours: #hex 3/4/6/8, rgb(a) / hsl(a) with numbers, names, transparent, currentcolor, system colours; nothing else', () => {
  for (const c of ['#abc', '#abcd', '#aabbcc', '#aabbccdd', '#ABC', 'rgb(1, 2, 3)', 'rgba(1, 2, 3, 0.5)', 'rgb(1 2 3 / 50%)', 'hsl(120deg, 50%, 50%)', 'hsla(120, 50%, 50%, .5)', 'RED', 'rebeccapurple', 'transparent', 'currentColor', 'windowtext', 'WindowText', 'canvastext']) assert.ok(isColor(c), c)
  for (const c of ['', '#ab', '#abcde', 'rgb(1, 2)', 'rgb(1, 2, 3, 4, 5)', 'rgb(1, 2, x)', 'rgb(1, 2, 3))', 'rgb(var(--x), 1, 2)', 'notacolor', 'red blue', 'url(x)', 'expression(1)', 'javascript:alert(1)', 'rgb(1,2,3);x:y']) assert.ok(!isColor(c), c)
})

test('a text colour nobody sees goes (transparent, alpha under 0.1): it is the hidden-text trick; a background may be transparent', () => {
  for (const v of ['transparent', 'TRANSPARENT', '#0000', '#ff000019', 'rgba(1, 2, 3, 0)', 'rgb(1 2 3 / 5%)', 'hsla(1, 2%, 3%, 0.09)']) {
    assert.ok(dropped(`color: ${v}`), v)
    assert.ok(dropped(`text-decoration-color: ${v}`), v)
    assert.equal(cleanAttr('font', 'color', v), null, v)
    assert.ok(kept(`background-color: ${v}`), v)
  }
  for (const v of ['#ff00001a', 'rgba(1, 2, 3, 0.1)', 'rgb(1 2 3 / 10%)', 'rgba(1, 2, 3, none)']) assert.ok(kept(`color: ${v}`), v)
})

test('attributes: each tag its own, each value checked, both sides of every limit', () => {
  const yes = [
    ['font', 'color', '#1f497d'], ['font', 'face', 'Times New Roman, serif'], ['font', 'size', '1'], ['font', 'size', '7'],
    ['table', 'border', '0'], ['table', 'border', '10'], ['table', 'cellpadding', '50'], ['table', 'cellspacing', '0'], ['table', 'width', '100%'], ['table', 'width', '1200'], ['table', 'align', 'center'], ['table', 'bgcolor', '#eeeeee'],
    ['td', 'colspan', '1'], ['td', 'colspan', '1000'], ['td', 'rowspan', '1000'], ['td', 'width', '33.3%'], ['td', 'align', 'justify'], ['td', 'valign', 'top'], ['td', 'bgcolor', 'yellow'],
    ['th', 'colspan', '2'], ['tr', 'align', 'right'], ['tr', 'valign', 'baseline'], ['tr', 'bgcolor', 'rgb(1, 2, 3)'], ['col', 'span', '3'], ['col', 'width', '120'],
    ['ol', 'start', '-3'], ['ol', 'start', '42'], ['ol', 'type', 'a'], ['ol', 'type', 'I'], ['li', 'value', '5'],
    ['p', 'align', 'center'], ['div', 'align', 'right'], ['h1', 'align', 'left'], ['h6', 'align', 'justify'],
  ]
  for (const [tag, name, value] of yes) assert.equal(cleanAttr(tag, name, ` ${value} `), value, `${tag} ${name}=${value}`)
  const no = [
    ['font', 'size', '0'], ['font', 'size', '8'], ['font', 'size', '+1'], ['font', 'face', 'a<b'], ['font', 'face', 'a;b'], ['font', 'face', '"a"'], ['font', 'color', 'javascript:alert(1)'],
    ['table', 'border', '11'], ['table', 'cellpadding', '51'], ['table', 'width', '101%'], ['table', 'width', '1201'], ['table', 'width', '50px'], ['table', 'align', 'justify'], ['table', 'bgcolor', 'url(x)'],
    ['td', 'colspan', '0'], ['td', 'colspan', '1001'], ['td', 'rowspan', '-1'], ['td', 'valign', 'center'], ['td', 'height', '10'], ['td', 'nowrap', ''],
    ['col', 'span', '0'], ['ol', 'type', 'x'], ['ol', 'start', '1.5'], ['li', 'value', 'x'], ['p', 'align', 'middle'],
    // an attribute on a tag that does not take it
    ['span', 'align', 'center'], ['span', 'color', 'red'], ['p', 'width', '10'], ['div', 'bgcolor', 'red'], ['li', 'type', 'a'], ['img', 'align', 'left'],
    // never kept, on any tag
    ['td', 'class', 'x'], ['td', 'id', 'x'], ['td', 'onclick', 'x'], ['p', 'dir', 'rtl'], ['p', 'lang', 'hu'], ['p', 'title', 't'], ['p', 'data-x', '1'], ['p', 'name', 'n'], ['table', 'background', 'x.png'], ['td', 'height', '1'],
    ['constructor', 'x', '1'], ['td', 'constructor', '1'], ['__proto__', 'x', '1'],
  ]
  for (const [tag, name, value] of no) assert.equal(cleanAttr(tag, name, value), null, `${tag} ${name}=${value}`)
  // the order: RICH_ATTRS, the style last, whatever the source order
  const attrs = { style: 'color: red', size: '2', color: 'blue', face: 'Arial', onclick: 'x' }
  assert.deepEqual(richAttrs('font', n => attrs[n]), [['color', 'blue'], ['face', 'Arial'], ['size', '2'], ['style', 'color: red;']])
  assert.deepEqual(richAttrs('constructor', () => 'x'), [], 'no prototype lookups')
})

test('the sanitizer: the rich tags kept, an unknown tag unwrapped, the attributes in their fixed order, a font with nothing left unwrapped', () => {
  assert.ok(COMPOSE_TAGS.every(t => RICH_TAGS.includes(t)), 'the composer\'s own tags are a part of the rich set')
  assert.deepEqual(RICH_TAGS.slice(COMPOSE_TAGS.length), [...RICH_EXTRA_TAGS])
  for (const tag of ['h4', 'h5', 'h6', 'sup', 'sub', 'mark', 'strike', 'dt', 'dd']) assert.equal(rich(`<${tag}>x</${tag}>`), `<${tag}>x</${tag}>`, tag)
  assert.equal(rich('<p>a<hr>b</p>'), '<p>a</p><hr>b<p></p>')
  assert.equal(rich('<custom-x style="color: red">a</custom-x><center>c</center><section>s</section>'), 'acs')
  assert.equal(rich('<td style="color: red" align="left" bgcolor="red" onclick="x" class="c" width="10">x</td>'), 'x', 'a cell outside a table is no cell')
  assert.equal(rich('<table><tr><td style="color: red" onclick="x" class="c" width="10" bgcolor="red" align="left">x</td></tr></table>'), '<table><tbody><tr><td width="10" align="left" bgcolor="red" style="color: red;">x</td></tr></tbody></table>')
  assert.equal(rich('<p><font style="position: fixed">a</font><font face="">b</font></p>'), '<p>ab</p>')
  // without rich nothing of it: the plain allow-list as before
  assert.equal(plain('<table border="1"><tr><td style="color: red">x</td></tr></table><h4 align="center">h</h4><font color="red">f</font>'), 'xhf')
})

// the table XSS set of the table paste (the tester's 16 payloads) and style payloads, through the rich mode on both
// ways: nothing active, nothing that loads, stable
const XSS = [
  '<table><tr><td><img src=x onerror=window.__p=1></td></tr></table>',
  '<table><tr><td><script>window.__p=1</script>x</td></tr></table>',
  '<table><tr><td><a href="javascript:window.__p=1">a</a></td></tr></table>',
  '<table><caption><svg><style><img src=x onerror=window.__p=1></style></svg></caption><tr><td>x</td></tr></table>',
  '<table><tr><td><math><mi><table><tr><td><mglyph><style><img src=x onerror=window.__p=1></style></mglyph></td></tr></table></mi></math></td></tr></table>',
  '<svg><table><tr><td><img src=x onerror=window.__p=1></td></tr></table></svg>',
  '<math><mtext><table><mglyph><style><img src=x onerror=window.__p=1>',
  '<form><math><mtext></form><form><mglyph><style></math><img src onerror=window.__p=1>',
  '<table><tr><td><noscript><p title="</noscript><img src=x onerror=window.__p=1>"></noscript></td></tr></table>',
  '<table><tr><td><textarea></td><td><img src=x onerror=window.__p=1></textarea></td></tr></table>',
  '<table><tr><td><iframe srcdoc="<script>parent.__p=1</script>"></iframe></td></tr></table>',
  '<table><tr><td><template><img src=x onerror=window.__p=1></template>t</td></tr></table>',
  '<table id="rows"><tr><td><form name="rows"><input name="rows"></form>x</td></tr></table>',
  '<table><tr><th><a href="https://ok.invalid" style="background:url(javascript:x)" onmouseover="window.__p=1">h</a></th><td><div style="position:fixed">d</div></td></tr></table>',
  '<table><tr><td>a<table><tr><td>b<table><tr><td><img src=x onerror=window.__p=1>c</td></tr></table></td></tr></table></td></tr></table>',
  '<table><tr><td>&lt;img src=x onerror=window.__p=1&gt;</td><td>&lt;/td&gt;&lt;script&gt;</td></tr></table>',
  // style payloads
  '<p style="background: url(javascript:alert(1))">a</p>',
  '<p style="background-image: URL(&quot;https://evil.invalid/t.png&quot;)">a</p>',
  '<p style="width: expression(alert(1)); color: red">a</p>',
  '<p style="color: u\\72l(https://evil.invalid/)">a</p>',
  '<p style="color: red; @import url(https://evil.invalid/x.css)">a</p>',
  '<p style="-moz-binding: url(https://evil.invalid/x.xml#x)">a</p>',
  '<p style="behavior: url(x.htc)">a</p>',
  '<p style="font-family: &quot;a&quot;; background: url(/*x*/https://evil.invalid/)">a</p>',
  '<p style="color: red&quot; onmouseover=&quot;alert(1)">a</p>',
  '<table background="https://evil.invalid/t.png" style="background: url(https://evil.invalid/t.png)"><tr><td background="https://evil.invalid/t.png">x</td></tr></table>',
  '<p style="list-style-image: url(https://evil.invalid/x.png); cursor: url(x), auto">a</p>',
  '<p style="color: red; content: url(https://evil.invalid/x.png)">a</p>',
  '<p style="color: rgb(1,2,3)/**/; background: u&#x72;l(https://evil.invalid/)">a</p>',
]
const ACTIVE = /^(script|iframe|style|svg|math|template|noscript|textarea|form|input|object|embed|img|link|meta|base)$/i
function activeIn(html) {
  const doc = new JSDOM(`<body>${html}</body>`).window.document
  const bad = []
  for (const e of doc.body.querySelectorAll('*')) {
    if (ACTIVE.test(e.nodeName)) bad.push(e.nodeName)
    for (const a of e.attributes) {
      if (/^on/i.test(a.name) || /javascript:|vbscript:/i.test(a.value) || ['srcdoc', 'background', 'src', 'class', 'id', 'name'].includes(a.name)) bad.push(`${e.nodeName} ${a.name}`)
      if (a.name === 'style' && /url\(|expression|import|binding|behavior|\\|evil/i.test(a.value)) bad.push(`${e.nodeName} style=${a.value}`)
    }
  }
  return bad
}
for (const [i, p] of XSS.entries()) {
  test(`rich, hostile ${i + 1}: nothing active or loading on both ways, stable: ${p.slice(0, 60)}`, () => {
    const a = rich(p)
    assert.deepEqual(activeIn(a), [], a)
    assert.equal(rich(a), a, 'stable')
    const m = mirror(p)
    assert.deepEqual(activeIn(m), [], m)
    assert.equal(mirror(m), m, 'stable')
    const attrs = html => [...new JSDOM(`<body>${html}</body>`).window.document.body.querySelectorAll('*')].flatMap(e => [...e.attributes].map(x => x.value)).join(' ')
    assert.doesNotMatch(attrs(a) + attrs(m), /evil|__p|alert/, 'not even in an attribute value (as text it may stay, escaped)')
  })
}

test('the rich mode does not keep hidden text out (the mirror does: the visible-text rules); what hides by a dropped property shows', () => {
  // display: none, visibility and a too small font are dropped declarations: the text stays, visible (the paste's own step takes
  // hidden text out before the sanitizer)
  assert.equal(rich('<p><span style="display: none">a</span><span style="font-size: 1px">b</span><span style="visibility: hidden">c</span></p>'), '<p>abc</p>')
  assert.equal(mirror('<p><span style="display: none">a</span><span style="font-size: 1px">b</span><span style="visibility: hidden">c</span>d</p>'), '<p>d</p>')
})

test('no hook is left behind: a rich call leaves the next plain and table-rows calls as before', () => {
  const html = '<table><tr><td style="color: red">a</td><td>b</td></tr></table><font color="#c62828">c</font>'
  const before = [plain(html), sanitizeCompose(purify, html, { tableRows: true })]
  rich(html)
  sanitizeCompose(purify, html, { rich: true, tableRows: true })
  assert.deepEqual([plain(html), sanitizeCompose(purify, html, { tableRows: true })], before)
  assert.deepEqual(before, ['abc', '<div><div>a b</div></div>c'])
})

test('RICH_ATTRS: every name listed has a check (no attribute is kept unchecked)', () => {
  for (const [tag, names] of Object.entries(RICH_ATTRS)) for (const n of names) assert.doesNotThrow(() => cleanAttr(tag, n, '1'), `${tag} ${n}`)
})

test('the net indent is never negative: a negative text-indent at most the own left margin + padding; letter-spacing -1 .. 20 px', () => {
  // Word's hanging indent: kept
  assert.equal(cleanStyle('margin-left: 36pt; text-indent: -18pt;', 'p'), 'margin-left: 36pt; text-indent: -18pt;')
  assert.equal(cleanStyle('margin: 0 0 0 48px; text-indent: -48px;', 'p'), 'margin: 0 0 0 48px; text-indent: -48px;')
  assert.equal(cleanStyle('padding-left: 20px; margin-left: 10px; text-indent: -30px;', 'p'), 'padding-left: 20px; margin-left: 10px; text-indent: -30px;')
  assert.equal(cleanStyle('margin: 0 24px; text-indent: -24px;', 'p'), 'margin: 0 24px; text-indent: -24px;')
  // further left than its own space: the text-indent goes, the rest stays
  assert.equal(cleanStyle('text-indent: -200px; color: red;', 'p'), 'color: red;')
  assert.equal(cleanStyle('margin-left: 10px; text-indent: -11px;', 'p'), 'margin-left: 10px;')
  assert.equal(cleanStyle('margin-left: 10%; text-indent: -1px;', 'p'), 'margin-left: 10%;', 'a % is no known space')
  // the later of a shorthand and its longhand counts
  assert.equal(cleanStyle('margin-left: 40px; margin: 0; text-indent: -20px;', 'p'), 'margin-left: 40px; margin: 0;')
  // a positive one as before; the range still holds with room on the left (-200 px is the last kept value)
  assert.equal(cleanStyle('text-indent: 200px;', 'p'), 'text-indent: 200px;')
  assert.equal(cleanStyle('margin-left: 200px; text-indent: -200px;', 'p'), 'margin-left: 200px; text-indent: -200px;')
  assert.equal(cleanStyle('margin-left: 200px; padding-left: 10px; text-indent: -200.1px;', 'p'), 'margin-left: 200px; padding-left: 10px;')
  for (const v of ['-1px', '0', '20px', 'normal']) assert.ok(kept(`letter-spacing: ${v}`), v)
  for (const v of ['-1.5px', '-5px', '21px']) assert.ok(dropped(`letter-spacing: ${v}`), v)
})

test('a length in em that moves or widens a box holds its bound at the largest font an element may declare (96 px)', () => {
  // margin / padding 0..200 px: 2em is 192 px at a 96 px font, 2.1em is 201.6 px
  for (const p of ['margin-left', 'padding-left', 'padding', 'margin']) {
    assert.ok(kept(`${p}: 2em`), `${p}: 2em`)
    assert.ok(dropped(`${p}: 2.1em`), `${p}: 2.1em`)
    assert.ok(dropped(`${p}: 12em`), `${p}: 12em`)
  }
  // the tester's cases: a 96 px font with 12em on the left
  assert.equal(cleanStyle('font-size: 96px; padding-left: 12em;', 'p'), 'font-size: 96px;')
  assert.equal(cleanStyle('font-size: 96px; margin-left: 12em;', 'p'), 'font-size: 96px;')
  assert.equal(cleanStyle('font-size: 96px; padding-left: 200px; text-indent: -12em;', 'p'), 'font-size: 96px; padding-left: 200px;')
  // text-indent -200..200 px, width up to 1200 px (12.5em)
  assert.ok(kept('text-indent: 2em') && dropped('text-indent: 2.1em') && dropped('text-indent: -2.1em'))
  assert.ok(kept('width: 12.5em', 'td') && dropped('width: 12.6em', 'td') && dropped('max-width: 13em', 'td'))
  // rem and the absolute units as before; a font size in em as before (against the parent's font)
  assert.ok(kept('padding-left: 12rem') && dropped('padding-left: 12.6rem'))
  assert.ok(kept('font-size: 6em') && kept('line-height: 12em'))
})

test('the net indent compares like lengths only: absolute with absolute, em with em, rem with rem, % with %', () => {
  // the absolute units together (Word: margin in inches, indent in points)
  assert.equal(cleanStyle('margin-left: .5in; text-indent: -18pt;', 'p'), 'margin-left: .5in; text-indent: -18pt;')
  assert.equal(cleanStyle('margin-left: .5in; text-indent: -.25in;', 'p'), 'margin-left: .5in; text-indent: -.25in;')
  // em against em (both the element's own font): kept up to the space, further left goes
  assert.equal(cleanStyle('padding-left: 2em; text-indent: -2em;', 'p'), 'padding-left: 2em; text-indent: -2em;')
  assert.equal(cleanStyle('margin-left: 1em; padding-left: 1em; text-indent: -2em;', 'p'), 'margin-left: 1em; padding-left: 1em; text-indent: -2em;')
  assert.equal(cleanStyle('padding-left: 1em; text-indent: -1.5em;', 'p'), 'padding-left: 1em;')
  // unlike lengths: the size between them is unknown, the text-indent goes
  assert.equal(cleanStyle('padding-left: 200px; text-indent: -1em;', 'p'), 'padding-left: 200px;')
  assert.equal(cleanStyle('padding-left: 2em; text-indent: -10px;', 'p'), 'padding-left: 2em;')
  assert.equal(cleanStyle('padding-left: 12rem; text-indent: -1em;', 'p'), 'padding-left: 12rem;')
  // only the part of the like kind counts: 10px + 1em against -20px
  assert.equal(cleanStyle('margin-left: 10px; padding-left: 1em; text-indent: -20px;', 'p'), 'margin-left: 10px; padding-left: 1em;')
  assert.equal(cleanStyle('margin-left: 10px; padding-left: 1em; text-indent: -10px;', 'p'), 'margin-left: 10px; padding-left: 1em; text-indent: -10px;')
})
