// SPDX-License-Identifier: GPL-3.0-or-later
// A Content-ID and a cid: reference compared as one key (RFC 2392: the cid: URL is the Content-ID without < >,
// %-encoded; the Content-ID itself is case-insensitive in practice: mail programs write the reference in another case).
// Used by the reader (the frame's cid: images, the attachments it offers) and the composer (the quote's images).

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
