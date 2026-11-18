// SPDX-License-Identifier: GPL-3.0-or-later
// The recipient column of the Sent and Drafts lists: there the sender is always the user, so the list shows whom the
// message went to. Pure: the main process sorts by recipientKey (an SQLite function), the renderer shows recipientLabel.

/** The folder roles whose list shows the recipient instead of the sender (assignRoles: the manual choice counts too). */
export const RECIPIENT_ROLES = Object.freeze(new Set(['sent', 'drafts']))

const BARE_ADDRESS = /^[^\s<>@,]+@[^\s<>,]*$/

const QUOTED_NAME = /^"((?:[^"\\]|\\.)*)"$/s
// a whole item as fmtAddr writes a quoted name: "name" <address>
const STRICT_QUOTED = /^"(?:[^"\\]|\\.)*"\s*<[^<>]*>$/s

/**
 * The pieces between the commas outside quoted names; null when a quote is left open (then no quoting is trusted).
 * Only a quote that opens an item counts, as fmtAddr writes it: an old unquoted name with a stray quote (O"Neil) does
 * not swallow the commas after it, and an item opening with a quote must be exactly '"name" <address>'.
 */
function quotedPieces(s) {
  const pieces = []
  let start = 0
  let quoted = false
  let blank = true
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
    } else if (c === ',') {
      pieces.push(s.slice(start, i))
      start = i + 1
      blank = true
    } else if (c === '"' && blank) {
      quoted = true
      blank = false
    } else if (c !== ' ' && c !== '\t') blank = false
  }
  if (quoted) return null
  pieces.push(s.slice(start))
  // a row stored before 0.15.1 may hold an unquoted name that only starts with a quote ('"Hi, there <h@x>'): the
  // quoting counts only when every piece that opens with a quote is exactly fmtAddr's shape, else the old reading
  for (const p of pieces) {
    const item = p.trim()
    if (item.startsWith('"') && !STRICT_QUOTED.test(item)) return null
  }
  return pieces
}

/**
 * A stored address list (envelope.js fmtAddrs: "Name <a@b>, c@d") back to [{ name, address }]. Since 0.15.1 fmtAddrs
 * quotes a name holding a comma, quote, angle bracket or backslash ("\"a@x, Real\" <r@x>"): a comma inside a quoted
 * string does not split, and a name that is one quoted string is unquoted. Rows stored before hold such names
 * unquoted ("Doe, John <j@x>"): a piece without angle brackets is an item only if it looks like an address, else it
 * is the start of a name and the next piece continues it. "Name <>" is an RFC 5322 group's name (imapflow: no host),
 * not a recipient, and is left out.
 */
export function parseAddrList(s, max = Infinity) {
  const out = []
  if (typeof s !== 'string' || !s.trim()) return out
  let buf = ''
  const flush = () => {
    const item = buf.trim()
    buf = ''
    const m = /^(.*?)\s*<([^<>]*)>$/s.exec(item)
    if (m) {
      const address = m[2].trim()
      const q = QUOTED_NAME.exec(m[1].trim())
      if (address) out.push({ name: q ? q[1].replace(/\\(.)/gs, '$1') : m[1].trim(), address })
      return
    }
    if (item) out.push({ name: '', address: item })
  }
  // the quote-aware split only where a quote is (the sort calls this once per row: most rows take the plain split)
  const pieces = (s.includes('"') && quotedPieces(s)) || s.split(',')
  for (const piece of pieces) {
    buf = buf ? `${buf},${piece}` : piece
    const item = buf.trim()
    if (/<[^<>]*>$/.test(item) || (!item.includes('<') && BARE_ADDRESS.test(item))) flush()
    if (out.length >= max) return out
  }
  // a leftover without an address (a name cut short, a group's "name:;" phrase) is no recipient
  if (buf.trim() && BARE_ADDRESS.test(buf.trim())) flush()
  return out
}

/**
 * The row's recipient as the list shows it: the first To recipient; with an empty To the first Cc, then the first Bcc
 * (a message sent with Bcc only). more = how many other distinct addresses the shown lines hold, for "Name +2": To and
 * Cc together; the Bcc counts only when it is the only line. The Bcc of a row stored before 0.15.1 is known only when
 * To and Cc are empty (the sync fills just those), so counting it elsewhere would give old and new rows different
 * numbers. -> { name, address, more, all: [{ name, address }] } or null (no recipient at all).
 */
export function recipientLabel({ to_addrs = '', cc_addrs = '', bcc_addrs = '' } = {}) {
  const to = parseAddrList(to_addrs)
  const cc = parseAddrList(cc_addrs)
  const shown = to.length || cc.length ? [...to, ...cc] : parseAddrList(bcc_addrs)
  const first = shown[0]
  if (!first) return null
  const seen = new Set()
  const all = []
  for (const a of shown) {
    const key = a.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    all.push(a)
  }
  return { name: first.name, address: first.address, more: all.length - 1, all }
}

/**
 * The text the list sorts by: the shown name, or the address without one; '' with no recipient. The same first
 * recipient as recipientLabel, read only up to it (SQLite calls this once per row of the sorted folder).
 */
export function recipientKey(to, cc, bcc) {
  for (const line of [to, cc, bcc]) {
    const [first] = parseAddrList(line, 1)
    if (first) return first.name || first.address
  }
  return ''
}
