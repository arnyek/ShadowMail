// SPDX-License-Identifier: GPL-3.0-or-later
// A whole message for the reader: headers, text and raw HTML, attachments with their
// content, the external image hosts. The HTML is NOT cleaned here: the renderer sanitizes it
// (DOMPurify) and shows it in a sandboxed frame; this module only parses and classifies.
import { simpleParser } from 'mailparser'
import { Parser } from 'htmlparser2'
import path from 'node:path'
import { MAIN_HTML_LIMIT, HTML_TOTAL, htmlTooLong } from './text.js'
import { utf8Headers, headerEnd } from './raw-headers.js'
import { fmtAddr, fmtAddrs } from './envelope.js'

// Executables, plus a few more types Windows runs or installs when opened (stricter is allowed).
export const EXECUTABLE_EXTENSIONS = Object.freeze([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1', '.vbs', '.js', '.jse', '.wsf', '.hta', '.lnk', '.cpl', '.reg', '.jar',
  '.pif', '.msp', '.mst', '.msc', '.vbe', '.wsc', '.wsh', '.ws', '.psm1', '.psd1', '.ps1xml', '.scf', '.url', '.inf', '.gadget',
  '.application', '.appref-ms', '.settingcontent-ms', '.library-ms', '.search-ms', '.chm', '.dll', '.sys', '.drv', '.ocx',
  '.iso', '.img', '.vhd', '.vhdx', '.appx', '.appxbundle', '.msix', '.msixbundle', '.diagcab', '.xll', '.website',
  // Outlook's blocked list: opened, Windows runs, installs or connects with these
  // (.rdp connects to a remote machine, .searchconnector-ms to a remote share; interpreters run the rest)
  '.rdp', '.searchconnector-ms', '.appinstaller', '.vsto', '.theme', '.themepack', '.desktopthemepackfile', '.wsb', '.msu',
  '.sct', '.shb', '.shs', '.hlp', '.ins', '.isp', '.jnlp', '.py', '.pyw', '.pyc', '.pyo', '.pl', '.xbap', '.vb', '.appcontent-ms',
  '.printerexport', '.ps2', '.ps2xml', '.psc1', '.psc2', '.cer', '.crt', '.der',
  '.mdb', '.mde', '.ade', '.adp', '.accdb', '.accde', '.mad', '.maf', '.mag', '.mam', '.maq', '.mar', '.mas', '.mat', '.mav', '.maw',
])

// Not programs, but opened by the browser as active content (scripts) from file://, outside the
// message frame's sandbox and the net guard. Save only, like the executables; kept as
// a separate list so the tests and the UI can say why. .xml: an XHTML namespace can run script.
export const BROWSER_ACTIVE_EXTENSIONS = Object.freeze([
  '.html', '.htm', '.xhtml', '.xht', '.shtml', '.svg', '.svgz', '.mht', '.mhtml', '.xml', '.xsl', '.xslt',
])

// "Megnyitás" ONLY for these; everything else can only be saved.
// The macro Office types (.docm .xlsm .pptm .dotm .xltm .potm .ppsm .xlsb), .rtf, .csv and the slide shows
// that start on open (.pps .ppsx) are left out on purpose. The two lists above stay as a second line.
export const OPENABLE_EXTENSIONS = Object.freeze([
  '.pdf',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff',
  '.txt',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp',
])

// device names, also with spaces before the extension ("CON .txt") and with superscript digits ("COM¹")
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])\s*(\..*)?$/i

/**
 * A file name that is safe to create on Windows: no folders, no control or reserved characters, no
 * trailing dots or spaces (Windows drops them, so "a.exe." would become "a.exe"), no device names.
 */
export function safeFileName(name, fallback = 'melleklet') {
  let n = String(name || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*‪-‮⁦-⁩]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  if (!n || /^\.+$/.test(n)) n = fallback
  if (WINDOWS_RESERVED.test(n)) n = `_${n}`
  if (n.length > 150) {
    const ext = path.extname(n).slice(0, 20)
    n = n.slice(0, 150 - ext.length) + ext
  }
  return n
}

/** Whether opening the file would run something. Decided on the name that would be written to disk. */
export function isExecutableName(name) {
  const ext = path.extname(safeFileName(name)).toLowerCase()
  return EXECUTABLE_EXTENSIONS.includes(ext)
}

/** Whether the browser would open the file as active content (HTML, SVG, MHT, XML). */
export function isBrowserActiveName(name) {
  const ext = path.extname(safeFileName(name)).toLowerCase()
  return BROWSER_ACTIVE_EXTENSIONS.includes(ext)
}

/** Whether "Megnyitás" may open the file: its last extension is on the allow list; no extension: no. */
export function isOpenableName(name) {
  const ext = path.extname(safeFileName(name)).toLowerCase()
  return OPENABLE_EXTENSIONS.includes(ext)
}

const isRemote = url => /^\s*(https?:)?\/\//i.test(url || '')

/** URLs of a srcset attribute ("a.png 1x, b.png 2x"). */
export function srcsetUrls(value) {
  return String(value || '')
    .split(',')
    .map(c => c.trim().split(/\s+/)[0])
    .filter(Boolean)
}

