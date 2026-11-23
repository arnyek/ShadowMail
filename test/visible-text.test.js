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

test('a page body\'s text= colour counts (an old newsletter: light text on a dark bgcolor body is visible; the same dark is hidden)', () => {
  assert.equal(visibleText('<html><body bgcolor="#000000" text="#ffffff"><p>fehér a feketén</p></body></html>'), 'fehér a feketén')
  assert.equal(visibleText('<html><body bgcolor="#000000" text="#050505"><p>rejtett</p></body></html>'), '')
  // any style (a sheet's too) wins over the attribute
  assert.equal(visibleText('<html><head><style>body { color: #000000 }</style></head><body bgcolor="#000000" text="#ffffff"><p>rejtett</p></body></html>'), '')
  // a value that is no colour is no attribute (the default black: on black, hidden)
  assert.equal(visibleText('<html><body bgcolor="#000000" text="zz"><p>rejtett</p></body></html>'), '')
  assert.equal(visibleText('<html><body text="zz"><p>marad</p></body></html>'), 'marad')
})

test('a background shorthand and its longhand: the one the cascade puts last decides (a rule\'s !important shorthand over an own longhand)', () => {
  // the rule's important white background wins: black text on white, visible
  assert.equal(visibleText('<style>td { background: #ffffff !important; }</style><table><tr><td style="background-color: #000000;">feher</td></tr></table>'), 'feher')
  // the own longhand wins over a plain rule: black on black, hidden
  assert.equal(visibleText('<style>td { background: #ffffff; }</style><table><tr><td style="background-color: #000000;">rejtett</td></tr></table>'), '')
  // both inline: the later one
  assert.equal(visibleText('<p style="background-color: #000000; background: #ffffff;">feher</p>'), 'feher')
  assert.equal(visibleText('<p style="background: #ffffff; background-color: #000000;">rejtett</p>'), '')
})

test('a far-off place in any unit is hidden (em in the element\'s own font, %, vw / vh); a near one, as in a hanging indent, is not', async () => {
  const { searchTextOf } = await import('../core/mime/text.js')
  const { visibleComposeHtml } = await import('../core/mime/visible-text.js')
  const hidden = {
    'text-indent -40em': '<p style="text-indent: -40em;">ELREJTVE</p>',
    'text-indent -12em on a 96 px own font': '<p style="font-size: 96px; text-indent: -12em;">ELREJTVE</p>',
    'text-indent -12em under an inherited 96 px font': '<div style="font-size: 96px;"><p style="text-indent: -12em;">ELREJTVE</p></div>',
    'absolute left -50em': '<div style="position: absolute; left: -50em;">ELREJTVE</div>',
    'absolute left -100%': '<div style="position: absolute; left: -100%;">ELREJTVE</div>',
    'absolute top -60vh': '<div style="position: absolute; top: -60vh;">ELREJTVE</div>',
    'fixed right -32rem': '<div style="position: fixed; right: -32rem;">ELREJTVE</div>',
    'text-indent -6in': '<p style="text-indent: -6in;">ELREJTVE</p>',
  }
  for (const [name, html] of Object.entries(hidden)) {
    const page = `<p>LATHATO</p>${html}`
    assert.equal(visibleText(page), 'LATHATO', `read_message: ${name}`)
    assert.ok(!searchTextOf({ html: page }).includes('ELREJTVE'), `search: ${name}`)
    assert.ok(!visibleComposeHtml(page).includes('ELREJTVE') && !visibleComposeHtml(page, { rich: true }).includes('ELREJTVE'), `Claude's quote: ${name}`)
  }
  const shown = {
    'Word hanging indent': '<p style="margin-left: .5in; text-indent: -.25in;">MARAD</p>',
    'text-indent -2em on 16 px': '<p style="text-indent: -2em;">MARAD</p>',
    'left -10% on a relative element': '<div style="position: relative; left: -10%;">MARAD</div>',
    'absolute left -10% (60 px)': '<div style="position: absolute; left: -10%;">MARAD</div>',
    'text-indent 2em': '<p style="text-indent: 2em;">MARAD</p>',
    'text-indent -30em in a 10 px font (300 px)': '<p style="font-size: 10px; text-indent: -30em;">MARAD</p>',
    'an unknown length (a variable) in a text-indent decides nothing': '<p style="text-indent: var(--i);">MARAD</p>',
    'an unknown length (min()) in a text-indent decides nothing': '<p style="text-indent: min(-100em, 2px);">MARAD</p>',
  }
  for (const [name, html] of Object.entries(shown)) assert.equal(visibleText(html), 'MARAD', name)
})

