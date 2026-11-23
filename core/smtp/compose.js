// SPDX-License-Identifier: GPL-3.0-or-later
// Building an outgoing message: HTML + an automatic plain-text part,
// attachments, threading headers. nodemailer's MailComposer does the MIME work (encoded-words for
// accented names and subjects, RFC 2231 file names, base64 / quoted-printable).
//
// Two raw forms of the same message:
//   raw        what goes to the SMTP server: no Bcc header (the Bcc addresses are only in the envelope)
//   sentCopy   what is kept in Sent / Drafts: with the Bcc header, so the user sees who got a blind copy
//              (as Thunderbird and Outlook keep it); it never travels to a recipient
import crypto from 'node:crypto'
import MailComposer from 'nodemailer/lib/mail-composer'
import { htmlToPlain } from '../mime/text.js'
import { textBlocks } from '../mime/text-blocks.js'

const addr = a => (a && a.address ? { name: a.name || '', address: a.address } : null)
const list = xs => (xs || []).map(addr).filter(Boolean)

/** A Message-ID on the sender's domain. */
export function newMessageId(fromAddress) {
  const domain = String(fromAddress || '').split('@')[1] || 'shadowmail.invalid'
  return `<${crypto.randomUUID()}@${domain.replace(/[^a-z0-9.-]/gi, '') || 'shadowmail.invalid'}>`
}

async function build(mail, keepBcc) {
  const node = new MailComposer(mail).compile()
  node.keepBcc = keepBcc
  return { raw: await node.build(), envelope: node.getEnvelope() }
}

/**
 * @param from        { name, address }
 * @param to, cc, bcc [{ name, address }]
 * @param subject     string
 * @param html        the editor's (sanitized) HTML, or null for a plain-text message
 * @param text        plain text; derived from html when missing
 * @param attachments [{ filename, content: Buffer, contentType? }]
 * @param inReplyTo, references   threading, references as an array of <message-id>s
 * @returns { raw, sentCopy, envelope: { from, to: [every recipient incl. Bcc] }, messageId, date }
 */
export async function composeMessage({ from, to = [], cc = [], bcc = [], subject = '', html = null, text = null, attachments = [], inReplyTo = null, references = [], messageId = null, date = new Date(), headers = {} }) {
  const sender = addr(from)
  if (!sender) throw Object.assign(new Error('no sender'), { code: 'no_sender' })
  const id = messageId || newMessageId(sender.address)
  const mail = {
    from: sender,
    to: list(to),
    cc: list(cc),
    bcc: list(bcc),
    subject,
    date,
    messageId: id,
    // a table as TAB-separated lines (the composer keeps a table a table: rich)
    text: text ?? (html ? htmlToPlain(html, { tables: true }) : ''),
    html: html || undefined,
    // an attachment with a cid is an inline part of the HTML (the signature image): nodemailer then builds multipart/related
    attachments: attachments.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType || undefined, ...(a.cid ? { cid: a.cid, contentDisposition: 'inline' } : {}) })),
    inReplyTo: inReplyTo || undefined,
    references: references && references.length ? references.join(' ') : undefined,
    headers: { ...headers, 'X-Mailer': 'ShadowMail' },
    // never fetch anything while building (nodemailer can load path/href attachments): only Buffers here
    disableFileAccess: true,
    disableUrlAccess: true,
  }
  const [{ raw, envelope }, { raw: sentCopy }] = await Promise.all([build(mail, false), build(mail, true)])
  return { raw, sentCopy, envelope, messageId: id, date }
}

// Reply, reply all, forward. Pure helpers: the composer fills its form from them.

const escapeHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const fmtOne = a => (a.name ? `${a.name} <${a.address}>` : a.address)
const fmtList = xs => (xs || []).map(fmtOne).join(', ')

// "Re:", "RE:", "Re[2]:", "Vá:", "Válasz:", "AW:", "SV:" / "Fwd:", "Fw:", "WG:", "Továbbítás:" at the start
const REPLY_PREFIX = /^\s*(re|aw|sv|vs|vá|válasz)(\[\d+\])?\s*:\s*/i
const FORWARD_PREFIX = /^\s*(fwd?|wg|tov|továbbítás|továbbított)(\[\d+\])?\s*:\s*/i

/** "Re: " once: an existing reply prefix (any common language or case) is not doubled. */
export function replySubject(subject) {
  const s = String(subject || '').trim()
  return `Re: ${s.replace(REPLY_PREFIX, '')}`
}

export function forwardSubject(subject) {
  const s = String(subject || '').trim()
  return `Fwd: ${s.replace(FORWARD_PREFIX, '')}`
}

