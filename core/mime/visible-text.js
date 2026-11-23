// SPDX-License-Identifier: GPL-3.0-or-later
// MCP: a message's HTML as
// the text a reader SEES in the app. The rule: drop what the app's reader would not show, nothing more. Hidden
// text is the usual carrier of a prompt injection.
//
// The app's reader: DOMPurify (sanitize.js, FORCE_BODY: head content lands in the body) in a <!doctype html>
// frame (standards mode: class and id names are case-sensitive). What DOMPurify removes WITH its content is
// dropped here too (DROP_TAGS); what it removes keeping the content (form, select, object...) is unwrapped: its
// own attributes and style vanish, its text shows (UNWRAP_TAGS).
//
// <style>: simple rules only: tag, *, .class, #id and their compounds; the rightmost
// compound decides (".a .h" hides every .h, a documented over-hiding); a pseudo or attribute selector in ANY
// part drops the rule; @media and every other at-rule is ignored, so is a <style media="print"> (any media but
// all/screen) and a <style> inside a dropped element (template, noscript...). The cascade: !important, inline,
// specificity of the whole selector, then source order.
// Hidden: display:none (also the `hidden` attribute, unless display is set), visibility:hidden|collapse
// (inherited: a child can be visible again), a computed font size below 3px (inherited: em/%/rem resolved, a
// child can reset it), opacity multiplied down the tree below 0.1, a transparent text colour or
// one (nearly) equal to the known background (inherited), off-screen position, a far text-indent (inherited),
// zero width/height with overflow:hidden, clip / clip-path that leave nothing, transform:scale(0), the body of a
// closed <details>. Kept (the app shows them): aria-hidden, mso-hide, <font size=1>. A background we cannot read
// (an image, var(), an unknown colour name) disables the colour comparison below it.
//
// Cost: every pass over CSS and text is linear (hand-written scanners, no backtracking regex on
// mail-controlled text); rules are indexed by id/class/tag and identical selectors are merged; the matching work
// has a ceiling (MAX_MATCH_WORK). A body over MAX_TAGS tags or MAX_DEPTH open elements is cut (its later <style> blocks still count); a body
// over the work ceiling gives no text. Both are reported (visibleTextInfo().cut), never silent.
import { Parser, DomHandler, DomUtils } from 'htmlparser2'
import { RICH_EXTRA_TAGS, RICH_ATTRS, RICH_PROPERTIES, VOID_TAGS, richAttrs, cleanStyle, cleanAttr } from '../smtp/rich-style.js'
const RICH_PROPERTY_SET = new Set(RICH_PROPERTIES)

const NAMED = {
  white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', yellow: '#ffff00', navy: '#000080', darkblue: '#00008b', snow: '#fffafa', ivory: '#fffff0', whitesmoke: '#f5f5f5',
  ghostwhite: '#f8f8ff', floralwhite: '#fffaf0', linen: '#faf0e6', seashell: '#fff5ee', mintcream: '#f5fffa', azure: '#f0ffff',
  aliceblue: '#f0f8ff', honeydew: '#f0fff0', lavenderblush: '#fff0f5', oldlace: '#fdf5e6', beige: '#f5f5dc', orange: '#ffa500',
  purple: '#800080', maroon: '#800000', olive: '#808000', teal: '#008080', lime: '#00ff00', aqua: '#00ffff', fuchsia: '#ff00ff',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', gainsboro: '#dcdcdc', dimgray: '#696969',
}
// DOMPurify's default FORBID_CONTENTS that can occur in a mail body, plus canvas: removed with their content
const DROP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'title', 'svg', 'math', 'iframe', 'audio', 'video', 'noembed', 'noframes', 'plaintext', 'xmp', 'canvas', 'selectedcontent'])
// sanitize.js FORBID_TAGS whose content DOMPurify keeps (KEEP_CONTENT): the element goes, its children stay
const UNWRAP_TAGS = new Set(['frame', 'frameset', 'object', 'embed', 'applet', 'param', 'portal', 'fencedframe', 'form', 'input', 'button', 'select', 'option', 'textarea', 'datalist', 'output', 'keygen', 'link', 'meta', 'base', 'source', 'track', 'picture', 'slot', 'dialog'])
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'blockquote', 'pre', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'ol', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption', 'address', 'center', 'form', 'fieldset', 'details', 'summary', 'hr', 'body', 'html'])
const UNKNOWN = 'unknown'
export const MAX_TAGS = 100_000 // the css-matcher case (text after tag 50 000) must stay; 5 MB of flat tags ~0.3 s
export const MAX_DEPTH = 1000 // htmlparser2's stack costs O(depth) per tag: 50 000 nested tags took 1 s
export const MAX_MATCH_WORK = 2_000_000 // candidate rules + declarations looked at, over the whole body
const PARSE_CHUNK = 4096
const STYLE_EXTEND = 256 * 1024 // a <style> cut in half is finished within this many characters, else no text
export const TIME_LIMIT_MS = 1500 // a net under the work ceiling: past this much CPU time no text, cut 'complex'
// a wall-clock bound far above it: a thread starved of the CPU for this long still ends
export const WALL_LIMIT_MS = 20_000
const MAX_VALUE = 2000 // a longer colour / size / background value is "unknown", never parsed
const MIN_FONT_PX = 3 // below 3px (2.25pt)
const MIN_OPACITY = 0.1

// --- colours -----------------------------------------------------------------------------------------
const clamp = n => Math.max(0, Math.min(255, Math.round(n)))
const hex = (r, g, b) => `#${[r, g, b].map(n => clamp(n).toString(16).padStart(2, '0')).join('')}`
function hslToRgb(h, s, l) {
  s /= 100
  l /= 100
  const k = n => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}
/** A CSS colour -> "#rrggbb", "transparent", or null (unknown). */
export function normalizeColor(value) {
  if (value === undefined || value === null) return null
  const v = String(value).trim().toLowerCase()
  if (!v || v.length > 100) return null
  if (v === 'transparent') return 'transparent'
  if (NAMED[v]) return NAMED[v]
  let m = v.match(/^#([0-9a-f]{3,4})$/)
  if (m) {
    if (m[1].length === 4 && m[1][3] === '0') return 'transparent'
    return `#${[...m[1].slice(0, 3)].map(c => c + c).join('')}`
  }
  m = v.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/)
  if (m) return m[2] === '00' ? 'transparent' : `#${m[1]}`
  if (!/^(rgba?|hsla?)\(/.test(v) || !v.endsWith(')')) return null
  const fn = v.slice(0, v.indexOf('('))
  const parts = v.slice(fn.length + 1, -1).split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return null
  const alpha = parts[3] !== undefined ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1
  if (alpha === 0) return 'transparent'
  const num = (p, scale) => (p.endsWith('%') ? (parseFloat(p) / 100) * scale : parseFloat(p))
  if (fn.startsWith('rgb')) {
    const rgb = parts.slice(0, 3).map(p => num(p, 255))
    return rgb.some(Number.isNaN) ? null : hex(...rgb)
  }
  const h = parseFloat(parts[0])
  const s = parseFloat(parts[1])
  const l = parseFloat(parts[2])
  return [h, s, l].some(Number.isNaN) ? null : hex(...hslToRgb(h, s, l))
}
const rgbOf = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
const HEX6 = /^#[0-9a-f]{6}$/
/** A page body's text= attribute (an old newsletter's <body bgcolor="#000000" text="#ffffff">) as "#rrggbb", else null:
 *  the lowest rule of the body's colour (any style, a sheet's too, wins over it). */
export function bodyTextColor(el) {
  if (el?.name !== 'body' || el.attribs?.text === undefined) return null
  const c = normalizeColor(el.attribs.text)
  return c && HEX6.test(c) ? c : null
}
const luminance = c => {
  const [r, g, b] = rgbOf(c).map(v => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** The WCAG contrast ratio of two "#rrggbb" colours (normalizeColor's form), or null when either is not one. */
export function contrastRatio(a, b) {
  if (!HEX6.test(a || '') || !HEX6.test(b || '')) return null
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
/** A colour's alpha (0..1; 1 for an opaque or an unknown one). */
export function colorAlpha(value) {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === 'transparent') return 0
  let m = v.match(/^#[0-9a-f]{3}([0-9a-f])$/)
  if (m) return parseInt(m[1] + m[1], 16) / 255
  m = v.match(/^#[0-9a-f]{6}([0-9a-f]{2})$/)
  if (m) return parseInt(m[1], 16) / 255
  m = v.match(/^(?:rgba?|hsla?)\(([^)]*)\)$/)
  if (!m) return 1
  const parts = m[1].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 4) return 1
  const a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
  return Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1
}
/** A colour as it shows on an opaque "#rrggbb" background (its alpha mixed in), "#rrggbb", or null. */
export function shownOn(value, bg) {
  const c = normalizeColor(value)
  if (c === 'transparent') return HEX6.test(bg || '') ? bg : null
  if (!HEX6.test(c || '') || !HEX6.test(bg || '')) return null
  const a = colorAlpha(value)
  if (a >= 1) return c
  const x = rgbOf(c)
  const y = rgbOf(bg)
  return hex(...x.map((v, i) => v * a + y[i] * (1 - a)))
}
// "the same colour" for the eye: a small distance counts (near-white on white)
const sameColor = (a, b) => {
  const x = rgbOf(a)
  const y = rgbOf(b)
  return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) < 24
}

// --- CSS scanning (linear) ---------------------------------------------------------------------------
const isWs = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'
const isHex = c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
// "\6f " -> "o", "\:" -> ":"; one left-to-right pass
function decodeEscapes(s) {
  if (!s.includes('\\')) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') {
      out += c
      continue
    }
    let j = i + 1
    while (j < s.length && j < i + 7 && isHex(s[j])) j++
    if (j > i + 1) {
      const cp = parseInt(s.slice(i + 1, j), 16)
      out += String.fromCodePoint(cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? cp : 0xfffd)
      if (j < s.length && isWs(s[j])) j++
      i = j - 1
    } else if (j < s.length) {
      out += s[j]
      i = j
    }
  }
  return out
}
// skips a quoted string from s[i] (the quote); returns the index after it (or the end)
function skipString(s, i) {
  const q = s[i]
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++
    else if (s[j] === q || s[j] === '\n') return j + 1
  }
  return s.length
}
// comments out (an unclosed one runs to the end, as in CSS), strings and escapes kept as written
function stripComments(s, unclosed = null) {
  if (!s.includes('/*')) return s
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '"' || c === "'") {
      const j = skipString(s, i)
      out += s.slice(i, j)
      i = j
    } else if (c === '\\') {
      out += s.slice(i, i + 2)
      i += 2
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2)
      if (end < 0) {
        if (unclosed) return unclosed
        break
      }
      out += ' '
      i = end + 2
    } else {
      out += c
      i++
    }
  }
  return out
}
// the end of a {...} block starting after its "{" at i: the index of the matching "}" (or the end)
function blockEnd(s, i) {
  let depth = 1
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === '\\') j++
    else if (c === '"' || c === "'") j = skipString(s, j) - 1
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return j
  }
  return s.length
}
/** A stylesheet (comments already out) -> [[prelude, body]] of its top-level rules; at-rules skipped. */
function topLevelRules(css) {
  const rules = []
  let start = 0
  let first = -1 // the first non-space character of the prelude: "@" = an at-rule
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (first < 0 && !isWs(c)) first = i
    if (c === '\\') i++
    else if (c === '"' || c === "'") i = skipString(css, i) - 1
    else if (c === ';' && css[first] === '@') {
      // a statement at-rule (@import, @charset) ends at ";". Anything else stays in the prelude, and a ";" or
      // "}" there makes the selector invalid, as in the browser
      start = i + 1
      first = -1
    } else if (c === '{') {
      const end = blockEnd(css, i + 1)
      const prelude = css.slice(start, i).replace(/<!--|-->/g, ' ').trim() // CDO / CDC are ignored at the top level
      if (prelude && prelude[0] !== '@') rules.push([prelude, css.slice(i + 1, end)])
      i = end
      start = end + 1
      first = -1
    }
  }
  return rules
}
// "a:b; c:url(x;y)" -> ["a:b", " c:url(x;y)"]: ";" outside strings and parentheses
function splitTop(s, sep) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') i++
    else if (c === '"' || c === "'") i = skipString(s, i) - 1
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}
/** "color: red !important; x: y" -> { color: { value: 'red', important: true }, x: {...} }; a later one wins. */
function declarations(text) {
  const out = {}
  if (!text) return out
  for (const decl of splitTop(stripComments(String(text)), ';')) {
    const i = decl.indexOf(':')
    if (i <= 0) continue
    const name = decodeEscapes(decl.slice(0, i).trim()).toLowerCase()
    let value = decl.slice(i + 1).trim()
    let important = false
    if (value.length >= 9 && value.slice(-9).toLowerCase() === 'important') {
      let j = value.length - 10
      while (j >= 0 && isWs(value[j])) j--
      if (value[j] === '!') {
        important = true
        value = value.slice(0, j).trim()
      }
    }
    if (!name || (out[name]?.important && !important)) continue
    out[name] = { value: decodeEscapes(value).toLowerCase(), important }
    // the shorthand sets the size too: "font-size:16px; font:0/0 a" is 0; a later font-size wins
    if (name === 'font' && !(out['font-size']?.important && !important)) {
      const size = fontShorthandSize(out.font.value)
      if (size !== undefined) {
        delete out['font-size']
        out['font-size'] = { value: size, important }
      }
    }
  }
  return out
}