test('a negative left or top margin far off is hidden (measured in the reader: out of reach); a near one, a right / bottom one, is not', () => {
  for (const st of ['margin-left: -2000px;', 'margin-top: -2000px;', 'margin: -2000px 0 0 0;', 'margin: 0 0 0 -2000px;', 'margin: 0 -2000px;', 'margin-left: -200em;', 'margin-top: -60vh;', 'font-size: 96px; margin-left: -6em;']) {
    assert.equal(visibleText(`<p>LATHATO</p><p style="${st}">ELREJTVE <b>BENNE</b></p>`), 'LATHATO', st)
  }
  for (const st of ['margin-left: -20px;', 'margin: -10px;', 'margin-right: -2000px;', 'margin-bottom: -2000px;', 'margin-left: -2em;', 'margin: 0 0 0 auto;']) {
    assert.ok(visibleText(`<p style="${st}">MARAD</p>`).includes('MARAD'), st)
  }
  // the shorthand and the longhand: the cascade's order decides (inline, in a sheet, an important rule)
  assert.ok(visibleText('<p style="margin: 0 0 0 -2000px; margin-left: 0;">MARAD</p>').includes('MARAD'))
  assert.equal(visibleText('<p style="margin-left: 0; margin: 0 0 0 -2000px;">ELREJTVE</p><p>LATHATO</p>'), 'LATHATO')
  assert.equal(visibleText('<style>.a { margin-left: 0; } .b { margin: 0 0 0 -2000px; }</style><p class="a b">ELREJTVE</p><p>LATHATO</p>'), 'LATHATO')
  assert.ok(visibleText('<style>.b { margin: 0 0 0 -2000px; } .a { margin-left: 0; }</style><p class="a b">MARAD</p>').includes('MARAD'))
  assert.ok(visibleText('<style>p.a { margin-left: 0; } .b { margin: 0 0 0 -2000px; }</style><p class="a b">MARAD</p>').includes('MARAD'), 'the more specific longhand')
  assert.equal(visibleText('<style>.b { margin: -2000px 0 0 0 !important; }</style><p class="b" style="margin-top: 0;">ELREJTVE</p><p>LATHATO</p>'), 'LATHATO')
})

test('a far relative offset and a far transform translation are hidden; near ones, sticky, rotations and unknown lengths are not', () => {
  const hidden = ['position: relative; left: -2000px;', 'position: relative; top: -2000px;', 'position: relative; left: -150em;', 'position: relative; right: 2000px;',
    'position: relative; bottom: 2000px;', 'transform: translateX(-2000px);', 'transform: translate(-150em, 0);', 'transform: translateY(-60vh);',
    'transform: translate3d(0, -2000px, 0);', 'transform: matrix(1, 0, 0, 1, -2000, 0);', 'translate: -2000px 0;', 'translate: 0 -2000px;',
    'transform: translateX(-300px) translateX(-300px);', 'transform: rotate(5deg) translateX(-2000px);', 'font-size: 96px; transform: translateX(-6em);',
    'position: relative; left: auto; right: 2000px;', 'position: relative; top: auto; bottom: 2000px;', 'position: relative; left: inherit; right: 2000px;',
    'position: relative; top: unset; bottom: 2000px;']
  for (const st of hidden) assert.equal(visibleText(`<p>LATHATO</p><p style="${st}">ELREJTVE <b>BENNE</b></p>`), 'LATHATO', st)
  const shown = ['position: relative; left: -20px;', 'position: relative; right: 2000px; left: 0;', 'position: relative; bottom: 2000px; top: 0;',
    'position: relative; left: auto; right: 20px;', 'position: relative; top: auto; bottom: -2000px;',
    'position: relative; top: -10px;', 'position: sticky; top: -2000px;', 'position: static; left: -2000px;', 'transform: translateX(-20px);',
    'transform: translate(2000px, 0);', 'transform: rotate(180deg);', 'transform: scale(1.5);', 'transform: translateX(calc(10px - 20px));',
    'translate: calc(10px - 20px) 0;', 'translate: none;', 'transform: translateX(-300px) translateX(200px);']
  for (const st of shown) assert.ok(visibleText(`<p style="${st}">MARAD</p>`).includes('MARAD'), st)
})

