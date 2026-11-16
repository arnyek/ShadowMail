// SPDX-License-Identifier: GPL-3.0-or-later
// HTML cleaning of a message body, the first line of defence. The result is shown in
// a sandboxed frame (no allow-scripts, no allow-same-origin) with its own CSP, and the main process
// net guard blocks every request it does not allow; this module removes what should not even try.
//
// Pure: the DOMPurify instance is passed in, so the same code runs in the renderer and, with jsdom,
// in node:test.

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

/**
 * @param purify          a DOMPurify instance (DOMPurify(window))
 * @param html            the message's raw HTML
 * @param messageId       database id of the message (for cid-img://m<id>/<cid>)
 * @param imagesAllowed   "Képek betöltése" was pressed for this message
 * @returns { html, externalImages }  externalImages: how many external images the body has (shown or not)
 */
export function sanitizeMail(purify, html, { messageId, imagesAllowed = false }) {
  let externalImages = 0
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
    return { html: out, externalImages }
  } finally {
    purify.removeHook('afterSanitizeAttributes', afterAttributes)
  }
}

// The composer's own HTML: only what its toolbar makes, so a paste from a web page or a
// word processor cannot bring scripts, styles, images, forms or tracking into an outgoing message.
// The ONE exception is the account's signature (core/smtp/signature.js): its marked block (a div with
// data-sm-signature) and its image, an img whose src is our own sig-img:// scheme; any other image (http, cid:,
// data:) and the marker on any other element go.
export const COMPOSE_TAGS = ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'img']
const SIG_IMG_SRC = /^sig-img:\/\/(?:account\/\d{1,12}|session\/[A-Za-z0-9_-]{1,64})$/

export function sanitizeCompose(purify, html) {
  const own = node => {
    const tag = node.nodeName ? node.nodeName.toLowerCase() : ''
    if (tag === 'img') {
      if (!SIG_IMG_SRC.test(node.getAttribute('src') || '')) {
        node.remove()
        return
      }
      node.setAttribute('alt', '')
    } else if (node.hasAttribute && node.hasAttribute('src')) node.removeAttribute('src')
    if (tag !== 'div' && node.hasAttribute && node.hasAttribute('data-sm-signature')) node.removeAttribute('data-sm-signature')
    if (tag !== 'img' && node.hasAttribute && node.hasAttribute('alt')) node.removeAttribute('alt')
    if (tag === 'a') {
      const href = node.getAttribute('href') || ''
      if (href && !/^(?:https?:|mailto:)/i.test(href)) node.removeAttribute('href')
    }
  }
  purify.addHook('afterSanitizeAttributes', own)
  try {
    return purify.sanitize(html || '', {
      ALLOWED_TAGS: COMPOSE_TAGS,
      ALLOWED_ATTR: ['href', 'src', 'alt', 'data-sm-signature'],
      // sig-img: passes the URI check; the hook above keeps it on our own img only, and links stay http(s)/mailto
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|sig-img:)/i,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: true,
    })
  } finally {
    purify.removeHook('afterSanitizeAttributes', own)
  }
}
