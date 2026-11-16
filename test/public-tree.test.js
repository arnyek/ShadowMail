// The public-check on this tree, as part of npm test. With the local deny list (the original repository) it is the full
// check; without it (a public clone, a fresh work tree, the Windows build folder) every category is checked except the
// local names, and the test says so. `npm run check:public` alone still insists on the list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = fileURLToPath(new URL('../scripts/public-check.mjs', import.meta.url))

test('public tree: the public-check finds nothing in this tree', (t) => {
  const hasLocal = fs.existsSync(new URL('../.public-deny.local', import.meta.url))
  if (!hasLocal) t.diagnostic('no .public-deny.local here: the local host and machine names were not checked')
  const r = spawnSync(process.execPath, [script, '--root', root, ...(hasLocal ? [] : ['--allow-missing-local'])], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /public-check: \d+ files, 0 findings/)
})