test('matrix3d moves too; a far move beside a turn, mirror, scale or skew is hidden either way; moves add up down the tree', () => {
  const hidden = ['transform: matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, -2000,0,0,1);', 'transform: matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,-2000,0,1);',
    'transform: rotate(180deg) translateX(2000px);', 'transform: scale(-1) translateX(2000px);', 'transform: skewX(10deg) translateY(-2000px);',
    'transform: perspective(100px) translateX(2000px);', 'transform: matrix(-1, 0, 0, 1, 2000, 0);', 'transform: matrix3d(-1,0,0,0, 0,1,0,0, 0,0,1,0, 2000,0,0,1);',
    'rotate: 180deg; transform: translateX(2000px);', 'scale: -1; translate: 2000px;', 'position: relative; left: -300px; transform: translateX(-300px);',
    'position: relative; top: -300px; translate: 0 -300px;']
  for (const st of hidden) assert.equal(visibleText(`<p>LATHATO</p><p style="${st}">ELREJTVE <b>BENNE</b></p>`), 'LATHATO', st)
  const shown = ['transform: rotate(180deg);', 'transform: rotate(5deg) translateX(100px);', 'transform: scale(1.5) translateX(-100px);', 'transform: translateX(2000px);',
    'transform: matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 2000,0,0,1);', 'transform: matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, -100,0,0,1);', 'rotate: 180deg;']
  for (const st of shown) assert.ok(visibleText(`<p style="${st}">MARAD</p>`).includes('MARAD'), st)
  // nested: the moves add up (signed), a parent's turn counts for its subtree; a margin does not add up
  const nest = (outer, inner) => visibleText(`<p>LATHATO</p><div style="${outer}"><p style="${inner}">BELSO</p>KULSO</div>`)
  const innerGone = out => !out.includes('BELSO') && out.includes('KULSO') && out.includes('LATHATO')
  assert.ok(innerGone(nest('position: relative; left: -300px;', 'position: relative; left: -300px;')), 'relative -300 + -300')
  assert.ok(innerGone(nest('position: relative; left: -300px;', 'transform: translateX(-300px);')), 'relative -300 + translate -300')
  assert.ok(innerGone(nest('transform: rotate(180deg) translateX(400px);', 'transform: translateX(200px);')), 'a turned parent, 400 + 200')
  assert.ok(innerGone(nest('position: relative; top: -300px;', 'position: relative; bottom: 300px;')), 'top -300 + bottom 300 (-300)')
  for (const [outer, inner] of [['position: relative; left: -300px;', 'position: relative; left: 300px;'], ['position: relative; left: -200px;', 'position: relative; left: -200px;'],
    ['margin-left: -300px;', 'margin-left: -300px;'], ['position: relative; left: 2000px;', 'position: relative; left: -2000px;'], ['transform: rotate(5deg);', 'transform: translateX(100px);']]) {
    assert.ok(nest(outer, inner).includes('BELSO'), `${outer} / ${inner}`)
  }
  // three levels: -200 each
  const deep = visibleText('<p>LATHATO</p><div style="position: relative; left: -200px;"><div style="position: relative; left: -200px;"><p style="position: relative; left: -200px;">MELY</p>KOZEP</div></div>')
  assert.ok(!deep.includes('MELY') && deep.includes('KOZEP'), deep)
})

