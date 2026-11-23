// SPDX-License-Identifier: GPL-3.0-or-later
// Messages dragged out of the list into another program (Claude, Explorer, the desktop, a mail program) as .eml files.
// prepare(ids): every message's whole source, byte for byte (MessageReader.source: the sealed store, or downloaded
// WITHOUT \Seen), written as "<subject>.eml" into one fresh folder data\tmp\drag-<random>\ and marked as from the
// internet (Mark-of-the-Web; where data\tmp cannot carry the mark, the %TEMP%\ShadowMail fallback, as for "Megnyitás").
// start(token, webContents): the native drag of those files. drop(token, paths): the message ids of a drag that came
// back onto one of our own folders (the files are ours, so it is a move, not a foreign file).
// The unencrypted copies go 10 minutes after the drag (not at the drop: the target may read the file later), and with
// the whole data\tmp at lock, quit and start (emptyTmpDir). No Electron import: the tests inject the clock and the folders.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ActionError } from './sync-manager.js'
import { markOfTheWeb, writeError } from './motw.js'
import { errCode } from '../../core/log-safe.js'
import { sourceFileName } from '../../core/mime/raw-view.js'
import { safeFileName } from '../../core/mime/message.js'

export const DRAG_MAX_FILES = 50
export const DRAG_MAX_BYTES = 100 * 1024 * 1024
// how long the drag waits for a message that is not stored here yet; the download goes on after it
export const DRAG_FETCH_MS = 2000
export const DRAG_KEEP_MS = 10 * 60 * 1000

/** A drag's error with numbers for the page (too_large: bytes and the limit). */
export class DragError extends ActionError {
  constructor(code, details = {}) {
    super(code)
    this.details = details
  }
}

/**
 * One drag's file names: the same name again (letter case does not count, as on Windows) gets "-2", "-3"...
 * before the extension, so every file can land in one folder.
 */
