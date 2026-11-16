// The package carries only the paths of package.json build.files. A main-process file importing anything outside them
// starts on Linux (the whole repo is there) and dies in the Windows package with ERR_MODULE_NOT_FOUND (an earlier
// package did not start: app/main/ipc/compose.js imported app/renderer/src/compose-shape.js). So: every relative
// import (static, dynamic, require, new URL for a worker) of every packaged JS file must resolve to a packaged file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rel = p => path.relative(repo, p).split(path.sep).join('/')

// the include patterns of build.files: "dir/**" -> the prefix "dir/", a plain file -> itself
function packagedTest() {
  const files = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).build.files.filter(f => !f.startsWith('!'))
  const prefixes = files.filter(f => f.endsWith('/**')).map(f => f.slice(0, -2))
  const exact = new Set(files.filter(f => !f.includes('*')))
  for (const f of files) assert.ok(f.endsWith('/**') || !f.includes('*'), `a build.files pattern this test does not understand: ${f}`)
  return r => exact.has(r) || prefixes.some(p => r.startsWith(p))
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(m?js|cjs)$/.test(e.name)) out.push(p)
  }
  return out
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bnew URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g

test('package: every relative import of the packaged main-process code resolves to a packaged file', () => {
  const packaged = packagedTest()
  const roots = ['app/main', 'app/preload', 'core'].map(d => path.join(repo, d))
  for (const r of roots) assert.ok(packaged(`${rel(r)}/x.js`), `${rel(r)} itself is packaged`)
  const bad = []
  let seen = 0
  for (const file of roots.flatMap(r => walk(r))) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(IMPORT_RE)) {
      seen++
      const target = rel(path.resolve(path.dirname(file), m[1]))
      if (!packaged(target)) bad.push(`${rel(file)} -> ${target}`)
      else if (!fs.existsSync(path.join(repo, target))) bad.push(`${rel(file)} -> ${target} (missing)`)
    }
  }
  assert.ok(seen > 100, `the scan found ${seen} imports: the pattern still matches`)
  assert.deepEqual(bad, [])
})
