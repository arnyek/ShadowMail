// SPDX-License-Identifier: GPL-3.0-or-later
// The composer's rich formatting: what a body written, pasted or saved in the composer may keep (a table with its grid, a
// colour, a font, a size, a list...), and nothing that can do harm. Pure (no DOM, no parser): the composer's sanitizer
// (app/renderer/src/sanitize.js sanitizeCompose `rich`) and the main process's mirror (core/mime/visible-text.js
// visibleComposeHtml `rich`) both call it, so the two write the same bytes.
//
// An ALLOW-list, with every value checked: a tag, an attribute or a CSS property not named here goes, and so does a value
// outside its range. What goes and why:
// - code and loading: every declaration whose value holds url(, image-set(, expression(, a backslash (an escape), @, /*,
//   <, >, a brace, a "!" (other than !important) or a control character; on* attributes, class, id, name, data-*, lang,
//   title (the allow-list keeps none of them)
// - breaking out, covering: position, top / right / bottom / left, z-index, transform, float, clear, display, overflow,
//   clip, clip-path (not on the list)
// - cutting, empty bands: height, min-height, max-height and the height attribute
// - freezing and turning the text: white-space, word-break, overflow-wrap, direction, unicode-bidi, dir, nowrap (the
//   composer's shape check counts on an ASCII space breaking the line outside a <pre>)
// - no formatting, or not portable: mso-*, -webkit-*, -moz-*, animations, transitions, filters, opacity, visibility,
//   cursor, pointer-events, user-select, content, background images, the font shorthand
// A declaration that goes takes no other with it. A value longer than MAX_VALUE goes; an element's cleaned style is at
// most MAX_STYLE characters (the declarations past it go).
//
// The output is deterministic: "prop: value;" joined by one space, in the source order (a property written twice: the
// last one, at its place), whitespace runs as one space, !important off; `background` is kept only as a single colour,
// written as background-color. Attributes come in RICH_ATTRS order, the style last.
// - the composer's "Automatic" text colour (text-colors.js AUTO_COLOR, a marker): a text colour of that value always
//   goes, as a font's color and as a color declaration, in any case or form; a font left with nothing is unwrapped.
import { isAutoColor } from './text-colors.js'

export const MAX_VALUE = 200
export const MAX_STYLE = 2000

/** The tags the rich mode keeps beyond the composer's own (sanitize.js COMPOSE_TAGS). */
export const RICH_EXTRA_TAGS = Object.freeze(['font', 'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'h4', 'h5', 'h6', 'sup', 'sub', 'hr', 'mark', 'strike', 'dl', 'dt', 'dd'])
// elements written without an end tag
export const VOID_TAGS = new Set(['br', 'hr', 'col', 'img'])
// no style on these (the image keeps only its own width rule; a break has nothing to style)
const NO_STYLE = new Set(['br', 'img'])
// width / min-width / max-width only on these (on anything else a width cuts or widens the text)
const SIZED = new Set(['table', 'col', 'td', 'th'])

const BLOCK_ALIGN = ['align']
/** The attributes each tag keeps in the rich mode (besides style and the composer's own href / src / alt / width rule), in output order. */
export const RICH_ATTRS = Object.freeze({
  font: ['color', 'face', 'size'],
  table: ['border', 'cellpadding', 'cellspacing', 'width', 'align', 'bgcolor'],
  td: ['colspan', 'rowspan', 'width', 'align', 'valign', 'bgcolor'],
  th: ['colspan', 'rowspan', 'width', 'align', 'valign', 'bgcolor'],
  tr: ['align', 'valign', 'bgcolor'],
  col: ['span', 'width'],
  ol: ['start', 'type'],
  li: ['value'],
  p: BLOCK_ALIGN,
  div: BLOCK_ALIGN,
  h1: BLOCK_ALIGN,
  h2: BLOCK_ALIGN,
  h3: BLOCK_ALIGN,
  h4: BLOCK_ALIGN,
  h5: BLOCK_ALIGN,
  h6: BLOCK_ALIGN,
})
/** Every attribute name the rich mode may keep (for DOMPurify's ALLOWED_ATTR / ADD_URI_SAFE_ATTR), style included. */
export const RICH_ATTR_NAMES = Object.freeze([...new Set([...Object.values(RICH_ATTRS).flat(), 'style'])])

// --- colours ---------------------------------------------------------------------------------------------------
// CSS named colours (CSS Color 4), transparent, currentcolor, and the system colours (Word writes windowtext)
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue ' +
    'chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey ' +
    'darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray ' +
    'darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen ' +
    'fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen ' +
    'lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime ' +
    'limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
    'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive ' +
    'olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver ' +
    'skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white ' +
    'whitesmoke yellow yellowgreen transparent currentcolor ' +
    'accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext field fieldtext graytext ' +
    'highlight highlighttext linktext mark marktext selecteditem selecteditemtext visitedtext activeborder activecaption ' +
    'appworkspace background buttonhighlight buttonshadow captiontext inactiveborder inactivecaption inactivecaptiontext ' +
    'infobackground infotext menu menutext scrollbar threeddarkshadow threedface threedhighlight threedlightshadow threedshadow ' +
    'window windowframe windowtext'
  ).split(' '),
)
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const COLOR_FN = /^(?:rgba?|hsla?)\(([^()]*)\)$/i
const FN_ARGS = /^[0-9.,%+\-/ ]*$/
const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%|deg|turn|rad|grad)?$/i

