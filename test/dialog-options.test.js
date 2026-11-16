// no native Open / Save dialog may add the chosen file to the Windows "Recent" list (a
// shortcut in the user's profile, outside the data folder). Every call goes through noRecent().
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { noRecent } from '../app/main/dialog-options.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('noRecent adds dontAddToRecent once and keeps the rest', () => {
  assert.deepEqual(noRecent({ defaultPath: 'a.eml' }), { defaultPath: 'a.eml', properties: ['dontAddToRecent'] })
  assert.deepEqual(noRecent({ properties: ['openFile', 'multiSelections'], filters: [] }), { properties: ['openFile', 'multiSelections', 'dontAddToRecent'], filters: [] })
  assert.deepEqual(noRecent({ properties: ['dontAddToRecent'] }).properties, ['dontAddToRecent'])
  assert.deepEqual(noRecent(), { properties: ['dontAddToRecent'] })
  const o = { properties: ['openFile'] }
  noRecent(o)
  assert.deepEqual(o.properties, ['openFile'], 'the caller object is not changed')
})

test('every showOpenDialog / showSaveDialog call of the main process goes through noRecent', () => {
  const files = []
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(m?js|cjs)$/.test(e.name)) files.push(p)
    }
  }
  walk(path.join(repo, 'app', 'main'))
  const CALL = /\.show(?:Open|Save)Dialog\(|\bdialog\[\w+\]\(/g
  const bad = []
  let calls = 0
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return
      const n = (line.match(CALL) || []).length
      if (!n) return
      calls += n
      if ((line.match(/noRecent\(/g) || []).length < n) bad.push(`${path.relative(repo, f)}:${i + 1}`)
    })
  }
  assert.ok(calls >= 8, `the scan found ${calls} dialog calls (6 places, two of them with a window / no-window pair)`)
  assert.deepEqual(bad, [])
})
