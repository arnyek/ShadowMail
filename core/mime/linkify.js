// SPDX-License-Identifier: GPL-3.0-or-later
// The web and e-mail addresses of a plain-text message, as links for the reader. Pure, no DOM, linear: a scanner with
// indexOf and bounded character walks, no backtracking regular expression (a 1 MiB hostile body must stay fast).
// http:// and https:// addresses, "www." without a scheme (https:// in front), and e-mail addresses (ASCII local part,
// a domain with at least one dot and a top-level part of at least two letters). Punctuation at the end ( . , ; : ! ? ' " )
// and an unmatched closing bracket ( ) ] } > ) are not part of the address. Any other scheme is no link.

export const MAX_LINKS = 1000

const URL_STARTS = ['https://', 'http://', 'www.']
// a letter or digit of any script (and _): an address does not start in the middle of a word ("kovács.anna@...")
const isWordChar = c => /[\p{L}\p{N}_]/u.test(c)
// what may stand in an address; it ends at white space, a control character, < > " and the characters below
const urlChar = c => c > ' ' && c !== '<' && c !== '>' && c !== '"' && c !== '\u007f' && !/[\s\u0080-\u009f]/.test(c)
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"'])
const PAIRS = { ')': '(', ']': '[', '}': '{' }
const localChar = c => /[A-Za-z0-9._%+-]/.test(c)
const domainChar = c => /[A-Za-z0-9.-]/.test(c)

/** The end of an address starting at `from` (its scheme or "www." already matched), its trailing marks taken off. */
function urlEnd(text, from) {
  let end = from
  const opens = { '(': 0, '[': 0, '{': 0 }
  const closes = { ')': 0, ']': 0, '}': 0 }
  while (end < text.length && urlChar(text[end])) {
    const c = text[end]
    if (c in opens) opens[c]++
    else if (c in closes) closes[c]++
    end++
  }
  for (;;) {
    const c = text[end - 1]
    if (TRAILING.has(c)) end--
    else if (c in PAIRS && closes[c] > opens[PAIRS[c]]) {
      closes[c]--
      end--
    } else break
  }
  return end
}

/** The web addresses: [{ start, end, href }], in order, not overlapping. */
function webLinks(text, limit) {
  const out = []
  const lower = text.toLowerCase()
  let at = 0
  // per kind the next occurrence at or after `at` (-1: none left); searched again only when `at` passed it, so every
  // kind's indexOf goes over the text once in all (a search to the end on every round was quadratic)
  const next = URL_STARTS.map(() => -2)
  while (out.length < limit) {
    // the nearest start of any kind from `at`
    let start = -1
    let kind = ''
    for (let j = 0; j < URL_STARTS.length; j++) {
      const k = URL_STARTS[j]
      if (next[j] === -2 || (next[j] !== -1 && next[j] < at)) next[j] = lower.indexOf(k, at)
      const i = next[j]
      if (i !== -1 && (start === -1 || i < start)) {
        start = i
        kind = k
      }
    }
    if (start === -1) break
    const before = start > 0 ? text[start - 1] : ''
    // "xhttp://", "awww.", "a.www.x", "/www.x": not the start of an address
    const wordBefore = before && (isWordChar(before) || (kind === 'www.' && (before === '.' || before === '/' || before === '@')))
    const head = start + kind.length
    const end = wordBefore ? head : urlEnd(text, head)
    // something after the scheme, and for "www." a dot further on ("www.x" alone is no address)
    const body = text.slice(head, end)
    if (!wordBefore && body && (kind !== 'www.' || body.includes('.'))) {
      const shown = text.slice(start, end)
      out.push({ start, end, href: kind === 'www.' ? `https://${shown}` : shown })
      at = end
    } else at = head
  }
  return out
}

/** The e-mail addresses outside the web links: [{ start, end, href }]. */
function mailLinks(text, taken, limit) {
  const out = []
  let t = 0 // the web links before the current @
  let lastEnd = 0
  let at = text.indexOf('@')
  while (at !== -1 && out.length < limit) {
    while (t < taken.length && taken[t].end <= at) t++
    const inside = t < taken.length && taken[t].start <= at
    let next = at + 1
    if (!inside) {
      let s = at
      while (s > lastEnd && localChar(text[s - 1])) s--
      // the walk stopped at a letter or digit of another script: the address would be a word's tail ("kovács.anna@")
      const midWord = s > lastEnd && isWordChar(text[s - 1])
      while (s < at && text[s] === '.') s++ // a local part does not start with a dot
      let e = at + 1
      while (e < text.length && domainChar(text[e])) e++
      while (e > at + 1 && (text[e - 1] === '.' || text[e - 1] === '-')) e--
      const domain = text.slice(at + 1, e)
      const dot = domain.lastIndexOf('.')
      const tld = dot === -1 ? '' : domain.slice(dot + 1)
      const before = s > 0 ? text[s - 1] : ''
      // the address must not continue a word on the left ("x@" inside "abc/x@y" is fine, "é" before is not checked)
      if (!midWord && s < at && dot > 0 && /^[A-Za-z]{2,}$/.test(tld) && !domain.includes('..') && before !== '@') {
        out.push({ start: s, end: e, href: `mailto:${text.slice(s, e)}` })
        lastEnd = e
        next = e
      }
    }
    at = text.indexOf('@', next)
  }
  return out
}

/**
 * The links of a plain text: [{ start, end, href }] (code unit offsets), in order, not overlapping, at most MAX_LINKS.
 * The text itself is never changed: a link is a range of it.
 */
export function linkify(text, { max = MAX_LINKS } = {}) {
  const s = String(text ?? '')
  if (!s) return []
  const web = webLinks(s, max)
  const mail = mailLinks(s, web, max)
  const all = [...web, ...mail].sort((a, b) => a.start - b.start)
  return all.slice(0, max)
}

/**
 * The links cut to consecutive pieces of the text (the reader's blocks): for each block [{ text, href? }] runs whose
 * texts join to the block. A link across a block boundary is a link in both blocks, to the same href.
 */
export function linkRuns(blocks, links) {
  const out = []
  let offset = 0
  let k = 0
  for (const block of blocks) {
    const end = offset + block.length
    const runs = []
    let at = offset
    while (k < links.length && links[k].end <= offset) k++
    let j = k
    while (j < links.length && links[j].start < end) {
      const l = links[j]
      const from = Math.max(l.start, offset)
      const to = Math.min(l.end, end)
      if (from > at) runs.push({ text: block.slice(at - offset, from - offset) })
      runs.push({ text: block.slice(from - offset, to - offset), href: l.href })
      at = to
      if (l.end > end) break // it goes on in the next block
      j++
    }
    k = j
    if (at < end) runs.push({ text: block.slice(at - offset) })
    out.push(runs)
    offset = end
  }
  return out
}
