// SPDX-License-Identifier: GPL-3.0-or-later
// FTS5 query helpers. Derived from an earlier internal tool by the same author.

// Characters/words that mean the user typed FTS5 syntax on purpose ("phrase", OR, NOT, word*, col:word).
export const FTS_OPERATORS = /["*()^]|\b(AND|OR|NOT|NEAR)\b|\b\w+\s*:/

/**
 * Free text -> a safe FTS5 expression: every word quoted, words of 3+ characters as prefixes
 * (Hungarian inflection: "számla" -> számlát, számlával, számlázás).
 */
export function toSafeFts(text, { prefix = true } = {}) {
  const tokens = String(text)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
  return tokens.map(t => (prefix && t.length >= 3 ? `"${t}"*` : `"${t}"`)).join(' ')
}

export function isFtsSyntaxError(err) {
  return /fts5|syntax|no such column|unterminated|malformed MATCH/i.test(err && err.message ? err.message : '')
}
