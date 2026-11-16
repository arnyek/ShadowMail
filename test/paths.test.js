import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from './helpers/tmp.js'
import { resolveDataDir, electronPaths, databasePath, ensureWritableDir, DATA_ENV } from '../core/paths.js'

test('packaged: data folder sits next to the exe', () => {
  const exePath = path.join(path.sep, 'apps', 'ShadowMail', 'ShadowMail.exe')
  assert.equal(
    resolveDataDir({ isPackaged: true, exePath, appPath: '/ignored', env: {} }),
    path.join(path.sep, 'apps', 'ShadowMail', 'data'),
  )
})

test('development: ./data-dev under the app path', () => {
  assert.equal(resolveDataDir({ isPackaged: false, exePath: '/x/electron', appPath: '/repo', env: {} }), path.join('/repo', 'data-dev'))
})

test(`${DATA_ENV} overrides both modes`, () => {
  const env = { [DATA_ENV]: '/tmp/pm-test-data' }
  assert.equal(resolveDataDir({ isPackaged: true, exePath: '/a/b.exe', appPath: '/repo', env }), path.resolve('/tmp/pm-test-data'))
  assert.equal(resolveDataDir({ isPackaged: false, exePath: '/a/b', appPath: '/repo', env }), path.resolve('/tmp/pm-test-data'))
})

test('all Electron paths and the database live inside the data folder', () => {
  const dataDir = path.join(path.sep, 'd', 'data')
  const all = [...Object.values(electronPaths(dataDir)), databasePath(dataDir)]
  assert.deepEqual(Object.keys(electronPaths(dataDir)).sort(), ['crashDumps', 'logs', 'sessionData', 'temp', 'userData'])
  for (const p of all) assert.ok(p.startsWith(dataDir + path.sep), p)
  assert.equal(databasePath(dataDir), path.join(dataDir, 'mail.sqlite'))
})

test('ensureWritableDir creates the folder and leaves no probe file', t => {
  const root = tempDir(t)
  const dir = path.join(root, 'data', 'electron', 'logs')
  ensureWritableDir(dir)
  assert.deepEqual(fs.readdirSync(dir), [])
})

// chmod does not make a Windows folder read-only; the Windows case is measured on the package.
const skipReadOnly = process.platform === 'win32' ? 'chmod has no effect on Windows folders'
  : process.getuid && process.getuid() === 0 ? 'root ignores permissions' : false

test('ensureWritableDir throws on a read-only parent', { skip: skipReadOnly }, t => {
  const root = tempDir(t)
  fs.chmodSync(root, 0o555)
  try {
    assert.throws(() => ensureWritableDir(path.join(root, 'data')), err => ['EACCES', 'EPERM'].includes(err.code))
    assert.deepEqual(fs.readdirSync(root), [])
  } finally {
    fs.chmodSync(root, 0o755)
  }
})