// --- selectors ---------------------------------------------------------------------------------------
const SPECIAL = new Set(['.', '#', '>', '+', '~', '*', ',', ':', '[', ']', '(', ')', '|', '{', '}', '"', "'", '/', '!', '<', '&', '%', '$', '^', '=', '@', ';', '?', '`'])
const isIdentChar = c => !isWs(c) && !SPECIAL.has(c)
const STRUCTURAL = new Set(['first-child', 'last-child', 'only-child'])
/**
 * One selector (no comma) -> { compounds: [{ tag, id, classes, comb }], spec }: comb is the combinator to the left
 * of the compound (' ', '>', '+', '~'), spec counted over the whole selector; null when the selector has a
 * pseudo/attribute part or is not a valid simple one.
 */
function parseSelector(sel) {
  let ids = 0
  let cls = 0
  let tags = 0
  const compounds = []
  let comb = null
  let i = 0
  const n = sel.length
  const ident = () => {
    const from = i
    if (sel[i] === '-' && sel[i + 1] >= '0' && sel[i + 1] <= '9') return null
    if (sel[i] >= '0' && sel[i] <= '9') return null
    while (i < n) {
      if (sel[i] === '\\') {
        // an escape: up to 6 hex digits and one optional space (\3a b), or one literal character (\:)
        let j = i + 1
        let h = 0
        while (j < n && h < 6 && isHex(sel[j])) {
          j++
          h++
        }
        if (h > 0) {
          if (j < n && isWs(sel[j])) j++
        } else j++
        i = j
      } else if (isIdentChar(sel[i])) i++
      else break
    }
    return i > from ? decodeEscapes(sel.slice(from, i)).trim() : null
  }
  while (i < n) {
    let sawWs = false
    while (i < n && isWs(sel[i])) {
      i++
      sawWs = true
    }
    if (i >= n) break
    if (sel[i] === '>' || sel[i] === '+' || sel[i] === '~') {
      if (!compounds.length || (comb && comb !== ' ')) return null
      comb = sel[i++]
      continue
    }
    if (compounds.length && !comb && sawWs) comb = ' '
    if (compounds.length && !comb) return null
    const compound = { tag: null, id: null, classes: [], comb: compounds.length ? comb : null }
    let any = false
    if (sel[i] === '*') {
      i++
      any = true
    } else if (sel[i] !== '.' && sel[i] !== '#') {
      const t = ident()
      if (!t) return null
      compound.tag = t.toLowerCase()
      tags++
      any = true
    }
    while (i < n && (sel[i] === '.' || sel[i] === '#')) {
      const kind = sel[i++]
      const name = ident()
      if (!name) return null
      if (kind === '#') {
        if (compound.id && compound.id !== name) return null // two ids: never matches
        compound.id = name
        ids++
      } else {
        compound.classes.push(name)
        cls++
      }
      any = true
    }
    // the structural pseudo-classes are matched (they depend only on the element tree,
    // which mirrors the reader's); any other pseudo, and every attribute selector, still skips the whole rule
    // (sanitize.js drops data-* and unknown attributes, so an attribute rule may not apply in the reader at all)
    const pseudos = []
    while (i < n && sel[i] === ':' && sel[i + 1] !== ':') {
      i++
      const name = ident()
      if (!name || !STRUCTURAL.has(name.toLowerCase())) return null
      pseudos.push(name.toLowerCase())
      cls++
    }
    if (pseudos.length && !any) any = true // ":first-child" alone = "*:first-child"
    if (!any) return null
    if (i < n && !isWs(sel[i]) && sel[i] !== '>' && sel[i] !== '+' && sel[i] !== '~') return null // ":", "[", junk
    compound.pseudos = [...new Set(pseudos)].sort()
    compound.classes = [...new Set(compound.classes)].sort()
    compounds.push(compound)
    comb = null
  }
  if (!compounds.length || comb) return null
  return { compounds, spec: Math.min(ids, 999) * 1e6 + Math.min(cls, 999) * 1e3 + Math.min(tags, 999) }
}

// --- the stylesheet ----------------------------------------------------------------------------------
// a <style> with ANY media attribute is skipped (doubtful: it may apply on some screens only);
// a non-CSS type is skipped as the browser does
function styleApplies(el) {
  if (el.attribs?.media !== undefined) return false
  const type = el.attribs?.type
  if (type !== undefined && !/^\s*(text\/css)?\s*$/i.test(type.slice(0, 100))) return false
  return true
}
/** Every applicable <style> text in document order (the walk skips dropped subtrees: template, noscript...). */
function styleTexts(doc) {
  const out = []
  const stack = [doc]
  while (stack.length) {
    const node = stack.pop()
    if (node.name === 'style') {
      if (styleApplies(node)) out.push(DomUtils.textContent(node))
      continue
    }
    if (node.name && DROP_TAGS.has(node.name)) continue
    const kids = node.children || []
    for (let i = kids.length - 1; i >= 0; i--) if (kids[i].type !== 'text') stack.push(kids[i])
  }
  return out
}
const UNCLOSED = Symbol('unclosed comment')
const compoundKey = c => `${c.comb || ''}${c.tag || '*'}#${c.id || ''}.${c.classes.join('.')}:${(c.pseudos || []).join(':')}`
// what the document has: a rule asking for a class, id or tag that no element has can never match, and is dropped
// before matching (newsletters ship big unused stylesheets)
function presentNames(doc) {
  const has = { classes: new Set(), ids: new Set(), tags: new Set() }
  const stack = [doc]
  while (stack.length) {
    const node = stack.pop()
    for (const c of node.children || []) {
      if (!isEl(c)) continue
      has.tags.add(c.name)
      if (c.attribs?.id !== undefined) has.ids.add(c.attribs.id)
      for (const x of classSet(c)) has.classes.add(x)
      stack.push(c)
    }
  }
  return has
}
const possible = (compounds, has) =>
  compounds.every(c => (!c.tag || has.tags.has(c.tag)) && (!c.id || has.ids.has(c.id)) && c.classes.every(x => has.classes.has(x)))
