// MCP: visibleText drops what the app's reader would not show, keeps what it shows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visibleText, visibleTextInfo, normalizeColor, MAX_DEPTH, MAX_TAGS } from '../core/mime/visible-text.js'

const X = 'INJECTX'
const hidden = {
  'style rule class': `<style>.x{display:none}</style><div class="x">${X}</div>`,
  'style rule id in body': `<div><style>#y { visibility: hidden }</style><p id="y">${X}</p></div>`,
  'style rule tag.class': `<style>span.h { font-size: 0 }</style><span class="h">${X}</span>`,
  'style rule descendant (the ancestor is there)': `<style>.a .h { display: none }</style><div class="a"><span class="h">${X}</span></div>`,
  'style rule after the element, comment inside': `<span class="h">${X}</span><style>/* x */ .h { display: none }</style>`,
  'style rule next to an at-rule': `<style>@import url(x.css); @media (max-width:600px) { .m { color: red } } .h { opacity: 0 }</style><b class="h">${X}</b>`,
  'font 2px': `<div style="font-size:2px">${X}</div>`,
  'font 2pt': `<div style="font-size:2pt">${X}</div>`,
  'css comment': `<div style="display:/**/none">${X}</div>`,
  'css escape': `<div style="display:n\\6f ne">${X}</div>`,
  'transparent': `<div style="color:transparent">${X}</div>`,
  'rgba alpha 0': `<div style="color:rgba(0,0,0,0)">${X}</div>`,
  'near white': `<div style="color:#fefefe">${X}</div>`,
  'hsl white': `<div style="color:hsl(0,0%,100%)">${X}</div>`,
  'rgb percent': `<div style="color:rgb(100%,100%,100%)">${X}</div>`,
  '8-digit white': `<div style="color:#ffffffff">${X}</div>`,
  'inherited white': `<div style="color:#fff"><span>${X}</span></div>`,
  'black on gradient black': `<div style="background-image:linear-gradient(#000,#000)"><span style="color:#000">${X}</span></div>`,
  'font 1px': `<div style="font-size:1px">${X}</div>`,
  'font shorthand 0/0': `<div style="font:0/0 a">${X}</div>`,
  'opacity 0.01': `<div style="opacity:0.01">${X}</div>`,
  'off-screen': `<div style="position:absolute;left:-9999px">${X}</div>`,
  'text-indent': `<div style="text-indent:-9999px">${X}</div>`,
  'max-height 0': `<div style="max-height:0;overflow:hidden">${X}</div>`,
  'clip rect': `<div style="position:absolute;clip:rect(0,0,0,0)">${X}</div>`,
  'clip-path': `<div style="clip-path:inset(100%)">${X}</div>`,
  'scale 0': `<div style="transform:scale(0)">${X}</div>`,
  'details closed': `<details><summary>s</summary>${X}</details>`,
  'svg text': `<svg><text>${X}</text></svg>`,
}
const visible = {
  'white on navy': `<div style="background:navy;color:white">${X}</div>`,
  'white on td image': `<table><tr><td background="x.png"><font color="#fff">${X}</font></td></tr></table>`,
  'white on var()': `<div style="background:var(--b)"><span style="color:#fff">${X}</span></div>`,
  'white on rgb spaces': `<div style="background:rgb( 0 , 0 , 0 )"><span style="color:#fff">${X}</span></div>`,
  'white on hsl': `<div style="background:hsl(220, 50%, 20%)"><span style="color:#fff">${X}</span></div>`,
  'white on unknown name': `<div style="background:rebeccapurple"><span style="color:#fff">${X}</span></div>`,
  'details open': `<details open><summary>s</summary>${X}</details>`,
  'later display wins': `<div style="display:none;display:block">${X}</div>`,
  'aria-hidden (the app shows it)': `<span aria-hidden="true">${X}</span>`,
  'a rule inside @media (at-rules ignored)': `<style>@media (max-width:600px) { .desk { display: none } }</style><div class="desk">${X}</div>`,
  'nested at-rule': `<style>@supports (display:grid) { @media screen { .d { display: none } } }</style><div class="d">${X}</div>`,
  'font 3px': `<div style="font-size:3px">${X}</div>`,
  'rule with :checked in a left part': `<style>#t:checked + .p { display: none }</style><input type="checkbox" id="t"><div class="p">${X}</div>`,
  'rule with :hover in a left part': `<style>.m:hover .s { display: none }</style><div class="m"><span class="s">${X}</span></div>`,
  'rule with an attribute selector in a left part': `<style>[data-ogsc] .x { display: none }</style><div><span class="x">${X}</span></div>`,
  'rule with a non-structural pseudo on the rightmost part': `<style>.k:hover { display: none }</style><div><span class="k">${X}</span></div>`,
  // the structural pseudos are matched exactly: not the first / last / only child -> stays
  ':first-child on a second child': `<style>.k:first-child { display: none }</style><div><b>a</b><span class="k">${X}</span></div>`,
  ':last-child on a first of two': `<style>.k:last-child { display: none }</style><div><span class="k">${X}</span><b>a</b></div>`,
  ':only-child with a sibling': `<style>.k:only-child { display: none }</style><div><span class="k">${X}</span><b>a</b></div>`,
  'a double-colon pseudo-element skips the rule': `<style>.k::before { display: none }</style><div><span class="k">${X}</span></div>`,
  'font 2.25pt': `<div style="font-size:2.25pt">${X}</div>`,
}

