// SPDX-License-Identifier: GPL-3.0-or-later
// IPC of the reader pane: open, thread, "load images", the frame's document, attachments.
// Every argument is checked here. Attachment contents never go to the renderer: they are saved or
// opened by the main process. Executable and browser-active types can only be saved.
import { noRecent } from '../dialog-options.js'
import fs from 'node:fs'
import path from 'node:path'
import { ActionError } from '../sync-manager.js'
import { openMarked, saveMarked, saveAllMarked, fallbackTmpDir } from '../motw.js'
import { errCode } from '../../../core/log-safe.js'
import { rawView, sourceFileName } from '../../../core/mime/raw-view.js'
import { safeFileName } from '../../../core/mime/message.js'
import { t } from '../../renderer/i18n/index.js'

export const READER_CHANNELS = Object.freeze([
  'mail:open', 'mail:thread', 'mail:replyInfo', 'mail:allowImages', 'mail:render', 'mail:saveAttachment', 'mail:openAttachment',
  // "Összes mentése": every offered attachment into one chosen folder, and that folder shown
  'mail:saveAllAttachments', 'mail:showSavedAttachments',
  // the "Fejlécek / Eredeti" view and the .eml save
  'mail:source', 'mail:saveSource',
])
export const MAX_VIEW_HTML = 20 * 1024 * 1024

const isId = v => Number.isInteger(v) && v > 0
const isIndex = v => Number.isInteger(v) && v >= 0 && v < 10_000

class BadRequest extends Error {}

/**
 * @param reader     MessageReader
 * @param tmpDir     data/tmp (opened attachments; emptied on start and on quit)
 * @param dialog     Electron dialog (showSaveDialog), injected for the tests
 * @param shell      Electron shell (openPath, showItemInFolder), injected for the tests
 * @param getWindow  () => BrowserWindow | null, the save dialog's parent
 */