class Stylesheet {
  constructor(texts, has) {
    this.byId = new Map()
    this.byClass = new Map()
    this.byTag = new Map()
    this.any = []
    const bySig = new Map()
    let order = 0
    for (const text of texts) {
      const css = stripComments(text, UNCLOSED)
      if (css === UNCLOSED) continue // a block with an unclosed /* comment is skipped
      for (const [prelude, body] of topLevelRules(css)) {
        const decls = declarations(body)
        const names = Object.keys(decls)
        if (!names.length) continue
        for (const sel of splitTop(prelude, ',')) {
          const p = parseSelector(sel.trim())
          if (!p || !possible(p.compounds, has)) continue
          const key = `${p.compounds.map(compoundKey).join(' ')}|${p.spec}`
          let rule = bySig.get(key)
          if (!rule) {
            const last = p.compounds[p.compounds.length - 1]
            rule = { compounds: p.compounds, spec: p.spec, decls: new Map(), failed: new Map(), upFailed: new Map(), dispHide: false, dispShow: false, visHide: false, visShow: false }
            bySig.set(key, rule)
            if (last.id) this.#add(this.byId, last.id, rule)
            else if (last.classes.length) this.#add(this.byClass, last.classes[0], rule)
            else if (last.tag) this.#add(this.byTag, last.tag, rule)
            else this.any.push(rule)
          }
          order++
          for (const name of names) {
            const d = decls[name]
            // merged rules keep whether they ever hid or showed (868 i)
            if (name === 'display') rule[DISPLAY_HIDES(d.value) ? 'dispHide' : 'dispShow'] = true
            if (name === 'visibility') rule[VISIBILITY_HIDES(d.value) ? 'visHide' : 'visShow'] = true
            const prev = rule.decls.get(name)
            // within one selector: an important declaration beats a normal one, else the later one wins
            if (!prev || d.important || !prev.important) rule.decls.set(name, { value: d.value, important: d.important, order })
          }
        }
      }
    }
  }
  #add(map, key, rule) {
    const list = map.get(key)
    if (list) list.push(rule)
    else map.set(key, [rule])
  }
}

// the tree is already the reader's (mirrorReader): no unwrapped or dropped tag is left, a <style> stays a sibling
const isEl = n => n && (n.type === 'tag' || n.type === 'script' || n.type === 'style')
const parentEl = el => (isEl(el.parent) ? el.parent : null)
function prevEl(el) {
  let p = el.prev
  while (p && !isEl(p)) p = p.prev
  return p
}
function nextEl(el) {
  let p = el.next
  while (p && !isEl(p)) p = p.next
  return p
}
// the class list is split once per element
function classSet(el) {
  if (el.classSet === undefined) el.classSet = new Set(String(el.attribs?.class || '').split(/\s+/).filter(Boolean))
  return el.classSet
}
function compoundMatches(el, c, budget) {
  budget.work += c.classes.length
  if (c.tag && c.tag !== el.name) return false
  if (c.id && c.id !== el.attribs?.id) return false
  if (c.classes.length) {
    const cls = classSet(el)
    for (const x of c.classes) if (!cls.has(x)) return false
  }
  for (const p of c.pseudos || []) {
    budget.work++
    if (p === 'first-child' && prevEl(el)) return false
    if (p === 'last-child' && nextEl(el)) return false
    if (p === 'only-child' && (prevEl(el) || nextEl(el))) return false
  }
  return true
}
// right to left, with backtracking over ancestors / earlier siblings. The result for (element, part) does not
// depend on where the match started, so the memos live on the rule and serve every element: a failed pair, and a
// chain searched upward in vain, are walked once per rule (a long descendant chain, "~" over 3000 siblings).
// Every step counts toward the work ceiling.
function matchFrom(el, rule, k, budget) {
  if (++budget.work > MAX_MATCH_WORK) throw new TooComplex()
  let seen = rule.failed.get(el)
  if (seen && seen.has(k)) return false
  const ok = matchStep(el, rule, k, budget)
  if (!ok) {
    if (!seen) rule.failed.set(el, (seen = new Set()))
    seen.add(k)
  }
  return ok
}
function matchStep(el, rule, k, budget) {
  const comps = rule.compounds
  if (!compoundMatches(el, comps[k], budget)) return false
  if (k === 0) return true
  const comb = comps[k].comb
  if (comb === '>') {
    const p = parentEl(el)
    return Boolean(p) && matchFrom(p, rule, k - 1, budget)
  }
  if (comb === '+') {
    const p = prevEl(el)
    return Boolean(p) && matchFrom(p, rule, k - 1, budget)
  }
  const step = comb === '~' ? prevEl : parentEl
  const key = `${comb}${k - 1}`
  const walked = []
  for (let p = step(el); p; p = step(p)) {
    budget.work++
    if (rule.upFailed.get(p)?.has(key)) break
    walked.push(p)
    if (matchFrom(p, rule, k - 1, budget)) return true
  }
  for (const p of walked) {
    let set = rule.upFailed.get(p)
    if (!set) rule.upFailed.set(p, (set = new Set()))
    set.add(key)
  }
  return false
}
const DISPLAY_HIDES = v => /^none\b/.test(v)
const VISIBILITY_HIDES = v => /^(hidden|collapse)\b/.test(v)
/**
 * The cascade for one element, as the browser's: an important declaration (inline important first) > inline > the
 * selector's specificity > source order; returns { prop: value }. The earlier doubtful-case
 * exceptions (i) "opposite display rules: the element stays" and (ii) "a <style> rule never beats an
 * inline display" are gone: they let 5 hidden cases through; the rules this cascade sees are the ones
 * the reader applies too (no @media, no attribute or non-structural pseudo selector, no media-attributed <style>).
 */
function computedStyle(el, sheet, budget) {
  const win = new Map()
  const take = (name, value, rank, spec, order) => {
    const w = win.get(name)
    if (!w || rank > w.rank || (rank === w.rank && (spec > w.spec || (spec === w.spec && order >= w.order)))) win.set(name, { value, rank, spec, order })
  }
  const id = el.attribs?.id
  const consider = list => {
    if (!list) return
    for (const r of list) {
      if (!matchFrom(el, r, r.compounds.length - 1, budget)) continue
      budget.work += r.decls.size
      for (const [name, d] of r.decls) take(name, d.value, d.important ? 2 : 0, r.spec, d.order)
    }
  }
  if (id) consider(sheet.byId.get(id))
  for (const c of classSet(el)) consider(sheet.byClass.get(c))
  consider(sheet.byTag.get(el.name))
  consider(sheet.any)
  const inline = declarations(el.attribs?.style)
  let k = 0
  for (const [name, d] of Object.entries(inline)) take(name, d.value, d.important ? 3 : 1, Infinity, k++)
  const out = {}
  let important = null
  for (const [name, w] of win) {
    out[name] = w.value
    if (w.rank === 2) (important ??= new Set()).add(name)
  }
  // the names a rule's !important decided (the paste writes those after the element's own style); not enumerable
  if (important) Object.defineProperty(out, RULE_IMPORTANT, { value: important })
  // each winner's place in the cascade (the paste writes them in that order: a shorthand and its longhands are two names
  // here, and in one style attribute the later one wins); not enumerable
  Object.defineProperty(out, CASCADE_PLACE, { value: win })
  // the background's shorthand and longhand are two names here: which one the cascade puts last (ownBackground)
  const bc = win.get('background-color')
  const b = win.get('background')
  if (bc && b && beats(b, bc)) Object.defineProperty(out, SHORTHAND_WINS, { value: true })
  // the margin's shorthand and a longhand side: which one the cascade puts last (marginSide)
  if (win.has('margin') && (win.has('margin-left') || win.has('margin-top'))) Object.defineProperty(out, MARGIN_WINNERS, { value: win })
  return out
}
// the cascade's order of two winners: rank (important, inline), then specificity, then the later one
const beats = (x, y) => x.rank > y.rank || (x.rank === y.rank && (x.spec > y.spec || (x.spec === y.spec && x.order >= y.order)))
const RULE_IMPORTANT = Symbol('rule important')
const SHORTHAND_WINS = Symbol('background shorthand wins')
const MARGIN_WINNERS = Symbol('margin winners')
const CASCADE_PLACE = Symbol('cascade place')