for (const [name, html] of Object.entries(hidden)) test(`hidden: ${name}`, () => assert.ok(!visibleText(`<p>látható</p>${html}`).includes(X), visibleText(html)))
for (const [name, html] of Object.entries(visible)) test(`visible: ${name}`, () => assert.ok(visibleText(html).includes(X)))

test('text layout: paragraphs and breaks on their own lines, entities decoded, whitespace collapsed', () => {
  assert.equal(visibleText('<p>Első   sor</p><p>Második<br>harmadik &amp; negyedik</p><ul><li>a</li><li>b</li></ul>'), 'Első sor\n\nMásodik\nharmadik & negyedik\n\n- a\n- b')
})

test('deep nesting is cut past MAX_DEPTH, a huge body past MAX_TAGS; both reported, both fast', () => {
  const ok = `${'<div>'.repeat(MAX_DEPTH - 10)}mély${'</div>'.repeat(MAX_DEPTH - 10)}`
  assert.deepEqual(visibleTextInfo(ok), { text: 'mély', cut: null })
  let t0 = performance.now()
  const deep = visibleTextInfo(`${'<div>'.repeat(50_000)}mély`)
  assert.ok(performance.now() - t0 < 500, `${performance.now() - t0} ms`)
  assert.equal(deep.cut, 'tags')
  t0 = performance.now()
  const flat = visibleTextInfo('<p>x</p>'.repeat(200_000))
  assert.ok(performance.now() - t0 < 3000)
  assert.equal(flat.cut, 'tags')
  assert.equal(visibleTextInfo(`${'<b>f</b>'.repeat(MAX_TAGS / 2 + 10)}<p>${X}</p>`).cut, 'tags', 'visible text past the cut: reported')
})

