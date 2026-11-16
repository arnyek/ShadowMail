// SPDX-License-Identifier: GPL-3.0-or-later
// Data directory resolution. Everything the app writes lives under one folder:
// packaged: <folder of the exe>\data, development: ./data-dev, tests/e2e: $SHADOWMAIL_DATA.
import fs from 'node:fs'
import path from 'node:path'

export const DATA_ENV = 'SHADOWMAIL_DATA'

export function resolveDataDir({ isPackaged, exePath, appPath, env = {} }) {
  if (env[DATA_ENV]) return path.resolve(env[DATA_ENV])
  if (isPackaged) return path.join(path.dirname(exePath), 'data')
  return path.join(appPath, 'data-dev')
}

// Electron/Chromium paths that would otherwise default to %APPDATA%, %LOCALAPPDATA% or %TEMP%.
export function electronPaths(dataDir) {
  const base = path.join(dataDir, 'electron')
  return {
    userData: path.join(base, 'userData'),
    sessionData: path.join(base, 'sessionData'),
    logs: path.join(base, 'logs'),
    crashDumps: path.join(base, 'crashDumps'),
    temp: path.join(dataDir, 'tmp'),
  }
}

export function databasePath(dataDir) {
  return path.join(dataDir, 'mail.sqlite')
}

// Creates the directory if needed and proves it is writable with a probe file.
// Throws the underlying fs error (EACCES, EPERM, EROFS, ...) when it is not.
export function ensureWritableDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const probe = path.join(dir, `.write-test-${process.pid}`)
  fs.writeFileSync(probe, '')
  fs.unlinkSync(probe)
}
