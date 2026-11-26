// SPDX-License-Identifier: GPL-3.0-or-later
// The sync's writes in small transactions with a yield between them: the sync runs on the main process's thread, the
// one that also moves and paints the window, and a long run of SQLite writes or message parses there stalls the UI.
// BODY_TX: the body phase's old-rule FTS texts (setBodies) per transaction; INSERT_TX: the new rows' metadata per
// transaction (insertMany); FLAG_TX: the flag check's changed flags per transaction (setFlagsMany: a mass change, e.g.
// 66 666 messages marked read elsewhere, was one 320 ms transaction, measured). Before each slice after the first, check() (a stopped sync throws: after a lock the
// database may be closed). hold() -> a promise or null: before EVERY slice, a WAL checkpoint some sync waits for is
// awaited first (core/db/checkpoint.js holding()): no write while it catches up.
export const BODY_TX = 5
export const INSERT_TX = 50
export const FLAG_TX = 500

/** one turn of the event loop: whatever waits on the main thread (input, IPC, paint) runs before the next slice */
export const tick = () => new Promise(resolve => setImmediate(resolve))

/** write(slice) for each slice of at most `size` items, a tick and check() between them; -> the sum of write's numbers */
export async function inSlices(items, size, write, check = () => {}, hold = () => null) {
  let total = 0
  for (let i = 0; i < items.length; i += size) {
    if (i > 0) {
      await tick()
      check()
    }
    const h = hold()
    if (h) {
      await h
      check()
    }
    const n = write(items.slice(i, i + size))
    if (typeof n === 'number') total += n
  }
  return total
}
