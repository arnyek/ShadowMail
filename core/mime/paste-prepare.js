// SPDX-License-Identifier: GPL-3.0-or-later
// The composer's paste, before its sanitizer (sanitize.js sanitizeCompose `rich`): what the clipboard's HTML shows is what
// goes in. Pure (htmlparser2, no DOM): the composer page runs it on the paste's text/html (MEASURED: in the renderer bundle
// a 1 MB web page copy takes ~80 ms; there is no `process` there, so visible-text.js's time net is the wall clock).
//
// 1. Hidden text out, with its element: the visible-text.js rules (display: none, visibility, opacity multiplied down
//    to under 0.1, a transparent colour, a font under 3 px, zero size with overflow hidden, clip, scale(0), a closed
//    details...) on the same cascade the reader's filter uses, EXCEPT "a text the colour of its background": that one is
//    a readability question (2), the text stays.
// 2. Readability: a text whose colour has a contrast under MIN_CONTRAST against its background (the nearest background in
//    the pasted piece, else the message's white) loses its colour declaration (the style's color, a font's color): the
//    text and the background stay, the text takes the default dark colour. A readable dark island (a light text on its
//    own dark background) stays as it was. A colour or a background that cannot be read (var(), an image) is left alone.
// 3. A table over MAX_PASTE_CELLS cells (its own and its nested ones) or deeper than MAX_PASTE_TABLE_DEPTH tables in
//    tables becomes lines, as sanitize.js tableToLines writes them (a line per row, the cells one space apart, a header cell
//    bold, the caption first): a huge or deeply nested table is slow to lay out in the editor.
// 4. Too complex (visible-text.js's work ceiling, or the paste's own time net PASTE_TIME_LIMIT_MS, or a body over its tag
//    or depth cut): { plain: true }, and the caller pastes the old way (no formatting, a table as lines) with an informing
//    line.
// The tree is read with the browser's table rules first (visible-text.js browserTables): a text standing in a table but in
// no cell is moved out of it by the sanitizer's parser, so its hidden or shown state is decided where it ends up.
// The <style> blocks go here (their rules are not written onto the elements yet), so does every node visible-text.js's
// reader tree drops (script, template, comments...); the sanitizer still decides on everything that is left.
import { Parser, DomHandler, DomUtils } from 'htmlparser2'
import { visibleTextInfo, contrastRatio, normalizeColor, shownOn, bodyTextColor, TIME_LIMIT_MS } from './visible-text.js'

export const MIN_CONTRAST = 3
// the paste's own time net (visible-text.js's is 1500 ms for read_message, the search and the MCP): the composer waits for
// it, so past this much the clipboard goes the old way (the planner's decision: the worst wait ~0.5 s, not 1.6 s)
export const PASTE_TIME_LIMIT_MS = 500
export const MAX_PASTE_CELLS = 20_000
export const MAX_PASTE_TABLE_DEPTH = 20

const isEl = n => n && (n.type === 'tag' || n.type === 'script' || n.type === 'style')

// node makers with the parser's own classes (domhandler is no direct dependency): an element and a text
const sample = (() => {
  const h = new DomHandler()
  new Parser(h).end('<div> </div>')
  return h.root.children[0]
})()
const ElementNode = sample.constructor
const TextNode = sample.children[0].constructor
function relink(parent, kids) {
  parent.children = kids
  for (let i = 0; i < kids.length; i++) {
    kids[i].parent = parent
    kids[i].prev = kids[i - 1] || null
    kids[i].next = kids[i + 1] || null
  }
}
const el = (name, kids = []) => {
  const e = new ElementNode(name, {}, [])
  relink(e, kids)
  return e
}