// --- lengths -----------------------------------------------------------------------------------------
const LENGTH = /^(-?(?:\d+\.?\d*|\.\d+))(px|pt|em|rem|%|ex|ch|cm|mm|in|pc|q|vw|vh|vmin|vmax)?$/
const length = v => {
  if (v === undefined || v.length > 40) return null
  const m = v.trim().match(LENGTH)
  return m ? { n: parseFloat(m[1]), unit: m[2] || '' } : null
}
// a length of any length for the hiding decisions (the far-off place, a zero size), read without a regex, in one pass:
// a sign, digits, an optional fraction, an optional exponent, a unit; the number through parseFloat (linear too). Zeros
// padded past LENGTH's guard ("-2000.000...0px", "-000...2000px") and an exponent ("-2e3px") read as the short form: as
// "unknown" they got through. The font size keeps LENGTH (its guard)
const LENGTH_UNITS = new Set(['', 'px', 'pt', 'em', 'rem', '%', 'ex', 'ch', 'cm', 'mm', 'in', 'pc', 'q', 'vw', 'vh', 'vmin', 'vmax'])
const isDigit = c => c >= '0' && c <= '9'
// the end of an exponent at `i` after a number's digits ("e3", "E-2", "e+5"; not the e of an em or ex unit), or `i`
function exponentEnd(t, i) {
  if (t[i] !== 'e' && t[i] !== 'E') return i
  let j = i + 1
  if (t[j] === '+' || t[j] === '-') j++
  if (!isDigit(t[j])) return i
  while (j < t.length && isDigit(t[j])) j++
  return j
}
function anyLength(v) {
  if (v === undefined) return null
  const t = v.trim()
  let i = t[0] === '-' ? 1 : 0
  const from = i
  while (i < t.length && isDigit(t[i])) i++
  let digits = i - from
  if (t[i] === '.') {
    i++
    const f = i
    while (i < t.length && isDigit(t[i])) i++
    digits += i - f
  }
  if (digits) i = exponentEnd(t, i)
  if (!digits || !LENGTH_UNITS.has(t.slice(i))) return null
  return { n: parseFloat(t.slice(0, i)), unit: t.slice(i) }
}
const FONT_KEYWORDS = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 }
const FONT_TAG_SIZES = [null, 10, 13, 16, 18, 24, 32, 48]
// a font-size value -> px, relative to the parent's px; null = unknown (keeps the parent's)
function fontPx(value, parent) {
  if (value === undefined) return null
  const v = value.trim()
  if (FONT_KEYWORDS[v] !== undefined) return FONT_KEYWORDS[v]
  if (v === 'smaller') return parent / 1.2
  if (v === 'larger') return parent * 1.2
  if (v === 'initial') return 16
  if (v === 'inherit' || v === 'unset' || v === 'revert') return parent
  // a calc() of lengths (em and % of the parent's size); a var(), an env() or a calc() we cannot work out stays unknown
  // (the parent's size): a newsletter may set its sizes by variables, and hiding those would hide real text (a KNOWN REST)
  if (/^calc\(/i.test(v)) return calcPx(v, parent, fontUnitPx)
  // read as the far-off place reads a length: any length, an exponent too ("1e-9px", "0.000...01px" were unknown and kept
  // the parent's readable size, while the browser draws them at nothing)
  const l = anyLength(v)
  return l ? fontUnitPx(l.n, l.unit, parent) : null
}
// a font-size number in its unit -> px: em, ex, ch and % of the parent's size, vw / vh / vmin / vmax of the 1000 x 1000 px
// view (as offsetPx), a bare number only as 0; null: no font size
function fontUnitPx(n, unit, parent) {
  switch (unit) {
    case 'em': return n * parent
    case 'ex': case 'ch': return n * parent * 0.5
    case '%': return (n / 100) * parent
    case '': return n === 0 ? 0 : null
    default: return unitPx(n, unit, parent)
  }
}
// the size in a "font" shorthand: the first token that is a size ("bold 0/0 a" -> "0"); a unitless number other
// than 0 is a weight, not a size
function fontShorthandSize(font) {
  if (font === undefined || font.length > MAX_VALUE) return undefined
  for (const token of font.split(/\s+/)) {
    const t = token.split('/')[0]
    if (FONT_KEYWORDS[t] !== undefined || t === 'smaller' || t === 'larger') return t
    const l = anyLength(t)
    if (l && (l.unit || l.n === 0)) return t
  }
  return undefined
}
const isZeroish = v => {
  const l = anyLength(v)
  return Boolean(l) && l.n <= 0
}
// the place a text is moved to, in px, for the far-off test: em = the element's own font (`font`), ex / ch half of it,
// rem = 16 px, vw / vh / vmin / vmax a 1000 x 1000 px view, % a 600 px box (a message's usual width; top / bottom the
// same, simplified), the absolute units as CSS defines them; a bare number as px (a quirks-mode page reads it so).
// null: unknown (calc(), var(), a keyword) decides nothing
const VIEW_PX = 1000
const BOX_PX = 600
function unitPx(n, unit, font) {
  switch (unit) {
    case '': case 'px': return n
    case 'pt': return (n * 4) / 3
    case 'pc': return n * 16
    case 'in': return n * 96
    case 'cm': return (n * 96) / 2.54
    case 'mm': return (n * 96) / 25.4
    case 'q': return (n * 96) / 101.6
    case 'em': return n * font
    case 'ex': case 'ch': return n * font * 0.5
    case 'rem': return n * 16
    case 'vw': case 'vh': case 'vmin': case 'vmax': return (n / 100) * VIEW_PX
    case '%': return (n / 100) * BOX_PX
    default: return null
  }
}
function offsetPx(v, font) {
  if (v !== undefined && /^\s*calc\(/i.test(v)) return calcPx(v, font)
  const l = anyLength(v)
  return l ? unitPx(l.n, l.unit, font) : null
}
// a calc() of lengths and numbers, read in one pass (recursive descent, parentheses and an inner calc() nested at most
// CALC_DEPTH deep): + and - between two lengths or two numbers, * by a plain number, / by a plain number other than 0; each
// length in px through `toPx` (offsetPx's units by default: em in the element's own font, % of the 600 px box; the font size
// passes its own, em and % of the parent's size). null: anything else (var(),
// env(), min() / max() / clamp(), a length times a length, a number as the result, a syntax error)
const CALC_DEPTH = 32
function calcPx(v, font, toPx = unitPx) {
  const t = v.trim()
  let i = 0
  const blank = () => {
    while (i < t.length && (t[i] === ' ' || t[i] === '\t' || t[i] === '\n' || t[i] === '\r')) i++
  }
  const isUnitChar = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '%'
  let sum
  const atom = depth => {
    blank()
    if (t.slice(i, i + 5).toLowerCase() === 'calc(') i += 4
    if (t[i] === '(') {
      if (depth >= CALC_DEPTH) return null
      i++
      const r = sum(depth + 1)
      blank()
      if (r === null || t[i] !== ')') return null
      i++
      return r
    }
    const from = i
    if (t[i] === '-' || t[i] === '+') i++
    let digits = 0
    while (i < t.length && isDigit(t[i])) {
      i++
      digits++
    }
    if (t[i] === '.') {
      i++
      while (i < t.length && isDigit(t[i])) {
        i++
        digits++
      }
    }
    if (!digits) return null
    i = exponentEnd(t, i)
    const end = i
    while (i < t.length && isUnitChar(t[i])) i++
    const unit = t.slice(end, i).toLowerCase()
    const n = parseFloat(t.slice(from, end))
    if (!unit) return { n }
    const px = LENGTH_UNITS.has(unit) ? toPx(n, unit, font) : null
    return px === null ? null : { px }
  }
  const product = depth => {
    let a = atom(depth)
    for (;;) {
      if (a === null) return null
      blank()
      const op = t[i]
      if (op !== '*' && op !== '/') return a
      i++
      const b = atom(depth)
      if (b === null) return null
      if (op === '*') {
        if (a.n !== undefined && b.n !== undefined) a = { n: a.n * b.n }
        else if (a.n !== undefined) a = { px: a.n * b.px }
        else if (b.n !== undefined) a = { px: a.px * b.n }
        else return null
      } else if (b.n === undefined || b.n === 0) return null
      else a = a.n !== undefined ? { n: a.n / b.n } : { px: a.px / b.n }
    }
  }
  sum = depth => {
    let a = product(depth)
    for (;;) {
      if (a === null) return null
      blank()
      const op = t[i]
      if (op !== '+' && op !== '-') return a
      i++
      const b = product(depth)
      if (b === null || (a.n === undefined) !== (b.n === undefined)) return null
      const sign = op === '+' ? 1 : -1
      a = a.n !== undefined ? { n: a.n + sign * b.n } : { px: a.px + sign * b.px }
    }
  }
  const r = atom(0)
  blank()
  return r !== null && i === t.length && r.px !== undefined && Number.isFinite(r.px) ? r.px : null
}
// a value that names a function we cannot read (var(), env(), a calc() we cannot evaluate, min() ...): unknown, not a
// keyword. Where a far move hides, unknown hides too (a variable or an unreadable calc() in a positioned element's place
// or in a translation); in a text-indent or a margin it decides nothing (newsletters use variables there: a KNOWN REST)
const opaque = (v, font) => v !== undefined && v.includes('(') && offsetPx(v, font) === null
const FAR_OFF_PX = -500
const farOff = (v, font) => {
  const px = offsetPx(v, font)
  return px !== null && px <= FAR_OFF_PX
}

// a margin side: of its longhand and the shorthand's value for it (1-4 values: top right bottom left), the one the cascade
// puts last (an important one first, then the more specific, then the later; "margin-left: 0; margin: 0 0 0 -2000px" is far off)
function marginSide(s, side) {
  const long = s[`margin-${side}`]
  let short
  if (s.margin !== undefined) {
    const t = s.margin.trim().split(/\s+/)
    short = side === 'top' ? t[0] : t.length >= 4 ? t[3] : t.length >= 2 ? t[1] : t[0]
  }
  if (long === undefined || short === undefined) return long ?? short
  const w = s[MARGIN_WINNERS]
  return w && beats(w.get('margin'), w.get(`margin-${side}`)) ? short : long
}

const negated = px => (px === null ? null : -px)
const READ_GUARD = 200
const UNREAD_HIDERS = ['transform', 'translate', 'rotate', 'scale', 'clip', 'clip-path']
const IDENTITY_3D = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, null, null, null, 1]
// a transform function that is no translation (it turns, mirrors, stretches or skews what the translations move)
const NOT_TRANSLATION = /\b(rotate|scale|skew|perspective)/i
// the x / y a transform's translate(), translateX(), translateY(), translate3d(), matrix() (e, f in px) and matrix3d() (the
// 13th and 14th in px) and the translate property move the box by, summed; an axis with an unknown length (calc(), var())
// is null (decides nothing). `other`: the transform (or a rotate / scale property) holds anything besides translations: a
// rotation, scale, skew, perspective or a matrix that is not a pure move. null: no move
// the top-level parts of a value, split where `isSep` holds outside parentheses (a calc() keeps its spaces and commas)
function topLevelSplit(v, isSep) {
  const out = []
  let depth = 0
  let from = 0
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && isSep(c)) {
      out.push(v.slice(from, i))
      from = i + 1
    }
  }
  out.push(v.slice(from))
  return out.map(x => x.trim()).filter(Boolean)
}
// a transform's functions, [name, arguments], their parentheses balanced (a calc() inside an argument stays in it), in
// one pass; an unbalanced value gives what closed before it
function transformFunctions(v) {
  const out = []
  let depth = 0
  let nameFrom = 0
  let argsFrom = 0
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '(') {
      if (depth === 0) argsFrom = i + 1
      depth++
    } else if (v[i] === ')' && depth > 0) {
      depth--
      if (depth === 0) {
        out.push([v.slice(nameFrom, argsFrom - 1).trim(), v.slice(argsFrom, i)])
        nameFrom = i + 1
      }
    }
  }
  return out
}
const isComma = c => c === ','
const isBlank = c => c === ' ' || c === '\t' || c === '\n' || c === '\r'
function translation(s, font) {
  let x = 0
  let y = 0
  let any = false
  let other = false
  let unknown = false
  const add = (axis, v) => {
    const px = v === undefined ? 0 : offsetPx(v.trim(), font)
    if (px === null && opaque(v, font)) unknown = true
    if (axis === 'x') x = x === null || px === null ? null : x + px
    else y = y === null || px === null ? null : y + px
    any = true
  }
  if (s.transform && s.transform.length < READ_GUARD) {
    if (NOT_TRANSLATION.test(s.transform)) other = true
    for (const [fn, body] of transformFunctions(s.transform)) {
      const args = topLevelSplit(body, isComma)
      const name = fn.toLowerCase()
      if (name === 'translate' || name === 'translate3d') {
        add('x', args[0])
        add('y', args[1])
      } else if (name === 'translatex') add('x', args[0])
      else if (name === 'translatey') add('y', args[0])
      else if (name === 'matrix' && args.length === 6) {
        add('x', `${args[4].trim()}px`)
        add('y', `${args[5].trim()}px`)
        if ([1, 0, 0, 1].some((v, i) => parseFloat(args[i]) !== v)) other = true
      } else if (name === 'matrix3d' && args.length === 16) {
        add('x', `${args[12].trim()}px`)
        add('y', `${args[13].trim()}px`)
        if (IDENTITY_3D.some((v, i) => v !== null && parseFloat(args[i]) !== v)) other = true
      }
    }
  }
  if (s.translate && s.translate.length < READ_GUARD && s.translate.trim() !== 'none') {
    const [tx, ty] = topLevelSplit(s.translate, isBlank)
    add('x', tx)
    add('y', ty)
  }
  for (const k of ['rotate', 'scale']) if (s[k] !== undefined && s[k].trim() !== 'none') other = true
  return any || other ? { x, y, other, unknown } : null
}
// the signed x / y the element moves itself (and its subtree) by: a relative position's offsets (left over right, top over
// bottom as they are, a right or bottom the other way; a left / top that is no length here, auto, initial, inherit, unset or
// an unknown calc, leaves it to the right / bottom, erring on hiding) plus the transform's translations; an unknown axis
// adds 0. Sticky is a scroll threshold, not a move. The margin is NOT here: it depends on the layout and is not added up
function moveOf(s, font) {
  let x = 0
  let y = 0
  let unknown = false
  // one axis of a relative place: the first side's length, else (a keyword) the other side's turned; an opaque side
  // (var(), an unreadable calc()) is unknown
  const pick = (first, second) => {
    const a = offsetPx(first, font)
    if (a !== null) return a
    if (opaque(first, font)) unknown = true
    const b = offsetPx(second, font)
    if (b !== null) return -b
    if (opaque(second, font)) unknown = true
    return 0
  }
  if (/^relative\b/.test(s.position || '')) {
    x += pick(s.left, s.right)
    y += pick(s.top, s.bottom)
  }
  const t = translation(s, font)
  if (t) {
    x += t.x ?? 0
    y += t.y ?? 0
    if (t.unknown) unknown = true
  }
  return { x, y, other: Boolean(t?.other), unknown }
}
// far off by a move (its own plus its ancestors'): up or left past FAR_OFF_PX; with a turn, mirror, scale or skew on the way
// a far move in any direction (the translation's real direction is not followed: erring on hiding)
const movedFar = m => m.x <= FAR_OFF_PX || m.y <= FAR_OFF_PX || (m.other && (Math.abs(m.x) >= -FAR_OFF_PX || Math.abs(m.y) >= -FAR_OFF_PX))

