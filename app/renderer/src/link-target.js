// SPDX-License-Identifier: GPL-3.0-or-later
// The link-target bar's logic (pure, runs in node:test too): where a hovered or focused link really goes, and
// whether its visible text shows a different address (a phishing pattern).
//
// The real target comes from the main process (Chromium's own status-bar URL, update-target-url): the message
// frame runs no script. The visible texts of the links come from the sanitizer (sanitize.js `links`).
//
// The registered domain (eTLD+1) uses a SMALL built-in list of two-level public suffixes (co.uk, com.au, co.hu...),
// not the full public-suffix list: a suffix missing here makes two different sites under it look like one domain
// (no warning), never the reverse for the listed ones.

/** Two-level public suffixes, the common ones. */
export const SECOND_LEVEL_SUFFIXES = new Set([
  // United Kingdom, Australia, New Zealand, South Africa, Ireland-like
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'police.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.za', 'org.za', 'gov.za', 'ac.za',
  // Hungary (the second-level names a registrar sells)
  'co.hu', 'org.hu', 'info.hu', 'priv.hu', 'tm.hu', 'shop.hu', 'bolt.hu', 'sport.hu', 'media.hu', 'hotel.hu',
  'film.hu', 'news.hu', 'city.hu', 'agrar.hu', 'suli.hu', 'utazas.hu', 'ingatlan.hu', 'forum.hu', 'reklam.hu',
  // Asia
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'gr.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'firm.in',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'org.hk', 'net.hk', 'gov.hk', 'edu.hk',
  'com.tw', 'org.tw', 'net.tw', 'gov.tw', 'edu.tw',
  'com.sg', 'org.sg', 'net.sg', 'gov.sg', 'edu.sg',
  'com.my', 'org.my', 'net.my', 'gov.my',
  'co.id', 'or.id', 'go.id', 'ac.id',
  'co.th', 'or.th', 'go.th', 'ac.th', 'in.th',
  'com.ph', 'org.ph', 'net.ph', 'gov.ph',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'com.tr', 'org.tr', 'net.tr', 'gov.tr', 'edu.tr',
  'com.sa', 'gov.sa', 'com.eg', 'com.pk',
  // Europe
  'com.pl', 'net.pl', 'org.pl', 'gov.pl',
  'com.ua', 'org.ua', 'net.ua', 'gov.ua',
  'co.at', 'or.at', 'gv.at', 'ac.at',
  'com.gr', 'com.cy', 'com.mt', 'com.ru', 'org.ru', 'com.ro', 'com.hr', 'co.rs', 'org.rs',
  // Americas
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'org.mx', 'gob.mx', 'com.ar', 'gob.ar', 'com.co', 'com.pe', 'com.ve', 'com.uy', 'com.ec', 'com.bo',
  'co.ca', 'gc.ca',
])

// A text like "report.pdf" or "invoice.zip" is a file name, not a domain: no warning for these "top-level domains"
const FILE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'txt', 'rtf', 'csv', 'zip', 'rar', 'gz', 'tar',
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'tif', 'tiff', 'mp3', 'mp4', 'mov', 'avi', 'wav', 'mkv',
  'htm', 'html', 'php', 'asp', 'aspx', 'jsp', 'xml', 'json', 'eml', 'msg', 'ics', 'vcf', 'exe', 'msi',
])

const MAX_TEXT = 300

