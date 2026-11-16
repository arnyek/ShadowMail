// SPDX-License-Identifier: GPL-3.0-or-later
// The account's text-index limit, shared by IMAP and POP3.
// body_index_days is stored in days (the UI shows years: N x 365, "all" = 0).

export const DAY_MS = 86_400_000

/** Cut-off in ms for an account, or null when there is no limit (body_index_days = 0). */
export function bodyCutoff(account, nowMs) {
  const days = Number(account.body_index_days)
  return days > 0 ? nowMs - days * DAY_MS : null
}

/** A message date inside the limit? A missing date counts as inside (better indexed than lost). */
export function withinBodyLimit(idate, cutoff) {
  return cutoff === null || !Number.isFinite(idate) || idate >= cutoff
}

/**
 * The common reconciler: run at the start of every sync and right after the limit
 * changes. Lowering the limit and aging both take the text out of the index unless the
 * message is pinned; raising it re-queues the rows for the body phase. Returns { cleared, requeued }.
 */
export function applyBodyLimit(index, account, nowMs = Date.now()) {
  return index.applyBodyLimit(account.id, bodyCutoff(account, nowMs))
}
