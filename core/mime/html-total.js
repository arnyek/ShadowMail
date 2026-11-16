// SPDX-License-Identifier: GPL-3.0-or-later
// mailparser's HTML -> text cap is per text/html part (maxHtmlLengthToParse): a multipart/mixed message with a text/plain
// part and many HTML parts each under the cap had every part converted on the main thread (20 x 262 K: ~3 s). This adds
// one parser option, `htmlTotal: { cap, linear? }`, that caps the SUM of the HTML parts mailparser would convert:
//   - sum <= cap: mailparser's own conversion, byte for byte as before;
//   - sum > cap: no conversion at all (as skipHtmlToText) and a textConversionError "HTML too long ..." (htmlTooLong);
//     with `linear` (a function html -> text, the worker's htmlToPlain) the text is made with it instead, every part in
//     mailparser's own order, so the late preview keeps the text/plain parts and the HTML parts' text.
// The per-part lengths are not in simpleParser's result, only in the parser's tree while its text is made
// (getTextContent), so the option hooks that internal method. mailparser is pinned (3.14.3). Without the option the
// original runs, untouched. If the method is gone or cannot be hooked, nothing is hooked (htmlTotalActive = false): the
// option is ignored, the per-part cap stays (maxHtmlLengthToParse) and latePreviewOf takes its old rule, the slower but
// correct way; test/parse-perf.test.js is red then. Both the main process and the worker import mailparser as ESM (its
// "import" entry), each thread its own instance, each hooked by its own import of this module.
import { MailParser } from 'mailparser'

const HOOKED = Symbol.for('shadowmail.htmlTotal')
const proto = MailParser.prototype
const original = typeof proto.getTextContent === 'function' ? proto.getTextContent : null

// mailparser's rule (getTextContent): a text/html part is converted to text when it is not inside a
// multipart/alternative and the message has a text part, or when it is the root and the message has no text part
const converted = (parser, alternative, node) => node.contentType === 'text/html' && ((!alternative && parser.hasText) || (node.root && !parser.hasText))

/** The text/html parts mailparser would convert, in its order: [node]. */
function convertedParts(parser) {
  const out = []
  const walk = (alternative, node) => {
    if (node.textContent && converted(parser, alternative, node)) out.push(node)
    alternative = alternative || node.contentType === 'multipart/alternative'
    if (node.children) for (const c of node.children) walk(alternative, c)
  }
  walk(false, parser.tree)
  return out
}

// mailparser 3.14.3's nesting guard before its own conversion (exceedsHtmlNestingDepth, mail-parser.js:80-140, not exported),
// copied: over MAX_NESTING_DEPTH levels a part is not converted (its text is ''). One linear pass that follows what
// htmlparser2 builds: a start tag opens an element (a trailing "/" does not close it), an end tag closes down to the
// nearest open element of that name and is ignored otherwise, comments are skipped; void elements and the ones the HTML
// parser closes by themselves (p, li, td ...) do not open a level.
export const MAX_NESTING_DEPTH = 1000
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const IMPLIED_END = new Set(['p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'rt', 'rp'])
const nameChar = c => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x3a || c === 0x5f
export function exceedsNestingDepth(html, maxDepth = MAX_NESTING_DEPTH) {
  const stack = []
  const open = new Map()
  const len = html.length
  let i = html.indexOf('<')
  while (i >= 0) {
    let pos = i + 1
    if (html.startsWith('!--', pos)) {
      const end = html.indexOf('-->', pos + 3)
      i = end < 0 ? -1 : html.indexOf('<', end + 3)
      continue
    }
    const closing = html.charCodeAt(pos) === 0x2f
    if (closing) pos++
    const nameStart = pos
    while (pos < len && nameChar(html.charCodeAt(pos))) pos++
    if (pos === nameStart) {
      i = html.indexOf('<', pos)
      continue
    }
    const name = html.slice(nameStart, pos).toLowerCase()
    const end = html.indexOf('>', pos)
    if (end < 0) break
    if (!VOID.has(name) && !IMPLIED_END.has(name)) {
      if (!closing) {
        stack.push(name)
        open.set(name, (open.get(name) || 0) + 1)
        if (stack.length > maxDepth) return true
      } else if (open.get(name)) {
        let popped
        do {
          popped = stack.pop()
          open.set(popped, open.get(popped) - 1)
        } while (popped !== name)
      }
    }
    i = html.indexOf('<', end + 1)
  }
  return false
}

/** One converted part by `linear`, as mailparser treats a part it cannot convert: too deep or a throw -> ''. */
function linearPart(html, linear) {
  if (exceedsNestingDepth(html)) return ''
  try {
    return linear(html)
  } catch {
    return ''
  }
}

/** mailparser's `text`, every converted HTML part made by `linear` (getTextContent's text array, in its order). */
function linearText(parser, linear) {
  const text = []
  const walk = (alternative, node) => {
    if (node.showMeta && parser.hasText) {
      const meta = ['From', 'Subject', 'Date', 'To', 'Cc', 'Bcc']
        .map(fkey => {
          const key = fkey.toLowerCase()
          if (!node.headers.has(key)) return false
          const value = node.headers.get(key)
          if (!value) return false
          return { key: fkey, value: Array.isArray(value) ? value[value.length - 1] : value }
        })
        .filter(entry => entry)
      text.push(
        '\n' +
          meta
            .map(entry => {
              let value = entry.value
              if (['From', 'To', 'Cc', 'Bcc'].includes(entry.key)) value = value.text
              else if (entry.key === 'Date') value = parser.options.formatDateString ? parser.options.formatDateString(value) : value.toUTCString()
              return entry.key + ': ' + value
            })
            .join('\n') +
          '\n',
      )
    }
    if (node.textContent) {
      if (node.contentType === 'text/plain') text.push(node.textContent)
      else if (node.contentType === 'message/delivery-status' && !parser.options.keepDeliveryStatus) text.push(node.textContent)
      else if (converted(parser, alternative, node)) text.push(linearPart(node.textContent, linear))
    }
    alternative = alternative || node.contentType === 'multipart/alternative'
    if (node.children) for (const c of node.children) walk(alternative, c)
  }
  walk(false, parser.tree)
  return text.join('\n')
}

function hooked() {
  const opt = this.options && this.options.htmlTotal
  if (!opt) return original.call(this)
  const total = convertedParts(this).reduce((n, node) => n + node.textContent.length, 0)
  if (total <= opt.cap) return original.call(this)
  // the options object is the caller's (shared, frozen): the parser gets a copy for this one call
  const options = this.options
  this.options = { ...options, skipHtmlToText: true }
  let response
  try {
    response = original.call(this)
  } finally {
    this.options = options
  }
  if (opt.linear && response.text !== undefined) this.text = response.text = linearText(this, opt.linear)
  response.textConversionError = response.textConversionError || new Error(`HTML too long for parsing ${total} characters in all`)
  return response
}

function install() {
  if (proto[HOOKED]) return proto.getTextContent === hooked || proto[HOOKED] === true
  if (!original) return false
  try {
    proto.getTextContent = hooked
    proto[HOOKED] = true
  } catch {
    return false // a frozen or read-only prototype
  }
  return proto.getTextContent === hooked
}

/** The cap on the sum is in force (the hook is on mailparser's parser). False: the per-part cap, the old way. */
export const htmlTotalActive = install()

/** For the tests: the walk alone, and mailparser's own method (the hook taken off for a comparison). */
export const htmlTotalInternals = { convertedParts, linearText, linearPart, original, hooked, proto }