test('a hiding value past the read guard hides; a long number reads as its short form (place, size, opacity)', () => {
  const z = n => '0'.repeat(n)
  const pad = ' translateY(0px)'.repeat(12)
  const hidden = [`transform: translateX(-2000px)${pad};`, `transform: scale(0)${pad};`, `clip-path: inset(0 0 0 0)${', circle(1px)'.repeat(20)};`,
    `clip: rect(1px, 2px, 3px, 4px)${'x'.repeat(220)};`, `translate: 0px${' 0px'.repeat(60)};`, `rotate: ${'1'.repeat(210)}deg;`,
    `position: absolute; left: -2000.${z(60)}px;`, `position: relative; left: -2000.${z(60)}px;`, `position: relative; top: -2000.${z(60)}px;`,
    `text-indent: -2000.${z(60)}px;`, `margin-left: -2000.${z(60)}px;`, `margin: 0 0 0 -2000.${z(2100)}px;`, `position: relative; left: -${z(60)}2000px;`,
    `transform: translateX(-2000.${z(60)}px);`, `opacity: 0.${z(60)};`, `opacity: 0.${z(60)}1;`, `overflow: hidden; height: 0.${z(60)}px;`]
  for (const st of hidden) assert.equal(visibleText(`<p>LATHATO</p><p style="${st}">ELREJTVE <b>BENNE</b></p>`), 'LATHATO', st.slice(0, 60))
  const harmless = `transform: ${'translateX(0px) '.repeat(12).trim()}` // a 191-character value
  assert.ok(harmless.length - 'transform: '.length < 200)
  const shown = ['transform: none;', `${harmless};`, 'clip-path: inset(0 0 0 0);', `position: relative; left: -20.${z(60)}px;`, `text-indent: -20.${z(60)}px;`,
    `opacity: 1.${z(60)};`, `opacity: 0.5${z(60)};`, `overflow: hidden; height: 20.${z(60)}px;`, `margin-left: ${z(60)}20px;`, `position: relative; left: -2000.${z(60)}px; left: 0;`,
    `overflow: hidden; height: 0.${z(60)}zz;`]
  for (const st of shown) assert.ok(visibleText(`<p style="${st}">MARAD</p>`).includes('MARAD'), st.slice(0, 60))
  // the font size reads a long number too (a size of nothing hides; the font-size test below has the rest)
  assert.ok(!visibleText(`<p style="font-size: 0.${z(60)}px;">ELREJTVE</p>`).includes('ELREJTVE'))
  // past the guard with no far move at all, and a translate padded with spaces inside: the raw (trimmed) length decides
  for (const st of [`transform: ${'translateX(0px) '.repeat(14).trim()};`, `translate: -2000px${' '.repeat(200)}0px;`]) {
    assert.equal(visibleText(`<p>LATHATO</p><p style="${st}">ELREJTVE</p>`), 'LATHATO', st.slice(0, 40))
  }
})

test('calc() is worked out for the far-off place; an unknown value (var(), env(), an unreadable calc()) hides in a positioned place or a translation, not in a text-indent or a margin', () => {
  const hidden = ['position: relative; left: calc(-2000px);', 'position: relative; left: calc(-1000px - 50em);', 'position: absolute; top: calc(-100vh - 10px);',
    'transform: translateX(calc(-2000px));', 'position: relative; left: var(--x);', 'transform: translateX(var(--x));', 'translate: var(--x);',
    'transform: translateX(calc(-100em));', 'translate: calc(-100em) 0;', 'text-indent: calc(-100em);', 'margin-left: calc(-1000px - 1000px);',
    'position: relative; left: calc(2 * -1000px);', 'position: relative; left: calc((-1000px - 1000px) / 2 * 3);', 'position: relative; left: calc(calc(-1000px) * 2);',
    'position: absolute; left: env(safe-area-inset-left);', 'position: absolute; right: min(10px, 20px);', 'position: relative; left: calc(10px * 10px);',
    'position: relative; left: auto; right: var(--r);', 'transform: translate(calc(10px - 2010px), 0);', 'position: relative; left: calc(-20em + 1px); font-size: 100px;']
  for (const st of hidden) assert.equal(visibleText(`<p>LATHATO</p><p style="${st}">ELREJTVE <b>BENNE</b></p>`), 'LATHATO', st)
  const shown = ['position: relative; left: calc(10px - 20px);', 'position: absolute; left: calc(50% - 100px);', 'text-indent: var(--i);', 'margin-left: var(--m);',
    'position: relative; left: calc(2000px);', 'transform: translateX(calc(2000px));', 'text-indent: calc(1em - 30px);', 'margin-left: env(x);',
    'position: relative; left: 0; right: var(--r);', 'position: static; left: var(--x);', 'transform: translateX(calc(-10px * 2)) rotate(5deg);',
    'transform: translateX(abc);', 'position: relative; left: calc(calc(10px) - 20px);', 'position: relative; left: calc(10px / 2);']
  for (const st of shown) assert.ok(visibleText(`<p style="${st}">MARAD</p>`).includes('MARAD'), st)
})