/** Whether `v` (trimmed) is a CSS colour this module keeps: #hex (3/4/6/8), rgb(a) / hsl(a) with numbers, a name. */
export function isColor(v) {
  if (typeof v !== 'string' || !v || v.length > MAX_VALUE) return false
  if (HEX_COLOR.test(v)) return true
  if (NAMED_COLORS.has(v.toLowerCase())) return true
  const m = COLOR_FN.exec(v)
  if (!m) return false
  // the units an hsl() hue may carry, and "none", are the only letters: taken out, the rest is numbers and separators
  const args = m[1].replace(/deg|turn|rad|grad|none/gi, ' ')
  if (!FN_ARGS.test(args)) return false
  const parts = m[1].split(/[\s,/]+/).filter(Boolean)
  return parts.length >= 3 && parts.length <= 4 && parts.every(p => p.toLowerCase() === 'none' || NUMBER.test(p))
}

// a text colour nobody sees: transparent, or an alpha under 0.1 (#rgba / #rrggbbaa, the 4th argument of rgb() / hsl()).
// It is the hidden-text trick, never formatting: a text colour keeps none of these (a background may be transparent)
function invisibleColor(v) {
  const s = v.toLowerCase()
  if (s === 'transparent') return true
  const a = /^#(?:[0-9a-f]{3}([0-9a-f])|[0-9a-f]{6}([0-9a-f]{2}))$/.exec(s)
  if (a) return parseInt(a[1] ? a[1] + a[1] : a[2], 16) / 255 < 0.1
  const m = COLOR_FN.exec(s)
  if (!m) return false
  const parts = m[1].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 4 || parts[3] === 'none') return false
  const alpha = parts[3].endsWith('%') ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3])
  return Number.isFinite(alpha) && alpha < 0.1
}
/**
 * A colour a text may have: a colour (isColor) that shows (not transparent, alpha at least 0.1), and not the composer's
 * "Automatic" marker (text-colors.js AUTO_COLOR: it means no colour of its own).
 */
export const isTextColorValue = v => isColor(v) && !invisibleColor(v) && !isAutoColor(v)

