// SPDX-License-Identifier: GPL-3.0-or-later
// What the Windows ZIP takes from the native SQLite module, measured with electron-builder's OWN node_modules filter
// (app-builder-lib getNodeModuleFileMatcher + the package.json "files"): the MSBuild leftovers of a Windows build
// (build\*.vcxproj(.filters), build\Release\obj\..., with the build machine's paths in them) stay out; the binary the
// app loads (build\Release\better_sqlite3.node), the Windows prebuild and the JS stay in. The other platforms'
// prebuilds and the C sources stay out as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher.js')
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
const MOD = 'node_modules/better-sqlite3-multiple-ciphers'

function packed() {
  const matcher = getNodeModuleFileMatcher(repo, '/out/app', s => s, {}, { config: pkg.build, debugLogger: { isEnabled: false } })
  const filter = matcher.createFilter()
  // the copy helper hands the filter the path inside the app as moduleFullFilePath (NodeModuleCopyHelper)
  return (rel, dir = false) => filter(path.join(repo, rel), { isDirectory: () => dir, moduleFullFilePath: rel })
}

// the leftovers found in the 0.12.0 and 0.14.0 ZIPs (the obj names: an MSBuild Release build's usual files)
const LEFTOVERS = [
  'build/better_sqlite3.vcxproj',
  'build/better_sqlite3.vcxproj.filters',
  'build/test_extension.vcxproj',
  'build/test_extension.vcxproj.filters',
  'build/Release/obj/better_sqlite3/better_sqlite3.node.recipe',
  'build/Release/obj/better_sqlite3/better_sqlite3.tlog/better_sqlite3.lastbuildstate',
  'build/Release/obj/test_extension/test_extension.node.recipe',
  'build/Release/obj/test_extension/test_extension.tlog/test_extension.lastbuildstate',
]

test('the MSBuild leftovers of a Windows build stay out of the package', () => {
  const take = packed()
  for (const f of LEFTOVERS) assert.equal(take(`${MOD}/${f}`), false, f)
  assert.equal(take(`${MOD}/build/Release/obj`, true), false, 'the obj folder itself')
})

test('what the app needs stays in: the built binary, the Windows prebuild, the JS, the package.json', () => {
  const take = packed()
  for (const f of ['build/Release/better_sqlite3.node', 'prebuilds/win32-x64.node', 'lib/index.js', 'lib/database.js', 'package.json']) {
    assert.equal(take(`${MOD}/${f}`), true, f)
  }
  for (const d of ['build', 'build/Release', 'lib', 'prebuilds']) assert.equal(take(`${MOD}/${d}`, true), true, d)
})

test('the earlier exclusions still hold; other modules are not touched', () => {
  const take = packed()
  for (const f of ['prebuilds/linux-x64.node', 'prebuilds/darwin-arm64.node', 'src/better_sqlite3.cpp', 'deps/sqlite3/sqlite3.c', 'docs/api.md']) {
    assert.equal(take(`${MOD}/${f}`), false, f)
  }
  assert.equal(take('node_modules/other-native/build/x.vcxproj'), true, 'only this module is filtered')
  assert.equal(take('node_modules/other-native/build/Release/obj/x.recipe'), true)
})