// Linearity, not the machine's momentary load: each case at N and N/4, the fastest of 3 runs of each.
// A linear scanner gives a ratio of about 4, a quadratic one about 16; the 5 ms floor keeps the noise of the
// very fast cases out, and an absolute ceiling still catches a general slowdown.
test('no mail-controlled input makes it slow (linear scanners): 400 KB vs 100 KB, best of 3', () => {
  const N = 400_000
  const RUNS = 3
  const MAX_RATIO = 8
  const FLOOR_MS = 5
  const CEILING_MS = 3000
  const rep = (s, bytes) => s.repeat(Math.max(1, Math.floor(bytes / s.length)))
  const cases = {
    'style no brace': n => `<style>${rep('a', n)}</style><p>x</p>`,
    'style open no close': n => `<style>${rep('a', n / 2)}{${rep('b', n / 2)}</style><p>x</p>`,
    'unclosed comments': n => `<style>${rep('/*', n)}</style><p>x</p>`,
    'at semicolons': n => `<style>${rep('@a;', n)}x{y:z}</style><p>x</p>`,
    'at no semicolon': n => `<style>${rep('@a ', n)}</style><p>x</p>`,
    'value spaces': n => `<style>.a{color:a${' '.repeat(n)}b}</style><p class="a">x</p>`,
    'important spaces': n => `<style>.a{color:red${' '.repeat(n)}!important}</style><p class="a">x</p>`,
    'bg split spaces': n => `<style>p{background-color:${rep('x ', n)}}</style><p>x</p>`,
    'bg url unclosed': n => `<style>p{background:${rep('url(', n)}}</style><p>x</p>`,
    'gradient unclosed': n => `<style>p{background:${rep('gradient(', n)}}</style><p>x</p>`,
    'gradient rgb unclosed': n => `<style>p{background:linear-gradient(${rep('rgb(', n)})}</style><p>x</p>`,
    'rgb spaces': n => `<style>p{color:rgb(${' '.repeat(n)}1)}</style><p>x</p>`,
    'escapes': n => `<style>${rep('\\61 ', n)}{display:none}</style><p>x</p>`,
    'deep selector': n => `<style>${rep('.a ', n)}{display:none}</style><p class="a">x</p>`,
    'selector list': n => `<style>${rep('.a,', n)}.h{display:none}</style><p class="h">x</p>`,
    // the tags grow with the rules, so a rules x tags product would show in the ratio too
    'many rules x tags': n => `<style>${rep('b{color:red}', n)}</style>${'<b>x</b>'.repeat(Math.round(24_500 * n / N))}`,
    'inline spaces': n => `<p style="color:a${' '.repeat(n)}b">x</p>`,
    'inline font digits': n => `<p style="font:${rep('1 ', n)}">x</p>`,
    'pre spaces': n => `<pre>a${' '.repeat(n)}b</pre>`,
    'unclosed style': n => `<p>x</p><style>${rep('.a{color:red}', n)}`,
  }
  const timed = html => {
    const t0 = performance.now()
    visibleTextInfo(html)
    return performance.now() - t0
  }
  for (const [name, make] of Object.entries(cases)) {
    // the small size always runs RUNS times; the big one is repeated only while the case fails. More runs can
    // only lower t(N), so this passes exactly when the full best-of-3 would, at about half the cost.
    const small = make(N / 4)
    let tSmall = Infinity
    for (let i = 0; i < RUNS; i++) tSmall = Math.min(tSmall, timed(small))
    const big = make(N)
    let tBig = Infinity
    let ratio = Infinity
    for (let i = 0; i < RUNS; i++) {
      tBig = Math.min(tBig, timed(big))
      ratio = tBig / Math.max(tSmall, FLOOR_MS)
      if (ratio < MAX_RATIO && tBig < CEILING_MS) break
    }
    const detail = `${name}: t(N) ${tBig.toFixed(1)} ms, t(N/4) ${tSmall.toFixed(1)} ms, ratio ${ratio.toFixed(2)}`
    assert.ok(ratio < MAX_RATIO, `not linear: ${detail} (limit ${MAX_RATIO})`)
    assert.ok(tBig < CEILING_MS, `too slow: ${detail} (limit ${CEILING_MS} ms)`)
  }
})

test('distinct rules on an element with many classes hit the work ceiling: no text, reported', () => {
  const classes = Array.from({ length: 12 }, (_, i) => `c${i}`)
  const rules = []
  for (let m = 1; m < 4096; m++) rules.push(`${classes.filter((_, i) => m & (1 << i)).map(c => `.${c}`).join('')}{color:red}`)
  const html = `<style>${rules.join('')}</style>${`<p class="${classes.join(' ')}">x</p>`.repeat(2000)}`
  const t0 = performance.now()
  assert.deepEqual(visibleTextInfo(html), { text: '', cut: 'complex' })
  assert.ok(performance.now() - t0 < 2000)
})

