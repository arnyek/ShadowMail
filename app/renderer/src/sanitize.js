// SPDX-License-Identifier: GPL-3.0-or-later
// HTML cleaning of a message body, the first line of defence. The result is shown in
// a sandboxed frame (no allow-scripts, no allow-same-origin) with its own CSP, and the main process
// net guard blocks every request it does not allow; this module removes what should not even try.
//
// Pure: the DOMPurify instance is passed in, so the same code runs in the renderer and, with jsdom,
// in node:test.
import { askedWidth } from '../../../core/smtp/image-width.js'
import { RICH_EXTRA_TAGS, RICH_ATTR_NAMES, richAttrs } from '../../../core/smtp/rich-style.js'

// Tags that run code, load or submit something, or change how the document is read.
const FORBID_TAGS = [
  'script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param', 'portal', 'fencedframe',
  'form', 'input', 'button', 'select', 'option', 'textarea', 'datalist', 'output', 'keygen',
  'link', 'meta', 'base', 'audio', 'video', 'source', 'track', 'picture', 'template', 'slot', 'dialog',
]
const FORBID_ATTR = ['action', 'formaction', 'ping', 'srcdoc', 'background', 'poster', 'dynsrc', 'lowsrc', 'longdesc', 'manifest', 'xmlns', 'autofocus', 'popover', 'popovertarget']

const LINK_SCHEMES = /^(https?:|mailto:)/i
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i
const REMOTE = /^\s*(https?:)?\/\//i
// the link list for the link-target bar (link-target.js): at most this many links, this much text each
export const MAX_LINKS = 5000
const MAX_LINK_TEXT = 300

/**
 * @param purify          a DOMPurify instance (DOMPurify(window))
 * @param html            the message's raw HTML
 * @param messageId       database id of the message (for cid-img://m<id>/<cid>)
 * @param imagesAllowed   "Képek betöltése" was pressed for this message
 * @returns { html, externalImages, links }  externalImages: how many external images the body has (shown or not);
 *          links: [{ href, text }] of the kept links (at most MAX_LINKS), text = the link's text after cleaning
 *          (an area's alt), whitespace collapsed, at most MAX_LINK_TEXT characters
 */
