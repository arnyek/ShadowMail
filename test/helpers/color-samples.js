// SPDX-License-Identifier: GPL-3.0-or-later
// The composer's colour samples: what the editor writes (core/smtp/text-colors.js) and what must not pass for it. Shared
// by test/text-colors.test.js (the sanitizer) and test/compose-quote.test.js (the main process's mirror).
import { TEXT_COLORS, HIGHLIGHT_COLORS } from '../../core/smtp/text-colors.js'

const RED = TEXT_COLORS[0].hex
const BLUE = TEXT_COLORS[3].hex
const YELLOW = HIGHLIGHT_COLORS[0].style
const PINK = HIGHLIGHT_COLORS[3].style

// name -> html
export const SAMPLES = {
  'a palette text colour': `<p>a <font color="${RED}">piros</font> b</p>`,
  'every text colour': TEXT_COLORS.map(c => `<font color="${c.hex}">${c.id}</font>`).join(' '),
  'a highlight on a span': `<p><span style="${YELLOW}">kiemelt</span></p>`,
  'every highlight on a span': HIGHLIGHT_COLORS.map(c => `<span style="${c.style}">${c.id}</span>`).join(' '),
  'a highlight on a font': `<p><font style="${PINK}">csak háttér</font></p>`,
  'colour and highlight on one font': `<p><font color="${BLUE}" style="${YELLOW}">mindkettő</font></p>`,
  'nested: a coloured font in a highlight, bold inside': `<p><span style="${YELLOW}">x <font color="${RED}">y <b>z</b></font></span> w</p>`,
  'a colour not in the palette': '<p><font color="#d32f2f">más piros</font> <font color="#000000">fekete</font></p>',
  'upper case hex': `<p><font color="${RED.toUpperCase()}">nagybetűs</font></p>`,
  'rgb() and named colours': '<p><font color="rgb(198, 40, 40)">rgb</font> <font color="red">red</font></p>',
  // DOMPurify trims every attribute value (the mirror does the same): these stay, as the editor's own
  'a value with space around it': `<p><font color=" ${RED}">szóköz</font> <span style=" ${YELLOW}\n">szóköz</span></p>`,
  'a javascript: colour': '<p><font color="javascript:alert(1)">js</font></p>',
  'face and size only: unwrapped': '<p><font face="Arial" size="7">face</font> <font>üres</font></p>',
  'face next to a palette colour: the face goes': `<p><font face="Arial" color="${RED}" size="1">piros</font></p>`,
  'a highlight with another property': `<p><span style="${YELLOW} position: fixed">pos</span> <span style="position: fixed; ${YELLOW}">pos2</span></p>`,
  'a highlight written in another way': '<p><span style="background-color: rgb(255,245,157);">tömör</span> <span style="background-color: rgb(255, 245, 157)">pontosvessző nélkül</span> <span style="background-color: #fff59d;">hex</span> <span style="BACKGROUND-COLOR: rgb(255, 245, 157);">nagy</span> <span style="background-color: rgb(255, 245, 157) !important;">important</span></p>',
  'a highlight not in the palette': '<p><span style="background-color: rgb(255, 0, 0);">piros háttér</span></p>',
  'a text colour as a style': `<p><span style="color: ${RED};">color stílus</span> <span style="color: ${RED}; ${YELLOW}">kettő</span></p>`,
  'a style with url() or expression()': '<p><span style="background: url(https://evil.invalid/x.png)">url</span> <span style="width: expression(alert(1))">expr</span></p>',
  'a highlight on a bold, an italic, an underline inside a colour': `<p><font color="${RED}"><b style="${YELLOW}">b</b> <i style="${PINK}">i</i> <u style="${YELLOW}">u</u> <s style="${YELLOW}">s</s> <strong style="${YELLOW}">st</strong> <em style="${YELLOW}">em</em></font></p>`,
  'a highlight on other elements': `<p style="${YELLOW}">p</p><div style="${YELLOW}">div</div><b style="${YELLOW}">b</b> <a href="https://example.invalid/" style="${YELLOW}">a</a><blockquote style="${YELLOW}">idézet</blockquote>`,
  'a colour attribute on other elements': `<p><span color="${RED}">span</span> <b color="${RED}">b</b> <a href="https://example.invalid/" color="${RED}">a</a></p>`,
  'an empty style': '<p><span style="">üres</span> <font style="">üres font</font></p>',
  'a coloured link and a link in a colour': `<p><a href="https://example.invalid/"><font color="${RED}">link</font></a> <font color="${BLUE}"><a href="mailto:a@example.invalid">levél</a></font></p>`,
  'colours in a table': `<table><tr><td><font color="${RED}">A1</font></td><td><span style="${YELLOW}">B1</span></td></tr></table>`,
  'a coloured font around a block': `<font color="${RED}"><p>bekezdés</p><ul><li>elem</li></ul></font>`,
  'a hostile mix': `<p><font color="${RED}" onclick="alert(1)" style="${YELLOW}">x</font><span style="${YELLOW}" onmouseover="alert(1)" class="c" id="i">y</span><img src="https://evil.invalid/t.png" style="${YELLOW}"><script>alert(1)</script></p>`,
}
