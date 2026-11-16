// SPDX-License-Identifier: GPL-3.0-or-later
// The message frame's two schemes.
//
//   mail-view://view/<token>       the sanitized body of the open message, with its OWN CSP header.
//   cid-img://m<message id>/<cid>  an embedded (cid:) image of the open message.
//   sig-img://account/<id>         an account's signature image, in the composer (core/smtp/signature.js);
//   sig-img://session/<id>         the signature image of a draft opened again (its own bytes, in the session).
//
// Why not <iframe srcdoc>: a srcdoc document inherits the CSP of the app page (measured:
// inline styles of the mail stayed blocked by the app's style-src 'self'), so the mail could only be
// styled by loosening the app's own policy. A document loaded from its own scheme has its own CSP,
// and the app page only needs frame-src mail-view:. The frame is still sandboxed without
// allow-scripts and allow-same-origin.

export const VIEW_SCHEME = 'mail-view'
export const CID_SCHEME = 'cid-img'
export const SIG_SCHEME = 'sig-img'

/** Call before app 'ready'. */
export function registerMailSchemes(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: VIEW_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: CID_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: SIG_SCHEME, privileges: { standard: true, secure: true } },
  ])
}

export function viewCsp(imagesAllowed) {
  const img = `${CID_SCHEME}: data:${imagesAllowed ? ' https: http:' : ''}`
  return `default-src 'none'; style-src 'unsafe-inline'; img-src ${img}; font-src data:; form-action 'none'; base-uri 'none'`
}

// Readable defaults for mails that bring no styles; the mail's own CSS wins.
const BASE_STYLE = `html{color-scheme:light}body{margin:12px;font:14px/1.45 "Segoe UI",system-ui,sans-serif;color:#1f2328;background:#fff;overflow-wrap:anywhere}
img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:0 0 0 8px;padding-left:8px;border-left:3px solid #d0d7de}`

export function viewDocument(bodyHtml, imagesAllowed) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${viewCsp(imagesAllowed)}">` +
    `<meta name="referrer" content="no-referrer"><style>${BASE_STYLE}</style></head><body>${bodyHtml}</body></html>`
}

const notFound = () => new Response('', { status: 404, headers: { 'content-type': 'text/plain' } })

/** Call after 'ready'. `reader` is the MessageReader; `signature(kind, ref)` -> { type, bytes } or null. */
export function handleMailProtocols({ protocol, reader, signature = () => null, log = () => {} }) {
  protocol.handle(SIG_SCHEME, request => {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return notFound()
    }
    const ref = url.pathname.replace(/^\//, '')
    const ok = (url.host === 'account' && /^\d{1,12}$/.test(ref)) || (url.host === 'session' && /^[A-Za-z0-9_-]{1,64}$/.test(ref))
    const img = ok ? signature(url.host, ref) : null
    if (!img) return notFound()
    return new Response(img.bytes, { headers: { 'content-type': img.type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } })
  })

  protocol.handle(VIEW_SCHEME, request => {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return notFound()
    }
    const token = url.pathname.replace(/^\//, '')
    const doc = url.host === 'view' ? reader.view(token) : null
    if (!doc) return notFound()
    const csp = viewCsp(doc.imagesAllowed)
    return new Response(viewDocument(doc.html, doc.imagesAllowed), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': csp,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      },
    })
  })

  protocol.handle(CID_SCHEME, request => {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return notFound()
    }
    const m = /^m(\d+)$/.exec(url.host)
    let cid
    try {
      cid = decodeURIComponent(url.pathname.replace(/^\//, ''))
    } catch {
      return notFound()
    }
    const part = m ? reader.cidImage(Number(m[1]), cid) : null
    if (!part) {
      log(`cid-img: not served ${url.host}`)
      return notFound()
    }
    return new Response(part.content, {
      headers: { 'content-type': part.contentType, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
    })
  })
}
