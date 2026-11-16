// A Node module hook that compiles the renderer's .jsx files for the unit tests, with the same
// compiler Vite uses (oxc, automatic React runtime). Register it before importing a .jsx file:
//
//   import { register } from 'node:module'
//   register('./helpers/jsx-loader.mjs', import.meta.url)
//   const { Button } = await import('../app/renderer/src/ui/index.js')
//
// Only *.jsx is touched; everything else loads as usual. Test-only, not part of the app.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

let transform = null

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !url.endsWith('.jsx')) return nextLoad(url, context)
  if (!transform) ({ transformWithOxc: transform } = await import('vite'))
  const file = fileURLToPath(url)
  const out = await transform(fs.readFileSync(file, 'utf8'), file, { lang: 'jsx', jsx: { runtime: 'automatic' } })
  return { format: 'module', source: out.code, shortCircuit: true }
}
