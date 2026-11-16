// SPDX-License-Identifier: GPL-3.0-or-later
// IPC of the unlocked session. Electron allows one ipcMain.handle per channel for the life of the
// app, while the services behind it (database, accounts, sync, reader, composer...) exist only between
// unlock and lock. So every channel is registered ONCE with a dispatcher, and the register* functions
// of a session fill the table the dispatcher reads. While locked the table is empty: { ok: false, error: 'locked' }.
export function createRoutedIpc(ipcMain) {
  const current = new Map() // channel -> handler of the open session
  const registered = new Set()
  const ensure = channel => {
    if (registered.has(channel)) return
    registered.add(channel)
    ipcMain.handle(channel, (event, ...args) => {
      const fn = current.get(channel)
      return fn ? fn(event, ...args) : { ok: false, error: 'locked' }
    })
  }
  return {
    /** The ipcMain stand-in the register* functions get. */
    handle(channel, fn) {
      ensure(channel)
      current.set(channel, fn)
    },
    /** At start: every channel answers 'locked' until the first unlock (no "no handler" rejection). */
    reserve(channels) {
      for (const c of channels) ensure(c)
    },
    /** Lock: no handler of the closed session is reachable any more. */
    clear() {
      current.clear()
    },
    isOpen: () => current.size > 0,
  }
}