test('combinators: a long descendant chain that fails high up costs elements x parts, not their combinations', () => {
  const sel = `.c ${Array(20).fill('.a').join(' ')} .b`
  const html = `<style>${sel}{display:none}</style>${'<div class="a">'.repeat(900)}<p class="b">${X}</p>`
  const t0 = performance.now()
  assert.deepEqual(visibleTextInfo(html), { text: X, cut: null })
  assert.ok(performance.now() - t0 < 500, `${performance.now() - t0} ms`)
  const hit = `<style>${sel}{display:none}</style><div class="c">${'<div class="a">'.repeat(900)}<p class="b">${X}</p>`
  assert.ok(!visibleText(hit).includes(X))
})

test('big class lists, display-heavy rules, flat comments, "~" over many siblings stay fast', () => {
  const r = (x, n) => x.repeat(n)
  const cls = Array.from({ length: 400 }, (_, i) => `c${i}`).join(' ')
  const cases = {
    'class list x descendant rules': `<style>${Array.from({ length: 300 }, (_, i) => `.c${i} .c${i + 1} p{color:red}`).join('')}</style><div class="${cls}">${r(`<p class="${cls}">x</p>`, 200)}</div><p>VISIBLEOK</p>`,
    'display values on many rules': `<style>${Array.from({ length: 3000 }, (_, i) => `.k${i % 50}{display:${i % 2 ? 'block' : 'inline'}}`).join('')}</style>${r(`<p class="${Array.from({ length: 50 }, (_, i) => `k${i}`).join(' ')}">x</p>`, 2000)}<p>VISIBLEOK</p>`,
    '99 000 flat comments': `<div>${r('<!---->x', 99_000)}</div><p>VISIBLEOK</p>`,
    '49 000 hidden siblings': `<div>${r('<b hidden>x</b>', 49_000)}</div><p>VISIBLEOK</p>`,
    '~ over 3000 siblings (.x present, after them)': `<style>.x ~ p{color:red}</style><div>${r('<p>row</p>', 3000)}<p class="x">x</p></div><p>VISIBLEOK</p>`,
    'unused deep rules': `<style>${Array.from({ length: 3000 }, (_, i) => `.n${i} .m${i} i{color:red}`).join('')}</style>${r('<div>', 990)}${r('<i>x</i>', 200)}VISIBLEOK`,
  }
  for (const [name, html] of Object.entries(cases)) {
    const t0 = performance.now()
    const res = visibleTextInfo(html)
    const ms = performance.now() - t0
    assert.ok(ms < 1000, `${name}: ${Math.round(ms)} ms`)
    assert.ok(res.text.includes('VISIBLEOK'), `${name}: ${res.cut}`)
  }
})

test('a cut never falls inside a <style> (tag cut and depth cut)', () => {
  const filler = '<b>f</b>'.repeat(MAX_TAGS / 2 - 3)
  const inStyle = `<p>VISIBLEOK</p><p class="h">${X}</p>${filler}<style>/* a < b */ .h{display:none} .z{content:"<"}</style>${'<i>t</i>'.repeat(50)}`
  const r1 = visibleTextInfo(inStyle)
  assert.equal(r1.cut, 'tags')
  assert.ok(!r1.text.includes(X) && r1.text.includes('VISIBLEOK'))
  // past MAX_DEPTH before the <style>: the 4 KB piece that triggers the cut ends inside its comment
  const r2 = visibleTextInfo(`${'<span>'.repeat(MAX_DEPTH + 5)}<p class="h">${X}</p><style>/*${'x'.repeat(4000)}*/ .h{display:none}</style>y`)
  assert.equal(r2.cut, 'tags')
  assert.ok(!r2.text.includes(X))
})