// hidden with its whole subtree, whatever the children say (properties that are not inherited); `font`: the element's own px;
// `move`: its own move plus its ancestors' (moveOf, summed by the walk)
function hiddenSubtree(el, s, font, move) {
  if (s.display !== undefined ? /^none\b/.test(s.display) : el.attribs && 'hidden' in el.attribs) return true
  // a value of these past the read guard is not read (a regex on it could be slow); unread, it hides: padded past the guard,
  // a far move or a scale(0) would get through
  if (UNREAD_HIDERS.some(k => s[k] !== undefined && s[k].length >= READ_GUARD && s[k].trim() !== 'none')) return true
  if (/^(absolute|fixed)$/.test(s.position || '') && ['left', 'top', 'right', 'bottom'].some(k => farOff(s[k], font) || opaque(s[k], font))) return true
  // a negative left or top margin far off moves the box and its text out of reach (MEASURED in the reader's frame: the frame
  // does not scroll left of or above its start); a right or bottom one does not move the box itself
  if (farOff(marginSide(s, 'left'), font) || farOff(marginSide(s, 'top'), font)) return true
  // an unknown move of its own (var(), an unreadable calc() in its place or translation) hides
  if (move && (move.unknown || movedFar(move))) return true
  // KNOWN LIMIT (accepted): the filter computes no layout, so a far move counts from the page's start: text that a long
  // content before it or an ancestor's padding brings back into reach is still hidden here. A security filter errs on hiding.
  // Nested margins are not added up (they depend on the layout).
  if (/^hidden\b/.test(s.overflow || '') && ['height', 'max-height', 'width', 'max-width'].some(k => s[k] !== undefined && isZeroish(s[k]))) return true
  if (s.clip && s.clip.length < READ_GUARD && /^rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(s.clip)) return true
  const cp = s['clip-path']
  if (cp && cp.length < READ_GUARD && (/^inset\(\s*(5\d|[6-9]\d|100)%/.test(cp) || /^circle\(\s*0/.test(cp))) return true
  if (s.transform && s.transform.length < READ_GUARD && /scale[xy]?\(\s*0(\.0+)?\s*(,\s*[\d.]+\s*)?\)/.test(s.transform)) return true
  return false
}
// parseFloat reads a value of any length in one pass: no length guard (one let "opacity: 0.000...0" through)
const opacityOf = v => {
  if (v === undefined) return 1
  const o = v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v)
  return Number.isNaN(o) ? 1 : Math.max(0, Math.min(1, o))
}

// --- backgrounds -------------------------------------------------------------------------------------
// the top-level tokens of a value: "url(x) #fff no-repeat" -> ["url(x)", "#fff", "no-repeat"]; commas split too
function valueTokens(v) {
  const out = []
  let depth = 0
  let start = -1
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    const sep = depth === 0 && (isWs(c) || c === ',')
    if (sep) {
      if (start >= 0) out.push(v.slice(start, i))
      start = -1
      continue
    }
    if (start < 0) start = i
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
  }
  if (start >= 0) out.push(v.slice(start))
  return out
}
// the element's own background: a colour, transparent (inherit), UNKNOWN (an image, var(), a name we do not know)
function ownBackground(el, s) {
  const attrBg = el.attribs?.bgcolor
  if (el.attribs?.background) return UNKNOWN
  const decl = (s[SHORTHAND_WINS] ? s.background : undefined) ?? s['background-color'] ?? s.background ?? s['background-image']
  if (decl === undefined) return attrBg ? normalizeColor(attrBg) || UNKNOWN : null
  if (decl.length > MAX_VALUE) return UNKNOWN
  if (/^(none|initial|inherit|transparent)$/.test(decl)) return decl === 'transparent' ? 'transparent' : null
  const tokens = valueTokens(decl)
  const grad = tokens.find(t => /^[a-z-]*gradient\(/.test(t))
  if (grad) {
    const inner = grad.slice(grad.indexOf('(') + 1, grad.endsWith(')') ? -1 : undefined)
    const colors = valueTokens(inner).map(normalizeColor).filter(Boolean)
    return colors.length && colors.every(c => c === colors[0]) ? colors[0] : UNKNOWN
  }
  for (const token of tokens) {
    if (token.startsWith('url(')) continue
    const c = normalizeColor(token)
    if (c) return c
  }
  return decl.includes('var(') || decl.includes('url(') || /^[a-z]+$/.test(decl) ? UNKNOWN : null
}

// --- the walk ----------------------------------------------------------------------------------------
class TooComplex extends Error {}
// The reader's tree: what DOMPurify removes with its content is gone (but a <style> stays: the
// reader keeps it, and a sibling selector counts it), what it unwraps is replaced by its children, comments go,
// and a table's direct rows get their implicit <tbody>, as the HTML parser makes it. One pass, children arrays
// rebuilt (no O(siblings) removal per node).
function makeTbody() {
  const h = new DomHandler()
  new Parser(h).end('<tbody></tbody>')
  return h.root.children[0]
}
function relink(parent, kids) {
  parent.children = kids
  for (let i = 0; i < kids.length; i++) {
    kids[i].parent = parent
    kids[i].prev = kids[i - 1] || null
    kids[i].next = kids[i + 1] || null
  }
}
function mirrorReader(doc) {
  const stack = [doc]
  while (stack.length) {
    const node = stack.pop()
    if (!node.children || !node.children.length) continue
    const out = []
    const work = node.children.slice().reverse()
    while (work.length) {
      const c = work.pop()
      if (c.type === 'comment' || c.type === 'directive' || c.type === 'cdata') continue
      if (isEl(c) && c.name !== 'style' && DROP_TAGS.has(c.name)) continue
      if (isEl(c) && UNWRAP_TAGS.has(c.name)) {
        const k = c.children || []
        for (let i = k.length - 1; i >= 0; i--) work.push(k[i])
        continue
      }
      out.push(c)
    }
    if (node.name === 'table') {
      let first = -1
      let last = -1
      for (let i = 0; i < out.length; i++) {
        if (out[i].name === 'tr') {
          if (first < 0) first = i
          last = i
        }
      }
      if (first >= 0) {
        const tbody = makeTbody()
        // made here (the parser's implied tbody): browserTables keeps it open after its rows, as the browser does
        tbody.implied = true
        tbody.children = out.slice(first, last + 1)
        out.splice(first, last - first + 1, tbody)
      }
    }
    relink(node, out)
    for (const c of out) if (isEl(c)) stack.push(c)
  }
}
// The browser's table rules for the rich mirror (HTML5 "in table" / "in table body" / "in row" / "in column group"),
// on the reader's tree: htmlparser2 keeps a table as it was written, a browser does not. So the recipient sees the same
// structure (and the Modal the same text) as the mirror writes: what may not stand in a table, a section or a row (text,
// a div, a link...) goes BEFORE the table (foster parenting), a row or a cell without its section or row gets one, a col
// its colgroup, a table part written inside a cell, a caption or a colgroup closes it and is read at the table's level,
// and a table part outside a table goes (its content stays; a col has none). Before this a text written right into a
// table went out (and showed) but was in neither the Modal's text nor the text part.
const TABLE_PARTS = new Set(['caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th'])
const SECTION = new Set(['thead', 'tbody', 'tfoot'])
let ElementNode = null
const newEl = name => {
  ElementNode ??= makeTbody().constructor
  return new ElementNode(name, {}, [])
}
const blank = n => n.type === 'text' && /^[ \t\n\f\r]*$/.test(n.data)
const isPart = n => isEl(n) && TABLE_PARTS.has(n.name)
// an element's children up to its first table part stay; the rest is handed back (read at the table's level)
function splitAtPart(el) {
  const kids = el.children || []
  const i = kids.findIndex(isPart)
  if (i < 0) return []
  relink(el, kids.slice(0, i))
  return kids.slice(i)
}
// one table: its children rebuilt; returns [fostered (before the table), after (a table started right in it, and all
// written after that: the browser closes this table there, so they stand after it)]
function fixTable(table) {
  const fostered = []
  const after = []
  const kids = []
  let group = null
  let section = null
  let row = null
  const put = (parent, n) => {
    if (parent === kids) kids.push(n)
    else parent.children.push(n)
  }
  const cellIn = cell => {
    if (!section) {
      section = newEl('tbody')
      kids.push(section)
    }
    if (!row) {
      row = newEl('tr')
      section.children.push(row)
    }
    row.children.push(cell)
  }
  // a stack (the next node last), and END marks where an explicit section or row was closed in the source
  const stack = [...(table.children || [])].reverse()
  const later = nodes => {
    for (let i = nodes.length - 1; i >= 0; i--) stack.push(nodes[i])
  }
  while (stack.length) {
    const n = stack.pop()
    if (n.end) {
      if (n.end === section) section = row = null
      else if (n.end === row) row = null
      continue
    }
    if (n.type === 'text') {
      if (blank(n)) put(row ? row : section ? section : group ? group : kids, n)
      else fostered.push(n)
      continue
    }
    if (!isEl(n)) continue
    const name = n.name
    if (name === 'caption') {
      group = section = row = null
      kids.push(n)
      later(splitAtPart(n))
    } else if (name === 'colgroup') {
      section = row = null
      kids.push(n)
      group = n
      // a colgroup holds cols only: a table part ends it (read at the table's level), anything else is fostered
      const inner = n.children || []
      const cols = []
      let rest = []
      for (let i = 0; i < inner.length; i++) {
        const c = inner[i]
        if (isEl(c) && c.name === 'col') cols.push(c)
        else if (blank(c)) cols.push(c)
        else if (isPart(c) || (isEl(c) && c.name === 'table')) {
          rest = inner.slice(i)
          break
        } else fostered.push(c)
      }
      n.children = cols
      // an explicit colgroup is closed after its own cols
      group = null
      later(rest)
    } else if (name === 'col') {
      section = row = null
      if (!group) {
        group = newEl('colgroup')
        kids.push(group)
      }
      group.children.push(n)
    } else if (SECTION.has(name)) {
      group = row = null
      kids.push(n)
      section = n
      const inner = n.children || []
      n.children = []
      // an implied tbody (mirrorReader's) has no end tag in the source: it stays open after its rows
      later(n.implied ? inner : [...inner, { end: n }])
    } else if (name === 'tr') {
      group = null
      if (!section) {
        section = newEl('tbody')
        kids.push(section)
      }
      section.children.push(n)
      row = n
      const inner = n.children || []
      n.children = []
      later([...inner, { end: n }])
    } else if (name === 'td' || name === 'th') {
      group = null
      cellIn(n)
      later(splitAtPart(n))
    } else if (name === 'table') {
      // a table start tag closes this table: it and everything written after it stand after this table
      after.push(n)
      while (stack.length) {
        const rest = stack.pop()
        if (!rest.end) after.push(rest)
      }
    } else if (name === 'style') put(kids, n)
    else fostered.push(n)
  }
  relink(table, kids)
  for (const k of kids) if (isEl(k) && k.children) relinkDeep(k)
  return [fostered, after]
}
// the children arrays above were filled directly: their parent / sibling links set again (sections, rows, colgroups)
function relinkDeep(el) {
  relink(el, el.children)
  for (const c of el.children) if (isEl(c) && (SECTION.has(c.name) || c.name === 'tr' || c.name === 'colgroup')) relinkDeep(c)
}
function browserTables(doc) {
  const stack = [doc]
  while (stack.length) {
    const node = stack.pop()
    if (!node.children || !node.children.length) continue
    let changed = false
    const out = []
    for (const c of node.children) {
      if (isEl(c) && c.name === 'table') {
        // what a table may not hold stands before it; a table started right in it closes it: it (and what follows)
        // stands after it, fixed the same way
        const emit = t => {
          const [fostered, after] = fixTable(t)
          if (fostered.length || after.length) changed = true
          // (a fostered node is never a table: fixTable puts a table after; a table inside one is reached below)
          out.push(...fostered)
          out.push(t)
          for (const a of after) {
            if (isEl(a) && a.name === 'table') emit(a)
            else out.push(a)
          }
        }
        emit(c)
      } else out.push(c)
    }
    if (changed) relink(node, out)
    for (const c of out) if (isEl(c)) stack.push(c)
  }
  // a table part not in its own place (a cell outside a row, a row outside a section...) goes, its content stays
  const parentOk = { td: 'tr', th: 'tr', tr: SECTION, thead: 'table', tbody: 'table', tfoot: 'table', caption: 'table', colgroup: 'table', col: 'colgroup' }
  const fits = c => {
    const want = parentOk[c.name]
    const p = c.parent && isEl(c.parent) ? c.parent.name : ''
    return want instanceof Set ? want.has(p) : want === p
  }
  const walk = [doc]
  while (walk.length) {
    const node = walk.pop()
    if (!node.children || !node.children.length) continue
    let changed = false
    const out = []
    for (const c of node.children) {
      if (isPart(c) && !fits(c)) {
        changed = true
        if (c.name !== 'col') out.push(...(c.children || []))
      } else out.push(c)
    }
    if (changed) {
      relink(node, out)
      walk.push(node)
      continue
    }
    for (const c of out) if (isEl(c)) walk.push(c)
  }
}

/**
 * The time net's clocks, in ms. cpu: this thread's own CPU time (process.threadCpuUsage: Node 22 and Electron's
 * Node 24 have it, in a worker too), so a loaded machine, where the work only waits for the CPU, does not cut a message
 * that is not complex (0.12.0-0.15.0: a wall clock, and a 404 KB newsletter of 0.8 s took 3 s under load and lost its
 * search text). null where the runtime has none: then the net is the wall clock, as before.
 */
export function threadCpuMs() {
  try {
    const u = process.threadCpuUsage()
    return (u.user + u.system) / 1000
  } catch {
    return null
  }
}
export const WORK_CLOCKS = Object.freeze({ cpu: threadCpuMs, wall: () => performance.now() })

/** A started net: over() is true past `limit` ms (TIME_LIMIT_MS) of CPU time (wall time without a CPU clock) or WALL_LIMIT_MS of wall time. */
function startNet(clocks, limit = TIME_LIMIT_MS) {
  const wall0 = clocks.wall()
  const cpu0 = clocks.cpu()
  if (cpu0 === null) return { over: () => clocks.wall() - wall0 > limit }
  return {
    over() {
      const wall = clocks.wall() - wall0
      if (wall > WALL_LIMIT_MS) return true
      const cpu = clocks.cpu()
      return cpu === null ? wall > limit : cpu - cpu0 > limit
    },
  }
}

// pass 1: every element's style on the whole reader's tree (a sibling or ancestor selector sees the elements that
// pass 2 hides: the browser matches on the whole document). A CPU-time net under the work ceiling (startNet).
function styleAll(doc, sheet, clocks, limit) {
  const budget = { work: 0 }
  const net = startNet(clocks, limit)
  let n = 0
  const styles = new Map()
  const stack = [doc]
  while (stack.length) {
    const node = stack.pop()
    const kids = node.children || []
    for (let i = kids.length - 1; i >= 0; i--) {
      const child = kids[i]
      if (!isEl(child) || child.name === 'style') continue
      styles.set(child, computedStyle(child, sheet, budget))
      if (budget.work > MAX_MATCH_WORK || ((++n & 255) === 0 && net.over())) throw new TooComplex()
      stack.push(child)
    }
  }
  return styles
}
// pass 2: the hidden nodes are marked, not removed (removal is O(siblings) each). `paste` (core/mime/paste-prepare.js):
// a text (nearly) the colour of its background is NOT hidden (the paste decides about it: its colour goes, the text
// stays; a pasted piece may have lost its background) unless `paste.sameColor` (a quote: the whole message is there, as
// for read_message), and every text that stays is handed to paste.onText(textNode, { color, bg }) with what SURVIVES the composer's
// rich sanitizer (keptColors): `color` and `bg` are chains ({ el, color | bg, up }, null = the default black / the white
// page), the nearest source first, so the paste can take a colour off and see what the text inherits then
// the text colour and the background the rich sanitizer keeps on an element (rich-style.js cleanStyle / cleanAttr): a style
// declaration first, else the font's color / the table part's bgcolor; colours as given (alpha kept); colorSaid: the
// element says a colour, kept or not
function keptColors(el) {
  // a page's body / html: its inherited colour goes onto the wrapping div (paste-prepare.js), its background does not
  if (PAGE_TAGS.has(el.name)) {
    const c = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(cleanStyle(el.attribs?.style ?? '', 'div'))
    if (c) return { color: c[1].trim(), colorSaid: true }
    const attr = bodyTextColor(el)
    return attr ? { color: attr, colorSaid: true } : {}
  }
  if (!RICH_TAGS.has(el.name)) return {}
  const decl = {}
  for (const d of cleanStyle(el.attribs?.style ?? '', el.name).split(';')) {
    const i = d.indexOf(':')
    if (i > 0) decl[d.slice(0, i).trim()] = d.slice(i + 1).trim()
  }
  const said = el.attribs?.style !== undefined && /(^|;)\s*color\s*:/i.test(el.attribs.style)
  let color = decl.color
  if (color === undefined && el.name === 'font' && el.attribs?.color !== undefined) color = cleanAttr('font', 'color', el.attribs.color) ?? undefined
  let bg = decl['background-color']
  if (bg === undefined && BGCOLOR_TAGS.has(el.name) && el.attribs?.bgcolor !== undefined) bg = cleanAttr(el.name, 'bgcolor', el.attribs.bgcolor) ?? undefined
  if (bg !== undefined && colorAlpha(bg) === 0) bg = undefined
  return { color, bg, colorSaid: said || (el.name === 'font' && el.attribs?.color !== undefined) }
}
const PAGE_TAGS = new Set(['body', 'html'])
// the cascade's declarations (`s`, computedStyle: rules and inline merged) that the element's own style does not say, or says
// otherwise (a rule's !important over it), for the properties the rich mode keeps; '' when none
// -> { first, last }: written BEFORE the element's own style (so its own longhand still beats a rule's shorthand: an own
// background-color over a rule's background), a rule's !important AFTER it (it wins over the own one)
function sheetOnly(s, el) {
  const own = inlineDecls(el)
  const important = s[RULE_IMPORTANT]
  const first = []
  const last = []
  // the weaker first: a type rule's shorthand (Excel's td { border: none }) before a class rule's longhands (its
  // .xl70 { border-right: ... }), as the browser's cascade has them; a tie keeps the cascade's own order (sort is stable)
  const place = s[CASCADE_PLACE]
  const entries = Object.entries(s)
  if (place) entries.sort(([a], [b]) => (beats(place.get(a), place.get(b)) ? 1 : 0) - (beats(place.get(b), place.get(a)) ? 1 : 0))
  for (const [name, value] of entries) {
    if (!(RICH_PROPERTY_SET.has(name) || name === 'background')) continue
    if (own[name] !== undefined && own[name] === value) continue
    ;(important && important.has(name) ? last : first).push(`${name}: ${value}`)
  }
  return { first: first.join('; '), last: last.join('; ') }
}
const inlineDecls = el => {
  const out = {}
  for (const [name, d] of Object.entries(declarations(el.attribs?.style))) out[name] = d.value
  return out
}
function prune(doc, sheet, clocks, paste = null, limit = TIME_LIMIT_MS) {
  const styles = styleAll(doc, sheet, clocks, limit)
  // no rule at all (a browser's copy writes its styles inline): nothing to write onto the elements, no second style parse
  const ruled = sheet.byId.size > 0 || sheet.byClass.size > 0 || sheet.byTag.size > 0 || sheet.any.length > 0
  const hidden = new Set()
  const root = { bg: '#ffffff', color: '#000000', font: 16, visible: true, indentOff: false, opacity: 1, pColor: null, pBg: null, moveX: 0, moveY: 0, moveOther: false }
  const stack = [[doc, root]]
  while (stack.length) {
    const [node, ctx] = stack.pop()
    for (const child of node.children || []) {
      if (child.type === 'text') {
        const c = ctx.color
        if (!ctx.visible || ctx.indentOff || ctx.font < MIN_FONT_PX || c === 'transparent' || ((!paste || paste.sameColor) && c !== UNKNOWN && ctx.bg !== UNKNOWN && c && ctx.bg && sameColor(c, ctx.bg))) hidden.add(child)
        else if (paste) paste.onText(child, { color: ctx.pColor, bg: ctx.pBg })
        continue
      }
      if (!isEl(child)) continue
      if (child.name === 'style' || DROP_TAGS.has(child.name)) {
        hidden.add(child)
        continue
      }
      const s = styles.get(child) || {}
      const opacity = ctx.opacity * opacityOf(s.opacity)
      // the element's own font first: an em offset below is in it
      let font = ctx.font
      if (child.name === 'font' && child.attribs?.size !== undefined) {
        const raw = child.attribs.size.trim()
        const n = parseInt(raw, 10)
        if (!Number.isNaN(n)) font = FONT_TAG_SIZES[Math.max(1, Math.min(7, /^[+-]/.test(raw) ? 3 + n : n))]
      }
      if (s['font-size'] !== undefined) {
        const px = fontPx(s['font-size'], ctx.font)
        // a negative size is invalid (ignored, as in the browser); one we cannot compute (calc, clamp, var, vw, max)
        // is a doubtful case and keeps the text readable
        if (px === null || !Number.isFinite(px)) font = Math.max(ctx.font, 16)
        else if (px >= 0) font = px
      }
      // the moves add up down the tree: a child's own move counts from where its ancestors moved it
      const mine = moveOf(s, font)
      const move = { x: ctx.moveX + mine.x, y: ctx.moveY + mine.y, other: ctx.moveOther || mine.other, unknown: mine.unknown }
      if (hiddenSubtree(child, s, font, move) || opacity < MIN_OPACITY) {
        hidden.add(child)
        continue
      }
      if (child.name === 'details' && !(child.attribs && 'open' in child.attribs)) {
        for (const d of child.children || []) if (d.name !== 'summary') hidden.add(d)
      }
      const own = ownBackground(child, s)
      const bg = own && own !== 'transparent' ? own : ctx.bg
      let color = ctx.color
      const declared = s.color ?? (child.name === 'font' ? child.attribs?.color?.toLowerCase() : (bodyTextColor(child) ?? undefined))
      if (declared !== undefined && !/^(inherit|initial|currentcolor)$/.test(declared)) color = normalizeColor(declared) || UNKNOWN
      // a link has the browser's own colour (a:link is not inherited from a white parent)
      else if (child.name === 'a' && child.attribs?.href !== undefined) color = '#0000ee'
      let { pColor, pBg } = ctx
      if (paste) {
        // what the composer's rich sanitizer keeps on this element (rich-style.js), nothing else: a <style> rule, a body's
        // or an unwrapped tag's colour, a gradient or an image background never reach the editor
        // the <style> rules (the cascade, `s`) written onto the element where they add to its own style; body / html too
        // (paste-prepare.js makes the body a wrapping div with their inherited declarations)
        if (ruled && (RICH_TAGS.has(child.name) || PAGE_TAGS.has(child.name))) {
          const extra = sheetOnly(s, child)
          if (extra.first || extra.last) child.attribs = { ...child.attribs, style: [extra.first, (child.attribs?.style || '').replace(/[\s;]*$/, ''), extra.last].filter(Boolean).join('; ') }
        }
        const kept = keptColors(child)
        if (kept.color) pColor = { el: child, color: kept.color, up: pColor }
        // a link has the browser's own colour, which no declaration of ours takes off (el null)
        else if (child.name === 'a' && child.attribs?.href !== undefined && !kept.colorSaid) pColor = { el: null, color: '#0000ee', up: pColor }
        if (kept.bg) pBg = { el: child, bg: kept.bg, up: pBg }
      }
      let visible = ctx.visible
      if (s.visibility !== undefined) {
        if (/^(hidden|collapse)\b/.test(s.visibility)) visible = false
        else if (/^visible\b/.test(s.visibility)) visible = true
      }
      const indentOff = s['text-indent'] !== undefined ? farOff(s['text-indent'], font) : ctx.indentOff
      stack.push([child, { bg, color, font, visible, indentOff, opacity, pColor, pBg, moveX: move.x, moveY: move.y, moveOther: move.other }])
    }
  }
  return hidden
}

// [ \t ] off both ends of a line, by hand (a regex here is quadratic on a long run of spaces)
const isPad = c => c === ' ' || c === '\t' || c === '\u00a0'
function trimLine(l) {
  let a = 0
  let b = l.length
  while (a < b && isPad(l[a])) a++
  while (b > a && isPad(l[b - 1])) b--
  return l.slice(a, b)
}
// iterative text output: blocks on their own lines, <br> a break, cells and list items marked
function textOf(doc, hidden) {
  const out = []
  const stack = [{ node: doc, phase: 0 }]
  while (stack.length) {
    const item = stack.pop()
    const n = item.node
    if (hidden.has(n)) continue
    if (n.type === 'text') {
      out.push(item.pre ? n.data : n.data.replace(/\s+/g, ' '))
      continue
    }
    if (item.phase === 1) {
      if (BLOCK.has(n.name)) out.push('\n')
      if (n.name === 'td' || n.name === 'th') out.push(' ')
      continue
    }
    if (n.name === 'br') {
      out.push('\n')
      continue
    }
    if (BLOCK.has(n.name)) out.push('\n')
    if (n.name === 'li') out.push('\n- ')
    stack.push({ node: n, phase: 1 })
    const pre = item.pre || n.name === 'pre'
    const kids = n.children || []
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], phase: 0, pre })
  }
  return out.join('').split('\n').map(trimLine).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The visible text of an HTML body (default background white, text black, 16px, as the reader shows it).
 * cut: null, 'tags' (only the first MAX_TAGS tags, or the part up to MAX_DEPTH nesting, are there) or 'complex' (over the work ceiling: no text).
 * tables: the browser's table rules on the tree first (browserTables: the rich mirror; the reader's text keeps the written order).
 * limitMs: the time net (TIME_LIMIT_MS; the composer's paste has a shorter one, paste-prepare.js PASTE_TIME_LIMIT_MS).
 */
export function visibleTextInfo(html, output = textOf, { clocks = WORK_CLOCKS, tables = false, paste = null, limitMs = TIME_LIMIT_MS } = {}) {
  const source = String(html || '')
  // the MAX_TAGS+1st "<" starts the cut (a body of exactly MAX_TAGS tags is whole)
  let at = -1
  for (let i = 0; i <= MAX_TAGS; i++) {
    at = source.indexOf('<', at + 1)
    if (at < 0) break
  }
  let end = at > 0 ? at : source.length
  // written in small pieces: past MAX_DEPTH open elements the rest is cut (Chromium itself flattens past 512)
  const handler = new DomHandler()
  const parser = new Parser(handler, { decodeEntities: true })
  for (let i = 0; i < end; i += PARSE_CHUNK) {
    const stop = Math.min(end, i + PARSE_CHUNK)
    parser.write(source.slice(i, stop))
    if (parser.stack.length > MAX_DEPTH) {
      end = stop
      break
    }
  }
  // a cut never leaves a <style> half read (an unclosed comment, a lost rule would show what it hides); a
  // style that does not close soon gives no text at all
  let unsafe = false
  if (end < source.length) {
    const finished = finishStyle(parser, source, end)
    if (finished < 0) unsafe = true
    else end = finished
  }
  parser.end()
  if (unsafe) return { text: '', cut: 'complex' }
  const doc = handler.root
  const cut = end < source.length
  try {
    mirrorReader(doc)
    if (tables) browserTables(doc)
    const hidden = prune(doc, new Stylesheet(styleTexts(doc), presentNames(doc)), clocks, paste, limitMs)
    return { text: output(doc, hidden), cut: cut ? 'tags' : null }
  } catch (e) {
    if (e instanceof TooComplex) return { text: '', cut: 'complex' }
    throw e
  }
}
/**
 * At a cut: is the parser inside a <style> element right now (its innermost open element; decided
 * from the parser's state, not by searching the text, which a "<!--<style-->" or a <stylex> fools)? Then the rest
 * of that style is written, closing tag by closing tag, until the parser has left it, within STYLE_EXTEND
 * characters (raw text: no tags, no depth). Returns the new end, or -1 when it does not close within the window.
 */
function finishStyle(parser, source, pos) {
  if (parser.stack[0] !== 'style') return pos
  const from = Math.max(0, pos - 8) // "</sty" may sit just before the cut
  const limit = Math.min(source.length, pos + STYLE_EXTEND)
  const window = source.slice(from, limit).toLowerCase()
  let written = pos
  let at = 0
  while (parser.stack[0] === 'style') {
    const close = window.indexOf('</style', at)
    if (close < 0) return -1
    const gt = window.indexOf('>', close)
    if (gt < 0) return -1
    const end = from + gt + 1
    if (end > written) {
      parser.write(source.slice(written, end))
      written = end
    }
    at = gt + 1
  }
  return written
}
export const visibleText = html => visibleTextInfo(html).text

// --- the composer's quote ------------------------------------------------------------------------------------
// The quote of a reply draft Claude makes: the VISIBLE part of the original (hidden text out, as above), as the
// composer's own HTML: only the tags of sanitize.js's sanitizeCompose allow-list, attribute only <a href> with
// http(s)/mailto, every other tag unwrapped (its content stays), text and href escaped. No DOM needed.
const COMPOSE_TAGS = new Set(['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3'])
const escText = s => s.replace(/[&<>\u00a0]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\u00a0': '&nbsp;' })[c])
const escAttr = s => s.replace(/[&"\u00a0]/g, c => ({ '&': '&amp;', '"': '&quot;', '\u00a0': '&nbsp;' })[c])
// a table's own lines, in tree order: its caption, the rows directly in it or in its thead / tbody / tfoot (a nested
// table's rows are its own); a line is its cells (td / th), each { th, kids }. Hidden rows and cells are left out.
// What stands in the table in no cell and no caption (ASCII whitespace, comments and columns aside; this parser keeps
// text written right in a table or a row there) is kept where it stands: a part of its row, or a line of its own, the
// same rule as sanitize.js's tableToLines
const ASCII_BLANK = /^[ \t\n\f\r]*$/
const strayIn = (n, hidden) => (isEl(n) ? !hidden.has(n) && n.name !== 'col' && n.name !== 'colgroup' : n.type === 'text' && !ASCII_BLANK.test(n.data))
function tableLines(table, hidden) {
  const lines = []
  const rowOf = tr =>
    (tr.children || []).flatMap(c => (isEl(c) && (c.name === 'td' || c.name === 'th') ? (hidden.has(c) ? [] : [{ th: c.name === 'th', kids: c.children || [] }]) : strayIn(c, hidden) ? [{ th: false, kids: [c] }] : []))
  for (const c of table.children || []) {
    if (isEl(c) && hidden.has(c)) continue
    if (isEl(c) && c.name === 'caption') lines.push([{ th: false, kids: c.children || [] }])
    else if (isEl(c) && c.name === 'tr') lines.push(rowOf(c))
    else if (isEl(c) && (c.name === 'thead' || c.name === 'tbody' || c.name === 'tfoot')) {
      for (const r of c.children || []) {
        if (isEl(r) && r.name === 'tr') {
          if (!hidden.has(r)) lines.push(rowOf(r))
        } else if (strayIn(r, hidden)) lines.push([{ th: false, kids: [r] }])
      }
    } else if (strayIn(c, hidden)) lines.push([{ th: false, kids: [c] }])
  }
  return lines
}
// with `rich` the formatting stays, by sanitizeCompose's `rich` rule (core/smtp/rich-style.js): the tags of RICH_TAGS, a table
// as a table (not as lines), the attributes and declarations that module keeps, in its fixed order after the href; a font
// or a span that keeps no attribute is unwrapped. The values are trimmed by rich-style.js itself (as DOMPurify trims every attribute
// value before it is checked). The same bytes as the sanitizer (test/rich-parity.test.js)
const RICH_TAGS = new Set([...COMPOSE_TAGS, ...RICH_EXTRA_TAGS])
// the tags whose bgcolor attribute the rich mode keeps
const BGCOLOR_TAGS = new Set(Object.keys(RICH_ATTRS).filter(t => RICH_ATTRS[t].includes('bgcolor')))
const richAttrText = n =>
  richAttrs(n.name, name => {
    const v = n.attribs?.[name]
    return typeof v === 'string' && Object.hasOwn(n.attribs, name) ? v : null
  })
    .map(([name, v]) => ` ${name}="${escAttr(v)}"`)
    .join('')
function composeHtmlOf(doc, hidden, { rich = false } = {}) {
  const out = []
  // inA: inside a kept <a>. A nested <a> is unwrapped: htmlparser2 nests it, but the recipient's HTML5
  // parser closes the outer one, so a nested link would be a live second link next to the one the Modal lists
  const stack = [{ node: doc, close: null, inA: false }]
  while (stack.length) {
    const item = stack.pop()
    if (item.close) {
      out.push(item.close)
      continue
    }
    const n = item.node
    if (hidden.has(n)) continue
    if (n.type === 'text') {
      out.push(escText(n.data))
      continue
    }
    const kids = n.children || []
    // a table: a line (div) per row, the cells one space apart, a header cell bold, the caption first; the same as
    // sanitize.js's tableToLines (tableRows), so Claude's quote and the composer's quote of a table are the same
    if (isEl(n) && n.name === 'table' && !rich) {
      const seq = [{ close: '<div>' }]
      for (const line of tableLines(n, hidden)) {
        seq.push({ close: '<div>' })
        line.forEach((cell, i) => {
          if (i) seq.push({ close: ' ' })
          if (cell.th) seq.push({ close: '<b>' })
          for (const k of cell.kids) seq.push({ node: k, close: null, inA: item.inA })
          if (cell.th) seq.push({ close: '</b>' })
        })
        seq.push({ close: '</div>' })
      }
      seq.push({ close: '</div>' })
      for (let i = seq.length - 1; i >= 0; i--) stack.push(seq[i])
      continue
    }
    const painted = rich && isEl(n) && RICH_TAGS.has(n.name) ? richAttrText(n) : ''
    // rich: a font or a span with no attribute left is unwrapped, as sanitizeCompose does
    const kept = rich ? RICH_TAGS.has(n.name) && ((n.name !== 'font' && n.name !== 'span') || painted !== '') : COMPOSE_TAGS.has(n.name)
    const keep = isEl(n) && kept && !(n.name === 'a' && item.inA)
    if (keep) {
      let attrs = ''
      const href = n.name === 'a' ? String(n.attribs?.href ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
      if (href && /^(?:https?:|mailto:)/i.test(href)) attrs = ` href="${escAttr(href)}"`
      attrs += painted
      out.push(`<${n.name}${attrs}>`)
      if (n.name === 'br' || (rich && VOID_TAGS.has(n.name))) continue
      stack.push({ close: `</${n.name}>` })
    }
    const inA = item.inA || (keep && n.name === 'a')
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], close: null, inA })
  }
  return out.join('')
}
const richComposeHtmlOf = (doc, hidden) => composeHtmlOf(doc, hidden, { rich: true })
/**
 * The visible part of a message's HTML as composer HTML (empty when the body is too complex to filter). `rich`: the
 * formatting stays (the user's own saved draft), as sanitizeCompose's `rich` keeps it.
 */
export const visibleComposeHtml = (html, { rich = false } = {}) => (rich ? visibleTextInfo(html, richComposeHtmlOf, { tables: true }) : visibleTextInfo(html, composeHtmlOf)).text
