// SPDX-License-Identifier: GPL-3.0-or-later
// Message actions on the server: read / unread, star, move, delete (to the Trash, or
// for good: \Deleted + EXPUNGE). Every function works on ONE folder of ONE account, takes UIDs, and
// opens the folder read-write (SELECT). imapflow answers a refused command (NO/BAD) with `false`
// instead of throwing: that becomes an ActionError-like error with code 'server_refused'.
// No Electron import, no database: the caller updates the index after the server said yes.

export class ServerRefused extends Error {
  constructor(what) {
    super(`the server refused: ${what}`)
    this.code = 'server_refused'
  }
}

/** The folder was recreated on the server (new UIDVALIDITY): our UIDs may point at OTHER messages. */
export class UidValidityChanged extends Error {
  constructor(folder) {
    super(`UIDVALIDITY of ${folder} changed on the server`)
    this.code = 'uidvalidity_changed'
  }
}

/** A UID set for the command line, consecutive UIDs as ranges ("1:500,502"): Ctrl+A on a big folder
 * must not exceed the server's line limit (Dovecot 64 kB). */
export function uidRange(uids) {
  const sorted = [...new Set(uids)].sort((a, b) => a - b)
  const parts = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(j > i ? `${sorted[i]}:${sorted[j]}` : String(sorted[i]))
    i = j + 1
  }
  return parts.join(',')
}
const range = uidRange

/**
 * SELECT (read-write), then the UIDVALIDITY check: when the server's value differs from
 * the one our UIDs were synced with (expect.uidvalidity), nothing is done. Without expect (callers that
 * do not know it) the check is skipped.
 */
async function inFolder(client, folder, fn, expect = {}) {
  const lock = await client.getMailboxLock(folder)
  try {
    if (expect.uidvalidity !== undefined && expect.uidvalidity !== null && String(client.mailbox.uidValidity) !== String(expect.uidvalidity)) {
      throw new UidValidityChanged(folder)
    }
    return await fn()
  } finally {
    lock.release()
  }
}

const hasCap = (client, cap) => Boolean(client.capabilities && client.capabilities.has(cap))

/**
 * \Deleted + EXPUNGE of exactly these UIDs. With UIDPLUS that is UID EXPUNGE. Without it a plain
 * EXPUNGE would also remove the messages another client marked \Deleted, so their flag
 * is taken off for the moment and put back afterwards.
 */
async function expungeOnly(client, uids) {
  if (hasCap(client, 'UIDPLUS')) {
    if ((await client.messageDelete(range(uids), { uid: true })) === false) throw new ServerRefused('EXPUNGE')
    return
  }
  const mine = new Set(uids)
  const found = await client.search({ deleted: true }, { uid: true })
  const others = Array.isArray(found) ? found.filter(u => !mine.has(u)) : []
  if (others.length && (await client.messageFlagsRemove(range(others), ['\\Deleted'], { uid: true })) === false) throw new ServerRefused('STORE -FLAGS')
  try {
    if ((await client.messageDelete(range(uids), { uid: true })) === false) throw new ServerRefused('EXPUNGE')
  } finally {
    if (others.length) await client.messageFlagsAdd(range(others), ['\\Deleted'], { uid: true }).catch(() => {})
  }
}

/** add / remove: arrays of flags, e.g. ['\\Seen']. */
export async function changeFlags(client, folder, uids, { add = [], remove = [] }, expect = {}) {
  if (!uids.length) return
  await inFolder(client, folder, async () => {
    if (add.length && (await client.messageFlagsAdd(range(uids), add, { uid: true })) === false) throw new ServerRefused('STORE +FLAGS')
    if (remove.length && (await client.messageFlagsRemove(range(uids), remove, { uid: true })) === false) throw new ServerRefused('STORE -FLAGS')
  }, expect)
}

/**
 * Moves to another folder of the same account (MOVE, or COPY + EXPUNGE where MOVE is missing; imapflow
 * picks). Returns the UID map { oldUid -> newUid } when the server tells it (UIDPLUS), else null.
 */
export async function moveMessages(client, folder, uids, target, expect = {}) {
  if (!uids.length) return null
  return inFolder(client, folder, async () => {
    if (!hasCap(client, 'MOVE') && !hasCap(client, 'UIDPLUS')) {
      // imapflow's fallback would be COPY + a plain EXPUNGE: copy, then expunge only ours
      const copied = await client.messageCopy(range(uids), target, { uid: true })
      if (copied === false) throw new ServerRefused('COPY')
      await expungeOnly(client, uids)
      return null
    }
    const res = await client.messageMove(range(uids), target, { uid: true })
    if (res === false) throw new ServerRefused('MOVE')
    return res && res.uidMap instanceof Map && res.uidMap.size ? res.uidMap : null
  }, expect)
}

/** Deletes for good: \Deleted + EXPUNGE of exactly these messages (see expungeOnly). */
export async function expungeMessages(client, folder, uids, expect = {}) {
  if (!uids.length) return
  await inFolder(client, folder, () => expungeOnly(client, uids), expect)
}

// Folders. Paths are full server paths (the parent's path + its delimiter + the name); imapflow
// adds the personal namespace prefix (e.g. "INBOX.") to a top-level name by itself and encodes UTF-7.

/** Creates a folder and subscribes to it (many clients show subscribed folders only). Returns the server path. */
export async function createFolder(client, path) {
  const res = await client.mailboxCreate(path)
  if (!res || !res.path) throw new ServerRefused('CREATE')
  if (res.created === false) throw Object.assign(new Error(`folder exists: ${res.path}`), { code: 'folder_exists' }) // ALREADYEXISTS
  await client.mailboxSubscribe(res.path).catch(() => {})
  return res.path
}

/** Renames a folder (the server moves its subfolders with it). Returns the new server path. */
export async function renameFolder(client, from, to) {
  const res = await client.mailboxRename(from, to)
  if (!res || !res.newPath) throw new ServerRefused('RENAME')
  await client.mailboxSubscribe(res.newPath).catch(() => {})
  return res.newPath
}

export async function deleteFolder(client, path) {
  await client.mailboxUnsubscribe(path).catch(() => {})
  const res = await client.mailboxDelete(path)
  if (!res) throw new ServerRefused('DELETE')
}
