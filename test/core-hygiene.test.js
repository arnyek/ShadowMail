// core/ is plain Node and environment-free: no process.env (except paths.js), no MCP, zod or PowerShell.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const coreDir = fileURLToPath(new URL('../core', import.meta.url))

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? jsFiles(p) : e.name.endsWith('.js') ? [p] : []
  })
}

test('core/ has no forbidden references', () => {
  const hits = []
  for (const file of jsFiles(coreDir)) {
    const rel = path.relative(coreDir, file)
    const text = fs.readFileSync(file, 'utf8')
    if (rel !== 'paths.js' && /process\.env/.test(text)) hits.push(`${rel}: process.env`)
    for (const word of ['@modelcontextprotocol', 'zod', 'powershell']) {
      if (new RegExp(word, 'i').test(text)) hits.push(`${rel}: ${word}`)
    }
  }
  assert.deepEqual(hits, [])
})
