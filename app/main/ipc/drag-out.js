// SPDX-License-Identifier: GPL-3.0-or-later
// IPC of dragging messages out of the list (drag-out.js): prepare the files, start the native drag, and tell a drop of
// our own files on one of our folders from a foreign file. The page never gets a path: a token and counts.
import { ActionError } from '../sync-manager.js'
import { errCode } from '../../../core/log-safe.js'
import { DragError, DRAG_MAX_FILES } from '../drag-out.js'

export const DRAG_OUT_CHANNELS = Object.freeze(['mail:dragOut', 'mail:dragStart', 'mail:dragDrop', 'mail:dragFetch'])

const isId = v => Number.isInteger(v) && v > 0
const isToken = v => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
const isPath = v => typeof v === 'string' && v.length > 0 && v.length <= 32767

class BadRequest extends Error {}

/** @param dragOut createDragOut(...) of the open session */
export function registerDragOutIpc({ ipcMain, dragOut, isTrustedSender, log = () => {} }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        return { ok: true, ...(await fn(event, ...args)) }
      } catch (err) {
        if (err instanceof BadRequest) return { ok: false, error: 'bad_request' }
        if (err instanceof DragError) return { ok: false, error: err.code, ...err.details }
        if (err instanceof ActionError) return { ok: false, error: err.code }
        log(`${channel} failed: ${errCode(err)}`)
        return { ok: false, error: 'internal' }
      }
    })

  // ids: 1..50 message ids -> { token, count, bytes }
  handle('mail:dragOut', async (_event, ids) => {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > DRAG_MAX_FILES || !ids.every(isId)) throw new BadRequest()
    return dragOut.prepare([...new Set(ids)])
  })
  // ids: 1..50 messages a drag could not take out yet -> { stored, error }: downloaded and stored for the next drag
  handle('mail:dragFetch', async (_event, ids) => {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > DRAG_MAX_FILES || !ids.every(isId)) throw new BadRequest()
    return dragOut.fetch([...new Set(ids)])
  })
  // the native drag of a prepared drag, from the page that asked for it
  handle('mail:dragStart', async (event, token) => {
    if (!isToken(token)) throw new BadRequest()
    return dragOut.start(token, event.sender)
  })
  // paths: what was dropped on a folder (the preload's webUtils.getPathForFile) -> { ids } of our own drag, or not_own
  handle('mail:dragDrop', async (_event, token, paths) => {
    if (!isToken(token) || !Array.isArray(paths) || paths.length > DRAG_MAX_FILES || !paths.every(isPath)) throw new BadRequest()
    return dragOut.drop(token, paths)
  })
}