// a style attribute without its color declaration(s) (the rest stays as written; the sanitizer cleans it)
// a style without the named declarations (lower-case names)
function without(style, names) {
  return style
    .split(';')
    .filter(d => {
      const i = d.indexOf(':')
      return i < 0 || !names.has(d.slice(0, i).trim().toLowerCase())
    })
    .join(';')
}
const COLOR_DECLS = new Set(['color'])
// what a page's body / html gives its text by inheritance (no background: the editor's page is white)
const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-transform'])
// the declarations of a style text, in order, lower-case names (the last one of a name wins)
const decls = style => {
  const out = new Map()
  for (const d of String(style || '').split(';')) {
    const i = d.indexOf(':')
    if (i < 0) continue
    const name = d.slice(0, i).trim().toLowerCase()
    out.delete(name)
    out.set(name, d.slice(i + 1).trim())
  }
  return out
}
// the first body (and the html around it): their inherited declarations (the rules written on them already) on the body,
// which becomes a plain div (the sanitizer unwraps a body); a faded colour stays off
function pageWrapper(doc, fade) {
  const body = DomUtils.findOne(e => e.name === 'body', doc.children, true)
  if (!body) return
  // no text left (all of it hidden): its colour and font would only colour what the user types there
  if (!/\S/.test(DomUtils.textContent(body))) {
    body.name = 'div'
    body.attribs = {}
    return
  }
  const keep = new Map()
  for (const el of [body.parent && body.parent.name === 'html' ? body.parent : null, body]) {
    if (!el) continue
    // the body's text= colour: under its own style, over the html's colour
    const attr = bodyTextColor(el)
    const own = [...(attr ? [['color', attr]] : []), ...decls(el.attribs?.style)]
    for (const [name, value] of own) {
      if (!INHERITED.has(name) || (name === 'color' && fade.has(el))) continue
      keep.delete(name)
      keep.set(name, value)
    }
  }
  body.name = 'div'
  body.attribs = keep.size ? { style: [...keep].map(([n, v]) => `${n}: ${v}`).join('; ') } : {}
}
const BG_DECLS = new Set(['background', 'background-color'])
// the first link of a colour / background chain (visible-text.js keptColors) whose element is not in `gone`
const live = (node, gone) => {
  while (node && node.el && gone.has(node.el)) node = node.up
  return node
}
const MAX_STEPS = 1000
const MAX_ROUNDS = 100

// the hidden nodes out of the tree, one pass, children arrays rebuilt
// a span / font that only carried the hidden text's colour (or font) goes with it: left empty, it would colour what the user
// types there (the tester's note); only one the hiding emptied, a deeper one first, then its parent. White space left in it
// stays, as plain text in its place (it parts two words)
const CARRIERS = new Set(['span', 'font'])
const blank = el => (el.children || []).every(c => c.type === 'text' && /^[ \t\n\f\r]*$/.test(c.data))
function dropHidden(doc, hidden) {
  const stack = [doc]
  const lost = [] // the nodes that lost a hidden child, each after its parent
  while (stack.length) {
    const node = stack.pop()
    if (!node.children || !node.children.length) continue
    const kids = node.children.filter(c => !hidden.has(c) && !(isEl(c) && c.name === 'style'))
    if (kids.length < node.children.length && node.children.some(c => hidden.has(c))) lost.push(node)
    relink(node, kids)
    for (const c of kids) if (isEl(c)) stack.push(c)
  }
  for (let i = lost.length - 1; i >= 0; i--) {
    let n = lost[i]
    while (isEl(n) && CARRIERS.has(n.name) && n.parent && blank(n)) {
      const p = n.parent
      relink(p, p.children.flatMap(c => (c === n ? n.children : [c])))
      n = p
    }
  }
}

// a table's own rows in tree order, as visible-text.js / sanitize.js tableToLines read them: its caption, the rows
// directly in it or in its thead / tbody / tfoot (a nested table's rows are its own); what stands in no cell (ASCII
// whitespace, comments and columns aside) stays where it stands, as a part of its row or a line of its own
const ASCII_BLANK = /^[ \t\n\f\r]*$/
const stray = n => (isEl(n) ? n.name !== 'col' && n.name !== 'colgroup' : n.type === 'text' && !ASCII_BLANK.test(n.data))
function toLines(table) {
  const lines = []
  // a part is a node or a cell's children (no wrapper: MEASURED, the editor's insertHTML is quadratic in bare spans)
  const line = parts => {
    const kids = []
    parts.forEach((p, i) => {
      if (i) kids.push(new TextNode(' '))
      if (Array.isArray(p)) kids.push(...p)
      else kids.push(p)
    })
    lines.push(el('div', kids))
  }
  const content = c => [...(c.children || [])]
  const rowLine = tr => {
    const parts = []
    for (const c of tr.children || []) {
      if (isEl(c) && c.name === 'td') parts.push(content(c))
      else if (isEl(c) && c.name === 'th') parts.push(el('b', [...(c.children || [])]))
      else if (stray(c)) parts.push(c)
    }
    line(parts)
  }
  for (const c of table.children || []) {
    if (isEl(c) && c.name === 'caption') line([content(c)])
    else if (isEl(c) && c.name === 'tr') rowLine(c)
    else if (isEl(c) && (c.name === 'thead' || c.name === 'tbody' || c.name === 'tfoot')) {
      for (const r of c.children || []) {
        if (isEl(r) && r.name === 'tr') rowLine(r)
        else if (stray(r)) line([r])
      }
    } else if (stray(c)) line([c])
  }
  return el('div', lines)
}

