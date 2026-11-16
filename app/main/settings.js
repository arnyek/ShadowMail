// SPDX-License-Identifier: GPL-3.0-or-later
// The app settings (schema v4): a key-value table in the encrypted database, so they are as
// protected as the mail and are reachable only while unlocked. { get(key) -> string | null, set(key, value) }
export function openSettings(db) {
  const get = db.prepare('SELECT value FROM settings WHERE key = ?').pluck()
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  return {
    get: key => get.get(key) ?? null,
    set: (key, value) => void set.run(key, String(value)),
  }
}
