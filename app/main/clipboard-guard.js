// SPDX-License-Identifier: GPL-3.0-or-later
// The recovery code leaves the clipboard. "Másolás" writes it from the main
// process and arms a 60 s timer; when it fires, on lock and on quit the clipboard is cleared, but ONLY if it
// still holds exactly the code: whatever the user copied in the meantime stays.
// Electron 45's clipboard is asynchronous (readText / writeText return promises): every call is awaited.
export const CLIPBOARD_CLEAR_MS = 60_000

/**
 * @param clipboard  electron clipboard (or a stand-in with writeText, readText, clear in tests)
 * @param delayMs    the time the code may stay
 * @param timers     { setTimeout, clearTimeout } (tests: a fake clock)
 * @param write      async (clipboard, text) => void; default writeText (main.js: windowsWrite on Windows)
 */
export function createClipboardGuard({ clipboard, delayMs = CLIPBOARD_CLEAR_MS, timers = globalThis, write = (c, t) => c.writeText(t), log = () => {} }) {
  let held = null // the text we put there, kept only until it is cleared or replaced
  let timer = null

  const disarm = () => {
    if (timer) timers.clearTimeout(timer)
    timer = null
  }

  /** Clears the clipboard if it still holds our text; forgets the text either way. -> cleared */
  const clearNow = async () => {
    disarm()
    if (held === null) return false
    const ours = held
    held = null
    try {
      if ((await clipboard.readText()) === ours) {
        await clipboard.clear()
        return true
      }
    } catch {
      log('clipboard: could not be read or cleared')
    }
    return false
  }

  let generation = 0
  const copy = async text => {
    disarm()
    const mine = ++generation
    held = text // before the write resolves: a lock right after the click still finds it
    try {
      await write(clipboard, text)
    } catch {
      log('clipboard: the history opt-out could not be written; plain text instead')
      await clipboard.writeText(text)
    }
    if (mine !== generation) return // a newer copy owns the clipboard now
    if (held === null) {
      // a lock or quit came while writing: its check may have run before the text landed
      try {
        if ((await clipboard.readText()) === text) await clipboard.clear()
      } catch {
        log('clipboard: could not be read or cleared')
      }
      return
    }
    timer = timers.setTimeout(() => void clearNow(), delayMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  return { copy, clearNow, isHolding: () => held !== null }
}

// Windows: the registered formats that keep a text out of the clipboard history (Win+V) and the cloud
// clipboard, written with the text in one atomic write (Electron 45: raw OS formats). Measured on Windows
// with Electron 45.3.0: the three formats are on the clipboard with these bytes next to the text.
const OS_FORMAT = name => `electron application/osclipboard;format="${name}"`
export function windowsWrite(ClipboardItem) {
  const dword = n => new Blob([new Uint8Array([n, 0, 0, 0])])
  return (clipboard, text) =>
    clipboard.write([
      new ClipboardItem({
        'text/plain': text,
        [OS_FORMAT('ExcludeClipboardContentFromMonitorProcessing')]: dword(1),
        [OS_FORMAT('CanIncludeInClipboardHistory')]: dword(0),
        [OS_FORMAT('CanUploadToCloudClipboard')]: dword(0),
      }),
    ])
}

/** Resolves when the promise settles or after ms, whichever comes first (the quit must not hang on it). */
export const settleWithin = (promise, ms, timers = globalThis) =>
  new Promise(resolve => {
    const t = timers.setTimeout(resolve, ms)
    Promise.resolve(promise).then(
      () => (timers.clearTimeout(t), resolve()),
      () => (timers.clearTimeout(t), resolve()),
    )
  })
