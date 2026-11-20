// SPDX-License-Identifier: GPL-3.0-or-later
// The composer window's own policy (app/renderer/compose.html): the main window's policy plus exactly ONE allowed
// inline style (the editor's image commands write it; measured) and the pasted images' scheme. The main window
// (index.html) keeps style-src 'self' and no inl-img:, and a received message's frame (mail-view:) never gets the hash.
// That no policy line shows at a pasted image is measured by test/e2e/paste-image-e2e.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { viewCsp } from '../app/main/protocols.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => fs.readFileSync(path.join(repo, rel), 'utf8')
const EDITOR_STYLE = "'sha256-fFC89QmtxDk/dIQSVl8wDRNRgE5CdR0b9SsBNcFgSGg='"

// the page's policy: directive -> its sources
function policyOf(html) {
  const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/g)]
  assert.equal(metas.length, 1, 'one policy on the page')
  return Object.fromEntries(
    metas[0][1]
      .split(';')
      .map(d => d.trim().split(/\s+/))
      .filter(d => d[0])
      .map(([name, ...sources]) => [name, sources]),
  )
}

test('the main window: style-src \'self\' only, no pasted-image scheme', () => {
  const main = policyOf(read('app/renderer/index.html'))
  assert.deepEqual(main['style-src'], ["'self'"])
  assert.ok(!main['img-src'].includes('inl-img:'))
  assert.ok(!JSON.stringify(main).includes('unsafe'), 'nothing unsafe at all')
})

test('the composer: the main window\'s policy, plus exactly the one editor style and inl-img:', () => {
  const main = policyOf(read('app/renderer/index.html'))
  const compose = policyOf(read('app/renderer/compose.html'))
  assert.deepEqual(Object.keys(compose).sort(), Object.keys(main).sort(), 'the same directives')
  for (const name of Object.keys(main)) {
    if (name === 'style-src') assert.deepEqual(compose[name], ["'self'", "'unsafe-hashes'", EDITOR_STYLE])
    else if (name === 'img-src') assert.deepEqual(compose[name], [...main[name], 'inl-img:'])
    else assert.deepEqual(compose[name], main[name], name)
  }
  assert.ok(!compose['style-src'].includes("'unsafe-inline'"))
  assert.ok(!compose['script-src'].some(s => s.includes('unsafe')), 'scripts as strict as before')
})

test('the two pages load the same app; the build makes both; the main process puts the composer on its page', () => {
  const body = html => html.slice(html.indexOf('<body>'))
  assert.equal(body(read('app/renderer/compose.html')), body(read('app/renderer/index.html')))
  const vite = read('vite.config.js')
  assert.match(vite, /index: `\$\{root\}\/index\.html`/)
  assert.match(vite, /compose: `\$\{root\}\/compose\.html`/)
  const main = read('app/main/main.js')
  assert.match(main, /win\.loadFile\(rendererCompose\(\), \{ hash: `compose=\$\{sessionId\}` \}\)/)
  assert.match(main, /mainWindow\.loadFile\(rendererIndex\(\)\)/)
})

test('a received message\'s frame never gets the editor\'s style hash', () => {
  for (const images of [false, true]) {
    const csp = viewCsp(images)
    assert.ok(!csp.includes('unsafe-hashes') && !csp.includes('sha256-'), csp)
  }
})
