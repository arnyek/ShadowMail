// SPDX-License-Identifier: GPL-3.0-or-later
// The interface language lives in the data folder (portable with it), in a small file without secrets:
// data\ui.json = { "language": "hu" }. The main process reads it before anything is shown (its early error
// dialogs too) and gives it to the renderer. Missing, unreadable or damaged: Hungarian. Written atomically.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { languageOf, LANGUAGES } from './ui-language.js'

export const UI_FILE = 'ui.json'

/** The language stored in <dataDir>/ui.json, or the default; never throws, never writes. */
export function readLanguage(dataDir) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, UI_FILE), 'utf8')
    const data = JSON.parse(raw)
    return languageOf(data && typeof data === 'object' ? data.language : null)
  } catch {
    return languageOf(null)
  }
}

/** Stores the language: a temporary file in the same folder, fsync, rename. An unknown language is refused. */
export function writeLanguage(dataDir, language) {
  if (!LANGUAGES.includes(language)) throw new Error('bad_language')
  const file = path.join(dataDir, UI_FILE)
  const tmp = path.join(dataDir, `${UI_FILE}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ language })}\n`, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
  return language
}