test('a fake "<style" (comment, <stylex>) never lifts the tag or depth cut; a style left open gives no text', () => {
  const cases = {
    'flat, comment': `${'<b>f</b>'.repeat(MAX_TAGS / 2 - 5)}<!--<style-->${'<b>x</b>'.repeat(200_000)}`,
    'flat, stylex': `${'<b>f</b>'.repeat(MAX_TAGS / 2 - 5)}<stylex>${'<b>x</b>'.repeat(200_000)}`,
    'deep, comment': `<p>VISIBLEOK</p><!--<style-->${'<b>'.repeat(330_000)}`,
    'deep, stylex': `<p>VISIBLEOK</p><stylex>${'<b>'.repeat(330_000)}`,
  }
  for (const [name, html] of Object.entries(cases)) {
    const t0 = performance.now()
    const r = visibleTextInfo(html)
    assert.ok(performance.now() - t0 < 1500, `${name}: ${Math.round(performance.now() - t0)} ms`)
    assert.equal(r.cut, 'tags', name)
  }
  const open = `<p class="h">${X}</p>${'<b>f</b>'.repeat(MAX_TAGS / 2 - 3)}<style>.h{display:none} /* ${'<'.repeat(10)} ${'x'.repeat(300_000)}`
  assert.deepEqual(visibleTextInfo(open), { text: '', cut: 'complex' })
})

test('exactly MAX_TAGS tags is a whole body', () => {
  assert.equal(visibleTextInfo(`${'<b>f</b>'.repeat(MAX_TAGS / 2 - 1)}<p>LASTOK</p>`).cut, null)
})

