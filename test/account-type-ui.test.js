// SPDX-License-Identifier: GPL-3.0-or-later
// A new account's type (jsdom): two radio buttons, none chosen; no port and no type-only field until the choice; Save
// and the connection test give the main process's refusal (the real validateAccount) under the choice; the usual port
// comes with the choice and follows it, a typed port stays; a security change before the choice does not break the
// editor; Claude's prefill comes with its type; a saved account shows its type, locked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'
import { validateAccount } from '../core/accounts/model.js'

setupDom()
const sent = []
const refuse = form => {
  sent.push(form)
  const { errors } = validateAccount(form, null, { hasIncoming: true, hasSmtp: true })
  return Object.keys(errors).length ? { ok: false, error: 'invalid', fields: errors } : { ok: true, account: { id: 1, ...form } }
}
window.shadowMail = {
  accounts: { save: async form => refuse(form), test: async form => refuse(form), signatureImage: async () => ({ ok: true, image: null }) },
  mail: { folders: async () => ({ ok: true, accounts: [] }) },
  folders: { setRole: async () => ({ ok: true, changed: 0 }) },
  onStatus: () => () => {},
}
const { createElement: h } = await import('react')
const { AccountEditor } = await import('../app/renderer/src/Accounts.jsx')
const { t } = await import('../app/renderer/i18n/index.js')
const wait = ms => new Promise(r => setTimeout(r, ms))
const click = el => inAct(async () => {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(20)
})
const typeInto = (el, value) => inAct(async () => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(el, value)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
  await wait(10)
})
const $ = (v, sel) => v.container.querySelector(sel)
const button = (v, text) => [...v.container.querySelectorAll('button')].find(b => b.textContent === text)

test('a new account: no type chosen, no port, no type-only field; Save and the test refuse with the type text', async tc => {
  sent.length = 0
  const v = await mount(h(AccountEditor, { account: null, onSaved() {}, onCancel() {} }))
  tc.after(v.unmount)
  const radios = [...v.container.querySelectorAll('fieldset.account-type input[type="radio"]')]
  assert.deepEqual(radios.map(r => [r.id, r.checked]), [['acc-type-imap', false], ['acc-type-pop3', false]])
  assert.equal($(v, 'fieldset.account-type legend').textContent, t.accountFields.type)
  assert.ok($(v, 'label[for="acc-type-pop3"]').textContent.includes(t.accountTypeHelp.pop3))
  assert.equal($(v, '#acc-type'), null, 'no preset menu')
  assert.equal($(v, '#acc-in_port').value, '')
  for (const id of ['#acc-save_sent_to_server', '#acc-archive_mode', '#acc-pop3_delete_after_days', '#acc-pop3-seen-help']) assert.equal($(v, id), null, id)

  await inAct(async () => {
    $(v, 'form.account-editor').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await wait(20)
  })
  assert.equal(sent.at(-1).type, '')
  assert.equal($(v, '#acc-type-error').textContent, t.accountError('bad_type'))
  assert.equal(t.accountError('bad_type'), t.accountErrors.bad_type)
  assert.equal($(v, 'fieldset.account-type').getAttribute('aria-describedby'), 'acc-type-error')

  await click(button(v, t.accountTest))
  assert.equal(sent.length, 2)
  assert.equal(sent.at(-1).type, '')
  assert.equal($(v, '#acc-type-error').textContent, t.accountError('bad_type'))
})

test('the choice: the usual port comes and follows it; a typed port stays; the type-only fields follow', async tc => {
  const v = await mount(h(AccountEditor, { account: null, onSaved() {}, onCancel() {} }))
  tc.after(v.unmount)
  await click($(v, '#acc-type-pop3'))
  assert.ok($(v, '#acc-type-pop3').checked && !$(v, '#acc-type-imap').checked)
  assert.equal($(v, '#acc-in_port').value, '995')
  assert.ok($(v, '#acc-pop3_delete_after_days'))
  assert.equal($(v, '#acc-save_sent_to_server'), null)
  await click($(v, '#acc-type-imap'))
  assert.equal($(v, '#acc-in_port').value, '993')
  assert.ok($(v, '#acc-save_sent_to_server') && $(v, '#acc-archive_mode'))
  assert.equal($(v, '#acc-pop3_delete_after_days'), null)
  await typeInto($(v, '#acc-in_port'), '1993')
  await click($(v, '#acc-type-pop3'))
  assert.equal($(v, '#acc-in_port').value, '1993', 'a typed port stays')
})

test('a security change before the type: the editor stays, the port comes with the type for that security', async tc => {
  const v = await mount(h(AccountEditor, { account: null, onSaved() {}, onCancel() {} }))
  tc.after(v.unmount)
  await click($(v, '#acc-in_security'))
  const option = [...document.querySelectorAll('[role="menuitemradio"], [role="option"]')].find(o => o.textContent === t.securityLabels.starttls)
  assert.ok(option, 'the STARTTLS option')
  await click(option)
  assert.equal($(v, '#acc-in_port').value, '')
  await click($(v, '#acc-type-imap'))
  assert.equal($(v, '#acc-in_port').value, '143')
})

test("Claude's prefill brings its type; a saved account shows its type, locked", async tc => {
  const p = await mount(h(AccountEditor, { account: { prefill: { type: 'pop3', email: 'a@example.invalid', in_host: 'h' } }, onSaved() {}, onCancel() {} }))
  tc.after(p.unmount)
  assert.ok($(p, '#acc-type-pop3').checked)
  assert.equal($(p, '#acc-in_port').value, '995')
  const bad = await mount(h(AccountEditor, { account: { prefill: { type: 'smtp', email: 'a@example.invalid' } }, onSaved() {}, onCancel() {} }))
  tc.after(bad.unmount)
  assert.ok(!$(bad, '#acc-type-imap').checked && !$(bad, '#acc-type-pop3').checked, 'an unknown prefilled type: none chosen')
  const saved = { id: 7, name: 'Munka', email: 'a@example.invalid', type: 'pop3', in_host: 'h', in_port: 995, in_security: 'tls', in_user: 'u', body_index_days: 1095, sync_interval_min: 5, save_sent_to_server: 0, smtp_same_password: 1, tls_verify: 1 }
  const s = await mount(h(AccountEditor, { account: saved, onSaved() {}, onCancel() {} }))
  tc.after(s.unmount)
  assert.equal($(s, 'fieldset.account-type'), null)
  // the stored type is a read-only value (the shared form base), not a disabled menu: named by its label, described by the hint
  const sel = $(s, '#acc-type')
  assert.ok(sel && sel.getAttribute('role') === 'textbox' && sel.getAttribute('aria-readonly') === 'true', 'read-only')
  assert.equal(sel.tagName, 'SPAN', 'not a control')
  assert.ok(sel.textContent.includes(t.typeLabels.pop3))
  assert.equal(document.getElementById(sel.getAttribute('aria-labelledby')).textContent, t.accountFields.type)
  assert.equal(document.getElementById(sel.getAttribute('aria-describedby')).textContent, t.accountForm.typeLocked)
})
