// "Küldés és archiválás" in the composer (Composer.jsx, jsdom, a stub bridge): the button after Küldés and before
// Küldés később, only when the main process says the original can be archived; its name, title and key in the
// attributes; Ctrl+Enter sends, Ctrl+Shift+Enter sends and archives (only then); neither while a dialog or a menu is
// open, while sending or after the send; the resend question comes before a keyboard send too; the main process's
// archive warnings in the "sent, but" notice.
process.env.TZ = 'Europe/Budapest'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'

setupDom()
// the composer measures its body after a frame
globalThis.requestAnimationFrame = window.requestAnimationFrame = fn => setTimeout(() => fn(Date.now()), 0)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame = id => clearTimeout(id)
const calls = []
let initial = null
let answer = () => ({ ok: true, rejected: [], warnings: [] })
let hold = null // a promise the send waits for (a send under way)
let suggestions = [] // the address book's answer to the recipient field
window.shadowMail = {
  language: 'hu',
  onStatus: () => () => {},
  compose: {
    accounts: async () => ({ ok: true, accounts: [{ id: 1, name: 'Munka', email: 'sajat@example.invalid', display_name: 'Saját', signature: '', hasImage: false }] }),
    initial: async () => initial,
    checked: async () => ({ ok: true }),
    ready: async () => ({ ok: true }),
    suspect: async () => ({ ok: true }),
    suggest: async () => ({ ok: true, contacts: suggestions }),
    onLockRequested: () => () => {},
    onCloseRequested: () => () => {},
    lockDone: async () => ({ ok: true }),
    send: async (sid, form, options) => {
      calls.push(['send', options])
      if (hold) await hold
      return answer()
    },
    schedule: async () => (calls.push(['schedule']), { ok: true }),
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
const { en } = await import('../app/renderer/i18n/en.js')

const SID = '11111111-2222-3333-4444-555555555555'
const reply = (over = {}) => ({ accountId: 1, to: 'anna@example.invalid', cc: '', subject: 'Re: Kérdés', quote: '<blockquote><p>Kérdés</p></blockquote>', inReplyTo: '<q@x>', references: ['<q@x>'], ...over })
const settle = () => inAct(async () => new Promise(r => setTimeout(r, 20)))
const button = name => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === name)
const archiveButton = () => document.querySelector('.compose-send-archive')
const click = el => inAct(async () => el.click())
const sends = () => calls.filter(c => c[0] === 'send')
const key = (shift, target = document.querySelector('.editor')) =>
  inAct(async () => {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true }))
  })

// one composer at a time, as in the app (one per window): the one before is unmounted first (two would share the key)
let mounted = null
const unmountLast = () => {
  if (mounted) mounted.unmount()
  mounted = null
}
async function open(t, init) {
  unmountLast()
  calls.length = 0
  initial = init
  answer = () => ({ ok: true, rejected: [], warnings: [] })
  hold = null
  const v = await mount(h(Composer, { sessionId: SID }))
  mounted = v
  t.after(() => mounted === v && unmountLast())
  await settle()
  await settle()
  return v
}

test('the texts in both languages', () => {
  assert.equal(hu.composeSendArchive, 'Küldés és archiválás')
  assert.equal(en.composeSendArchive, 'Send and archive')
  assert.match(hu.composeSendTitle, /Ctrl\+Enter/)
  assert.match(en.composeSendTitle, /Ctrl\+Enter/)
  assert.match(hu.composeSendArchiveTitle, /^Küldés és archiválás .*Ctrl\+Shift\+Enter/)
  assert.match(en.composeSendArchiveTitle, /^Send and archive .*Ctrl\+Shift\+Enter/)
})

test('archivable: the button between Küldés and Küldés később, its name, title and key; a click sends with archive', async t => {
  await open(t, { ok: true, form: reply(), attachments: [], archivable: true })
  const footer = [...document.querySelector('.compose-actions').children]
  const send = button(hu.composeSend)
  const archive = archiveButton()
  const later = button(hu.composeSendLater)
  assert.equal(Boolean(archive), true, 'the button is there')
  assert.deepEqual([footer.indexOf(send), footer.indexOf(archive), footer.indexOf(later)], [0, 1, 2], 'Küldés, Küldés és archiválás, Küldés később')
  assert.equal(archive.getAttribute('aria-label'), hu.composeSendArchive)
  assert.equal(archive.getAttribute('title'), hu.composeSendArchiveTitle)
  assert.equal(archive.getAttribute('aria-keyshortcuts'), 'Control+Shift+Enter')
  assert.equal(archive.textContent.trim(), hu.composeSendArchive)
  assert.ok(archive.classList.contains('btn-outlined') && send.classList.contains('btn-primary'), 'Küldés stays the primary one')
  assert.equal(send.getAttribute('aria-keyshortcuts'), 'Control+Enter')
  assert.equal(send.getAttribute('title'), hu.composeSendTitle)
  await click(archive)
  await settle()
  assert.deepEqual(sends(), [['send', { archive: true }]])
  assert.ok(calls.some(c => c[0] === 'close'), 'the window closes as after a plain send')
})