const shown = {
  // inherited properties, a child resets them
  'MJML text block (td font-size:0, div 13px)': `<table><tr><td style="font-size:0px;padding:10px 25px"><div style="font-size:13px;color:#000">${X}</div></td></tr></table>`,
  'inline-block columns via <style>': `<style>.cols{font-size:0}.col{display:inline-block;font-size:14px}</style><div class="cols"><div class="col">${X}</div></div>`,
  'font:0/0 parent, child 16px': `<div style="font:0/0 a"><span style="font-size:16px">${X}</span></div>`,
  'visibility hidden parent, visible child': `<div style="visibility:hidden"><p style="visibility:visible">${X}</p></div>`,
  'em of a small parent (7px)': `<p style="font-size:14px"><span style="font-size:0.5em">${X}</span></p>`,
  'opacity .5': `<div style="opacity:.5">${X}</div>`,
  // the cascade and what the reader really applies
  'style media=print': `<style media="print">.h{display:none}</style><p class="h">${X}</p>`,
  'style media=(max-width)': `<style media="(max-width:600px)">.h{display:none}</style><p class="h">${X}</p>`,
  'style type=text/plain': `<style type="text/plain">.h{display:none}</style><p class="h">${X}</p>`,
  'style inside template': `<template><style>.h{display:none}</style></template><p class="h">${X}</p>`,
  'style inside noscript': `<noscript><style>.h{display:none}</style></noscript><p class="h">${X}</p>`,
  'class case differs (standards mode)': `<!DOCTYPE html><style>.H{display:none}</style><p class="h">${X}</p>`,
  'specificity: #i block beats a later div none': `<style>#i{display:block} div{display:none}</style><div id="i">${X}</div>`,
  'specificity: .show beats a later p none': `<style>.show{display:block} p{display:none}</style><p class="show">${X}</p>`,
  'unclosed comment hides the later rules': `<style>/* .x{color:red} .h{display:none}</style><p class="h">${X}</p>`,
  'hidden attribute overridden by display:block': `<div hidden style="display:block">${X}</div>`,
  'select (DOMPurify keeps the option text)': `<select><option>${X}</option></select>`,
  'text in an unclosed head': `<html><head><meta charset="utf-8"><p>${X}</p></html>`,
  'invalid selector (entity is literal CSS)': `<style>&#46;h{display:none}</style><p class="h">${X}</p>`,
  'stray brace makes the selector invalid': `<style>} .h{display:none}</style><p class="h">${X}</p>`,
  'white on a dark body via <style>': `<style>body{background:#111}</style><body><p style="color:#fff">${X}</p></body>`,
  'white on a dark class background': `<style>.hdr{background-color:#123456}</style><table class="hdr"><tr><td style="color:#fff">${X}</td></tr></table>`,
  'font size=1 (the app shows it)': `<font size="1">${X}</font>`,
  // a <style> after the cut is not applied any more, the cut is reported
  'a <style> past the tag cut': `<p class="h">${X}</p>${'<b>f</b>'.repeat(MAX_TAGS / 2 + 10)}<style>.h{display:none}</style>`,
  // the reader's tree (implicit tbody, DOMPurify-removed siblings)
  '.t > tr is not a child in the reader (tbody between)': `<style>.t > tr > td{display:none}</style><table class="t"><tr><td>${X}</td></tr></table>`,
  // pre-existing, now kept (doubtful = kept)
  'negative font-size is invalid': `<p style="font-size:16px;font-size:-1px">${X}</p>`,
  'font-size:0 wrapper, child calc()': `<div style="font-size:0"><span style="font-size:calc(12px + 2px)">${X}</span></div>`,
  'a link in white text keeps its own colour': `<div style="color:#fff"><a href="https://example.invalid">${X}</a></div>`,
  '~ sibling past a removed <input> (DOMPurify drops it)': `<style>input ~ .fallback{display:none}</style><input type="checkbox"><div class="fallback">${X}</div>`,
  // in a doubtful case the <style> rule is left out
  // (the (i) and (ii) cases are decided by the cascade now: see `gone`)
  '868 (iii): style media=screen': `<style media="screen">.h{display:none}</style><p class="h">${X}</p>`,
  '868 (iii): the rule BEFORE an unclosed comment is skipped too': `<style>.h{display:none} /* x</style><p class="h">${X}</p>`,
  'descendant without the ancestor': `<style>.a .h{display:none}</style><p class="h">${X}</p>`,
  'child combinator, not a child': `<style>div>.h{display:none}</style><div><span><p class="h">${X}</p></span></div>`,
  'sibling combinator, not the previous sibling': `<style>i+.h{display:none}</style><i></i><b></b><p class="h">${X}</p>`,
}
const gone = {
  // the browser's cascade, not the earlier (i)/(ii) exceptions (they let 5 hidden cases through)
  'cascade: an important rule beats an inline display:block': `<style>.h{display:none!important}</style><div class="h" style="display:block">${X}</div>`,
  'cascade: an important rule beats inline visibility:visible': `<style>.h{visibility:hidden!important}</style><div class="h" style="visibility:visible">${X}</div>`,
  'cascade: .h none beats a less specific div block': `<style>.h{display:none} div{display:block}</style><div class="h">${X}</div>`,
  'cascade: #i none beats a later .c block': `<style>#i{display:none} .c{display:block}</style><div id="i" class="c">${X}</div>`,
  'cascade: div.h none beats a later .h block': `<style>div.h{display:none} .h{display:block}</style><div class="h">${X}</div>`,
  'cascade: the same selector in two blocks, block then none': `<style>.h{display:block}</style><style>.h{display:none}</style><p class="h">${X}</p>`,
  'cascade: #i hidden beats p visible': `<style>#i{visibility:hidden} p{visibility:visible}</style><p id="i">${X}</p>`,
  // the structural pseudos
  ':first-child': `<style>.k:first-child { display: none }</style><div><span class="k">${X}</span></div>`,
  ':last-child': `<style>.k:last-child { display: none }</style><div><b>a</b><span class="k">${X}</span></div>`,
  ':only-child': `<style>.k:only-child { display: none }</style><div><span class="k">${X}</span></div>`,
  'opacity 0 parent, child 1': `<div style="opacity:0"><p style="opacity:1">${X}</p></div>`,
  'opacity multiplied below 0.1': `<div style="opacity:.3"><p style="opacity:.3">${X}</p></div>`,
  '0.08em of 16px': `<p style="font-size:0.08em">${X}</p>`,
  'inline important beats a later inline': `<div style="display:none!important;display:block">${X}</div>`,
  'escaped colon .a\\:b': `<style>.a\\:b{display:none}</style><div class="a:b">${X}</div>`,
  'hex escaped colon .a\\3a b': `<style>.a\\3a b{display:none}</style><div class="a:b">${X}</div>`,
  'escaped [ ]': `<style>.a\\[1\\]{display:none}</style><div class="a[1]">${X}</div>`,
  'escaped dot is one class': `<style>.a\\.b{display:none}</style><div class="a.b">${X}</div>`,
  'non-ASCII class': `<style>.скрыт{display:none}</style><div class="скрыт">${X}</div>`,
  'non-ASCII id': `<style>#é{display:none}</style><div id="é">${X}</div>`,
  'escaped brace in a value': `<style>.x{content:"\\7d"} .h{display:none}</style><p class="h">${X}</p>`,
  'CDO/CDC around rules': `<style><!-- .h{display:none} --></style><p class="h">${X}</p>`,
  'descendant with the ancestor': `<style>.a .h{display:none}</style><div class="a"><div><p class="h">${X}</p></div></div>`,
  'child combinator': `<style>div>.h{display:none}</style><div><p class="h">${X}</p></div>`,
  'sibling combinator +': `<style>i+.h{display:none}</style><i></i><p class="h">${X}</p>`,
  'sibling combinator ~ over a hidden sibling': `<style>i~.h{display:none}</style><i style="display:none"></i><b></b><p class="h">${X}</p>`,
  'one rule, no conflict, wins over the default': `<style>p.h{display:none}</style><p class="h">${X}</p>`,
  // the font shorthand sets the size, in declaration order
  'font shorthand after font-size (inline)': `<p style="font-size:16px; font:0/0 a">${X}</p>`,
  'font shorthand after font-size (rules)': `<style>.x{font-size:16px} .x{font:0/0 a}</style><p class="x">${X}</p>`,
  'font shorthand by specificity': `<style>.x{font:0/0 a} p{font-size:16px}</style><p class="x">${X}</p>`,
  // the reader's tree
  '.t > tbody > tr > td with an implicit tbody': `<style>.t > tbody > tr > td{display:none}</style><table class="t"><tr><td>${X}</td></tr></table>`,
  'p.a + p.b with an empty <form> between (unwrapped)': `<style>p.a + p.b{display:none}</style><p class="a">a</p><form></form><p class="b">${X}</p>`,
  'h1 + p with a <script> between (removed)': `<style>h1 + p{display:none}</style><h1>t</h1><script>x</script><p>${X}</p>`,
  'font-size inherit from a 1px parent': `<div style="font-size:1px"><span style="font-size:inherit">${X}</span></div>`,
  'visibility hidden inherited': `<div style="visibility:hidden"><span>${X}</span></div>`,
  'text-indent inherited': `<div style="text-indent:-9999px"><span>${X}</span></div>`,
}
for (const [name, html] of Object.entries(shown)) test(`shown: ${name}`, () => assert.ok(visibleText(html).includes(X), visibleText(html)))
for (const [name, html] of Object.entries(gone)) test(`hidden: ${name}`, () => assert.ok(!visibleText(`<p>látható</p>${html}`).includes(X)))

test('normalizeColor', () => {
  assert.deepEqual(['#FFF', 'white', 'rgb(255, 255, 255)', 'rgb(255 255 255 / 0)', '#ffff', 'hsl(0 0% 0%)', 'var(--x)'].map(normalizeColor), ['#ffffff', '#ffffff', '#ffffff', 'transparent', '#ffffff', '#000000', null])
})