test('an exponent in a length reads as its number (-2e3px is -2000px); the e of an em or ex unit is no exponent', () => {
  const hidden = ['position: relative; left: -2e3px;', 'text-indent: -2e3px;', 'margin-left: -2e3px;', 'transform: translateX(-2e3px);',
    'position: absolute; top: -2E3px;', 'position: relative; left: -2e+3px;', 'position: relative; left: -.2e4px;', 'position: relative; left: -2e2em;',
    'position: relative; left: calc(-2e3px);', 'position: relative; left: calc(-1e3px * 2);', 'translate: -2e3px 0;', 'position: relative; left: -2e3;']
  for (const st of hidden) assert.equal(visibleText(`<p>LATHATO</p><p style="${st}">ELREJTVE <b>BENNE</b></p>`), 'LATHATO', st)
  const shown = ['position: relative; left: 2e3px;', 'text-indent: -2e1px;', 'position: relative; left: -2e-3px;', 'position: relative; left: -2em;',
    'position: relative; left: -2ex;', 'text-indent: -1e1em;', 'position: relative; left: calc(-2e1px);', 'margin-left: -2e;']
  for (const st of shown) assert.ok(visibleText(`<p style="${st}">MARAD</p>`).includes('MARAD'), st)
})

test('a font size with an exponent, a long fraction, a view unit or a calc() is read: a size of nothing hides on every way out', async () => {
  const { searchTextOf } = await import('../core/mime/text.js')
  const { visibleComposeHtml } = await import('../core/mime/visible-text.js')
  const z = n => '0'.repeat(n)
  const hidden = ['font-size: 1e-9px;', 'font-size: 1E-9px;', `font-size: 0.${z(60)}1px;`, 'font-size: 1e-3em;', 'font-size: 0.1vw;', 'font-size: calc(0px);',
    'font-size: calc(1px - 1px);', 'font: 1e-9px Arial;', 'font: italic 0.1vw/2 Arial;', 'font-size: calc(10% - 1px);', 'font-size: 1e-1vh;']
  for (const st of hidden) {
    const page = `<p>LATHATO</p><p style="${st}">ELREJTVE <b>BENNE</b></p>`
    assert.equal(visibleText(page), 'LATHATO', `read_message: ${st}`)
    assert.ok(!searchTextOf({ html: page }).includes('ELREJTVE'), `search: ${st}`)
    assert.ok(!visibleComposeHtml(page).includes('ELREJTVE') && !visibleComposeHtml(page, { rich: true }).includes('ELREJTVE'), `Claude's quote: ${st}`)
  }
  const shown = ['font-size: 1.2e1px;', 'font-size: 1e1pt;', 'font-size: 2vw;', 'font-size: calc(10px + 2px);', 'font-size: var(--fs);', 'font-size: -5px;',
    'font-size: 1e400px;', 'font: bold 700 Arial;', 'font-size: calc(var(--a) * 1px);', 'font-size: calc(50% + 2px);', 'font-size: 1e-9;']
  for (const st of shown) assert.ok(visibleText(`<div style="font-size: 16px;"><p style="${st}">MARAD</p></div>`).includes('MARAD'), st)
  // em and % in a calc() are of the parent's size: 0.1em of a 16 px parent is 1.6 px (hidden), of a 96 px one 9.6 px (shown)
  assert.ok(!visibleText('<div style="font-size: 16px;"><p style="font-size: calc(0.1em);">ELREJTVE</p></div>').includes('ELREJTVE'))
  assert.ok(visibleText('<div style="font-size: 96px;"><p style="font-size: calc(0.1em);">MARAD</p></div>').includes('MARAD'))
})