/** References of a reply: the original's References + its Message-ID, no duplicates, order kept. */
export function replyReferences(original) {
  const out = []
  for (const r of [...(original.references || []), original.messageId]) if (r && !out.includes(r)) out.push(r)
  return out
}

/**
 * Recipients of a reply. To: Reply-To, else From. all = true: the original To joins To, its Cc stays Cc.
 * Our own addresses (every account of the app, any case) are left out, every address once.
 * A message WE sent (From is one of our addresses, e.g. from Sent), like Thunderbird (planner, msg
 * 1860): reply -> To = the original To; reply all -> To = the original To, Cc = the original Cc; our
 * own addresses still left out, and if To would stay empty (a message to oneself) the sender stays.
 */
export function replyRecipients(original, { all = false, ownAddresses = [] }) {
  const own = new Set(ownAddresses.map(a => String(a).toLowerCase()))
  const seen = new Set()
  const keep = list =>
    (list || []).filter(a => {
      const key = String(a.address || '').toLowerCase()
      if (!key || own.has(key) || seen.has(key)) return false
      seen.add(key)
      return true
    })
  const fromOwn = (original.from || []).some(a => own.has(String(a.address || '').toLowerCase()))
  if (fromOwn) {
    const to = keep(original.to)
    const cc = all ? keep(original.cc) : []
    return { to: to.length ? to : (original.from || []).slice(0, 1), cc }
  }
  const first = original.replyTo && original.replyTo.length ? original.replyTo : original.from
  const to = keep([...(first || []), ...(all ? original.to || [] : [])])
  const cc = all ? keep(original.cc) : []
  return { to, cc }
}

// the quote's and the forwarded block's date: one formatter per locale (the interface language's, from the caller)
const dateFmts = new Map()
function dateFmt(locale) {
  let f = dateFmts.get(locale)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    dateFmts.set(locale, f)
  }
  return f
}

const lineBreaks = s => escapeHtml(s).replace(/\r?\n/g, '<br>')

/** Length of the line break that ends s at `end` (2 for CRLF, 1 for LF), 0 when none. */
function breakBefore(s, end) {
  if (end > 0 && s.charCodeAt(end - 1) === 10) return end > 1 && s.charCodeAt(end - 2) === 13 ? 2 : 1
  return 0
}

/**
 * The blocks of a long text as block elements. A boundary falls where a line ends (or inside a line longer than
 * LONG_LINE), so the block's own last line break IS the boundary and is left out. Empty lines at a block's end move to the
 * start of the next block: a trailing <br> draws no line in a browser but is a line in the text part (html-to-text), a
 * leading one is a line in both (measured: the same text part as the old one <p>). A block of line breaks only is carried
 * whole, so no empty element is left (an empty <div> is no line in a browser, but one in the text part).
 * Linear (measured: a regex over the carried run was quadratic, 160 000 empty lines took 23 s in the main process): the
 * carried line breaks are a COUNT, and a block's trailing line breaks are counted from its end, each character once.
 */
function blocksHtml(blocks) {
  const out = []
  let carry = 0 // line breaks carried to the start of the next block
  blocks.forEach((b, i) => {
    let end = b.length
    let carryNext = 0
    if (i < blocks.length - 1) {
      const last = breakBefore(b, end)
      if (last) {
        end -= last // the boundary itself
        for (let n = breakBefore(b, end); n; n = breakBefore(b, end)) {
          end -= n
          carryNext++
        }
        if (end === 0) {
          // line breaks only: carried whole (the boundary too), no element
          carry += carryNext + 1
          return
        }
      }
    }
    out.push(`<div>${'<br>'.repeat(carry)}${lineBreaks(b.slice(0, end))}</div>`)
    carry = carryNext
  })
  return `<div>${out.join('')}</div>`
}

/**
 * The original's body for quoting: its HTML, or its text escaped with line breaks. A long text goes in blocks of the reader's
 * cutter (text-blocks.js): one <p> of a 2 MB alternating Hebrew text froze the composer (measured: 0 of 5
 * ready in 30 s); one block element per piece keeps the layout cost linear. One block: exactly the old output.
 */
function bodyHtml(original) {
  if (original.html) return original.html
  const blocks = textBlocks(original.text || '')
  if (blocks.length <= 1) return `<p>${lineBreaks(original.text || '')}</p>`
  return blocksHtml(blocks)
}

/**
 * The words of the outgoing quote and forward come from the caller, in the interface language (they go to the
 * recipient): `text` = { wrote: header => line, forwarded: the separator line, labels: { from, date, subject, to, cc } }
 * (the i18n `outgoingQuote`), `locale` the date's (the i18n `locale`).
 */
