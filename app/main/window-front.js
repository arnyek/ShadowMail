// SPDX-License-Identifier: GPL-3.0-or-later
// One helper that brings the main window forward. Electron free:
// it gets the window (and the focused one), so it is tested with fakes.
// - No main window (or a destroyed one): not_available.
// - keepFocus(focused) true (the user is typing in a composer window): the main window does NOT jump in front of it, it only
//   flashes on the taskbar until it gets the focus ('flashed'); the caller's view change happens behind it.
// - Otherwise restore (if minimized), show, focus ('shown'). Windows may still refuse the foreground to a background app:
//   then the window flashes (the OS does that by itself on focus()).

export class WindowError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

/**
 * @param win        the main BrowserWindow (or null)
 * @param focused    the focused BrowserWindow now (BrowserWindow.getFocusedWindow()), or null
 * @param keepFocus  (focused) => true when that window must keep the focus (a composer)
 * @returns 'shown' | 'flashed'
 */
export function showMainWindow(win, { focused = null, keepFocus = () => false } = {}) {
  if (!win || win.isDestroyed()) throw new WindowError('not_available')
  if (focused && focused !== win && !focused.isDestroyed?.() && keepFocus(focused)) {
    win.flashFrame(true)
    // the flashing stops when the user comes to the window
    win.once('focus', () => !win.isDestroyed() && win.flashFrame(false))
    return 'flashed'
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return 'shown'
}