function hostOf(url) {
  try {
    const u = new URL(url.trim().startsWith('//') ? `https:${url.trim()}` : url.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Hosts of the external images (<img src>, <img srcset>) of a message. These are what "Képek
 * betöltése" allows in the net guard; CSS url(), <link>, other tags stay blocked.
 */
export function externalImageHosts(html) {
  const hosts = new Set()
  if (!html) return hosts
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name !== 'img') return
        const urls = [attrs.src, ...srcsetUrls(attrs.srcset)].filter(isRemote)
        for (const u of urls) {
          const h = hostOf(u)
          if (h) hosts.add(h)
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  )
  parser.write(html)
  parser.end()
  return hosts
}

export const REPLACEMENT_CHAR = '\uFFFD'

/** Whether a stored row shows a header decoded with U+FFFD (a raw 8-bit field read as UTF-8 before 0.15.1). */
export const hasBrokenHeader = row => [row.subject, row.from_name, row.to_addrs, row.cc_addrs].some(v => typeof v === 'string' && v.includes(REPLACEMENT_CHAR))

const addressList = field => {
  if (!field) return []
  const objs = Array.isArray(field) ? field : [field]
  return objs.flatMap(o => o.value || []).flatMap(a => (a.group ? a.group : [a])).map(a => ({ name: a.name || '', address: a.address || '' }))
}

/**
 * A header block (the whole message works too, only its headers are read) -> the list row's header columns, decoded like
 * parseMessage: { subject, from_addr, from_name, to_addrs, cc_addrs, sender_text, recipients_text }. allSenders: the
 * search text of the sender names every From address (the POP3 rule), else the first (the IMAP rule).
 */
export async function headerColumns(headers, { allSenders = false } = {}) {
  // only the header block: no body, no attachment is parsed
  const end = Buffer.isBuffer(headers) ? headerEnd(headers) : -1
  const block = end > 0 ? Buffer.concat([headers.subarray(0, end), Buffer.from('\r\n')]) : headers
  const p = await simpleParser(utf8Headers(block), { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true })
  const from = addressList(p.from)
  const to = fmtAddrs(addressList(p.to))
  const cc = fmtAddrs(addressList(p.cc))
  return {
    subject: p.subject || '',
    from_addr: (from[0] && from[0].address) || null,
    from_name: (from[0] && from[0].name) || null,
    to_addrs: to,
    cc_addrs: cc,
    sender_text: allSenders ? fmtAddrs(from) : fmtAddr(from[0]),
    recipients_text: [to, cc].filter(Boolean).join(', '),
  }
}

/**
 * Raw message -> { subject, from, to, cc, replyTo, date, messageId, inReplyTo, references, text, html, attachments }.
 * html keeps its cid: links (the reader serves them); attachments carry their content (Buffer).
 * Charsets (UTF-8, ISO-8859-2, windows-1250, ...) are decoded by mailparser (iconv-lite); a top-level header field sent as
 * raw 8-bit bytes that are not UTF-8 is first rewritten as UTF-8 in the message's charset (raw-headers.js).
 * attachmentFallback: the name of an attachment without one is `<attachmentFallback>-<n>`; the default ("melleklet") is
 * what the sync stores and what goes to Claude, the reader passes the interface language's word.
 * htmlText: mailparser makes `text` of the message's HTML parts too, capped (MAIN_HTML_LIMIT on the sum of the HTML parts
 * it converts, html-total.js; over it no HTML part is converted and `htmlTextLate` is true). Off by default: every caller reads the HTML when there is one (the view, the quote,
 * MCP), and that conversion is quadratic in the text of a table (5.3 MB of tiny cells: 89 s on the main thread). Only
 * the reader's old-rule text and preview of a row not indexed yet need it.
 */
export async function parseMessage(source, { attachmentFallback = 'melleklet', htmlText = false } = {}) {
  const base = { keepCidLinks: true, skipImageLinks: true, skipTextLinks: true, skipTextToHtml: true }
  const p = await simpleParser(utf8Headers(source), htmlText ? { ...base, maxHtmlLengthToParse: MAIN_HTML_LIMIT, htmlTotal: HTML_TOTAL } : { ...base, skipHtmlToText: true })
  const attachments = (p.attachments || []).map((a, index) => {
    const filename = safeFileName(a.filename, `${attachmentFallback}-${index + 1}`)
    const contentType = String(a.contentType || 'application/octet-stream').toLowerCase()
    const cid = a.cid ? String(a.cid).replace(/^<|>$/g, '') : null
    return {
      index,
      filename,
      contentType,
      size: a.size ?? (a.content ? a.content.length : 0),
      cid,
      // a related inline image (logo, embedded picture) is shown in the body, not offered as a file
      inline: Boolean(cid) && a.contentDisposition !== 'attachment' && contentType.startsWith('image/'),
      executable: isExecutableName(filename),
      browserActive: isBrowserActiveName(filename),
      openable: isOpenableName(filename),
      content: a.content || Buffer.alloc(0),
    }
  })
  return {
    subject: p.subject || '',
    from: addressList(p.from),
    to: addressList(p.to),
    cc: addressList(p.cc),
    bcc: addressList(p.bcc), // a saved draft keeps its Bcc line; a received message has none
    replyTo: addressList(p.replyTo),
    // "claude" on a draft Claude made (X-ShadowMail-Draft-Origin), else null
    draftOrigin: p.headers && p.headers.get ? String(p.headers.get('x-shadowmail-draft-origin') || '').trim().toLowerCase() || null : null,
    date: p.date instanceof Date && !Number.isNaN(p.date.getTime()) ? p.date.getTime() : null,
    messageId: p.messageId || null,
    inReplyTo: typeof p.inReplyTo === 'string' && p.inReplyTo ? p.inReplyTo.trim() : null,
    references: (Array.isArray(p.references) ? p.references : p.references ? String(p.references).split(/\s+/) : []).filter(Boolean),
    text: typeof p.text === 'string' ? p.text : '',
    html: typeof p.html === 'string' && p.html ? p.html : null,
    // htmlText asked, but an HTML part was over the cap: no text of it here (the worker makes the preview)
    htmlTextLate: htmlText && htmlTooLong(p),
    attachments,
  }
}
