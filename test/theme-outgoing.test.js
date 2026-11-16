// The theme stays in the composer's frame: what goes out (a new message, a reply, a forward) is the editor's HTML through
// sanitizeCompose, which keeps no class, style or data attribute, so no theme token or color can reach the message. The
// same editor content under every theme (and a probe theme) gives the same bytes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'
import { THEMES, applyTheme } from '../app/renderer/src/themes.js'

// what an editor could hold after typing, pasting or formatting under a theme: theme classes, token colors, a data mark
const EDITED = [
  '<p class="editor-line" style="color: var(--c-text); background: var(--c-bg)" data-theme="dark">Kedves Anna,</p>',
  '<blockquote style="border-left: 2px solid var(--c-accent)"><p>az eredeti <b class="x">levél</b></p></blockquote>',
  '<div><span style="color:#e8eaed">sötét témából másolt szöveg</span> <a href="https://example.invalid/" class="link" style="color: var(--c-accent)">link</a></div>',
].join('')

function outgoing(themeId) {
  const { window } = new JSDOM('<!doctype html><html><body><div class="editor" contenteditable="true"></div></body></html>')
  applyTheme(themeId, window.document)
  window.document.documentElement.dataset.theme = themeId // a probe id too, as the page would carry it
  const editor = window.document.querySelector('.editor')
  editor.innerHTML = EDITED
  return sanitizeCompose(createDOMPurify(window), editor.innerHTML)
}

test('the outgoing HTML carries no theme: no class, style, data attribute, token or color', () => {
  const html = outgoing('default')
  assert.doesNotMatch(html, /class=|style=|data-|var\(--|#e8eaed/i, html)
  assert.equal(html, '<p>Kedves Anna,</p><blockquote><p>az eredeti <b>levél</b></p></blockquote><div><span>sötét témából másolt szöveg</span> <a href="https://example.invalid/">link</a></div>')
})

test('the outgoing HTML is byte for byte the same under every theme and a probe theme', () => {
  const ids = [...THEMES.map(t => t.id), 'probe-dark']
  const out = ids.map(outgoing)
  assert.deepEqual(new Set(out).size, 1, JSON.stringify(Object.fromEntries(ids.map((id, i) => [id, out[i]]))))
})
