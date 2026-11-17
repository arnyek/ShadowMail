// SPDX-License-Identifier: GPL-3.0-or-later
// The open message's neighbours in the list's order (the reader's Up / Down keys) and the message that opens after the
// open one left the list (deleted, archived, moved): the one below, at the end the one above, else none. Pure.
import { assignRoles, inArchive } from '../../../core/imap/folders.js'

/** The id delta steps away from id in ids (-1 above, 1 below); null at the edge or when id is not listed. */
export function neighbor(ids, id, delta) {
  const i = ids.indexOf(id)
  if (i < 0) return null
  const j = i + delta
  return j >= 0 && j < ids.length ? ids[j] : null
}

/**
 * The message to open after the removed ids left the list, when the open one is among them: the first one below it that
 * stays, else the last one above it that stays, else null. undefined: the open one is not removed (nothing changes).
 */
export function afterRemoval(ids, openId, removed) {
  const gone = new Set(removed)
  if (!gone.has(openId)) return undefined
  const i = ids.indexOf(openId)
  if (i < 0) return null
  for (let j = i + 1; j < ids.length; j++) if (!gone.has(ids[j])) return ids[j]
  for (let j = i - 1; j >= 0; j--) if (!gone.has(ids[j])) return ids[j]
  return null
}

/**
 * Where an Archive action of a message in folder goes: { archive } (the account's Archive role folder), or { reason }
 * when it cannot: 'no_archive' (the account has no Archive) or 'in_archive' (the message is in the Archive or below it).
 */
export function archiveFor(folders, folder) {
  let archive = null
  for (const [p, role] of assignRoles(folders)) if (role === 'archive') archive = p
  if (!archive) return { reason: 'no_archive' }
  if (inArchive(folders, archive, folder)) return { reason: 'in_archive' }
  return { archive }
}

/** The four reader keys: Up / Down step, Delete deletes (with Shift too, as before), End archives; no other modifier. */
export function readerKeyOf(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || (e.shiftKey && e.key !== 'Delete')) return null
  return { ArrowUp: 'up', ArrowDown: 'down', Delete: 'delete', End: 'archive' }[e.key] || null
}