test('Küldés (button and Ctrl+Enter) sends without archive; Ctrl+Shift+Enter with it', async t => {
  await open(t, { ok: true, form: reply(), attachments: [], archivable: true })
  await click(button(hu.composeSend))
  await settle()
  assert.deepEqual(sends(), [['send', undefined]])
  await open(t, { ok: true, form: reply(), attachments: [], archivable: true })
  await key(false)
  await settle()
  assert.deepEqual(sends(), [['send', undefined]], 'Ctrl+Enter')
  await open(t, { ok: true, form: reply(), attachments: [], archivable: true })
  await key(true, document.querySelector('#compose-subject'))
  await settle()
  assert.deepEqual(sends(), [['send', { archive: true }]], 'Ctrl+Shift+Enter, from the subject field too')
})

test('a new message: no button', async t => {
  await open(t, { ok: true, form: null, attachments: [], archivable: false })
  assert.equal(archiveButton() === null, true, 'a new message: no button') // a jsdom node in an assert message takes ages to print
})

test('not archivable (no Archive): no button; Ctrl+Shift+Enter does nothing, Ctrl+Enter sends', async t => {
  await open(t, { ok: true, form: reply(), attachments: [] })
  assert.equal(archiveButton() === null, true, 'no archivable field: no button')
  await key(true)
  await settle()
  assert.deepEqual(sends(), [], 'Ctrl+Shift+Enter: nothing')
  await key(false)
  await settle()
  assert.deepEqual(sends(), [['send', undefined]])
})

test('no key while a dialog or a menu is open', async t => {
  await open(t, { ok: true, form: reply(), attachments: [], archivable: true })
  await click(button(hu.composeSendLater))
  assert.ok(document.querySelector('[role="dialog"]'), 'the schedule dialog is open')
  await key(false, document.querySelector('[role="dialog"]'))
  await key(true, document.querySelector('[role="dialog"]'))
  await settle()
  assert.deepEqual(sends(), [], 'nothing sent under the dialog')
  // a menu (the text colour menu of the toolbar)
  await open(t, { ok: true, form: reply(), attachments: [], archivable: true })
  await click(document.querySelector(`button[aria-label="${hu.composeColors.text}"]`) || document.querySelector('.editor-toolbar .menu-anchor > button'))
  assert.ok(document.querySelector('[role="menu"]'), 'a menu is open')
  await key(false, document.querySelector('[role="menu"]'))
  await settle()
  assert.deepEqual(sends(), [], 'nothing sent under the menu')
})

test('while sending: the button is disabled and no key sends again; after the send no key sends', async t => {
  await open(t, { ok: true, form: reply(), attachments: [], archivable: true })
  let release
  hold = new Promise(r => (release = r))
  answer = () => ({ ok: true, rejected: ['nincs@example.invalid'], warnings: ['archive_rejected'] })
  await key(true)
  await settle()
  assert.equal(sends().length, 1)
  assert.equal(archiveButton().disabled, true, 'disabled while sending')
  assert.equal(button(hu.composeSending).disabled, true)
  await key(false)
  await key(true)
  await settle()
  assert.equal(sends().length, 1, 'no second send while sending')
  await inAct(async () => release())
  await settle()
  // refused recipient: the window stays open with the main process's sentence
  const notice = document.body.textContent
  assert.ok(notice.includes('Az eredeti levelet nem archiváltam, mert egy címzett elutasította.'), 'the sentence is shown')
  assert.ok(!calls.some(c => c[0] === 'close'), 'the window stays open')
  assert.equal(archiveButton().disabled, true, 'disabled after the send')
  await key(false)
  await key(true)
  await settle()
  assert.equal(sends().length, 1, 'no key sends after the send')
})

test('an open suggestion list: Ctrl+Enter and Ctrl+Shift+Enter pick the suggestion and send nothing; the next one sends', async t => {
  await open(t, { ok: true, form: reply({ to: '' }), attachments: [], archivable: true })
  suggestions = [{ name: 'Kovács Anna', address: 'anna@example.invalid' }, { name: 'András', address: 'andras@example.invalid' }]
  t.after(() => (suggestions = []))
  const to = document.querySelector('#compose-to')
  const typeTo = async v =>
    inAct(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(to, v)
      to.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  for (const shift of [false, true]) {
    await typeTo('an')
    await inAct(async () => new Promise(r => setTimeout(r, 250))) // the field asks after 150 ms
    assert.ok(document.querySelector('.suggestions'), 'the list is open')
    await key(shift, to)
    await settle()
    assert.deepEqual(sends(), [], `${shift ? 'Ctrl+Shift+Enter' : 'Ctrl+Enter'} under the list: nothing sent`)
    assert.match(to.value, /Kovács Anna <anna@example\.invalid>/, 'the suggestion picked')
  }
  await key(true, to)
  await settle()
  assert.deepEqual(sends(), [['send', { archive: true }]], 'with the list closed the key sends')
})

test('the resend question comes before a keyboard send too; its yes sends once with archive', async t => {
  await open(t, { ok: true, form: { ...reply(), mayHaveGone: 'uncertain' }, attachments: [], archivable: true })
  await key(true)
  const modal = document.querySelector('[role="alertdialog"]')
  assert.ok(modal, 'it asks')
  assert.deepEqual(sends(), [])
  // the key again under the question: nothing
  await key(true, modal)
  await settle()
  assert.deepEqual(sends(), [])
  await click(button(hu.scheduledList.interruptedYes))
  await settle()
  assert.deepEqual(sends(), [['send', { archive: true }]])
})
