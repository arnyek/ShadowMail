// SPDX-License-Identifier: GPL-3.0-or-later
// A reply's / forward's quote keeps the original's formatting (core/mime/paste-prepare.js prepareQuote, then the rich
// sanitizer): the composer's way (Composer.jsx writeBody: sanitizeCompose) and Claude's quote (app/main/compose.js
// claudeQuote: the main process's mirror visibleComposeHtml) on the same quote, byte for byte; hidden text out (a text the
// colour of its background too: the whole message is there), a light text on a dark page body readable, the table limit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'
import { visibleComposeHtml } from '../core/mime/visible-text.js'
import { prepareQuote, preparePaste, MAX_PASTE_TABLE_DEPTH } from '../core/mime/paste-prepare.js'
import { quoteParts, joinQuote } from '../core/smtp/compose.js'
import { htmlToPlain } from '../core/mime/text.js'
import { RICH_SAMPLES } from './helpers/rich-samples.js'
import { SAMPLES as COLOR_SAMPLES } from './helpers/color-samples.js'

const purify = createDOMPurify(new JSDOM('').window)
const TEXT = { wrote: h => `${h} írta:`, forwarded: '---------- Továbbított üzenet ----------', labels: { from: 'Feladó', date: 'Dátum', subject: 'Tárgy', to: 'Címzett', cc: 'Másolat' } }
const original = html => ({ html, text: '', from: [{ name: 'Kovács Anna', address: 'anna@example.invalid' }], to: [], cc: [], subject: 'Próba', date: '2026-11-20T10:00:00Z' })
// the quote in its parts (our header before and after, the original's body between)
const reply = html => quoteParts('reply', original(html), TEXT, 'hu-HU')
const forward = html => quoteParts('forward', original(html), TEXT, 'hu-HU')
// the two ways, as Composer.jsx writeBody and app/main/compose.js claudeQuote run them: the body alone made ready
const composer = p => {
  const r = prepareQuote(p.body)
  return r.plain ? sanitizeCompose(purify, joinQuote(p), { tableRows: true }) : sanitizeCompose(purify, joinQuote({ ...p, body: r.html }), { rich: true })
}
const claude = p => {
  const r = prepareQuote(p.body)
  return r.plain ? visibleComposeHtml(joinQuote(p)) : visibleComposeHtml(joinQuote({ ...p, body: r.html }), { rich: true })
}
const QUOTE_TABLES = {
  'a table among paragraphs': '<p>Előtte</p><table border="1"><tr><td>a</td><td>b</td></tr></table><p>Utána</p>',
  'a table with thead / tbody / tfoot, a caption, header cells, links in a cell': '<table><caption>Cím</caption><thead><tr><th>Név</th><th>Ár</th></tr></thead><tbody><tr><td><a href="https://example.invalid/">Termék</a></td><td>1000 Ft</td></tr></tbody><tfoot><tr><td>Össz</td><td>1000</td></tr></tfoot></table>',
  'a nested table and an empty cell': '<table><tr><td><table><tr><td>be1</td><td>be2</td></tr></table></td><td></td><td>jobb</td></tr></table>',
}
// samples whose hidden or invisible text the quote drops on purpose (the whole message: a transparent or same-coloured text
// is hidden there) are not parity samples of the sanitizer, but both ways still agree on them
const ALL = { ...RICH_SAMPLES, ...COLOR_SAMPLES, ...QUOTE_TABLES }

for (const [name, html] of Object.entries(ALL)) {
  for (const [how, wrap] of [['reply', reply], ['forward', forward]]) {
    test(`the quote's two ways byte for byte (${how}): ${name}`, () => {
      const q = wrap(html)
      const a = composer(q)
      assert.equal(claude(q), a)
      // a second cleaning changes nothing, on either way
      assert.equal(sanitizeCompose(purify, a, { rich: true }), a)
      assert.equal(visibleComposeHtml(a, { rich: true }), a)
    })
  }
}

