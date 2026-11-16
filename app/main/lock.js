// SPDX-License-Identifier: GPL-3.0-or-later
// What happens before a lock: the open composers save their drafts, at most
// timeoutMs in all; a failure or a timeout never stops the lock. The quit path does not come here
// (the composer does not ask on quit).

/**
 * @param saveAll   ({ timeoutMs }) => Promise<{ failed }>, ipc/compose.js saveAllForLock (or null: no composer)
 * @param log       one line, without any mail content
 * @returns the number of drafts that could not be saved (never throws, never waits longer than timeoutMs + 1 s)
 */
export async function saveBeforeLock({ saveAll, log = () => {}, timeoutMs = 10_000 }) {
  if (!saveAll) return 0
  let timer = null
  try {
    const res = await Promise.race([
      saveAll({ timeoutMs }),
      // a safety net over the composer's own limit: the lock must come
      new Promise((_, reject) => (timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs + 1000))),
    ])
    const failed = Math.max(0, Number(res && res.failed) || 0)
    if (failed) log(`lock: ${failed} draft(s) not saved, locking anyway`)
    return failed
  } catch (err) {
    log(`lock: saving the drafts failed (${(err && (err.code || err.name)) || 'error'}), locking anyway`)
    return 1
  } finally {
    clearTimeout(timer)
  }
}