// the tables over the limits made lines: the cell count of a table is its own and its nested tables'; the depth is the
// number of tables around it. One walk carries the nearest table down (no walk up per cell)
function limitTables(doc) {
  const tables = [] // [table, depth, outer table] in tree order (an outer one before its inner ones)
  const cells = new Map()
  const stack = [[doc, 0, null]]
  while (stack.length) {
    const [node, depth, table] = stack.pop()
    for (const c of node.children || []) {
      if (!isEl(c)) continue
      if (c.name === 'table') {
        tables.push([c, depth + 1, table])
        cells.set(c, 0)
        stack.push([c, depth + 1, c])
        continue
      }
      if ((c.name === 'td' || c.name === 'th') && table) cells.set(table, cells.get(table) + 1)
      stack.push([c, depth, table])
    }
  }
  if (!tables.length) return 0
  // the inner tables first: a nested table's count is final before its outer table takes it
  for (let i = tables.length - 1; i >= 0; i--) {
    const [t, , outer] = tables[i]
    if (outer) cells.set(outer, cells.get(outer) + cells.get(t))
  }
  let made = 0
  for (const [t, depth] of tables) {
    if (depth <= MAX_PASTE_TABLE_DEPTH && cells.get(t) <= MAX_PASTE_CELLS) continue
    const parent = t.parent
    const kids = parent.children.slice()
    kids[kids.indexOf(t)] = toLines(t)
    relink(parent, kids)
    made++
  }
  return made
}

