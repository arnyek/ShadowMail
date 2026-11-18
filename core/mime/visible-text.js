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
  for (const [name, w] of win) out[name] = w.value
  return out
}

// --- lengths -----------------------------------------------------------------------------------------
const LENGTH = /^(-?(?:\d+\.?\d*|\.\d+))(px|pt|em|rem|%|ex|ch|cm|mm|in|pc|q|vw|vh|vmin|vmax)?$/
const length = v => {
  if (v === undefined || v.length > 40) return null
  const m = v.trim().match(LENGTH)
  return m ? { n: parseFloat(m[1]), unit: m[2] || '' } : null
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
  const l = length(v)
  if (!l) return null
  switch (l.unit) {
    case 'px': return l.n
    case 'pt': return (l.n * 4) / 3
    case 'pc': return l.n * 16
    case 'in': return l.n * 96
    case 'cm': return (l.n * 96) / 2.54
    case 'mm': return (l.n * 96) / 25.4
    case 'q': return (l.n * 96) / 101.6
    case 'em': return l.n * parent
    case 'ex': case 'ch': return l.n * parent * 0.5
    case 'rem': return l.n * 16
    case '%': return (l.n / 100) * parent
    case '': return l.n === 0 ? 0 : null
    default: return null // vw, vh...: unknown
  }
}
// the size in a "font" shorthand: the first token that is a size ("bold 0/0 a" -> "0"); a unitless number other
// than 0 is a weight, not a size
function fontShorthandSize(font) {
  if (font === undefined || font.length > MAX_VALUE) return undefined
  for (const token of font.split(/\s+/)) {
    const t = token.split('/')[0]
    if (FONT_KEYWORDS[t] !== undefined || t === 'smaller' || t === 'larger') return t
    const l = length(t)
    if (l && (l.unit || l.n === 0)) return t
  }
  return undefined
}
const isZeroish = v => {
  const l = length(v)
  return Boolean(l) && l.n <= 0
}
const farOff = v => {
  const l = length(v)
  return Boolean(l) && l.n <= -500
}