export function sanitizeMail(purify, html, { messageId, imagesAllowed = false }) {
  let externalImages = 0
  const linkNodes = []
  const fixUrl = (el, attr) => {
    const v = el.getAttribute(attr)
    if (v === null) return
    const value = v.trim()
    if (/^cid:/i.test(value)) {
      const cid = value.slice(4).replace(/^<|>$/g, '')
      el.setAttribute(attr, `cid-img://m${messageId}/${encodeURIComponent(cid)}`)
    } else if (REMOTE.test(value)) {
      externalImages++
      if (imagesAllowed) el.setAttribute(attr, value.startsWith('//') ? `https:${value}` : value)
      else el.removeAttribute(attr)
    } else if (!DATA_IMAGE.test(value)) {
      el.removeAttribute(attr)
    }
  }

  const afterAttributes = node => {
    const tag = node.nodeName ? node.nodeName.toLowerCase() : ''
    if (tag === 'a' || tag === 'area') {
      const href = (node.getAttribute('href') || '').trim()
      if (href && !LINK_SCHEMES.test(href)) node.removeAttribute('href')
      // every link opens as a popup, which the main process hands to the system browser (or drops)
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
      if (node.hasAttribute('href') && linkNodes.length < MAX_LINKS) linkNodes.push(node)
    }
    if (tag === 'img') {
      fixUrl(node, 'src')
      const srcset = node.getAttribute('srcset')
      if (srcset !== null) {
        if (REMOTE.test(srcset)) externalImages++
        // srcset is all-or-nothing: kept only if images are allowed and every candidate is http(s)
        const ok = imagesAllowed && srcset.split(',').every(c => /^\s*https?:\/\//i.test(c))
        if (!ok) node.removeAttribute('srcset')
      }
      node.setAttribute('referrerpolicy', 'no-referrer')
      if (!imagesAllowed) node.removeAttribute('loading')
    }
    // no element may navigate or load through these, whatever the tag
    for (const attr of ['src', 'href', 'srcset']) {
      if (tag !== 'img' && tag !== 'a' && tag !== 'area' && node.hasAttribute && node.hasAttribute(attr)) node.removeAttribute(attr)
    }
    if (node.hasAttribute && node.hasAttribute('target') && tag !== 'a' && tag !== 'area') node.removeAttribute('target')
  }

  purify.addHook('afterSanitizeAttributes', afterAttributes)
  try {
    const out = purify.sanitize(html || '', {
      USE_PROFILES: { html: true },
      FORBID_TAGS,
      FORBID_ATTR,
      ALLOW_DATA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      WHOLE_DOCUMENT: false,
      // <style> blocks stay (mails rely on them); CSS url() is held back by the frame's CSP and the net guard
      ADD_TAGS: ['style'],
      FORCE_BODY: true,
    })
    // read after the whole tree is clean: a link's text is what is left of it (the nodes stay usable after serializing)
    const links = linkNodes.map(n => ({
      href: n.getAttribute('href').trim(),
      text: (n.nodeName.toLowerCase() === 'area' ? n.getAttribute('alt') || '' : n.textContent).slice(0, MAX_LINK_TEXT * 4).replace(/\s+/g, ' ').trim().slice(0, MAX_LINK_TEXT),
    }))
    return { html: out, externalImages, links }
  } finally {
    purify.removeHook('afterSanitizeAttributes', afterAttributes)
  }
}

// The composer's own HTML: only what its toolbar makes, so a paste from a web page or a
// word processor cannot bring scripts, styles, images, forms or tracking into an outgoing message.
// The exceptions are the account's signature (core/smtp/signature.js): its marked block (a div with
// data-sm-signature) and its image, an img whose src is our own sig-img:// scheme; and a pasted image of THIS
// composer session (inl-img://session/<sessionId>/<id>, the caller's sessionId); any other image (http, cid:, data:,
// another session's inl-img) and the marker on any other element go. Only a pasted image keeps a width (the size
// menu's choice, a whole number of pixels: core/smtp/image-width.js); every other width goes.
export const COMPOSE_TAGS = ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'img']
const SIG_IMG_SRC = /^sig-img:\/\/(?:account\/\d{1,12}|session\/[A-Za-z0-9_-]{1,64})$/
const INL_IMG_SRC = /^inl-img:\/\/session\/([0-9a-f-]{36})\/[0-9a-f]{24}$/

/** A pasted image's src in the composer of `sessionId`. */
export const pastedImageSrc = (sessionId, id) => `inl-img://session/${sessionId}/${id}`
/** Whether `src` is a pasted image of the composer of `sessionId`. */
export function isPastedImageOf(src, sessionId) {
  const m = INL_IMG_SRC.exec(src || '')
  return Boolean(m && sessionId && m[1] === sessionId)
}

// A table is not the composer's own: its tags go and only the text is kept, and a web page's copied table (Chromium
// writes no space or line between the cells: "</th><td>") ran together into one line ("Name:1b Telecom..."). With
// `tableRows` each row of the table becomes a line of its own (a div), its cells side by side with one space between,
// a header cell bold as it showed; a caption is the first line. Nested tables become lines inside the row's line when
// the sanitizer reaches them. Done on the table's own subtree BEFORE the sanitizer unwraps it (uponSanitizeElement
// runs before the content is kept), so everything moved is sanitized as usual afterwards.
export function tableToLines(table) {
  const doc = table.ownerDocument
  const lines = doc.createElement('div')
  const line = parts => {
    const div = doc.createElement('div')
    parts.forEach((part, i) => {
      if (i) div.append(doc.createTextNode(' '))
      div.append(part)
    })
    lines.append(div)
  }
  const children = el => {
    const frag = doc.createDocumentFragment()
    frag.append(...el.childNodes)
    return frag
  }
  // what stands in the table but in no cell and no caption (whitespace, comments and columns aside) is kept where it
  // stands: as a part of its row, or as a line of its own. Dropping it lost text: measured in the app, a table nested
  // 200 deep lost its innermost text in a reply's quote; this Chromium puts that text right into a table (only the
  // table-level branch, taken out, loses it again)
  const stray = n => (n.nodeType === 3 ? !/^[ \t\n\f\r]*$/.test(n.data) : n.nodeType === 1 && n.nodeName !== 'COL' && n.nodeName !== 'COLGROUP')
  const rowLine = row => {
    const parts = []
    for (const c of [...row.childNodes]) {
      if (c.nodeName === 'TD') parts.push(children(c))
      else if (c.nodeName === 'TH') {
        const b = doc.createElement('b')
        b.append(children(c))
        parts.push(b)
      } else if (stray(c)) parts.push(c)
    }
    line(parts)
  }
  // in tree order (a caption is the first child of a valid table; a tfoot stands where it was written)
  for (const c of [...table.childNodes]) {
    if (c.nodeName === 'CAPTION') line([children(c)])
    else if (c.nodeName === 'TR') rowLine(c)
    else if (c.nodeName === 'THEAD' || c.nodeName === 'TBODY' || c.nodeName === 'TFOOT') {
      for (const r of [...c.childNodes]) {
        if (r.nodeName === 'TR') rowLine(r)
        else if (stray(r)) line([r])
      }
    } else if (stray(c)) line([c])
  }
  table.replaceChildren(lines)
}

