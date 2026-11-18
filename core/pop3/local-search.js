// SPDX-License-Identifier: GPL-3.0-or-later
// "Keresés a régi levelek szövegében is" for POP3 accounts.
//
// Looks through the data/store .eml files of the POP3 messages beyond the account's limit that the
// user never opened (body_state 3, body_pinned 0), newest first, WITHOUT the index: the text is
// parsed, folded (NFD, marks off, lower case) and must contain every word of the query. Nothing is
// written: the messages stay out of the full-text index until opened.
// Missing or broken files are counted and skipped. It yields to the event loop between files, so the
// app stays usable, and stops within one file of a cancel.
import { simpleParser } from 'mailparser'
import { foldForSearch, searchWords, searchTextOf, SEARCH_PARSE } from '../mime/text.js'
import { utf8Headers } from '../mime/raw-headers.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

/** Rows to look through (newest first). accountIds: POP3 accounts only. */
export function oldPop3Rows(db, accountIds) {
  if (!accountIds.length) return []
  const marks = accountIds.map(() => '?').join(', ')
  return db
    .prepare(
      `SELECT m.id, m.account_id, m.store_path FROM messages m JOIN accounts a ON a.id = m.account_id
        WHERE a.type = 'pop3' AND m.account_id IN (${marks}) AND m.body_state = 3 AND m.body_pinned = 0
          AND m.store_path IS NOT NULL
        ORDER BY m.idate DESC, m.id DESC`,
    )
    .all(...accountIds)
}

/**
 * The searchable text of a raw message: subject, sender, recipients and the body (HTML -> plain).
 * The headers are in, so a query whose words are split between the subject and the body still matches
 * (the index search ANDs across its columns the same way).
 */
export async function messageText(source) {
  const p = await simpleParser(utf8Headers(source), SEARCH_PARSE) // no HTML -> text: searchTextOf reads the HTML itself
  // the visible text, as the index (searchTextOf)
  const body = searchTextOf(p)
  return [p.subject, p.from && p.from.text, p.to && p.to.text, p.cc && p.cc.text, body].filter(Boolean).join('\n')
}

/**
 * @param db, sealed (SealedStore of data/store)
 * @param accountIds   POP3 account ids in scope
 * @param query        the search box text
 * @param signal       AbortSignal: stops between files
 * @param onProgress   ({ done, total, skipped }) at most every progressMs
 * @param onHit        (messageId) for every match, as it is found
 * @returns { done, total, skipped, hits, cancelled }
 */
export async function searchOldPop3({ db, sealed, accountIds, query, signal, onProgress = () => {}, onHit = () => {}, progressMs = 100, textOf = messageText }) {
  const words = searchWords(query).map(foldForSearch)
  const rows = words.length ? oldPop3Rows(db, accountIds) : []
  const state = { done: 0, total: rows.length, skipped: 0, hits: 0, cancelled: false }
  let last = 0
  for (const r of rows) {
    if (signal && signal.aborted) {
      state.cancelled = true
      break
    }
    try {
      // sealed: a damaged or missing file counts as skipped, the search goes on
      // `textOf` may run on the worker thread; null = it was dropped (lock): counted as skipped
      const raw = await textOf(await sealed.readAsync(r.store_path))
      if (raw === null) throw new Error('dropped')
      const text = foldForSearch(raw)
      if (words.every(w => text.includes(w))) {
        state.hits++
        onHit(r.id)
      }
    } catch {
      state.skipped++
    }
    state.done++
    const now = Date.now()
    if (now - last >= progressMs) {
      last = now
      onProgress({ done: state.done, total: state.total, skipped: state.skipped })
    }
    await tick()
  }
  onProgress({ done: state.done, total: state.total, skipped: state.skipped })
  return state
}