function checkText(text, locale) {
  if (!text || typeof text.wrote !== 'function' || typeof text.forwarded !== 'string' || !text.labels || typeof locale !== 'string') {
    throw new Error('quote text and locale needed')
  }
}

function replyParts(original, text, locale) {
  checkText(text, locale)
  const when = original.date ? dateFmt(locale).format(new Date(original.date)) : ''
  const who = fmtList(original.from) || ''
  return { before: `<p>${text.wrote(escapeHtml([when, who].filter(Boolean).join(', ')))}</p><blockquote>`, body: bodyHtml(original), after: '</blockquote>' }
}
function forwardParts(original, text, locale) {
  checkText(text, locale)
  const l = text.labels
  const lines = [
    [l.from, fmtList(original.from)],
    [l.date, original.date ? dateFmt(locale).format(new Date(original.date)) : ''],
    [l.subject, original.subject || ''],
    [l.to, fmtList(original.to)],
    [l.cc, fmtList(original.cc)],
  ].filter(([, v]) => v)
  return { before: `<p>${text.forwarded}<br>${lines.map(([k, v]) => `${k}: ${escapeHtml(v)}`).join('<br>')}</p>`, body: bodyHtml(original), after: '' }
}
/**
 * A reply's ('reply') or a forward's ('forward') quote in three parts: our own markup before and after it, and the
 * original's body between them (as given, the composer sanitizes it). The composer and Claude's quote make the body ready
 * alone, so the original's own <style> never reaches our header lines; before + body + after is quoteHtml / forwardHtml.
 */
export function quoteParts(mode, original, text, locale) {
  return mode === 'forward' ? forwardParts(original, text, locale) : replyParts(original, text, locale)
}
export const joinQuote = p => p.before + p.body + p.after

/** "<date>, <sender> wrote:" (in the given words) + the original in a blockquote. The composer sanitizes it. */
export const quoteHtml = (original, text, locale) => joinQuote(replyParts(original, text, locale))

/** The forwarded block: the original's header lines (the given labels), then its body. */
export const forwardHtml = (original, text, locale) => joinQuote(forwardParts(original, text, locale))

// mailto: links: limits of what a link may put into the composer
export const MAILTO_MAX = Object.freeze({ href: 200_000, address: 20_000, subject: 2000, body: 100_000 })

// control characters (CR and LF too) out of a one-line field: a link cannot add header lines
const oneLine = s => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()

/**
 * A mailto: link (RFC 6068) -> { to, cc, subject, body } for the composer, or null when it is not
 * one we take. to: the path plus every "to" field; cc, subject, body as given (body is plain text).
 * Bcc is dropped on purpose: a link must not add a recipient the user does not see in the form
 * (the Bcc row is hidden by default). Other fields (in-reply-to, ...) are dropped too. "+" stays "+"
 * (RFC 6068, unlike a web form). Too long, or not valid percent-encoding: null.
 */
export function parseMailto(href) {
  if (typeof href !== 'string' || href.length > MAILTO_MAX.href || !/^mailto:/i.test(href)) return null
  const rest = href.slice('mailto:'.length).split('#')[0]
  const q = rest.indexOf('?')
  const to = []
  const cc = []
  const subject = []
  const body = []
  try {
    const pathPart = q < 0 ? rest : rest.slice(0, q)
    if (pathPart) to.push(decodeURIComponent(pathPart))
    if (q >= 0) {
      for (const field of rest.slice(q + 1).split('&')) {
        if (!field) continue
        const eq = field.indexOf('=')
        const name = decodeURIComponent(eq < 0 ? field : field.slice(0, eq)).toLowerCase()
        const value = eq < 0 ? '' : decodeURIComponent(field.slice(eq + 1))
        if (name === 'to') to.push(value)
        else if (name === 'cc') cc.push(value)
        else if (name === 'subject') subject.push(value)
        else if (name === 'body') body.push(value)
      }
    }
  } catch {
    return null // URIError: a broken %-sequence
  }
  const join = xs => xs.map(oneLine).filter(Boolean).join(', ')
  const out = {
    to: join(to),
    cc: join(cc),
    subject: oneLine(subject.join(' ')),
    body: body.join('\n').replace(/\r\n?/g, '\n'),
  }
  if (out.to.length > MAILTO_MAX.address || out.cc.length > MAILTO_MAX.address || out.subject.length > MAILTO_MAX.subject || out.body.length > MAILTO_MAX.body) return null
  return out
}

/** The plain-text body of a mailto: link as composer HTML: escaped, one paragraph per line. */
export function mailtoBodyHtml(text) {
  if (!text) return ''
  return text
    .split('\n')
    .map(line => `<p>${line ? escapeHtml(line) : '<br>'}</p>`)
    .join('')
}
