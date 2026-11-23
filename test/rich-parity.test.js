// SPDX-License-Identifier: GPL-3.0-or-later
// The composer's rich mode on its two ways, byte for byte: the sanitizer (app/renderer/src/sanitize.js sanitizeCompose, jsdom
// + DOMPurify, as in the composer page) and the main process's mirror (core/mime/visible-text.js visibleComposeHtml,
// htmlparser2, Claude's send_draft). A second cleaning gives the same bytes (stable), on both ways.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'
import { visibleComposeHtml } from '../core/mime/visible-text.js'
import { RICH_SAMPLES } from './helpers/rich-samples.js'
import { SAMPLES as COLOR_SAMPLES } from './helpers/color-samples.js'

const purify = createDOMPurify(new JSDOM('').window)
const rich = html => sanitizeCompose(purify, html, { rich: true })
const mirror = html => visibleComposeHtml(html, { rich: true })

// the colour samples a mirror filters for its own reason (a transparent text is hidden text there): no parity sample
const NOT_PARITY = new Set([])

for (const [name, html] of [...Object.entries(RICH_SAMPLES), ...Object.entries(COLOR_SAMPLES).filter(([n]) => !NOT_PARITY.has(n))]) {
  test(`rich: the sanitizer = the mirror, byte for byte: ${name}`, () => {
    const out = rich(html)
    assert.equal(mirror(html), out)
    assert.equal(rich(out), out, 'a second cleaning (sanitizer) changes nothing')
    assert.equal(mirror(out), out, 'a second cleaning (mirror) changes nothing')
  })
}
