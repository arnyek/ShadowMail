// SPDX-License-Identifier: GPL-3.0-or-later
// "Keresés a szerveren is": IMAP UID SEARCH in every synced folder of an
// account, only for messages older than the account's limit (BEFORE <cut-off>), whose text is not in
// the local index. The UIDs found are mapped to the local metadata rows.
//
// - Every word is one TEXT criterion; imapflow allows one TEXT per query, so the words are searched
//   one by one and the UID sets intersected (AND, like the local search).
// - imapflow sends CHARSET UTF-8 for non-ASCII words by itself. A server that refuses it answers NO/BAD,
//   which imapflow returns as `false` (it does not throw): then the word is retried without accents
//   (plain ASCII, no CHARSET).
// - The folders are EXAMINEd (read-only): searching never marks anything.
// - Cancel: checked before every command; a SEARCH already sent is waited for at most `abortGraceMs`,
//   then the connection is closed (the caller's ImapConnection reconnects on the next use).
import { isConnectionLoss } from './sync.js'
import { foldForSearch, searchWords } from '../mime/text.js'

const asciiFold = w => foldForSearch(w).replace(/[^\x20-\x7e]/g, '')

class Cancelled extends Error {
  constructor() {
    super('server search cancelled')
    this.code = 'CANCELLED'
  }
}

/** One folder: the UIDs matching every word, or null when the server refused the search. */
export async function searchFolderUids(client, words, before) {
  let result = null
  for (const word of words) {
    let uids = await client.search({ text: word, before }, { uid: true })
    if (uids === false && /[^\x20-\x7e]/.test(word)) {
      const plain = asciiFold(word) // the server refused CHARSET UTF-8: retry without it
      if (plain) uids = await client.search({ text: plain, before }, { uid: true })
    }
    if (uids === false) return null
    const set = new Set(uids)
    result = result === null ? set : new Set([...result].filter(u => set.has(u)))
    if (!result.size) break
  }
  return result ? [...result] : []
}

/**
 * @param client    a connected imapflow client (the account's interactive connection)
 * @param index     MailIndex
 * @param account   accounts row
 * @param query     the search box text
 * @param cutoffMs  the account's limit (bodyCutoff); null = no limit: nothing to do on the server
 * @param folders   folder paths to search (default: every synced, non-local folder of the account)
 * @param signal    AbortSignal
 * @param onProgress ({ done, total, folder })
 * @param onHits    (rows) local rows found in one folder (beyond the limit, not opened)
 * @returns { done, total, hits, failedFolders, cancelled }
 */
export async function serverSearch({ client, index, account, query, cutoffMs, folders = null, signal, onProgress = () => {}, onHits = () => {}, abortGraceMs = 1500 }) {
  const words = searchWords(query)
  const paths = folders || index.folders(account.id).filter(f => !f.is_local).map(f => f.path)
  const state = { done: 0, total: cutoffMs === null ? 0 : paths.length, hits: 0, failedFolders: [], cancelled: false }
  if (!words.length || cutoffMs === null) return state
  const before = new Date(cutoffMs)

  // a running command is waited for a little, then the connection is dropped
  const guarded = async promise => {
    if (!signal) return promise
    if (signal.aborted) throw new Cancelled()
    let onAbort
    const aborted = new Promise((_, reject) => {
      onAbort = () => {
        const timer = setTimeout(() => {
          try {
            client.close()
          } catch {
            // already closed
          }
          reject(new Cancelled())
        }, abortGraceMs)
        promise.then(
          () => {
            clearTimeout(timer)
            reject(new Cancelled())
          },
          () => {
            clearTimeout(timer)
            reject(new Cancelled())
          },
        )
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([promise, aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  try {
    for (const path of paths) {
      if (signal && signal.aborted) throw new Cancelled()
      onProgress({ done: state.done, total: state.total, folder: path })
      let lock
      try {
        lock = await guarded(client.getMailboxLock(path, { readOnly: true }))
      } catch (err) {
        // a folder gone from the server (or refused) is skipped, the others are still searched
        // (one bad folder must not end it); a cancel or a dropped connection still ends the search
        if (err.code === 'CANCELLED' || isConnectionLoss(err)) throw err
        state.failedFolders.push(path)
        state.done++
        continue
      }
      let uids
      try {
        uids = await guarded(searchFolderUids(client, words, before))
      } finally {
        lock.release()
      }
      if (uids === null) state.failedFolders.push(path)
      else if (uids.length) {
        const rows = []
        for (const uid of uids) {
          const row = index.getByUid(account.id, path, uid)
          // only what the local search cannot find: beyond the limit and never opened
          if (row && row.body_state === 3 && !row.body_pinned) rows.push(row)
        }
        if (rows.length) {
          state.hits += rows.length
          onHits(rows)
        }
      }
      state.done++
    }
  } catch (err) {
    if (err.code !== 'CANCELLED') throw err
    state.cancelled = true
  }
  onProgress({ done: state.done, total: state.total, folder: null })
  return state
}
