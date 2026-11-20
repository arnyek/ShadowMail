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

// A-Z only, as SQLite's lower() and core/db/labels.js asciiLower: a keyword is ASCII
const lowerAscii = s => String(s).replace(/[A-Z]+/g, c => c.toLowerCase())

/**
 * Label keywords on / off: UID STORE +FLAGS / -FLAGS, never a FLAGS replace (a flag another client set meanwhile stays).
 * The folder's PERMANENTFLAGS (read in the lock) decide each keyword to put on: allowed with \* in the list, or with the
 * keyword itself in it (ASCII case-insensitive; then the server's own spelling goes), or when the server sent no
 * PERMANENTFLAGS at all (RFC 3501: every flag is permanent then). A keyword not allowed is not sent (imapflow would drop it
 * with a warning only) and comes back in `refused`, for the caller's local fallback. Taking off is always allowed.
 * add: keywords (lower case); remove: keywords in every spelling to take off.
 * -> { added: [keyword as asked], refused: [keyword] }. A NO is server_refused.
 */
export async function storeKeywords(client, folder, uids, { add = [], remove = [] }, expect = {}) {
  if (!uids.length || !(add.length + remove.length)) return { added: [], refused: [] }
  return inFolder(client, folder, async () => {
    const perm = client.mailbox && client.mailbox.permanentFlags
    const listed = new Map()
    let any = !(perm instanceof Set)
    if (perm instanceof Set) {
      for (const f of perm) {
        if (f === '\\*') any = true
        else listed.set(lowerAscii(f), f)
      }
    }
    const send = []
    const added = []
    const refused = []
    for (const k of add) {
      if (listed.has(k)) send.push(listed.get(k))
      else if (!any) {
        refused.push(k)
        continue
      } else send.push(k)
      added.push(k)
    }
    if (send.length && (await client.messageFlagsAdd(range(uids), send, { uid: true })) === false) throw new ServerRefused('STORE +FLAGS')
    if (remove.length && (await client.messageFlagsRemove(range(uids), remove, { uid: true })) === false) throw new ServerRefused('STORE -FLAGS')
    return { added, refused }
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

/**
 * A folder renamed or moved under another parent: RENAME (the server takes the subtree along). `subscribed`: the paths of the
 * moved subtree that were subscribed before; each is subscribed under its new name and its old name unsubscribed, so
 * the result is the same whether or not the server carries a child's subscription along (the old name would stay a
 * subscription without a folder). Those two are best effort: a refusal there does not undo the move. Returns the
 * new path (the server's form, with its namespace prefix).
 */
export async function moveFolder(client, from, to, subscribed = []) {
  const res = await client.mailboxRename(from, to)
  if (!res || !res.newPath) throw new ServerRefused('RENAME')
  const oldRoot = res.path || from
  for (const old of subscribed) {
    const next = res.newPath + old.slice(oldRoot.length)
    await client.mailboxSubscribe(next).catch(() => {})
    await client.mailboxUnsubscribe(old).catch(() => {})
  }
  return res.newPath
}

/** SUBSCRIBE / UNSUBSCRIBE one folder (the subscriptions dialog). A NO is server_refused. */
export async function setSubscription(client, path, subscribed) {
  const ok = subscribed ? await client.mailboxSubscribe(path) : await client.mailboxUnsubscribe(path)
  if (ok === false) throw new ServerRefused(subscribed ? 'SUBSCRIBE' : 'UNSUBSCRIBE')
}

export async function deleteFolder(client, path) {
  await client.mailboxUnsubscribe(path).catch(() => {})
  const res = await client.mailboxDelete(path)
  if (!res) throw new ServerRefused('DELETE')
}