// --- Word's lists: Word puts a list on the clipboard as paragraphs with "mso-list: lN levelM lfoK", the marker (a
// bullet in Symbol / Courier / Wingdings, or "1.", "a)", "iv.") as text in a "mso-list: Ignore" span. Each run of such
// paragraphs becomes a real ul / ol (the marker decides, the first one of a list its type and start), deeper levels nested in
// the item before them; the marker and the paragraph's indent (margin, text-indent) go, the rest of its formatting stays on
// the li. Linear: one pass over the tree, each list's items linked once.
const MSO_LIST = /(?:^|;)\s*mso-list\s*:\s*(l\d+)\s+level(\d+)/i
const MSO_IGNORE = /(?:^|;)\s*mso-list\s*:\s*ignore\b/i
const LIST_PARAS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const INDENT_DECLS = new Set(['margin', 'margin-left', 'text-indent', 'mso-list'])
const listPara = n => isEl(n) && LIST_PARAS.has(n.name) && MSO_LIST.test(n.attribs?.style || '')
// what may stand between two list paragraphs of one run: white space, comments, Word's <![if ...]> directives
const between = n => (n.type === 'text' ? ASCII_BLANK.test(n.data) : !isEl(n))
const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }
const romanValue = r => [...r.toLowerCase()].reduce((sum, c, i, a) => sum + (ROMAN[c] < (ROMAN[a[i + 1]] || 0) ? -ROMAN[c] : ROMAN[c]), 0)
const BULLET = { tag: 'ul', type: null, start: 1 }
const SYMBOL_FONT = /\b(symbol|wingdings[\w ]*|webdings)\b/i
// a marker -> { tag, type, start } or null: "1." / "1)" / "(1)" numbered, "a." letters, "i." / "iv." roman (a single i, v
// or x is roman: a letter list starts at a); a bullet (ul): a marker in a symbol font (its glyphs are letters in Unicode:
// Wingdings' square is "§", its arrow "Ø"), one without a letter or digit, or Word's Courier New "o". Any other marker with
// a letter or digit ("1.1.", "1.a)", "Step 1.", "1. §") is null: the paragraph stays one, its number kept as text
function listKind({ text, symbol }) {
  const m = /^\(?([0-9]{1,6}|[a-z]{1,4}|[A-Z]{1,4})[.)]$/.exec(text)
  if (m) {
    const v = m[1]
    if (/^\d+$/.test(v)) return { tag: 'ol', type: null, start: Number(v) }
    const upper = v === v.toUpperCase()
    if (/^[ivxlcdm]+$/i.test(v) && (v.length > 1 || /^[ivx]$/i.test(v))) return { tag: 'ol', type: upper ? 'I' : 'i', start: romanValue(v) }
    if (v.length === 1) return { tag: 'ol', type: upper ? 'A' : 'a', start: v.toLowerCase().charCodeAt(0) - 96 }
  }
  if (symbol || text === 'o' || !/[\p{L}\p{N}]/u.test(text)) return BULLET
  return null
}
// the marker span's text (white space runs as one space, trimmed), whether it is set in a symbol font (on the span or a
// carrier above it, up to the paragraph), and the span taken out (with the carriers it leaves empty, up to the paragraph)
function takeMarker(p) {
  const span = DomUtils.findOne(e => MSO_IGNORE.test(e.attribs?.style || ''), p.children || [], true)
  if (!span) return { text: '', symbol: false }
  const text = DomUtils.textContent(span).replace(/[\s\u00a0]+/g, ' ').trim()
  let symbol = false
  for (let e = span; e && e !== p; e = e.parent) {
    if (SYMBOL_FONT.test(e.attribs?.style || '') || SYMBOL_FONT.test(e.attribs?.face || '')) symbol = true
  }
  let n = span
  while (n && n !== p && n.parent) {
    const parent = n.parent
    relink(parent, parent.children.filter(c => c !== n))
    if (parent === p || !(parent.children || []).every(between)) break
    n = parent
  }
  return { text, symbol }
}
function wordLists(doc) {
  const stack = [doc]
  while (stack.length) {
    const node = stack.pop()
    const kids = node.children || []
    if (kids.some(listPara)) {
      const out = []
      for (let i = 0; i < kids.length; i++) {
        if (!listPara(kids[i])) {
          out.push(kids[i])
          continue
        }
        // the run: list paragraphs, with only white space / comments between them
        const run = []
        let j = i
        while (j < kids.length) {
          if (listPara(kids[j])) run.push(kids[j])
          else if (!between(kids[j])) break
          j++
        }
        // trailing white space after the last paragraph stays outside the list
        let end = j
        while (end > i && !listPara(kids[end - 1])) end--
        out.push(...buildLists(run))
        for (let k = end; k < j; k++) out.push(kids[k])
        i = j - 1
      }
      relink(node, out)
    }
    for (const c of node.children || []) if (isEl(c)) stack.push(c)
  }
}
function buildLists(run) {
  const roots = []
  const items = new Map() // list -> its items, linked once at the end
  const open = [] // { level, id, tag, list, last }
  const newList = (kind, level, id) => {
    const list = el(kind.tag)
    if (kind.type) list.attribs.type = kind.type
    if (kind.start !== 1) list.attribs.start = String(kind.start)
    items.set(list, [])
    const top = open[open.length - 1]
    // a deeper list goes into the item before it
    if (top && top.last) relink(top.last, [...top.last.children, list])
    else roots.push(list)
    open.push({ level, id, tag: kind.tag, list, last: null })
  }
  for (const p of run) {
    const [, id, lv] = MSO_LIST.exec(p.attribs.style)
    const level = Number(lv)
    const marker = takeMarker(p)
    const kind = listKind(marker)
    const kept = [...decls(p.attribs.style)].filter(([n]) => !INDENT_DECLS.has(n) && !n.startsWith('mso-'))
    const style = kept.length ? { style: kept.map(([n, v]) => `${n}: ${v}`).join('; ') } : {}
    if (!kind) {
      // an unknown marker with a number or letter: the paragraph stays one with its marker as text (a space for Word's tab),
      // and the lists before it end there (a numbered item after it starts a list of its own, at its own number)
      open.length = 0
      p.attribs = style
      relink(p, [new TextNode(`${marker.text} `), ...(p.children || [])])
      roots.push(p)
      continue
    }
    while (open.length && open[open.length - 1].level > level) open.pop()
    let top = open[open.length - 1]
    // the same level but another list (its id at the top level) or another kind (bullet / number): a list of its own
    if (top && top.level === level && ((open.length === 1 && top.id !== id) || top.tag !== kind.tag)) {
      open.pop()
      top = open[open.length - 1]
    }
    if (!top || top.level < level) newList(kind, level, id)
    top = open[open.length - 1]
    p.name = 'li'
    p.attribs = style
    items.get(top.list).push(p)
    top.last = p
  }
  for (const [list, lis] of items) relink(list, lis)
  return roots
}

// the elements whose text a page does not show as text (the head with its title, a style sheet, a script...)
const NO_SHOWN_TEXT = new Set(['head', 'title', 'style', 'script', 'template', 'noscript'])
/**
 * Whether a clipboard HTML has text to show (not white space), outside the head, style and script elements: the composer's
 * "an image, or a piece of a page" decision. Pure (htmlparser2), no document: a DOMParser document takes the page's CSP,
 * and an Excel clipboard's <style> block in it was a console line at every paste (MEASURED, the line's hash is the
 * block's; Excel puts a picture of the cells beside its HTML, so the check runs on every Excel paste).
 */
