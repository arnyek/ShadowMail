// SPDX-License-Identifier: GPL-3.0-or-later
// IMAP envelope / BODYSTRUCTURE helpers.
// Derived from an earlier internal tool by the same author.

export const fmtAddr = a => (a && a.name ? `${a.name} <${a.address}>` : (a && a.address) || '')
export const fmtAddrs = list => (list || []).map(fmtAddr).join(', ')

/** Walks a BODYSTRUCTURE: attachments and the first text/plain and text/html parts. */
export function analyzeStructure(node) {
  const attachments = []
  let textPart = null
  let htmlPart = null
  const walk = n => {
    if (!n) return
    if (n.childNodes && n.childNodes.length) {
      n.childNodes.forEach(walk)
      return
    }
    const type = (n.type || '').toLowerCase()
    const filename = (n.dispositionParameters && n.dispositionParameters.filename) || (n.parameters && n.parameters.name) || null
    const isAttachment = n.disposition === 'attachment' || (filename && !type.startsWith('text/'))
    if (isAttachment) {
      attachments.push({
        part: n.part || '1',
        // stored with the row (messages.attachments), never shown: the reader names it from the message itself
        filename: filename || `melleklet-${n.part || '1'}`,
        type,
        size: n.size || 0,
        // logos embedded in signatures: listed, but they do not count as "has attachment"
        inline: n.disposition !== 'attachment' && type.startsWith('image/'),
      })
    } else if (type === 'text/plain' && !textPart) {
      textPart = n.part || '1'
    } else if (type === 'text/html' && !htmlPart) {
      htmlPart = n.part || '1'
    }
  }
  walk(node)
  return { attachments, textPart, htmlPart }
}

/** The References header of a raw header block, as space-separated <message-id>s, or null. */
export function extractReferences(headersBuf) {
  if (!headersBuf) return null
  const m = headersBuf.toString('utf8').match(/^references:[ \t]*((?:.*)(?:\r?\n[ \t].*)*)/im)
  if (!m) return null
  const ids = m[1].match(/<[^>]+>/g)
  return ids ? ids.join(' ') : null
}