export function registerReaderIpc({ ipcMain, reader, tmpDir, fallbackDir = fallbackTmpDir(tmpDir), dialog, shell, getWindow = () => null, labels = null, isTrustedSender, log = () => {} }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        return { ok: true, ...(await fn(...args)) }
      } catch (err) {
        if (err instanceof BadRequest) return { ok: false, error: 'bad_request' }
        if (err instanceof ActionError) return { ok: false, error: err.code }
        log(`${channel} failed: ${errCode(err)}`)
        return { ok: false, error: 'internal' }
      }
    })

  handle('mail:open', async id => {
    if (!isId(id)) throw new BadRequest()
    const message = await reader.open(id)
    // the open message's label ids (0.17.0; Labels.labelsOfRows), for the reader's chips
    return { message: labels ? { ...message, labels: labels.labelsOfRows([id]).get(id) || [] } : message }
  })

  handle('mail:thread', async id => {
    if (!isId(id)) throw new BadRequest()
    return { messages: reader.thread(id) }
  })

  handle('mail:replyInfo', async id => {
    if (!isId(id)) throw new BadRequest()
    return reader.replyInfo(id)
  })

  handle('mail:allowImages', async id => {
    if (!isId(id)) throw new BadRequest()
    return { hosts: reader.allowImages(id) }
  })

  // The renderer sanitized the body; the main process serves it from mail-view: with its own CSP.
  handle('mail:render', async (id, html) => {
    if (!isId(id) || typeof html !== 'string' || html.length > MAX_VIEW_HTML) throw new BadRequest()
    return { url: `mail-view://view/${reader.setView(id, html)}` }
  })

  handle('mail:saveAttachment', async (id, index) => {
    if (!isId(id) || !isIndex(index)) throw new BadRequest()
    const part = reader.attachment(id, index)
    const win = getWindow()
    const opts = { defaultPath: part.filename }
    const res = win ? await dialog.showSaveDialog(win, noRecent(opts)) : await dialog.showSaveDialog(noRecent(opts))
    if (res.canceled || !res.filePath) return { saved: false }
    saveMarked({ filePath: res.filePath, content: part.content, log }) // Mark-of-the-Web
    return { saved: true }
  })

  // "Összes mentése": the folder chosen in the main process's own dialog (the page never names a path), every offered
  // attachment written there (saveAllAttachments: numbered, never over a file, marked). The log has counts and codes,
  // never a file name or the folder.
  let lastSaved = null // the first file of the last "Összes mentése": what "Megnyitás a mappában" shows
  handle('mail:saveAllAttachments', async id => {
    if (!isId(id)) throw new BadRequest()
    const parts = reader.offeredAttachments(id)
    if (!parts.length) throw new ActionError('not_found')
    const win = getWindow()
    const opts = { properties: ['openDirectory', 'createDirectory'] }
    const res = win ? await dialog.showOpenDialog(win, noRecent(opts)) : await dialog.showOpenDialog(noRecent(opts))
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { saved: false }
    const files = await saveAllMarked({ folder: res.filePaths[0], files: parts.map(p => ({ filename: p.filename, content: p.content })), fallback: t.attachmentFallback, log })
    const saved = files.filter(f => f.ok)
    lastSaved = saved.length ? saved[0].path : null
    const codes = [...new Set(files.filter(f => !f.ok).map(f => f.error))]
    log(`attachments saved: ${saved.length} of ${files.length}${codes.length ? ` (${codes.join(', ')})` : ''}`)
    return {
      saved: true,
      files: files.map(({ name, ok, error }) => (ok ? { name, ok } : { name, ok, error })),
      executable: parts.filter((p, i) => files[i].ok && p.executable).length,
      // the same save-only rule as the single Save (isBrowserActiveName): the browser would run it from file://
      browserActive: parts.filter((p, i) => files[i].ok && p.browserActive).length,
    }
  })
  handle('mail:showSavedAttachments', async () => {
    if (!lastSaved) throw new ActionError('not_found')
    shell.showItemInFolder(lastSaved)
    return {}
  })

  // the raw message (MessageReader.source: the sealed store, or downloaded WITHOUT \Seen),
  // as text for the view: the header block, the text up to 2 MB, the summary; never the parsed body
  handle('mail:source', async id => {
    if (!isId(id)) throw new BadRequest()
    const { source } = await reader.source(id)
    const view = await rawView(source)
    log(`source view: message ${id}, ${view.size} bytes${view.truncated ? ', truncated' : ''}`)
    return view
  })
  // the whole, uncut message as <subject>.eml, marked as from the internet, where the user chooses
  handle('mail:saveSource', async id => {
    if (!isId(id)) throw new BadRequest()
    const { row, source } = await reader.source(id)
    const win = getWindow()
    const opts = { defaultPath: sourceFileName(row.subject, safeFileName, t.sourceFileFallback), filters: [{ name: 'E-mail (.eml)', extensions: ['eml'] }] }
    const res = win ? await dialog.showSaveDialog(win, noRecent(opts)) : await dialog.showSaveDialog(noRecent(opts))
    if (res.canceled || !res.filePath) return { saved: false }
    saveMarked({ filePath: res.filePath, content: source, log })
    log(`source saved: message ${id}, ${source.length} bytes`)
    return { saved: true }
  })

  handle('mail:openAttachment', async (id, index) => {
    if (!isId(id) || !isIndex(index)) throw new BadRequest()
    const part = reader.attachment(id, index)
    if (part.executable) throw new ActionError('executable')
    if (part.browserActive) throw new ActionError('browser_active')
    // only the allow list opens; everything else is saved (the two lists above give the sharper reason)
    if (!part.openable) throw new ActionError('not_openable')
    // marked (Mark-of-the-Web) before it opens; not on NTFS -> %TEMP%\ShadowMail, else not at all
    await openMarked({ filename: part.filename, content: part.content, tmpDir, fallbackDir, openPath: file => shell.openPath(file), log })
    return {}
  })
}

/** Empties data/tmp (start and quit). A file still open in another program may stay; that is fine. */
export function emptyTmpDir(tmpDir, log = () => {}) {
  let entries = []
  try {
    entries = fs.readdirSync(tmpDir)
  } catch {
    return
  }
  for (const name of entries) {
    try {
      fs.rmSync(path.join(tmpDir, name), { recursive: true, force: true })
    } catch (err) {
      log(`tmp cleanup: an entry kept (${errCode(err)})`)
    }
  }
}
