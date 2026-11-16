// A draft Claude made shows a small "Claude" mark in the list and in the
// search hits; the mark comes from the $ShadowMailClaude keyword in the row's flags (any case), nothing else.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount } from './helpers/react-dom-env.js'

setupDom()
const { createElement: h } = await import('react')
const { RowText, isClaudeDraft } = await import('../app/renderer/src/RowText.jsx')

const row = flags => ({ id: 1, from_addr: 'a@example.invalid', subject: 'Tárgy', date: Date.UTC(2026, 10, 12), has_attachments: 0, flags })

test('the "Claude" mark: only with the keyword', async () => {
  assert.equal(isClaudeDraft(row('\\Draft \\Seen $ShadowMailClaude')), true)
  assert.equal(isClaudeDraft(row('\\Draft $shadowmailclaude')), true, 'IMAP keywords are case-insensitive')
  assert.equal(isClaudeDraft(row('\\Draft \\Seen')), false)
  assert.equal(isClaudeDraft(row('$ShadowMailClaudeX')), false)
  const withMark = await mount(h('div', null, h(RowText, { m: row('\\Draft $ShadowMailClaude') })))
  const mark = withMark.container.querySelector('.claude-mark')
  assert.ok(mark)
  assert.equal(mark.textContent, 'Claude')
  const without = await mount(h('div', null, h(RowText, { m: row('\\Draft') })))
  assert.equal(without.container.querySelector('.claude-mark'), null)
})
