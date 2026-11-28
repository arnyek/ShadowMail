// SPDX-License-Identifier: GPL-3.0-or-later
// The Start menu shortcut the new-mail notice needs: Windows shows a notice of a program run from a ZIP only if a Start
// menu shortcut carries the same AppUserModelID as the process (measured: without it nothing shows, and the program
// still gets "show"). Electron-free: the shell (writeShortcutLink, readShortcutLink) and the file system are given.
// Only the packaged program on Windows touches a shortcut: a development, test or e2e run never does (it must not
// rewrite the owner's own shortcut). Our shortcut: its target is this exe and its AUMID is ours; a foreign one is
// never removed. Logged: written | removed | failed (<code>), never the path.
import path from 'node:path'
import nodeFs from 'node:fs'
import { errCode } from '../../core/log-safe.js'

export const APP_USER_MODEL_ID = 'ShadowMail'
// Windows takes a new shortcut in only after a while: the first notice after a write waits this long (3 s was enough)
export const SHORTCUT_SETTLE_MS = 3000

export function shortcutPathOf(appData) {
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ShadowMail.lnk')
}

/**
 * @param shell      { writeShortcutLink(path, operation, options) -> boolean, readShortcutLink(path) -> details (throws when missing) }
 * @param platform   process.platform
 * @param isPackaged app.isPackaged
 * @param execPath   process.execPath (the exe the shortcut starts)
 * @param appData    app.getPath('appData')
 * -> { applies, ensure() -> boolean, write() -> boolean, remove() -> boolean }
 */
export function notifyShortcut({ shell, platform = process.platform, isPackaged, execPath, appData, description = 'ShadowMail', fs = nodeFs, log = () => {} }) {
  const applies = platform === 'win32' && Boolean(isPackaged) && Boolean(appData) && Boolean(execPath)
  const file = applies ? shortcutPathOf(appData) : null
  const same = (a, b) => typeof a === 'string' && path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase()
  const read = () => {
    try {
      return shell.readShortcutLink(file)
    } catch {
      return null
    }
  }
  const ours = link => Boolean(link) && same(link.target, execPath) && link.appUserModelId === APP_USER_MODEL_ID
  const write = () => {
    if (!applies) return true
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const ok = shell.writeShortcutLink(file, 'create', { target: execPath, appUserModelId: APP_USER_MODEL_ID, icon: execPath, iconIndex: 0, description })
      if (!ok) throw Object.assign(new Error('the shortcut was not written'), { code: 'not_written' })
      log('notify shortcut: written')
      return true
    } catch (err) {
      log(`notify shortcut: failed (${errCode(err)})`)
      return false
    }
  }
  return {
    applies,
    /** An enabled notice at unlock: a missing shortcut, or one pointing elsewhere (the folder moved), is written again. */
    ensure() {
      if (!applies) return true
      return ours(read()) ? true : write()
    },
    write,
    /** The notice switched off: our shortcut goes; a foreign one (another target or AUMID) stays. */
    remove() {
      if (!applies) return true
      const link = read()
      if (!ours(link)) return true
      try {
        fs.unlinkSync(file)
        log('notify shortcut: removed')
        return true
      } catch (err) {
        log(`notify shortcut: failed (${errCode(err)})`)
        return false
      }
    },
  }
}