// With `rich` (the user's own text: what is sent or saved, a saved draft opened again, a copy of the composer's own
// text) the formatting stays too, by core/smtp/rich-style.js: the tags of RICH_TAGS (a table with its grid, font, sup / sub,
// h4-h6, hr...), and on them only the attributes and CSS properties that module keeps, each value checked; every other
// attribute and declaration goes, a font or a span left with no attribute is unwrapped (its content stays). The attributes are
// written in one fixed order (the composer's own href / src / alt / width / signature mark first, then RICH_ATTRS, the style
// last), so the main process's mirror (visible-text.js visibleComposeHtml `rich`) writes the same bytes. The palette
// colours of the toolbar (core/smtp/text-colors.js) are a part of it. Without it (a quote, a paste, a mailto body, a
// signature) no formatting stays, and the result is the same as before (test/fixtures/compose-colors-off.json).
export const RICH_TAGS = Object.freeze([...COMPOSE_TAGS, ...RICH_EXTRA_TAGS])

// MEASURED (Electron 45, the planner's decision): the editor's insertHTML is quadratic in the top-level blocks it inserts
// when the caret stands in an empty paragraph with a block after it (a new message: the signature block), a 1 MB web page
// copy 36.5 s; the same HTML in ONE wrapping div is one block: 435 ms, the same text, one Ctrl+Z. And it is quadratic in
// bare spans (2000 lines of 5 bare spans: 22 s), which the plain mode leaves on every span.
export const INSERT_WRAP_NODES = 50
// the sanitized tree as the editor's insertHTML gets it (`insert`): at INSERT_WRAP_NODES top-level nodes or more, in one bare
// <div> (no attribute; it stays in the text and goes out as it is, harmless: unwrapping it would cost an undo step)
const insertHtml = body => (body.childNodes.length >= INSERT_WRAP_NODES ? `<div>${body.innerHTML}</div>` : body.innerHTML)
const OWN_ATTRS = ['href', 'src', 'alt', 'width', 'data-sm-signature']

/**
 * The composer's sanitizer. `insert`: the HTML goes into the editor's insertHTML (a paste): no bare span (the plain mode
 * too) and many top-level nodes in one wrapping div (insertHtml), from the same tree, with no second parse.
 */
