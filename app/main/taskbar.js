// SPDX-License-Identifier: GPL-3.0-or-later
// The unread badge on the taskbar button (Windows overlay icon). One badge per unlocked session: the total of every
// account's inbox (core/db/unread-total.js), redrawn after a write that may change it (TEMP triggers, folded by
// unread-badge.js), gone on lock and quit. The switch lives in the encrypted settings (taskbar_unread, ON by default).
// IPC: taskbar:status, taskbar:setEnabled (Beállítások / Megjelenés). Not on Windows: nothing is drawn.
// Never logged: the number, or anything of a message.
import fs from 'node:fs'
import { badgeBitmaps } from '../../core/unread-badge.js'
import { unreadInboxTotal, watchUnreadChanges } from '../../core/db/unread-total.js'
import { errCode } from '../../core/log-safe.js'
import { createUnreadBadge, TASKBAR_UNREAD_KEY, taskbarUnreadOn } from './unread-badge.js'

export const TASKBAR_CHANNELS = Object.freeze(['taskbar:status', 'taskbar:setEnabled'])

/** The badge of `n` as one nativeImage, a representation for every taskbar scale (16 px = 100%), or null for none. */
export function badgeImage(nativeImage, n) {
  const bitmaps = badgeBitmaps(n)
  if (!bitmaps) return null
  const [base, ...more] = bitmaps
  const image = nativeImage.createFromBitmap(base.buffer, { width: base.width, height: base.height, scaleFactor: 1 })
  for (const b of more) image.addRepresentation({ scaleFactor: b.width / base.width, width: b.width, height: b.height, buffer: b.buffer })
  return image
}

/**
 * apply(n) for the main window: setOverlayIcon(the badge, its description), null at 0. Not on Windows: no overlay.
 * testLog: a file the e2e reads (SHADOWMAIL_TEST_OVERLAY_LOG), one JSON line a call; it only watches.
 */
export function overlayApplier({ getWindow, nativeImage, describe, platform = process.platform, testLog = null, log = () => {} }) {
  return n => {
    let image = null
    try {
      image = n > 0 ? badgeImage(nativeImage, n) : null
      if (platform === 'win32') {
        const win = getWindow()
        if (win && !win.isDestroyed()) win.setOverlayIcon(image, image ? describe(n) : '')
      }
    } catch (err) {
      log(`taskbar badge failed: ${errCode(err)}`)
    }
    if (testLog) {
      const line = { at: Date.now(), n: image ? n : null, scales: image ? image.getScaleFactors() : [] }
      try {
        fs.appendFileSync(testLog, `${JSON.stringify(line)}\n`)
      } catch {
        // a test aid only
      }
    }
  }
}

/** The badge of one unlocked session: counts at once (when the switch is ON) and after every change. -> { enabled(), setEnabled(on), stop() } */
export function startTaskbarBadge({ db, settings, apply, log = () => {}, delayMs }) {
  const badge = createUnreadBadge({ total: () => unreadInboxTotal(db), apply, delayMs, enabled: taskbarUnreadOn(settings.get(TASKBAR_UNREAD_KEY)) })
  const unwatch = watchUnreadChanges(db, () => badge.changed(), { log })
  badge.refresh()
  return {
    enabled: () => badge.enabled,
    setEnabled(on) {
      settings.set(TASKBAR_UNREAD_KEY, on ? 'on' : 'off')
      log(`taskbar badge switch ${on ? 'on' : 'off'}`)
      badge.setEnabled(on)
    },
    /** Lock and quit: the badge goes, the triggers are dropped (before the database closes). */
    stop() {
      badge.stop()
      unwatch()
    },
  }
}

export function registerTaskbarIpc({ ipcMain, taskbar, isTrustedSender, log = () => {} }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        return { ok: true, ...fn(...args) }
      } catch (err) {
        if (err && err.badRequest) return { ok: false, error: 'bad_request' }
        log(`${channel} failed: ${errCode(err)}`)
        return { ok: false, error: 'internal' }
      }
    })
  handle('taskbar:status', (...args) => {
    if (args.length) throw Object.assign(new Error('bad request'), { badRequest: true })
    return { enabled: taskbar.enabled() }
  })
  handle('taskbar:setEnabled', (on, ...rest) => {
    if (typeof on !== 'boolean' || rest.length) throw Object.assign(new Error('bad request'), { badRequest: true })
    taskbar.setEnabled(on)
    return { enabled: taskbar.enabled() }
  })
}
