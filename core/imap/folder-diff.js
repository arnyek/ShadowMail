// SPDX-License-Identifier: GPL-3.0-or-later
// The set work of one folder's sync (core/imap/sync.js syncFolder), pure: the stored rows against the server's UIDs.
// The sync's read worker (core/db/sync-read-worker.js) and the main thread's fallback both call these, so the two
// paths decide by one rule. Linear in the folder's size; no spread of a big array (100 000+ UIDs overflow the stack).

// without CONDSTORE the flag check asks every known message: in UID ranges of this many known UIDs, one after the other
// (100 000 known messages, the sync's own run over real imapflow: one `min:*` FETCH gave a 1 s main-thread block,
// ranges of 5 000 still 165 ms on the first one, 2 000 at most 50 ms, measured)
export const FLAG_CHUNK = 2000

/** the known UIDs (any order) as `first:last` ranges of at most `size` UIDs each, ascending */
export function flagRanges(uids, size = FLAG_CHUNK) {
  const sorted = Uint32Array.from(uids).sort()
  const out = []
  for (let i = 0; i < sorted.length; i += size) out.push(`${sorted[i]}:${sorted[Math.min(i + size, sorted.length) - 1]}`)
  return out
}

/**
 * rows: the folder's stored rows ({ id, uid, flags }), server: its UIDs on the server (any iterable of numbers).
 * -> { gone: [{ id, uid }] (stored, not on the server; in the rows' order), fresh: Uint32Array (on the server, not
 * stored; newest first), known: Map uid -> flags (stored and on the server), minKnown (Infinity when none),
 * serverSet }
 */
export function folderDiff(rows, server) {
  const serverSet = server instanceof Set ? server : new Set(server)
  const localSet = new Set()
  const gone = []
  const known = new Map()
  let minKnown = Infinity
  for (const r of rows) {
    localSet.add(r.uid)
    if (!serverSet.has(r.uid)) {
      gone.push({ id: r.id, uid: r.uid })
      continue
    }
    known.set(r.uid, r.flags)
    if (r.uid < minKnown) minKnown = r.uid
  }
  let n = 0
  for (const u of serverSet) if (!localSet.has(u)) n++
  const fresh = new Uint32Array(n)
  let i = 0
  for (const u of serverSet) if (!localSet.has(u)) fresh[i++] = u
  fresh.sort().reverse()
  return { gone, fresh, known, minKnown, serverSet }
}

/** rows ({ id, uid, ... }) whose UID is on the server, as [{ id, uid }] in their order */
export function onServer(rows, serverSet) {
  const out = []
  for (const r of rows) if (serverSet.has(r.uid)) out.push({ id: r.id, uid: r.uid })
  return out
}

/**
 * The flag check's answers against the stored flags: uids[i] has flags[i] (the words joined by one space) on the
 * server. A UID not among the known ones is skipped. -> [{ uid, flags }] of the changed ones, in the answers' order
 */
export function changedFlags(known, uids, flags) {
  const out = []
  for (let i = 0; i < uids.length; i++) {
    const uid = uids[i]
    if (!known.has(uid)) continue
    if (flags[i] !== known.get(uid)) out.push({ uid, flags: flags[i] })
  }
  return out
}