// hidden with its whole subtree, whatever the children say (properties that are not inherited)
function hiddenSubtree(el, s) {
  if (s.display !== undefined ? /^none\b/.test(s.display) : el.attribs && 'hidden' in el.attribs) return true
  if (/^(absolute|fixed)$/.test(s.position || '') && ['left', 'top', 'right', 'bottom'].some(k => farOff(s[k]))) return true
  if (/^hidden\b/.test(s.overflow || '') && ['height', 'max-height', 'width', 'max-width'].some(k => s[k] !== undefined && isZeroish(s[k]))) return true
  if (s.clip && s.clip.length < 200 && /^rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(s.clip)) return true
  const cp = s['clip-path']
  if (cp && cp.length < 200 && (/^inset\(\s*(5\d|[6-9]\d|100)%/.test(cp) || /^circle\(\s*0/.test(cp))) return true
  if (s.transform && s.transform.length < 200 && /scale[xy]?\(\s*0(\.0+)?\s*(,\s*[\d.]+\s*)?\)/.test(s.transform)) return true
  return false
}
const opacityOf = v => {
  if (v === undefined || v.length > 40) return 1
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
  const decl = s['background-color'] ?? s.background ?? s['background-image']
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
        tbody.children = out.slice(first, last + 1)
        out.splice(first, last - first + 1, tbody)
      }
    }
    relink(node, out)
    for (const c of out) if (isEl(c)) stack.push(c)
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

/** A started net: over() is true past TIME_LIMIT_MS of CPU time (wall time without a CPU clock) or WALL_LIMIT_MS of wall time. */
function startNet(clocks) {
  const wall0 = clocks.wall()
  const cpu0 = clocks.cpu()
  if (cpu0 === null) return { over: () => clocks.wall() - wall0 > TIME_LIMIT_MS }
  return {
    over() {
      const wall = clocks.wall() - wall0
      if (wall > WALL_LIMIT_MS) return true
      const cpu = clocks.cpu()
      return cpu === null ? wall > TIME_LIMIT_MS : cpu - cpu0 > TIME_LIMIT_MS
    },
  }
}

// pass 1: every element's style on the whole reader's tree (a sibling or ancestor selector sees the elements that
// pass 2 hides: the browser matches on the whole document). A CPU-time net under the work ceiling (startNet).
function styleAll(doc, sheet, clocks) {
  const budget = { work: 0 }
  const net = startNet(clocks)
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
// pass 2: the hidden nodes are marked, not removed (removal is O(siblings) each)
function prune(doc, sheet, clocks) {
  const styles = styleAll(doc, sheet, clocks)
  const hidden = new Set()
  const root = { bg: '#ffffff', color: '#000000', font: 16, visible: true, indentOff: false, opacity: 1 }
  const stack = [[doc, root]]
  while (stack.length) {
    const [node, ctx] = stack.pop()
    for (const child of node.children || []) {
      if (child.type === 'text') {
        const c = ctx.color
        if (!ctx.visible || ctx.indentOff || ctx.font < MIN_FONT_PX || c === 'transparent' || (c !== UNKNOWN && ctx.bg !== UNKNOWN && c && ctx.bg && sameColor(c, ctx.bg))) hidden.add(child)
        continue
      }
      if (!isEl(child)) continue
      if (child.name === 'style' || DROP_TAGS.has(child.name)) {
        hidden.add(child)
        continue
      }
      const s = styles.get(child) || {}
      const opacity = ctx.opacity * opacityOf(s.opacity)
      if (hiddenSubtree(child, s) || opacity < MIN_OPACITY) {
        hidden.add(child)
        continue
      }
      if (child.name === 'details' && !(child.attribs && 'open' in child.attribs)) {
        for (const d of child.children || []) if (d.name !== 'summary') hidden.add(d)
      }
      const own = ownBackground(child, s)
      const bg = own && own !== 'transparent' ? own : ctx.bg
      let color = ctx.color
      const declared = s.color ?? (child.name === 'font' ? child.attribs?.color?.toLowerCase() : undefined)
      if (declared !== undefined && !/^(inherit|initial|currentcolor)$/.test(declared)) color = normalizeColor(declared) || UNKNOWN
      // a link has the browser's own colour (a:link is not inherited from a white parent)
      else if (child.name === 'a' && child.attribs?.href !== undefined) color = '#0000ee'
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
      let visible = ctx.visible
      if (s.visibility !== undefined) {
        if (/^(hidden|collapse)\b/.test(s.visibility)) visible = false
        else if (/^visible\b/.test(s.visibility)) visible = true
      }
      const indentOff = s['text-indent'] !== undefined ? farOff(s['text-indent']) : ctx.indentOff
      stack.push([child, { bg, color, font, visible, indentOff, opacity }])
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
 */
export function visibleTextInfo(html, output = textOf, { clocks = WORK_CLOCKS } = {}) {
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
    const hidden = prune(doc, new Stylesheet(styleTexts(doc), presentNames(doc)), clocks)
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
function composeHtmlOf(doc, hidden) {
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
    const keep = isEl(n) && COMPOSE_TAGS.has(n.name) && !(n.name === 'a' && item.inA)
    if (keep) {
      let attrs = ''
      const href = n.name === 'a' ? String(n.attribs?.href ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
      if (href && /^(?:https?:|mailto:)/i.test(href)) attrs = ` href="${escAttr(href)}"`
      out.push(`<${n.name}${attrs}>`)
      if (n.name === 'br') continue
      stack.push({ close: `</${n.name}>` })
    }
    const inA = item.inA || (keep && n.name === 'a')
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], close: null, inA })
  }
  return out.join('')
}
/** The visible part of a message's HTML as composer HTML (empty when the body is too complex to filter). */
export const visibleComposeHtml = html => visibleTextInfo(html, composeHtmlOf).text