test('the quote keeps the formatting: a table with its grid and background, colours, fonts; the text part a line per row, cells TAB apart', () => {
  const html = '<p style="font-family: Georgia, serif;"><font color="#c62828">piros</font> <span style="background-color: rgb(255, 245, 157);">sárga</span></p><table border="1" style="border-collapse: collapse;"><tbody><tr><th bgcolor="#eeeeee">Termék</th><th>Db</th></tr><tr><td style="border: 1px solid #999999;">Kazán A</td><td align="right">1</td></tr></tbody></table>'
  const out = composer(reply(html))
  assert.ok(out.includes('<table border="1" style="border-collapse: collapse;">'), out)
  assert.ok(out.includes('<th bgcolor="#eeeeee">Termék</th>'), out)
  assert.ok(out.includes('<td style="border: 1px solid #999999;">Kazán A</td>'), out)
  assert.ok(out.includes('<font color="#c62828">piros</font>'), out)
  assert.ok(out.includes('<p style="font-family: Georgia, serif;">'), out)
  assert.ok(/^<p>[^<]*Kovács Anna[^<]*írta:<\/p><blockquote>/.test(out), out)
  // the text part: the quote's lines with "> ", a table row a line, the cells one TAB apart
  assert.match(htmlToPlain(out, { tables: true }), /> Termék\tDb\n> Kazán A\t1/)
})

test('hidden text out of the quote, the sent HTML and the text part: display none, white on white, font-size 0, a preheader, a transparent colour', () => {
  const html = '<div style="display: none; max-height: 0; overflow: hidden;">ELOSZOVEG</div><p>Látható</p><div style="display: none;">REJTETT1</div><p style="color: #ffffff;">REJTETT2</p><p><span style="font-size: 0;">REJTETT3</span> <span style="color: transparent;">REJTETT4</span></p><table bgcolor="#ffffff"><tr><td><font color="#fefefe">REJTETT5</font></td></tr></table>'
  for (const q of [reply(html), forward(html)]) {
    for (const out of [composer(q), claude(q)]) {
      assert.ok(out.includes('Látható'), out)
      assert.ok(!/REJTETT|ELOSZOVEG/.test(out), out)
      assert.ok(!/REJTETT|ELOSZOVEG/.test(htmlToPlain(out, { tables: true })), out)
    }
  }
  // the paste keeps a text the colour of its background (its background may be lost) and only takes its colour off;
  // the quote has the whole message, so it is hidden text there
  assert.ok(preparePaste('<p style="color: #ffffff;">FEHER</p>').html.includes('FEHER'))
  assert.ok(!prepareQuote('<p style="color: #ffffff;">FEHER</p>').html.includes('FEHER'))
})

