// SPDX-License-Identifier: GPL-3.0-or-later
// HTML cleaning of a message body, the first line of defence. The result is shown in
// a sandboxed frame (no allow-scripts, no allow-same-origin) with its own CSP, and the main process
// net guard blocks every request it does not allow; this module removes what should not even try.
//
// Pure: the DOMPurify instance is passed in, so the same code runs in the renderer and, with jsdom,
// in node:test.
import { askedWidth } from '../../../core/smtp/image-width.js'
import { isTextColor, isHighlightStyle } from '../../../core/smtp/text-colors.js'

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

// With `colors` (the user's own text: what is sent or saved, and a saved draft opened again) the toolbar's colours stay too,
// and only they (core/smtp/text-colors.js): a font's color when it is a palette text colour, written exactly as the editor
// writes it, and a style on a span, a font or a b / strong / i / em / u / s / a / code when it is exactly one palette
// highlight (the editor writes a highlight onto a bold inside a coloured font, and onto a whole link or code element). Every other colour, style and font
// attribute goes, and a font left with neither is unwrapped (its content stays). Without it (a quote, a paste, a mailto
// body, a signature) no colour stays, and the result is the same as before colours were added.
const COLOR_TAGS = [...COMPOSE_TAGS, 'font']
const STYLED_TAGS = new Set(['span', 'font', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'code'])

export function sanitizeCompose(purify, html, { sessionId = null, tableRows = false, colors = false } = {}) {
  const ownImage = src => SIG_IMG_SRC.test(src) || isPastedImageOf(src, sessionId)
  const tables = (node, data) => {
    if (data.tagName === 'table' && node.rows) tableToLines(node)
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
    if (tag !== 'img' && node.hasAttribute && node.hasAttribute('width')) node.removeAttribute('width')
    if (tag === 'a') {
      const href = node.getAttribute('href') || ''
      if (href && !/^(?:https?:|mailto:)/i.test(href)) node.removeAttribute('href')
    }
    if (colors && node.hasAttribute) {
      if (node.hasAttribute('color') && !(tag === 'font' && isTextColor(node.getAttribute('color')))) node.removeAttribute('color')
      if (node.hasAttribute('style') && !(STYLED_TAGS.has(tag) && isHighlightStyle(node.getAttribute('style')))) node.removeAttribute('style')
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
    if (!colors) return purify.sanitize(html || '', config)
    // style is "URI safe" in DOMPurify already; color is not (a palette hex value would fail the scheme check), so it is added
    // the same way as width. The tree comes back (RETURN_DOM: the very body DOMPurify serializes otherwise), so a font
    // that kept no colour can be unwrapped before it is serialized
    const body = purify.sanitize(html || '', {
      ...config,
      ALLOWED_TAGS: COLOR_TAGS,
      ALLOWED_ATTR: [...config.ALLOWED_ATTR, 'color', 'style'],
      ADD_URI_SAFE_ATTR: ['width', 'color'],
      RETURN_DOM: true,
    })
    if (!body) return ''
    for (const font of [...body.querySelectorAll('font')]) {
      if (!font.hasAttribute('color') && !font.hasAttribute('style')) font.replaceWith(...font.childNodes)
    }
    return body.innerHTML
  } finally {
    purify.removeHook('afterSanitizeAttributes', own)
    if (tableRows) purify.removeHook('uponSanitizeElement', tables)
  }
}
