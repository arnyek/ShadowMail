// "Küldés később": a scheduled message whose earlier send may have gone out (interrupted, or no answer after the data)
// opened in the composer (Composer.jsx, jsdom, a stub bridge): the composer says so above the form, and Küldés or
// Küldés később asks first (the focus on Mégse, as the list's Küldés most); Mégse sends nothing, the yes sends once and
// does not ask again; on the Küldés később path the question and its yes say it schedules again. A message without that
// state never asks.
process.env.TZ = 'Europe/Budapest'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'

setupDom()
// the composer measures its body after a frame
globalThis.requestAnimationFrame = window.requestAnimationFrame = fn => setTimeout(() => fn(Date.now()), 0)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame = id => clearTimeout(id)
const calls = []
let initialForm = null
window.shadowMail = {
  language: 'hu',
  onStatus: () => () => {},
  compose: {
    accounts: async () => ({ ok: true, accounts: [{ id: 1, name: 'Munka', email: 'sajat@example.invalid', display_name: 'Saját', signature: '', hasImage: false }] }),
    initial: async () => ({ ok: true, form: initialForm, attachments: [] }),
    checked: async () => ({ ok: true }),
    ready: async () => ({ ok: true }),
    suspect: async () => ({ ok: true }),
    suggest: async () => ({ ok: true, items: [] }),
    onLockRequested: () => () => {},
    onCloseRequested: () => () => {},
    lockDone: async () => ({ ok: true }),
    send: async (sid, form) => (calls.push(['send', form.subject]), { ok: true, rejected: [], warnings: [] }),
    schedule: async (sid, form, at) => (calls.push(['schedule', at]), { ok: true }),
    saveDraft: async () => ({ ok: true, savedAt: Date.now() }),
    close: async () => (calls.push(['close']), { ok: true }),
    discard: async () => ({ ok: true }),
    addFiles: async () => ({ ok: true, attachments: [] }),
    removeAttachment: async () => ({ ok: true, attachments: [] }),
  },
}
const { createElement: h } = await import('react')
const { Composer } = await import('../app/renderer/src/Composer.jsx')
const { hu } = await import('../app/renderer/i18n/hu.js')
const ts = hu.scheduledList

const SID = '11111111-2222-3333-4444-555555555555'
const form = (over = {}) => ({ accountId: 1, to: 'anna@example.invalid', cc: '', bcc: '', subject: 'Időzített', draftHtml: '<p>Szia</p>', inReplyTo: null, references: [], ...over })
const settle = () => inAct(async () => new Promise(r => setTimeout(r, 20)))
const button = name => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === name)
const click = el => inAct(async () => el.click())

async function open(t, f) {
  calls.length = 0
  initialForm = f
  const v = await mount(h(Composer, { sessionId: SID }))
  t.after(v.unmount)
  await settle()
  await settle()
  return v
}

test('an uncertain scheduled message: the warning above the form; Küldés asks (focus on Mégse); Mégse sends nothing; the yes sends once', async t => {
  await open(t, form({ mayHaveGone: 'uncertain' }))
  const warn = document.querySelector('.compose-may-have-gone')
  assert.ok(warn, 'the warning is shown')
  assert.ok(warn.textContent.includes(hu.composeMayHaveGone))
  await click(button(hu.composeSend))
  let modal = document.querySelector('[role="alertdialog"]')
  assert.ok(modal, 'it asks')
  assert.ok(modal.textContent.includes(ts.interruptedText))
  assert.equal(document.activeElement.textContent.trim(), ts.interruptedNo, 'the focus on Mégse')
  await click(document.activeElement)
  assert.equal(document.querySelector('[role="alertdialog"]'), null)
  assert.deepEqual(calls, [], 'nothing sent')
  await click(button(hu.composeSend))
  await click(button(ts.interruptedYes))
  await settle()
  assert.deepEqual(calls.filter(c => c[0] === 'send'), [['send', 'Időzített']], 'sent once')
})

test('an interrupted one: Küldés később asks too before scheduling it again; after the yes no second question', async t => {
  await open(t, form({ mayHaveGone: 'interrupted' }))
  assert.ok(document.querySelector('.compose-may-have-gone'))
  await click(button(hu.composeSendLater))
  const ok = document.querySelector('.compose-schedule-ok')
  await click(ok)
  const modal = document.querySelector('[role="alertdialog"]')
  assert.ok(modal, 'it asks before scheduling')
  assert.ok(modal.textContent.includes(ts.interruptedLaterTitle) && modal.textContent.includes(ts.interruptedLaterText), 'its own question: the yes schedules')
  assert.ok(!modal.textContent.includes(ts.interruptedTitle) && !button(ts.interruptedYes), 'not the Küldés most question')
  assert.deepEqual(calls, [])
  await click(button(ts.interruptedLaterYes))
  await settle()
  assert.equal(calls.filter(c => c[0] === 'schedule').length, 1, 'scheduled once')
})

test('a scheduled message without that state, and a draft: no warning, Küldés sends at once', async t => {
  for (const f of [form(), form({ subject: 'Piszkozat' })]) {
    await open(t, f)
    assert.equal(document.querySelector('.compose-may-have-gone'), null)
    await click(button(hu.composeSend))
    await settle()
    assert.equal(document.querySelector('[role="alertdialog"]'), null, 'no question')
    assert.equal(calls.filter(c => c[0] === 'send').length, 1)
    for (const el of [...document.body.children]) el.remove()
  }
})