export function uniqueNames(names) {
  const taken = new Set()
  return names.map(name => {
    const ext = path.extname(name)
    const base = name.slice(0, name.length - ext.length)
    let candidate = name
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base}-${n}${ext}`
    taken.add(candidate.toLowerCase())
    return candidate
  })
}

/**
 * The drag's picture: a plain envelope, `size` x `size` raw BGRA pixels (nativeImage.createFromBitmap). Only fully
 * opaque grey or fully clear pixels, so the byte order and premultiplying do not matter.
 */
export function envelopeBitmap(size = 32) {
  const px = Buffer.alloc(size * size * 4)
  const left = 1
  const right = size - 2
  const top = Math.round(size * 0.22)
  const bottom = size - 1 - Math.round(size * 0.22)
  const midX = (left + right) / 2
  const midY = top + (bottom - top) * 0.6
  // distance of (x, y) from the segment a-b
  const dist = (x, y, ax, ay, bx, by) => {
    const dx = bx - ax
    const dy = by - ay
    const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(x - ax - k * dx, y - ay - k * dy)
  }
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const edge = x === left || x === right || y === top || y === bottom
      const flap = Math.min(dist(x, y, left, top, midX, midY), dist(x, y, right, top, midX, midY)) < 0.75
      const grey = edge || flap ? 0x55 : 0xff
      px.set([grey, grey, grey, 0xff], (y * size + x) * 4)
    }
  }
  return px
}

// a fresh folder under `dir` with every file in it, each marked; returns the folder and the files' paths
async function writeAll(dir, entries, mark, fsp) {
  const sub = path.join(dir, `drag-${crypto.randomBytes(8).toString('hex')}`)
  await fsp.mkdir(sub, { recursive: true })
  const files = []
  try {
    for (const { name, source } of entries) {
      const file = path.join(sub, name)
      await fsp.writeFile(file, source, { flag: 'wx' })
      files.push(file)
    }
  } catch (err) {
    await fsp.rm(sub, { recursive: true, force: true }).catch(() => {})
    throw new ActionError(writeError(err))
  }
  return { sub, files, markAll: () => files.forEach(f => mark(f)) }
}

/**
 * @param reader       MessageReader (source)
 * @param tmpDir       data/tmp
 * @param fallbackDir  %TEMP%\ShadowMail\<hash>, when data/tmp cannot carry the mark
 * @param icon         the drag's picture (a nativeImage)
 * @param fallback     () => the .eml name of a message without a subject (t.sourceFileFallback: read at each drag,
 *                     the language may change while unlocked)
 */
export function createDragOut({
  reader,
  tmpDir,
  fallbackDir,
  icon,
  fallback,
  mark = markOfTheWeb,
  fsp = fs.promises,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = t => clearTimeout(t),
  fetchMs = DRAG_FETCH_MS,
  keepMs = DRAG_KEEP_MS,
  maxBytes = DRAG_MAX_BYTES,
  platform = process.platform,
  log = () => {},
}) {
  const drags = new Map() // token -> { sub, files, ids, timer }
  const samePath = platform === 'win32' ? p => path.resolve(p).toLowerCase() : p => path.resolve(p)

  const remove = token => {
    const d = drags.get(token)
    if (!d) return
    drags.delete(token)
    clearTimer(d.timer)
    fs.rm(d.sub, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }, err => {
      if (err) log(`drag out: a folder kept (${errCode(err)}); it is emptied at the next start`)
    })
  }
  const arm = token => {
    const d = drags.get(token)
    clearTimer(d.timer)
    d.timer = setTimer(() => remove(token), keepMs)
    if (d.timer && typeof d.timer.unref === 'function') d.timer.unref()
  }

  // every source, or ActionError('not_yet') when one is still downloading after fetchMs; the downloads go on
  // and are stored (MessageReader.source), so the next drag finds them here
  async function sources(ids) {
    const pending = ids.map(id => reader.source(id))
    for (const p of pending) p.catch(() => {}) // a late failure after the wait is no unhandled rejection
    let timer = null
    const late = new Promise(resolve => {
      timer = setTimer(() => resolve(null), fetchMs)
    })
    try {
      const got = await Promise.race([Promise.all(pending), late])
      if (!got) throw new ActionError('not_yet')
      return got
    } finally {
      clearTimer(timer)
    }
  }

  return {
    async prepare(ids) {
      let got
      try {
        got = await sources(ids)
      } catch (err) {
        log(`drag out failed: ${err instanceof ActionError ? err.code : errCode(err)} (${ids.length} message(s))`)
        throw err
      }
      const bytes = got.reduce((n, g) => n + g.source.length, 0)
      if (bytes > maxBytes) {
        log(`drag out refused: ${ids.length} message(s), ${bytes} bytes, over the limit`)
        throw new DragError('too_large', { bytes, max: maxBytes })
      }
      const word = fallback()
      const names = uniqueNames(got.map(g => sourceFileName(g.row.subject, safeFileName, word)))
      const entries = got.map((g, i) => ({ name: names[i], source: g.source }))
      let out = await writeAll(tmpDir, entries, mark, fsp)
      try {
        out.markAll()
      } catch (err) {
        log(`drag out: mark of the web failed in data/tmp (${errCode(err)}), trying the system temp folder`)
        await fsp.rm(out.sub, { recursive: true, force: true }).catch(() => {})
        out = await writeAll(fallbackDir, entries, mark, fsp)
        try {
          out.markAll()
        } catch (err2) {
          log(`drag out: mark of the web failed in the system temp folder too (${errCode(err2)}), no drag`)
          await fsp.rm(out.sub, { recursive: true, force: true }).catch(() => {})
          throw new ActionError('motw_failed')
        }
      }
      const token = crypto.randomBytes(16).toString('hex')
      drags.set(token, { sub: out.sub, files: out.files, ids, timer: null })
      arm(token) // a drag that never starts (the mouse let go while preparing) goes the same way
      log(`drag out: ${ids.length} message(s), ${bytes} bytes`)
      return { token, count: ids.length, bytes }
    },

    /** The native drag of a prepared drag's files. On Windows it returns at the drop; the 10 minutes start again then. */
    start(token, webContents) {
      const d = drags.get(token)
      if (!d) throw new ActionError('not_found')
      webContents.startDrag({ files: d.files, icon })
      if (drags.has(token)) arm(token)
      return {}
    },

    /** A drop of `paths` on one of our folders: the ids of the drag's messages among them, or not_own. */
    drop(token, paths) {
      const d = drags.get(token)
      const wanted = new Set(paths.map(samePath))
      const ids = d ? d.files.flatMap((f, i) => (wanted.has(samePath(f)) ? [d.ids[i]] : [])) : []
      if (!ids.length || ids.length !== wanted.size) throw new ActionError('not_own')
      return { ids }
    },

    /**
     * The messages a drag could not take out yet (not stored here): downloaded in the background, WITHOUT \Seen, and
     * stored, so the next drag carries them. -> { stored: [ids], error: the first failure's code or null }
     */
    async fetch(ids) {
      const done = await Promise.allSettled(ids.map(id => reader.source(id)))
      const stored = ids.filter((_, i) => done[i].status === 'fulfilled')
      const failed = done.find(d => d.status === 'rejected')
      const error = failed ? (failed.reason instanceof ActionError ? failed.reason.code : 'internal') : null
      log(`drag out: ${stored.length} of ${ids.length} message(s) fetched for the next drag${error ? ` (${error})` : ''}`)
      return { stored, error }
    },

    /** Lock / quit: the timers stop; the folders go with the whole data\tmp (emptyTmpDir). */
    dispose() {
      for (const d of drags.values()) clearTimer(d.timer)
      drags.clear()
    },

    size: () => drags.size,
  }
}