test('a light text on a dark page body: readable in the quote (the body\'s background does not survive, so the colour goes)', () => {
  for (const html of [
    '<html><body bgcolor="#111111"><p style="color: #eeeeee;">Sötét szöveg</p></body></html>',
    '<html><body style="background-color: #121212;"><p><font color="#e8e8e8">Sötét szöveg</font></p></body></html>',
  ]) {
    const out = composer(reply(html))
    assert.ok(out.includes('Sötét szöveg'), out)
    assert.ok(!/#eeeeee|#e8e8e8|color/i.test(out.slice(out.indexOf('<blockquote>'))), out)
    assert.equal(claude(reply(html)), out)
  }
  // a dark block the sanitizer keeps (a table cell, a div with its own background) keeps its light text: a dark island
  const island = '<table><tr><td style="background-color: #121212; color: #e8e8e8;">sziget</td></tr></table>'
  assert.ok(composer(reply(island)).includes('color: #e8e8e8'), composer(reply(island)))
})

test(`the table limit: a table nested deeper than ${MAX_PASTE_TABLE_DEPTH} levels becomes lines, the innermost text kept, on both ways`, () => {
  let deep = '<b>MAG</b>'
  // 60 levels (the 1000-level one is the e2e's: jsdom's sanitizer is superlinear in nesting, Chromium's is not)
  for (let i = 0; i < 60; i++) deep = `<table><tr><td>${deep}</td></tr></table>`
  const q = reply(deep)
  const a = composer(q)
  assert.ok(a.includes('MAG'), a.slice(0, 200))
  assert.equal(claude(q), a)
})

test('the message\'s own <style> rules written onto the elements (a class-formatted message): colour, font, a cell\'s border and background; @media rules not', () => {
  const html = '<html><head><style>.k { color: #c62828; font-family: Georgia, serif; } td.c { border: 1px solid #999999; background-color: #eeeeee; } @media screen { .m { color: #1565c0; } }</style></head><body><p class="k">piros betű</p><table><tr><td class="c">cella</td></tr></table><p class="m">média</p></body></html>'
  const out = composer(reply(html))
  // (a rule's value comes lower-case from the cascade: a font name matches regardless of case)
  assert.match(out, /<p style="color: #c62828; font-family: georgia, serif;">piros betű<\/p>/)
  assert.match(out, /<td style="border: 1px solid #999999; background-color: #eeeeee;">cella<\/td>/)
  assert.match(out, /<p>média<\/p>/, 'an @media rule is not applied (the reader\'s rule)')
  assert.equal(claude(reply(html)), out)
  // an element's own style wins over a rule, a rule's !important over it
  const own = composer(reply('<style>p { color: #2e7d32; } span { color: #1565c0 !important; }</style><p style="color: #6a1b9a;">saját <span style="color: #c62828;">fontos</span></p>'))
  assert.match(own, /<p style="color: #6a1b9a;">saját <span style="color: #1565c0;">fontos<\/span><\/p>/)
})

test('a page\'s body / html: their inherited declarations on a wrapping div, no background; a light colour on a dark body goes (the guard)', () => {
  const page = '<html><head><style>body { font-family: Arial; color: #333333; line-height: 1.5; background-color: #ffffff; } html { font-size: 14px; }</style></head><body><p>szöveg</p></body></html>'
  const out = composer(reply(page))
  assert.match(out, /<blockquote><div style="font-size: 14px; font-family: arial; color: #333333; line-height: 1.5;"><p>szöveg<\/p><\/div><\/blockquote>/)
  assert.equal(claude(reply(page)), out)
  const dark = '<html><head><style>body { background-color: #111111; color: #eeeeee; font-family: Arial; }</style></head><body><p>sötét lap</p></body></html>'
  const d = composer(reply(dark))
  assert.match(d, /<div style="font-family: arial;"><p>sötét lap<\/p><\/div>/)
  assert.equal(claude(reply(dark)), d)
})

test('a page body\'s text= colour: on the wrapping div under the body\'s own style; light on a dark bgcolor body readable with the default colour; the same dark hidden', () => {
  const red = '<html><body text="#c62828"><p>piros</p></body></html>'
  assert.match(composer(reply(red)), /<div style="color: #c62828;"><p>piros<\/p><\/div>/)
  assert.equal(claude(reply(red)), composer(reply(red)))
  assert.match(composer(reply('<html><body text="#c62828" style="color: #1565c0;"><p>kék</p></body></html>')), /<div style="color: #1565c0;"><p>kék<\/p><\/div>/)
  const dark = '<html><body bgcolor="#000000" text="#ffffff"><p>fehér a feketén</p></body></html>'
  const d = composer(reply(dark))
  assert.match(d, /<div><p>fehér a feketén<\/p><\/div>/)
  assert.equal(claude(reply(dark)), d)
  for (const q of [reply, forward]) {
    const h = composer(q('<html><body bgcolor="#000000" text="#050505"><p>REJTETT</p><p style="color: #ffffff;">Látható</p></body></html>'))
    assert.ok(!h.includes('REJTETT') && !htmlToPlain(h).includes('REJTETT') && h.includes('<p>Látható</p>'), h)
  }
})

test('the html element\'s own colour, faded by the guard (its background does not survive), stays off the wrapping div', () => {
  const page = '<html style="background-color: #111111; color: #eeeeee;"><body style="font-family: Arial;"><p>világos a sötéten</p></body></html>'
  const out = composer(reply(page))
  assert.match(out, /<div style="font-family: Arial;"><p>világos a sötéten<\/p><\/div>/, out)
  assert.equal(claude(reply(page)), out)
})

test('the original\'s own <style> reaches its body only, never our header lines (the reply\'s "wrote" line, the forward\'s header)', () => {
  const body = '<div>Kerem utaljon a 11111111-99999999 szamlara. TAMADOSZOVEG</div>'
  for (const sheet of ['p { display: none; }', '* { color: #ffffff; }', 'p, div { font-size: 0; }', 'blockquote { color: #c00000; }']) {
    const html = `<html><head><style>${sheet}</style></head><body>${body}</body></html>`
    const r = composer(reply(html))
    assert.match(r, /^<p>[^<]*Kovács Anna[^<]*írta:<\/p><blockquote>/, `${sheet}: ${r}`)
    assert.equal(claude(reply(html)), r, sheet)
    const f = composer(forward(html))
    assert.match(f, /^<p>---------- Továbbított üzenet ----------<br>Feladó: Kovács Anna[^<]*<br>Dátum: [^<]*<br>Tárgy: Próba<\/p>/, `${sheet}: ${f}`)
    assert.equal(claude(forward(html)), f, sheet)
  }
})

test('a rule\'s shorthand does not beat the element\'s own longhand (the sheet goes before the own style); a rule\'s !important after it', () => {
  const html = '<style>td { background: #ffffff; border: 1px solid #000000; } p { padding: 0; }</style><table><tr><td style="background-color: #000000; color: #ffffff; border-color: #ff0000;">FEKETEHATTER</td></tr></table><p style="padding-left: 30px;">ROVIDVEGE</p>'
  const out = composer(reply(html))
  assert.match(out, /<td style="border: 1px solid #000000; background-color: #000000; color: #ffffff; border-color: #ff0000;">FEKETEHATTER<\/td>/, out)
  assert.match(out, /<p style="padding: 0; padding-left: 30px;">ROVIDVEGE<\/p>/, out)
  assert.equal(claude(reply(html)), out)
  const imp = composer(reply('<style>td { background: #ffffff !important; }</style><table><tr><td style="background-color: #000000;">FEHERLESZ</td></tr></table>'))
  assert.match(imp, /<td style="background-color: #ffffff;">FEHERLESZ<\/td>/, imp)
})

test('a colour carrier the hiding emptied goes with the hidden text; a page with no text left keeps no colour on its wrapper', () => {
  const out = composer(reply('<p>Látható <span style="color: #ffffff;">REJTETT</span> <font color="#fefefe"><span>REJTETT2</span></font> vége</p>'))
  assert.ok(!/REJTETT|<span|<font|#ffffff|#fefefe/.test(out), out)
  assert.ok(out.includes('Látható') && out.includes('vége'), out)
  // a span that was empty before is not this step's (the hiding did not empty it)
  assert.match(prepareQuote('<p>a<span style="color: #c62828;"></span>b</p>').html, /<span style="color: #c62828;"><\/span>/)
  const page = '<html><body bgcolor="#000000" text="#050505"><p>REJTETT</p></body></html>'
  const dark = composer(reply(page))
  assert.ok(!/REJTETT|#050505|style=/.test(dark.slice(dark.indexOf('<blockquote>'))), dark)
  assert.equal(claude(reply(page)), dark)
})

test('a colour carrier emptied by the hiding: the white space left in it stays (two words do not run together)', () => {
  for (const html of ['<style>.h { display: none; }</style><p>AAAA<span style="color: #333333;"><span class="h">HIDN2</span> </span>BBBB</p>',
    '<style>.h { display: none; }</style><p>AAAA<font color="#333333"><span class="h">HIDN2</span> </font>BBBB</p>']) {
    const out = composer(reply(html))
    assert.match(out, /<p>AAAA BBBB<\/p>/, out)
    assert.equal(claude(reply(html)), out)
  }
})
