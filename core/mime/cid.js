// SPDX-License-Identifier: GPL-3.0-or-later
// A Content-ID and a cid: reference compared as one key (RFC 2392: the cid: URL is the Content-ID without < >,
// %-encoded; the Content-ID itself is case-insensitive in practice: mail programs write the reference in another case).
// Used by the reader (the frame's cid: images, the attachments it offers) and the composer (the quote's images).

import { Parser } from 'htmlparser2'
/** A Content-ID or a cid: reference as a key: without < >, %-decoded where it decodes, lower case. */
export function cidKey(raw) {
  let v = String(raw).replace(/^<|>$/g, '')
  try {
    v = decodeURIComponent(v)
  } catch {
    // not %-encoded: as it is
  }
  return v.toLowerCase()
}

// a cid: reference anywhere in an HTML (an attribute, a CSS url(), the text); it ends at a quote, a space or a bracket
const CID_ANY_RE = /cid:<?([^\s"'<>()]+)/gi
const bare = raw => String(raw).replace(/^<|>$/g, '')

/** Every cid: reference of an HTML as written (without < >), in one pass. */
export function cidRefsIn(html) {
  const refs = new Set()
  if (!html) return refs
  for (const m of html.matchAll(CID_ANY_RE)) refs.add(bare(m[1]))
  return refs
}

const IMG_TAG_RE = /<img\b(?:[^<>"']|"[^"<>]*"|'[^'<>]*')*>/gi
const ATTR_RE = /(\s)([^\s=/>"']+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+))?/g
// a cid: URL as a whole src value (RFC 2392: the Content-ID without < >, %-encoded)
const CID_SRC_RE = /^\s*cid:([^\s"'<>()]+)\s*$/i

// every <img src> value of an HTML through `fn(value without quotes)`: a string is the new src, undefined keeps it
function mapImgSrc(html, fn) {
  return html.replace(IMG_TAG_RE, tag =>
    tag.replace(ATTR_RE, (whole, space, name, eq, value) => {
      if (!value || name.toLowerCase() !== 'src') return whole
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : ''
      const src = fn(quote ? value.slice(1, -1) : value)
      return src === undefined ? whole : `${space}${name}${eq}"${src}"`
    }),
  )
}

/**
 * Every <img src="cid:..."> of an HTML through `fn(the cid as written)`: a string is the new src, undefined keeps it.
 * Only an image's src: a cid: in a background, a link, a CSS url() or the text is left alone, because the editor's
 * cleaning keeps only <img src>, and a part referred to only there must stay an attachment of a forward.
 */
export function mapImgCidSrc(html, fn) {
  return mapImgSrc(html, value => {
    const m = CID_SRC_RE.exec(value)
    return m ? fn(m[1]) : undefined
  })
}

// Elements whose content the reader's frame never shows as elements: raw text for an HTML parser, and what its
// sanitizer (app/renderer/src/sanitize.js sanitizeMail, DOMPurify with the html profile) removes WITH its content
// (DOMPurify's FORBID_CONTENTS among the elements it removes: forbidden tags and foreign content). An <img> in one of
// them shows no part. Kept on the safe side: an image counted as not shown is only offered as a file too.
const INERT = new Set([
  'script', 'style', 'title', 'textarea', 'xmp', 'plaintext', 'iframe', 'noembed', 'noframes', 'noscript', 'template',
  'audio', 'video', 'head', 'svg', 'math', 'foreignobject', 'annotation-xml', 'desc', 'mi', 'mn', 'mo', 'ms', 'mtext',
])

/**
 * The cid: references the reader's frame shows (as written, without < >): the src of every real <img> element, read as
 * an HTML parser reads it (htmlparser2, one linear pass), outside the INERT elements, taken as the frame's sanitizer
 * takes it (fixUrl: trimmed, "cid:", the < > off). So an "<img src=cid:..>" that is only text (in a comment, an
 * attribute value, a textarea, a script) shows nothing and hides nothing. A cid: in a background, a CSS url(), a link
 * or the text is not among them either: the frame shows none of those.
 */
export function imgCidRefsIn(html) {
  const refs = new Set()
  if (!html) return refs
  const inertStack = []
  let inert = 0
  const parser = new Parser({
    onopentag(name, attrs) {
      const isInert = INERT.has(name)
      inertStack.push(isInert)
      if (isInert) inert++
      if (name !== 'img' || inert || typeof attrs.src !== 'string') return
      const value = attrs.src.trim()
      if (/^cid:/i.test(value)) refs.add(value.slice(4).replace(/^<|>$/g, ''))
    },
    onclosetag() {
      if (inertStack.pop()) inert--
    },
  }, { lowerCaseTags: true, lowerCaseAttributeNames: true, decodeEntities: true })
  parser.write(String(html))
  parser.end()
  return refs
}

/**
 * The part a cid: reference of a message shows, or null: the part whose Content-ID is written the same way first, and
 * only then the first one whose cidKey matches (another case, %-encoded). So two parts whose Content-IDs differ only in
 * case each keep their own reference, and a reference written another way still finds its part. `parts`: the message's
 * parts (`cid` with or without < >, `accept(part)` may leave some out). -> ref => part | null; built once per message.
 */
export function cidResolver(parts, accept = () => true) {
  const exact = new Map()
  const byKey = new Map()
  for (const p of parts) {
    if (!p.cid || !accept(p)) continue
    const b = bare(p.cid)
    if (!exact.has(b)) exact.set(b, p)
    const k = cidKey(p.cid)
    if (!byKey.has(k)) byKey.set(k, p)
  }
  return ref => exact.get(bare(ref)) ?? byKey.get(cidKey(ref)) ?? null
}