// --- lengths ---------------------------------------------------------------------------------------------------
const LENGTH = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(px|pt|em|rem|%|cm|mm|in)?$/i
const PX_PER = { px: 1, pt: 4 / 3, em: 16, rem: 16, cm: 96 / 2.54, mm: 96 / 25.4, in: 96 }
/** "12pt" -> { n: 12, unit: 'pt', px: 16 } (px: the size against a 16 px font; null for %), or null. A bare number only as 0. */
export function lengthOf(token) {
  const m = LENGTH.exec(token)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] || '').toLowerCase()
  if (!Number.isFinite(n)) return null
  if (!unit && n !== 0) return null
  return { n, unit, px: unit === '%' ? null : unit ? n * PX_PER[unit] : 0 }
}
// a length within [min, max] px; `pct`: [min, max] percent, or no percent
const lengthIn = (token, min, max, pct = null) => {
  const l = lengthOf(token)
  if (!l) return false
  if (l.unit === '%') return Boolean(pct) && l.n >= pct[0] && l.n <= pct[1]
  return l.px >= min && l.px <= max
}
// the largest font an element may declare itself (font-size below)
const FONT_MAX_PX = 96
// a length that moves or widens a box (margin, padding, text-indent, width): its bound holds at any font the element may
// have, so an em counts at FONT_MAX_PX (with a 96 px font, 12em is 1152 px, not 192)
const boxLengthIn = (token, min, max, pct = null) => {
  const l = lengthOf(token)
  if (!l) return false
  if (l.unit === '%') return Boolean(pct) && l.n >= pct[0] && l.n <= pct[1]
  const px = l.unit === 'em' ? l.n * FONT_MAX_PX : l.px
  return px >= min && px <= max
}

// --- the value tokens ------------------------------------------------------------------------------------------
// split at `sep` outside parentheses (a space-separated value: sep ' '; a list: sep ',')
function splitOutside(v, sep) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === sep && depth === 0) {
      out.push(v.slice(start, i))
      start = i + 1
    }
    if (depth < 0) return null
  }
  if (depth !== 0) return null
  out.push(v.slice(start))
  return out.map(s => s.trim()).filter(s => s !== '')
}
const tokens = v => splitOutside(v, ' ')
const kw = (...words) => {
  const set = new Set(words)
  return v => set.has(v.toLowerCase())
}

