// SPDX-License-Identifier: GPL-3.0-or-later
// The view settings (prefs.js in the renderer) live in the window's localStorage, which Chromium writes to disk late: a
// value set just before a forced stop (a crash, taskkill) could be lost. app:flushPrefs makes the asking window's
// session write its storage now. No argument; an argument is a bad request, like everywhere else.
import { errCode } from '../../../core/log-safe.js'

export const PREFS_CHANNEL = 'app:flushPrefs'

export function registerPrefsIpc({ ipcMain, isTrustedSender, log = () => {} }) {
  ipcMain.handle(PREFS_CHANNEL, async (event, ...args) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
    if (args.length) return { ok: false, error: 'bad_request' }
    try {
      event.sender.session.flushStorageData()
      return { ok: true }
    } catch (err) {
      log(`${PREFS_CHANNEL} failed: ${errCode(err)}`)
      return { ok: false, error: 'internal' }
    }
  })
}