export function sanitizeCompose(purify, html, { sessionId = null, tableRows = false, rich = false, insert = false } = {}) {
  const ownImage = src => SIG_IMG_SRC.test(src) || isPastedImageOf(src, sessionId)
  // a table made lines: in the rich mode (which keeps the table tag) unwrapped after the sanitizer, as the plain mode drops it
  const lined = new Set()
  const tables = (node, data) => {
    if (data.tagName === 'table' && node.rows) {
      tableToLines(node)
      if (rich) lined.add(node)
    }
  }
  const own = node => {
    const tag = node.nodeName ? node.nodeName.toLowerCase() : ''
    if (tag === 'img') {
      if (!ownImage(node.getAttribute('src') || '')) {
        node.remove()
        return
      }
      node.setAttribute('alt', '')
      if (node.hasAttribute('width') && !(isPastedImageOf(node.getAttribute('src'), sessionId) && askedWidth(node.getAttribute('width')) !== null)) node.removeAttribute('width')
    } else if (node.hasAttribute && node.hasAttribute('src')) node.removeAttribute('src')
    if (tag !== 'div' && node.hasAttribute && node.hasAttribute('data-sm-signature')) node.removeAttribute('data-sm-signature')
    if (tag !== 'img' && node.hasAttribute && node.hasAttribute('alt')) node.removeAttribute('alt')
    // rich: a table's, a cell's or a column's width is the rich rule's (below)
    if (tag !== 'img' && !rich && node.hasAttribute && node.hasAttribute('width')) node.removeAttribute('width')
    if (tag === 'a') {
      const href = node.getAttribute('href') || ''
      if (href && !/^(?:https?:|mailto:)/i.test(href)) node.removeAttribute('href')
    }
    if (rich && node.hasAttribute) {
      // the composer's own attributes on their own tags only (a link's href, an image's width), as the mirror writes them
      const keep = OWN_ATTRS.filter(n => (n !== 'width' || tag === 'img') && (n !== 'href' || tag === 'a')).flatMap(n => (node.hasAttribute(n) ? [[n, node.getAttribute(n)]] : []))
      keep.push(...richAttrs(tag, n => node.getAttribute(n)))
      for (const a of [...node.attributes]) node.removeAttribute(a.name)
      for (const [n, v] of keep) node.setAttribute(n, v)
    }
  }
  purify.addHook('afterSanitizeAttributes', own)
  if (tableRows) purify.addHook('uponSanitizeElement', tables)
  try {
    const config = {
      ALLOWED_TAGS: COMPOSE_TAGS,
      ALLOWED_ATTR: ['href', 'src', 'alt', 'width', 'data-sm-signature'],
      // DOMPurify checks every attribute that is not "URI safe" against ALLOWED_URI_REGEXP, which wants a scheme: a
      // width of "320" would go (measured); the hook below still keeps it only on a pasted image, as a number
      ADD_URI_SAFE_ATTR: ['width'],
      // sig-img: and inl-img: pass the URI check; the hook above keeps them on our own img only, links stay http(s)/mailto
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|sig-img:|inl-img:)/i,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: true,
    }
    if (!rich && !insert) return purify.sanitize(html || '', config)
    if (!rich) {
      const plain = purify.sanitize(html || '', { ...config, RETURN_DOM: true })
      if (!plain) return ''
      for (const span of [...plain.querySelectorAll('span')]) if (!span.attributes.length) span.replaceWith(...span.childNodes)
      return insertHtml(plain)
    }
    // every rich attribute but style is "URI safe" in no DOMPurify list (a colour, a number would fail the scheme check), so
    // they are added the same way as width; rich-style.js checks the values. The tree comes back (RETURN_DOM: the very body
    // DOMPurify serializes otherwise), so a font that kept no attribute can be unwrapped before it is serialized
    const body = purify.sanitize(html || '', {
      ...config,
      ALLOWED_TAGS: RICH_TAGS,
      ALLOWED_ATTR: [...config.ALLOWED_ATTR, ...RICH_ATTR_NAMES],
      ADD_URI_SAFE_ATTR: ['width', ...RICH_ATTR_NAMES],
      RETURN_DOM: true,
    })
    if (!body) return ''
    for (const table of lined) table.replaceWith(...table.childNodes)
    // a font or a span left with no attribute is unwrapped (its content stays): it formats nothing, and MEASURED (Electron
    // 45) the editor's insertHTML is quadratic in bare spans (2000 lines of 5 bare spans: 22 s; with a style: 0.3 s), which a
    // web page's copy makes once its noise styles are dropped
    for (const el of [...body.querySelectorAll('font, span')]) {
      if (!el.attributes.length) el.replaceWith(...el.childNodes)
    }
    return insert ? insertHtml(body) : body.innerHTML
  } finally {
    purify.removeHook('afterSanitizeAttributes', own)
    if (tableRows) purify.removeHook('uponSanitizeElement', tables)
  }
}
