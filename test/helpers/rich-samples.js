// SPDX-License-Identifier: GPL-3.0-or-later
// The composer's rich samples (core/smtp/rich-style.js): what a web page's copy, a word processor and the composer's own
// toolbar write, and what must not pass. Shared by test/rich-style.test.js (the sanitizer) and test/rich-parity.test.js
// (the sanitizer and the main process's mirror, byte for byte). No hidden text here: the mirror drops it (the visible-text
// rules), the sanitizer does not, so a hidden sample is no parity sample (display: none, a font size under 3 px: those are
// in test/rich-style.test.js, on the sanitizer).

// name -> html
export const RICH_SAMPLES = {
  'a table with a border, a background and a colspan':
    '<table border="1" cellpadding="4" cellspacing="0" width="100%" style="border-collapse: collapse; border: 1px solid #999999;"><tbody><tr><th colspan="2" bgcolor="#eeeeee" style="text-align: left;">Fej</th></tr><tr><td width="30%" style="border: 1px solid #999999; padding: 4px 8px;">A1</td><td style="background-color: rgb(255, 245, 157);">B1</td></tr></tbody></table>',
  'a table with a caption, thead, tfoot, colgroup and a rowspan':
    '<table><caption>Ár</caption><colgroup><col span="2" width="120"></colgroup><thead><tr><th>Termék</th><th>Db</th></tr></thead><tbody><tr><td rowspan="2" valign="top">Kazán A</td><td align="right">1</td></tr><tr><td align="right">2</td></tr></tbody><tfoot><tr><td>Össz</td><td>3</td></tr></tfoot></table>',
  'a nested table': '<table><tbody><tr><td><table><tbody><tr><td>be1</td><td>be2</td></tr></tbody></table></td><td>jobb</td></tr></tbody></table>',
  'font face, size and colour': '<p><font face="Times New Roman" size="4" color="#1f497d">betű</font> <font face="Arial">arial</font> <font size="9">rossz méret</font></p>',
  'headings h4-h6, sup, sub, hr, mark, strike': '<h4 align="center">h4</h4><h5>h5</h5><h6>h6</h6><p>x<sup>2</sup> H<sub>2</sub>O <mark>jel</mark> <strike>át</strike></p><hr style="border: 0; border-top: 1px solid #cccccc;">',
  'a definition list': '<dl><dt style="font-weight: bold;">Kifejezés</dt><dd style="margin-left: 20px;">leírás</dd></dl>',
  'an ordered list with start and type': '<ol start="3" type="a" style="list-style-type: lower-alpha;"><li value="5">öt</li><li>hat</li></ol><ul style="list-style-position: inside;"><li>pont</li></ul>',
  'the toolbar palette (colour and highlight)': '<p><font color="#c62828">piros</font> <span style="background-color: rgb(255, 245, 157);">sárga</span> <font color="#1565c0" style="background-color: rgb(248, 187, 208);">mindkettő</font></p>',
  'text styles': '<p style="font-family: Calibri, sans-serif; font-size: 11pt; line-height: 1.5; text-indent: -18pt; margin: 0cm 0cm 0cm 36pt;"><span style="font-weight: 700; font-style: italic; text-decoration: underline;">egy</span> <span style="letter-spacing: 1px; text-transform: uppercase; font-variant: small-caps;">kettő</span> <span style="vertical-align: super; font-size: smaller;">3</span> <span style="text-shadow: 1px 1px 2px #888888;">árnyék</span></p>',
  'a Chromium copy with its noise':
    '<span style="color: rgb(32, 33, 36); font-family: Roboto, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; display: inline !important; float: none;">Chromium</span>',
  'a dark page block (a light text on a dark background)': '<div style="background-color: rgb(18, 18, 18); color: rgb(232, 232, 232); padding: 8px;">sötét</div>',
  'Word-like styles': '<p class="MsoNormal" style="margin-bottom: 0.0001pt; line-height: normal; mso-list: l0 level1 lfo1;"><span style="font-family: Symbol; mso-fareast-font-family: Symbol;">·</span><span style="font-size: 7pt; font-family: \'Times New Roman\', serif;">   </span>elem</p><p style="border: none; border-bottom: solid windowtext 1.0pt; padding: 0cm 0cm 1.0pt 0cm;">vonal</p>',
  'what goes: code, loading, breaking out, cutting':
    '<p><span style="background: url(https://evil.invalid/x.png); color: red;">url</span> <span style="width: expression(alert(1)); color: blue;">expr</span> <span style="color: u\\72l(x); font-weight: bold;">escape</span> <span style="position: fixed; top: 0; z-index: 9; color: green;">pos</span> <span style="float: left; clear: both; transform: scale(2); color: gray;">float</span></p><div style="height: 1px; overflow: hidden; white-space: nowrap; direction: rtl; font-size: 12px;">cut</div><p dir="rtl" class="x" id="y" lang="hu" title="t" onclick="alert(1)">attrs</p>',
  'limits on both sides': '<p><span style="font-size: 3px;">3</span> <span style="font-size: 96px;">96</span> <span style="font-size: 97px;">97</span> <span style="margin: -1px; padding: 200px;">neg</span></p><table width="100%"><tbody><tr><td colspan="1000" width="1200">x</td><td colspan="1001" width="1201">y</td></tr></tbody></table><table width="101%"><tbody><tr><td>z</td></tr></tbody></table>',
  'a link with a style, a highlight on a link': '<p><a href="https://example.invalid/x?a=1&amp;b=2" style="color: rgb(26, 13, 171); text-decoration: none;">link</a> <a href="javascript:alert(1)" style="color: red;">js</a></p>',
  'a hostile mix': '<p><font color="#c62828" onclick="alert(1)" style="background-color: rgb(255, 245, 157);">x</font><span style="color: red" onmouseover="alert(1)" class="c" id="i">y</span><img src="https://evil.invalid/t.png" style="color: red;"><script>alert(1)</script></p>',
  'an empty and a bad style, a font with nothing left': '<p><span style="">üres</span> <font style="position: fixed;">semmi</font> <font>üres font</font> <span style=";;;: ; color:;">pont</span></p>',
  'a repeated property, !important, a background shorthand': '<p><span style="color: red; COLOR: blue !important; margin: 0; margin-top: 4px; background: #ffff00;">ismétlés</span> <span style="background: #fff url(x.png);">kép</span> <span style="background: #ffffff no-repeat;">két tag</span></p>',
  'quotes in a font family': '<p><span style="font-family: &quot;Segoe UI&quot;, \'Helvetica Neue\', sans-serif;">idézőjel</span> <span style="font-family: &quot;a;b&quot;;">pontosvessző</span></p>',
  'a link target on another element, a src, an alt': '<p><span href="https://example.invalid/" src="https://evil.invalid/x" alt="x" style="color: red;">nem link</span> <b href="mailto:a@example.invalid">b</b></p>',
  'entities and a non-breaking space': '<p style="font-family: Arial;">a&nbsp;b &lt;c&gt; &amp;</p>',
}
