// SPDX-License-Identifier: GPL-3.0-or-later
// The one key rule of an e-mail address: trimmed and lower-cased by JavaScript, so an accented
// capital (ÁRVÍZ.tűrő@...) matches too. SQLite's NOCASE and lower() fold ASCII only, so in SQL the same rule is the
// addr_key() function, registered on every connection (core/db/index.js openDatabase). Pure, no import.

/** The address key: String(x).trim().toLowerCase(); null and undefined stay null. */
export function addrKey(x) {
  return x === null || x === undefined ? null : String(x).trim().toLowerCase()
}
