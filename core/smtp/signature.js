// SPDX-License-Identifier: GPL-3.0-or-later
// The account's signature in a message body: ONE rule for the composer (renderer) and the MCP drafts (main process).
// Pure, no DOM: the renderer and the main process both import it.
//
// In the editor the signature is a marked block, so a change of the sender swaps just this block:
//   <div data-sm-signature=""><p>-- <br>text</p><p><img src="sig-img://account/<id>" alt=""></p></div>
// (an account without a signature still gets the empty block, so a later sender with one can fill it). The image sits
// UNDER the text; an image alone comes as "-- " and the image. Outgoing (send, draft save) the block is unwrapped
// (`unwrapSignature`): a text-only signature leaves byte for byte the old markup, and the image becomes an inline cid
// part (`inlineSignatureImages`).

export const SIG_IMG_SCHEME = 'sig-img'
export const SIGNATURE_ATTR = 'data-sm-signature'
// the cid of our own signature image: recognized when a saved draft is opened again
export const SIG_CID_RE = /^sig-[0-9a-f]{16,64}@shadowmail$/i

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/** The editor's src of an account's signature image. */
export const accountImageSrc = accountId => `${SIG_IMG_SCHEME}://account/${Number(accountId)}`

/** The signature block's inner HTML: the text (escaped, line breaks kept), the image under it. */
export function signatureInner(text, imageSrc) {
  const lines = text ? escapeHtml(text).replace(/\r?\n/g, '<br>') : ''
  const img = imageSrc ? `<img src="${escapeHtml(imageSrc)}" alt="">` : ''
  if (lines && img) return `<p>-- <br>${lines}</p><p>${img}</p>`
  if (lines) return `<p>-- <br>${lines}</p>`
  if (img) return `<p>-- <br>${img}</p>`
  return ''
}

/** The body's signature part: an empty line, then the marked block (empty when the account has no signature). */
export function signatureHtml(text, imageSrc = null) {
  return `<p><br></p><div ${SIGNATURE_ATTR}="">${signatureInner(text, imageSrc)}</div>`
}

/** The signature of an account row ({ id, signature, has_signature_image }) or of a composer account
 * ({ id, signature, hasImage }). */
export function accountSignatureHtml(account) {
  if (!account) return signatureHtml('')
  const hasImage = Boolean(account.hasImage ?? account.has_signature_image)
  return signatureHtml(account.signature || '', hasImage ? accountImageSrc(account.id) : null)
}

const BLOCK_RE = new RegExp(`<div ${SIGNATURE_ATTR}(?:="")?>`, 'g')

/**
 * Outgoing HTML: every signature block unwrapped (its marker div gone, its content in place). The block is the
 * composer's own markup, a div without other attributes; a block the user emptied leaves nothing.
 */
export function unwrapSignature(html) {
  let out = ''
  let at = 0
  BLOCK_RE.lastIndex = 0
  for (let m = BLOCK_RE.exec(html); m; m = BLOCK_RE.exec(html)) {
    // the matching </div>: count the nested divs inside the block (the composer writes divs in quotes, never in it,
    // but a paste could). Each next open / close position is searched again only once passed: one forward scan, so a
    // deep nesting stays linear (a fresh search per step was quadratic: 20 000 levels 3 s, in the main process)
    let depth = 1
    let i = m.index + m[0].length
    const inner = i
    let open = html.indexOf('<div', i)
    let close = html.indexOf('</div>', i)
    while (depth > 0) {
      if (close < 0) return html // not well formed: leave it as it is (the sanitizer wrote it, so this does not happen)
      if (open >= 0 && open < close) {
        depth++
        i = open + 4
        open = html.indexOf('<div', i)
      } else {
        depth--
        i = close + 6
        close = html.indexOf('</div>', i)
        if (open >= 0 && open < i) open = html.indexOf('<div', i)
      }
    }
    out += html.slice(at, m.index) + html.slice(inner, i - 6)
    at = i
    BLOCK_RE.lastIndex = i
  }
  return out + html.slice(at)
}