/** The host in its ASCII (punycode) form, lower case, no trailing dot; null if it is not a host. */
export function asciiHost(host) {
  const h = String(host || '').trim().replace(/\.$/, '')
  if (!h || /[\s/?#@\\]/.test(h)) return null
  try {
    const out = new URL(`http://${h}/`).hostname
    return out ? out.toLowerCase().replace(/\.$/, '') : null
  } catch {
    return null
  }
}

const isIp = host => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[')

/** The registered domain (eTLD+1) of an ASCII host, with the built-in suffix list; an IP address is itself. */
export function registeredDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '')
  if (!h || isIp(h)) return h
  const labels = h.split('.')
  if (labels.length <= 2) return h
  const lastTwo = labels.slice(-2).join('.')
  return labels.slice(SECOND_LEVEL_SUFFIXES.has(lastTwo) ? -3 : -2).join('.')
}

/**
 * The address a link's visible text shows, as an ASCII host; null if the text is not an address
 * ("Kattints ide", a file name, a sentence). Accepted: a URL with a scheme ("https://..."), a bare domain or a
 * domain with a path ("otpbank.hu", "www.otpbank.hu/belepes"), an e-mail address ("info@example.org").
 */
export function addressOfText(text) {
  let s = String(text || '').slice(0, MAX_TEXT).replace(/[\u200b-\u200d\u2060\ufeff]/g, '').trim()
  s = s.replace(/^[<("'\u201c\u201e[]+/, '').replace(/[>)"'\u201d\].,;:!?]+$/, '')
  if (!s || /\s/.test(s)) return null
  const mail = /^(?:mailto:)?[^@/:]+@([^@/?#]+)$/i.exec(s)
  if (mail) return /\./.test(mail[1]) ? asciiHost(mail[1]) : null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      return /^(?:https?|ftp):$/.test(u.protocol) && u.hostname ? asciiHost(u.hostname) : null
    } catch {
      return null
    }
  }
  const m = /^((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(\p{L}{2,63}))(?::\d{1,5})?([/?#].*)?$/u.exec(s)
  if (!m) return null
  // "report.pdf": a file name; "www.report.pdf" or "report.pdf/x" would be odd, but only the bare form is excused
  if (FILE_EXTENSIONS.has(m[2].toLowerCase()) && !m[3] && !/^www\./i.test(s)) return null
  return asciiHost(m[1])
}

// RFC 3492 (Punycode) decoding, for showing an xn-- label in its Unicode form
const BASE = 36
const decodeLabel = label => {
  const input = label.slice(4)
  const output = []
  const delim = input.lastIndexOf('-')
  for (let j = 0; j < Math.max(delim, 0); j++) {
    if (input.charCodeAt(j) >= 0x80) return null
    output.push(input.charCodeAt(j))
  }
  let n = 128
  let bias = 72
  let i = 0
  const adapt = (delta, points, first) => {
    let d = first ? Math.floor(delta / 700) : delta >> 1
    d += Math.floor(d / points)
    let k = 0
    while (d > 455) {
      d = Math.floor(d / 35)
      k += BASE
    }
    return k + Math.floor((36 * d) / (d + 38))
  }
  for (let pos = delim > 0 ? delim + 1 : 0; pos < input.length; ) {
    const oldi = i
    let w = 1
    for (let k = BASE; ; k += BASE) {
      if (pos >= input.length) return null
      const c = input.charCodeAt(pos++)
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : BASE
      if (digit >= BASE) return null
      i += digit * w
      const tk = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias
      if (digit < tk) break
      w *= BASE - tk
      if (i > 0x10ffff * 4 || w > 0x10ffff * 4) return null
    }
    bias = adapt(i - oldi, output.length + 1, oldi === 0)
    n += Math.floor(i / (output.length + 1))
    i %= output.length + 1
    if (n > 0x10ffff) return null
    output.splice(i++, 0, n)
  }
  let out
  try {
    out = String.fromCodePoint(...output)
  } catch {
    return null
  }
  // a valid xn-- label decodes to something non-ASCII, and a control or invisible character is never shown as one
  return /[^\x00-\x7f]/.test(out) && !/[\p{C}\p{Z}]/u.test(out) ? out : null
}

/** The Unicode form of an ASCII host (xn-- labels decoded); the label stays as it is if it does not decode. */
export function unicodeHost(host) {
  return String(host || '')
    .split('.')
    .map(l => (/^xn--/i.test(l) ? decodeLabel(l.toLowerCase()) || l : l))
    .join('.')
}

const hasPunycode = host => String(host || '').split('.').some(l => /^xn--/i.test(l))

/**
 * What the bar shows for a target URL.
 * @param url    the real target (Chromium's status-bar URL)
 * @param texts  the visible texts of the message's links with this target (sanitize.js `links`), [] if unknown
 * @returns null (nothing to show) or { kind: 'web'|'mailto'|'other', scheme, user, sub, domain, rest, host,
 *          unicode (the Unicode host, only if it has xn-- labels), mismatch (the host the text shows, or null) }
 */
export function linkTarget(url, texts = []) {
  const raw = String(url || '')
  if (!raw) return null
  let u
  try {
    u = new URL(raw)
  } catch {
    return { kind: 'other', scheme: '', user: '', sub: '', domain: '', rest: raw, host: '', unicode: null, mismatch: null }
  }
  let host = ''
  let user = ''
  let rest = ''
  let kind = 'other'
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    kind = 'web'
    host = u.hostname.toLowerCase().replace(/\.$/, '')
    // "https://otpbank.hu@evil.example/": the part before @ is not the host; shown, but not as the host
    if (u.username || u.password) user = `${shortUser(decodeSafe(u.username))}${u.password ? ':***' : ''}@`
    rest = `${u.port ? `:${u.port}` : ''}${u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname}${u.search}${u.hash}`
  } else if (u.protocol === 'mailto:') {
    kind = 'mailto'
    const address = decodeSafe(u.pathname.split(',')[0])
    const at = address.lastIndexOf('@')
    if (at > 0) {
      host = asciiHost(address.slice(at + 1)) || ''
      user = `${address.slice(0, at)}@`
    } else {
      user = address
    }
  } else {
    return { kind, scheme: u.protocol, user: '', sub: '', domain: '', rest: raw.slice(u.protocol.length), host: '', unicode: null, mismatch: null }
  }
  const domain = host ? registeredDomain(host) : ''
  const sub = host && host.length > domain.length ? host.slice(0, host.length - domain.length) : ''
  let mismatch = null
  if (host) {
    for (const text of texts) {
      const shown = addressOfText(text)
      if (shown && registeredDomain(shown) !== domain) {
        mismatch = shown
        break
      }
    }
  }
  const scheme = kind === 'web' ? `${u.protocol}//` : 'mailto:'
  return { kind, scheme, user, sub, domain, rest, host, unicode: hasPunycode(host) ? unicodeHost(host) : null, mismatch }
}

// a user part can be thousands of characters; the bar shows its start and end, so the host after it stays in view
const USER_MAX = 48
function shortUser(user) {
  return user.length > USER_MAX ? `${user.slice(0, 24)}\u2026${user.slice(-16)}` : user
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** The key the sanitizer's link list and the status-bar URL meet on (both parsed the same way). */
export function linkKey(href) {
  try {
    return new URL(String(href).trim()).href
  } catch {
    return null
  }
}

/** Map of linkKey -> visible texts, from the sanitizer's links ({ href, text }). */
export function linkTexts(links) {
  const map = new Map()
  for (const { href, text } of links || []) {
    const key = linkKey(href)
    if (!key) continue
    const list = map.get(key)
    if (list) {
      if (list.length < 20 && !list.includes(text)) list.push(text)
    } else map.set(key, [text])
  }
  return map
}

/**
 * Which of the message's links the reported target is: { target, texts } or null (none of them).
 * `target` is the URL the bar shows and checks: the reported one, or, for a cut report (the main process sent only
 * the start of a very long URL), the message's OWN full link. The bar never parses a cut URL: the cut can fall inside
 * the user part ("https://a.a....otpbank.hu" + "...@evil.example/") and would show a false host. If several links start
 * with the cut report and their hosts differ, `target` is null (the bar cannot tell which one it is).
 * Every link whose key starts with a cut report counts (a linear pass over at most MAX_LINKS keys, only then).
 */
export function matchFor(map, url, cut = false) {
  if (!cut) {
    const texts = map.get(linkKey(url))
    return texts ? { target: url, texts } : null
  }
  const keys = []
  let texts = []
  for (const [key, list] of map) {
    if (key.length >= url.length && key.startsWith(url)) {
      keys.push(key)
      texts = [...texts, ...list]
    }
  }
  if (!keys.length) return null
  const hosts = new Set(keys.map(k => (linkTarget(k) || {}).host))
  return { target: hosts.size === 1 ? keys[0] : null, texts }
}
