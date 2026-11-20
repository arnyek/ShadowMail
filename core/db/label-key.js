// SPDX-License-Identifier: GPL-3.0-or-later
// The key a label binds to: the message, not the index row. A row's id is lost when a message is moved without a UID
// map (the row goes, the target's sync brings a new one) and on a UIDVALIDITY change or a full resync; the Message-ID
// is not. So a label comes back as soon as the row is back.
//
//   m:<Message-ID without the angle brackets and the outer blanks; the case kept>
//   h:<first 32 hex of sha256(lower(from_addr) | date | size)>   when the message has no Message-ID
//
// The subject is not part of the fallback: the header repair (MailIndex.setHeaders) may rewrite it later. The same
// function fills the column in migration 15 and on every insert (MailIndex.insertMany), so both give the same key.
import crypto from 'node:crypto'

export const LABEL_KEY_MESSAGE_ID = 'm:'
export const LABEL_KEY_HASH = 'h:'

/** The bare Message-ID ('<a@b>' and ' <a@b> ' -> 'a@b'), or '' when there is none. */
export function bareMessageId(messageId) {
  let s = typeof messageId === 'string' ? messageId.trim() : ''
  if (s.startsWith('<')) s = s.slice(1)
  if (s.endsWith('>')) s = s.slice(0, -1)
  return s.trim()
}

const part = v => (v === null || v === undefined ? '' : String(v))

/** The label key of a message row ({ message_id, from_addr, date, size }). */
export function labelKeyOf(row) {
  const id = bareMessageId(row.message_id)
  if (id) return LABEL_KEY_MESSAGE_ID + id
  const basis = `${part(row.from_addr).toLowerCase()}|${part(row.date)}|${part(row.size)}`
  return LABEL_KEY_HASH + crypto.createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 32)
}