const BORDER_STYLES = kw('none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset')
const isBorderWidth = t => kw('thin', 'medium', 'thick')(t) || lengthIn(t, 0, 10)
const DECORATION_LINES = new Set(['underline', 'overline', 'line-through'])
const DECORATION_STYLES = kw('solid', 'double', 'dotted', 'dashed', 'wavy')
const FONT_SIZE_WORDS = kw('xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large', 'smaller', 'larger')
const LIST_TYPES = kw('disc', 'circle', 'square', 'decimal', 'decimal-leading-zero', 'lower-roman', 'upper-roman', 'lower-alpha', 'upper-alpha', 'lower-latin', 'upper-latin', 'lower-greek', 'none')
const VERTICAL_WORDS = kw('baseline', 'sub', 'super', 'top', 'text-top', 'middle', 'bottom', 'text-bottom')
// a font family: a quoted name without quotes, backslash or markup inside, or bare words of letters, digits, space, - _ .
const QUOTED_FAMILY = /^(?:"[^"'\\<>{}();]{1,100}"|'[^"'\\<>{}();]{1,100}')$/
const BARE_FAMILY = /^[\p{L}\p{N}_\-. ]{1,100}$/u

// 1 to `max` tokens, each passing `ok`
const upTo = (max, ok) => v => {
  const t = tokens(v)
  return Boolean(t) && t.length >= 1 && t.length <= max && t.every(ok)
}
const one = ok => upTo(1, ok)
// a shorthand of at most one of each kind, in any order, at least one
const anyOrder = (...kinds) => v => {
  const t = tokens(v)
  if (!t || !t.length || t.length > kinds.length) return false
  const used = new Set()
  for (const x of t) {
    const k = kinds.findIndex((ok, i) => !used.has(i) && ok(x))
    if (k < 0) return false
    used.add(k)
  }
  return true
}
const margin = t => t.toLowerCase() === 'auto' || boxLengthIn(t, 0, 200, [0, 50])
const padding = t => boxLengthIn(t, 0, 200, [0, 50])
const fontSize = t => FONT_SIZE_WORDS(t) || lengthIn(t, 3, FONT_MAX_PX, [18.75, 600])
const lineHeight = t => {
  if (t.toLowerCase() === 'normal') return true
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t)) return Number(t) >= 0.5 && Number(t) <= 5
  return lengthIn(t, 4, 200, [50, 500])
}
const spacing = t => t.toLowerCase() === 'normal' || lengthIn(t, -5, 20)
const sizeOf = t => t.toLowerCase() === 'auto' || boxLengthIn(t, 0, 1200, [0, 100])
const maxSize = t => t.toLowerCase() === 'none' || boxLengthIn(t, 0, 1200, [0, 100])
const shadowOne = s => {
  const t = tokens(s)
  if (!t || t.length < 2 || t.length > 4) return false
  const colors = t.filter(isColor)
  const lens = t.filter(x => !isColor(x))
  if (colors.length > 1 || lens.length < 2 || lens.length > 3) return false
  // offsets within 20 px either way, the blur 0..20 px
  return lens.every((x, i) => (i < 2 ? lengthIn(x, -20, 20) : lengthIn(x, 0, 20)))
}
const textShadow = v => {
  if (v.toLowerCase() === 'none') return true
  const list = splitOutside(v, ',')
  return Boolean(list) && list.length >= 1 && list.length <= 3 && list.every(shadowOne)
}
const fontFamily = v => {
  const list = splitOutside(v, ',')
  return Boolean(list) && list.length >= 1 && list.length <= 10 && list.every(f => QUOTED_FAMILY.test(f) || (BARE_FAMILY.test(f) && /[\p{L}\p{N}]/u.test(f)))
}
const decorationLine = v => {
  const t = tokens(v)
  if (!t || !t.length) return false
  if (t.length === 1 && t[0].toLowerCase() === 'none') return true
  const seen = new Set()
  return t.length <= 3 && t.every(x => DECORATION_LINES.has(x.toLowerCase()) && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
}
const decoration = v => {
  const t = tokens(v)
  if (!t || !t.length || t.length > 5) return false
  const lines = t.filter(x => DECORATION_LINES.has(x.toLowerCase()) || x.toLowerCase() === 'none')
  const rest = t.filter(x => !(DECORATION_LINES.has(x.toLowerCase()) || x.toLowerCase() === 'none'))
  if (!lines.length || !decorationLine(lines.join(' '))) return false
  return anyOrder(DECORATION_STYLES, isColor)(rest.join(' ')) || rest.length === 0
}

// property -> check(value); every one not here goes
const SIDES = ['top', 'right', 'bottom', 'left']
const PROPS = {
  color: one(isTextColorValue),
  'background-color': one(isColor),
  'font-family': fontFamily,
  'font-size': one(fontSize),
  'font-weight': one(t => kw('normal', 'bold', 'bolder', 'lighter')(t) || (/^\d{1,4}$/.test(t) && Number(t) >= 1 && Number(t) <= 1000)),
  'font-style': one(kw('normal', 'italic', 'oblique')),
  'font-variant': one(kw('normal', 'small-caps')),
  'font-variant-caps': one(kw('normal', 'small-caps')),
  'text-decoration': decoration,
  'text-decoration-line': decorationLine,
  'text-decoration-style': one(DECORATION_STYLES),
  'text-decoration-color': one(isTextColorValue),
  'text-transform': one(kw('none', 'capitalize', 'uppercase', 'lowercase')),
  // letters closer than 1 px apart run together: a 3 px letter at -5 px is a word nobody can read (planner, 5243)
  'letter-spacing': one(t => t.toLowerCase() === 'normal' || lengthIn(t, -1, 20)),
  'word-spacing': one(spacing),
  'line-height': one(lineHeight),
  'text-align': one(kw('left', 'right', 'center', 'justify', 'start', 'end')),
  'text-indent': one(t => boxLengthIn(t, -200, 200)),
  'vertical-align': one(t => VERTICAL_WORDS(t) || lengthIn(t, -20, 20)),
  'text-shadow': textShadow,
  margin: upTo(4, margin),
  padding: upTo(4, padding),
  border: anyOrder(isBorderWidth, BORDER_STYLES, isColor),
  'border-width': upTo(4, isBorderWidth),
  'border-style': upTo(4, BORDER_STYLES),
  'border-color': upTo(4, isColor),
  'border-collapse': one(kw('collapse', 'separate')),
  'border-spacing': upTo(2, t => lengthIn(t, 0, 50)),
  'border-radius': upTo(4, t => lengthIn(t, 0, 100, [0, 50])),
  'list-style-type': one(LIST_TYPES),
  'list-style-position': one(kw('inside', 'outside')),
  width: one(sizeOf),
  'min-width': one(sizeOf),
  'max-width': one(maxSize),
}
for (const s of SIDES) {
  PROPS[`margin-${s}`] = one(margin)
  PROPS[`padding-${s}`] = one(padding)
  PROPS[`border-${s}`] = PROPS.border
  PROPS[`border-${s}-width`] = one(isBorderWidth)
  PROPS[`border-${s}-style`] = one(BORDER_STYLES)
  PROPS[`border-${s}-color`] = one(isColor)
}
const SIZE_PROPS = new Set(['width', 'min-width', 'max-width'])
// a length's kind and size, so that only like lengths are added or compared: the absolute units (px, pt, cm, mm, in) in px,
// em (the element's own font), rem (the root's) and % (the containing block's width) in their own number; null: auto
const measure = v => {
  const l = lengthOf(v)
  if (!l) return null
  return l.unit === 'em' || l.unit === 'rem' || l.unit === '%' ? { kind: l.unit, n: l.n } : { kind: 'abs', n: l.px }
}
// the left of a 1-4 value box shorthand (top, right, bottom, left as CSS reads them)
const leftOf = v => {
  const t = v.split(' ').filter(Boolean)
  return t.length >= 4 ? t[3] : t.length >= 2 ? t[1] : t[0] || ''
}
// the element's own left margin + padding of `kind` from its kept declarations (the later one of a shorthand and its
// longhand wins); a part of another kind counts 0: against this kind its size is unknown (planner, 5243: the net indent)
function leftSpace(kept, kind) {
  let m = ''
  let p = ''
  for (const [prop, v] of kept) {
    if (prop === 'margin') m = leftOf(v)
    else if (prop === 'margin-left') m = v
    else if (prop === 'padding') p = leftOf(v)
    else if (prop === 'padding-left') p = v
  }
  const of = v => {
    const x = measure(v)
    return x && x.kind === kind && x.n > 0 ? x.n : 0
  }
  return of(m) + of(p)
}
/** The CSS properties the rich mode keeps (background as a single colour comes on top, as background-color). */
export const RICH_PROPERTIES = Object.freeze(Object.keys(PROPS))

// what no kept value may hold: code, loading, escapes, comments, markup, blocks, a second "!", control characters. The first
// layer: every property's own check below would refuse these too, this one holds if a check is ever widened
export const FORBIDDEN_VALUE = /url\(|image-set\(|expression\(|[\\@<>{}!"'`&;\u0000-\u0008\u000e-\u001f\u007f]|\/\*|\*\//i
const IMPORTANT = /!\s*important\s*$/i
const NAME = /^-?[a-z][a-z-]*$/

/** One declaration's value cleaned for `prop` on `tag`: the value as kept (whitespace collapsed), or null. */
function cleanValue(prop, raw, tag) {
  let v = raw.replace(IMPORTANT, '')
  v = v.replace(/[ \t\n\r\f]+/g, ' ').trim()
  if (!v || v.length > MAX_VALUE) return null
  // quotes only in a font family (its own check holds them to whole names)
  const forbidden = prop === 'font-family' ? FORBIDDEN_VALUE.test(v.replace(/["']/g, '')) : FORBIDDEN_VALUE.test(v)
  if (forbidden) return null
  if (SIZE_PROPS.has(prop) && !SIZED.has(tag)) return null
  // own properties only: a name like "constructor" must not reach Object.prototype
  const check = Object.hasOwn(PROPS, prop) ? PROPS[prop] : null
  return check && check(v) ? v : null
}

/**
 * A style attribute's text -> the kept declarations, "prop: value;" joined by one space ('' when none is kept).
 * `tag`: the element's lower-case name (some properties are kept on some tags only; br and img keep none).
 */
export function cleanStyle(styleText, tag) {
  if (typeof styleText !== 'string' || !styleText || NO_STYLE.has(tag)) return ''
  const kept = new Map()
  for (const decl of styleText.split(';')) {
    const i = decl.indexOf(':')
    if (i <= 0) continue
    let prop = decl.slice(0, i).trim().toLowerCase()
    if (!NAME.test(prop)) continue
    let value
    if (prop === 'background') {
      // only a single colour (the rest of the shorthand loads images or positions them)
      value = cleanValue('background-color', decl.slice(i + 1), tag)
      prop = 'background-color'
    } else value = cleanValue(prop, decl.slice(i + 1), tag)
    if (value === null) continue
    // the last one wins, at its own place (a later shorthand or longhand keeps its order against the others)
    kept.delete(prop)
    kept.set(prop, value)
  }
  // the net indent is never negative (planner, 5243): a negative text-indent at most the element's own left margin + padding,
  // further left the first line stands outside the editor (and the recipient's window)
  // (in like units only: -12em against a 200 px padding is unknown, so it goes)
  const indent = kept.get('text-indent')
  if (indent !== undefined) {
    const x = measure(indent)
    if (x && x.n < 0 && -x.n > leftSpace(kept, x.kind)) kept.delete('text-indent')
  }
  const out = []
  let length = 0
  for (const [prop, value] of kept) {
    const d = `${prop}: ${value};`
    const add = (out.length ? 1 : 0) + d.length
    if (length + add > MAX_STYLE) break
    out.push(d)
    length += add
  }
  return out.join(' ')
}

// --- attributes ------------------------------------------------------------------------------------------------
const int = (min, max) => v => /^\d{1,7}$/.test(v) && Number(v) >= min && Number(v) <= max
const signedInt = v => /^-?\d{1,9}$/.test(v)
const tableWidth = v => (/^\d{1,4}(?:\.\d{1,4})?%$/.test(v) ? Number(v.slice(0, -1)) <= 100 : /^\d{1,5}$/.test(v) && Number(v) <= 1200)
const FACE = /^[\p{L}\p{N} _\-.,']{1,200}$/u
const ATTR_CHECKS = {
  color: isTextColorValue,
  bgcolor: isColor,
  face: v => FACE.test(v) && /[\p{L}\p{N}]/u.test(v),
  size: v => /^[1-7]$/.test(v),
  border: int(0, 10),
  cellpadding: int(0, 50),
  cellspacing: int(0, 50),
  colspan: int(1, 1000),
  rowspan: int(1, 1000),
  span: int(1, 1000),
  width: tableWidth,
  valign: kw('top', 'middle', 'bottom', 'baseline'),
  start: signedInt,
  value: signedInt,
  // case matters: "a" and "A" are two list types
  type: v => /^[1aAiI]$/.test(v),
}
const attrsOf = tag => (Object.hasOwn(RICH_ATTRS, tag) ? RICH_ATTRS[tag] : [])
const TABLE_ALIGN = kw('left', 'center', 'right')
const BLOCK_ALIGNS = kw('left', 'center', 'right', 'justify')

/** One attribute of `tag` in the rich mode: the value kept (trimmed), or null (it goes). style: cleanStyle ('' -> null). */
export function cleanAttr(tag, name, value) {
  if (typeof value !== 'string') return null
  if (name === 'style') {
    const s = cleanStyle(value, tag)
    return s ? s : null
  }
  if (!attrsOf(tag).includes(name)) return null
  const v = value.trim()
  if (!v || v.length > MAX_VALUE) return null
  if (name === 'align') return (tag === 'table' ? TABLE_ALIGN(v) : BLOCK_ALIGNS(v)) ? v : null
  return ATTR_CHECKS[name](v) ? v : null
}

/**
 * The rich attributes of an element: `get(name)` gives an attribute's value (or null / undefined); the kept ones come
 * back as [[name, value]] in RICH_ATTRS order, the style last. The composer's own attributes (href, src, alt, the
 * image's width, the signature mark) are not looked at: the caller keeps them by its own rule.
 */
export function richAttrs(tag, get) {
  const out = []
  for (const name of [...attrsOf(tag), 'style']) {
    const raw = get(name)
    if (raw === null || raw === undefined) continue
    const v = cleanAttr(tag, name, raw)
    if (v !== null) out.push([name, v])
  }
  return out
}