export function hasShownText(html) {
  if (!html) return false
  let skip = 0
  let shown = false
  const parser = new Parser({
    onopentag: name => {
      if (NO_SHOWN_TEXT.has(name)) skip++
    },
    onclosetag: name => {
      if (NO_SHOWN_TEXT.has(name) && skip > 0) skip--
    },
    ontext: text => {
      if (!skip && !shown && text.trim()) {
        shown = true
        parser.pause()
      }
    },
  }, { decodeEntities: true })
  parser.end(String(html))
  return shown
}

/**
 * The clipboard's text/html made ready for the composer's rich sanitizer.
 * -> { html, plain: false, faded, lined } or { html: null, plain: true, reason: 'complex' | 'cut' } (paste it the old way)
 *    faded: how many colour declarations went for readability; lined: how many tables became lines.
 */
export function preparePaste(html, { clocks, quote = false } = {}) {
  // readability, on what the rich sanitizer keeps: a text whose colour (its alpha mixed in) stands under MIN_CONTRAST on
  // its background loses its colour declaration, then the next one up the chain, until it is readable or has the default;
  // if even the default stands under it (a dark background the sanitizer keeps), the background goes too, nearest first
  const fade = new Set()
  const dropBg = new Set()
  const texts = []
  // a text of white space only shows nothing: it decides nothing (a space between two spans on a dark block)
  const onText = (text, ctx) => {
    if (/\S/.test(text.data)) texts.push(ctx)
  }
  // one text made readable; true when a declaration went
  const settle = ctx => {
    let changed = false
    for (let step = 0; step < MAX_STEPS; step++) {
      const b = live(ctx.bg, dropBg)
      const bg = b ? normalizeColor(b.bg) : '#ffffff'
      const c = live(ctx.color, fade)
      const shown = shownOn(c ? c.color : '#000000', bg)
      const ratio = shown ? contrastRatio(shown, bg) : null
      if (ratio === null || ratio >= MIN_CONTRAST) return changed
      if (c && c.el) fade.add(c.el)
      else if (b) dropBg.add(b.el)
      else return changed
      changed = true
    }
    return changed
  }
  // a background that went changes what the texts under it stand on (planner, 5243): the guard runs again over every text
  // until nothing goes (each round takes a declaration off for good, so it ends)
  const settleAll = () => {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let changed = false
      for (const ctx of texts) if (settle(ctx)) changed = true
      if (!changed) return
    }
  }
  let lined = 0
  const build = (doc, hidden) => {
    settleAll()
    dropHidden(doc, hidden)
    pageWrapper(doc, fade)
    for (const e of fade) {
      if (e.attribs?.style !== undefined) e.attribs.style = without(e.attribs.style, COLOR_DECLS)
      if (e.name === 'font' && e.attribs?.color !== undefined) delete e.attribs.color
    }
    for (const e of dropBg) {
      if (e.attribs?.style !== undefined) e.attribs.style = without(e.attribs.style, BG_DECLS)
      if (e.attribs?.bgcolor !== undefined) delete e.attribs.bgcolor
    }
    wordLists(doc)
    lined = limitTables(doc)
    return DomUtils.getOuterHTML(doc.children, { encodeEntities: 'utf8' })
  }
  // a quote (prepareQuote): the whole message is there, so a text the colour of its background is hidden, as for
  // read_message; and its net is the reader's (the composer is opening, nothing waits on a keystroke)
  const r = visibleTextInfo(String(html || ''), build, { ...(clocks ? { clocks } : {}), paste: { onText, sameColor: quote }, limitMs: quote ? TIME_LIMIT_MS : PASTE_TIME_LIMIT_MS, tables: true })
  if (r.cut === 'complex') return { html: null, plain: true, reason: 'complex' }
  // a body over the tag or depth cut is a part of the clipboard: never paste a part silently
  if (r.cut === 'tags') return { html: null, plain: true, reason: 'cut' }
  return { html: r.text, plain: false, faded: fade.size + dropBg.size, lined }
}

/**
 * A reply's or a forward's quote (the header line and the original, as core/smtp/compose.js quoteHtml / forwardHtml
 * write it) made ready for the rich sanitizer: the paste's steps, but a text the colour of its background is hidden (the
 * whole message is there) and the reader's time net. The composer (Composer.jsx) and Claude's quote (app/main/compose.js)
 * run it on the same quote, so the two ways keep their byte-for-byte parity.
 */
export const prepareQuote = (html, { clocks } = {}) => preparePaste(html, { clocks, quote: true })
