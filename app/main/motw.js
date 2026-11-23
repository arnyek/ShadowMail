// SPDX-License-Identifier: GPL-3.0-or-later
// Mark-of-the-Web for attachments written to disk.
// Windows only: a Zone.Identifier NTFS stream with ZoneId=3 ("Internet") next to the file, so Office
// opens it in Protected View and SmartScreen warns about a downloaded program. Elsewhere a no-op.
// No Electron import: the tests drive it with injected platform / file writer / openPath.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { ActionError } from './sync-manager.js'
import { errCode } from '../../core/log-safe.js'
import { safeFileName } from '../../core/mime/message.js'

export const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\n'

/** Marks `file` as coming from the internet. Returns true when marked, false on a no-op platform; throws when it fails (e.g. not NTFS). */
export function markOfTheWeb(file, { platform = process.platform, writeFile = fs.writeFileSync } = {}) {
  if (platform !== 'win32') return false
  writeFile(`${file}:Zone.Identifier`, ZONE_IDENTIFIER)
  return true
}

/**
 * %TEMP%\ShadowMail\<hash of the data folder>: the fallback for "Megnyitás" when data\tmp cannot carry
 * the mark (exFAT/FAT32 stick). One subfolder per copy of the app, so starting or quitting one copy
 * never empties another copy's opened attachments.
 */
export const fallbackTmpDir = (dataDir = '') =>
  path.join(os.tmpdir(), 'ShadowMail', crypto.createHash('sha256').update(path.resolve(String(dataDir)).toLowerCase()).digest('hex').slice(0, 16))

// removes a folder; a file a virus scanner still holds (EBUSY/EPERM) must not stop the caller
function removeQuietly(dir, log) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (err) {
    log(`could not remove a temporary folder (${errCode(err)}); it is emptied at the next start`)
  }
}

function writeInOwnFolder(dir, filename, content) {
  // own folder per opening: two attachments with the same name do not overwrite each other
  const sub = path.join(dir, crypto.randomBytes(6).toString('hex'))
  fs.mkdirSync(sub, { recursive: true })
  const file = path.join(sub, filename)
  fs.writeFileSync(file, content)
  return { sub, file }
}

/**
 * "Megnyitás": write into data\tmp, mark, then open. If the mark cannot be written there, the copy is
 * removed and the file goes to %TEMP%\ShadowMail, marked, and opens from there; if that fails too,
 * nothing opens (ActionError motw_failed). Returns the path that was opened.
 */
export async function openMarked({ filename, content, tmpDir, fallbackDir, openPath, mark = markOfTheWeb, log = () => {} }) {
  let { sub, file } = writeInOwnFolder(tmpDir, filename, content)
  try {
    mark(file)
  } catch (err) {
    log(`mark of the web failed in data/tmp (${errCode(err)}), trying the system temp folder`)
    removeQuietly(sub, log)
    ;({ sub, file } = writeInOwnFolder(fallbackDir, filename, content))
    try {
      mark(file)
    } catch (err2) {
      log(`mark of the web failed in the system temp folder too (${errCode(err2)}), not opening`)
      removeQuietly(sub, log)
      throw new ActionError('motw_failed', err2)
    }
  }
  const error = await openPath(file) // '' on success, the reason otherwise
  if (error) {
    log('open attachment failed: the system could not open it') // its text may name the file
    throw new ActionError('open_failed')
  }
  return file
}

// a failed write as a code the reader can say
export const writeError = err => (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') ? 'not_writable' : err && err.code === 'ENOSPC' ? 'disk_full' : 'write_failed')

/**
 * "Összes mentése": every file into `folder` (the user chose it), one by one, each under its cleaned name
 * (safeFileName, `fallback` for an empty one) and NEVER over an existing file: created exclusively ('wx'), a taken
 * name becomes "name (2).ext", "name (3).ext" ... (also for two attachments of one message with the same name). A
 * name that would not land right in the folder is left out (bad_name). Each saved file is marked (Mark-of-the-Web; a
 * failed mark is only logged, as for "Mentés másként"). One file's failure does not stop the rest, nothing is rolled
 * back; a file whose write failed half way is removed. `clean` (the name cleaner) and `fsp` are for the tests.
 * -> [{ name, path, ok: true } | { name, ok: false, error }] in the order of `files`; error: bad_name, name_taken,
 *    not_writable, disk_full, write_failed
 */
export async function saveAllMarked({ folder, files, fallback = 'melleklet', mark = markOfTheWeb, log = () => {}, fsp = fs.promises, maxTries = 1000, clean = safeFileName }) {
  const root = path.resolve(folder)
  const out = []
  for (const f of files) {
    const name = clean(f.filename, fallback)
    const ext = path.extname(name)
    const base = name.slice(0, name.length - ext.length)
    let saved = null
    let error = null
    for (let n = 1; n <= maxTries && !saved && !error; n++) {
      const target = path.resolve(root, n === 1 ? name : `${base} (${n})${ext}`)
      if (path.dirname(target) !== root) {
        error = 'bad_name'
        break
      }
      let handle
      try {
        handle = await fsp.open(target, 'wx')
      } catch (err) {
        if (err && err.code === 'EEXIST') continue
        error = writeError(err)
        break
      }
      try {
        await handle.writeFile(f.content)
        saved = target
      } catch (err) {
        error = writeError(err)
      } finally {
        await handle.close().catch(() => {})
      }
      if (error) await fsp.rm(target, { force: true }).catch(() => {})
    }
    if (!saved && !error) error = 'name_taken'
    if (saved) {
      try {
        mark(saved)
      } catch (err) {
        log(`mark of the web failed on a saved file (${errCode(err)})`)
      }
      out.push({ name: path.basename(saved), path: saved, ok: true })
    } else out.push({ name, ok: false, error })
  }
  return out
}

/** "Mentés másként": write, then mark; a failed mark is only logged (the user chose the place). */
export function saveMarked({ filePath, content, mark = markOfTheWeb, log = () => {} }) {
  fs.writeFileSync(filePath, content)
  try {
    mark(filePath)
  } catch (err) {
    log(`mark of the web failed on the saved file (${errCode(err)})`)
  }
}
