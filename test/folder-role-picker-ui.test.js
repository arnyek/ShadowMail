// SPDX-License-Identifier: GPL-3.0-or-later
// The role picker in the account editor (jsdom): a saved IMAP account shows five selects, "Automatic" names the folder
// the automatic rule chose, a chosen folder is selected; choosing calls folders:setRole and reloads; a refusal shows its
// text; a new account and a POP3 account have no picker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'

setupDom()
const calls = []
let rows = []
let nextResult = { ok: true, changed: 2 }
window.shadowMail = {
  accounts: {
    signatureImage: async () => ({ ok: true, image: null }),
    save: async () => ({ ok: true }),
    test: async () => ({ ok: true }),
  },
  mail: { folders: async () => (calls.push(['folders']), { ok: true, accounts: [{ id: 7, folders: rows }] }) },
  folders: { setRole: async q => (calls.push(['setRole', q]), nextResult) },
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
const base = { id: 7, name: 'Munka', email: 'a@example.invalid', in_host: 'h', in_port: 993, in_security: 'tls', in_user: 'u', body_index_days: 1095, sync_interval_min: 5, save_sent_to_server: 1, smtp_same_password: 1, tls_verify: 1, signature: '' }
const row = (path, role = null, manual = 0) => ({ path, delimiter: '/', special_use: null, is_local: 0, role, role_manual: manual, count: 0, unread: 0 })

test('a saved IMAP account: five roles, Automatic names the automatic folder, a chosen one is selected', async t2 => {
  rows = [row('INBOX', 'inbox'), row('Sent', 'sent'), row('Elküldött elemek'), row('Régi', 'trash', 1), row('Drafts', 'drafts')]
  calls.length = 0
  const v = await mount(h(AccountEditor, { account: { ...base, type: 'imap' }, onSaved() {}, onCancel() {} }))
  t2.after(v.unmount)
  await inAct(() => wait(30))
  const box = v.container.querySelector('fieldset.folder-roles')
  assert.ok(box)
  assert.deepEqual([...box.querySelectorAll('.folder-role')].map(e => e.dataset.role), ['drafts', 'sent', 'trash', 'junk', 'archive'])
  const trigger = role => v.container.querySelector(`#acc-role-${role}`)
  assert.equal(trigger('sent').textContent, t.folderRolePicker.autoNow('Sent'))
  assert.equal(trigger('trash').textContent, 'Régi', 'the chosen folder is the value')
  assert.equal(trigger('junk').textContent, t.folderRolePicker.auto, 'no folder for junk: plain Automatic')
  // the options: Automatic, then every server folder except INBOX
  await click(trigger('sent'))
  const items = [...v.container.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]')].map(e => e.textContent)
  assert.ok(items.includes('Elküldött elemek') && !items.includes('INBOX'), JSON.stringify(items))
  const pick = [...v.container.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]')].find(e => e.textContent === 'Elküldött elemek')
  await click(pick)
  assert.deepEqual(calls.filter(c => c[0] === 'setRole'), [['setRole', { accountId: 7, role: 'sent', path: 'Elküldött elemek' }]])
  assert.ok(calls.filter(c => c[0] === 'folders').length >= 2, 'reloaded after the choice')
})

test('Automatic sends null; a refusal shows its text', async t2 => {
  rows = [row('INBOX', 'inbox'), row('Régi', 'trash', 1)]
  calls.length = 0
  nextResult = { ok: false, error: 'not_found' }
  const v = await mount(h(AccountEditor, { account: { ...base, type: 'imap' }, onSaved() {}, onCancel() {} }))
  t2.after(v.unmount)
  await inAct(() => wait(30))
  await click(v.container.querySelector('#acc-role-trash'))
  const auto = [...v.container.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]')].find(e => e.textContent === t.folderRolePicker.auto)
  await click(auto)
  assert.deepEqual(calls.filter(c => c[0] === 'setRole'), [['setRole', { accountId: 7, role: 'trash', path: null }]])
  assert.equal(v.container.querySelector('.folder-roles-error').textContent, t.folderError('not_found'))
  nextResult = { ok: true, changed: 2 }
})

test('a new account and a POP3 account: no picker, no folder call', async t2 => {
  calls.length = 0
  const n = await mount(h(AccountEditor, { account: null, onSaved() {}, onCancel() {} }))
  t2.after(n.unmount)
  const p = await mount(h(AccountEditor, { account: { ...base, type: 'pop3' }, onSaved() {}, onCancel() {} }))
  t2.after(p.unmount)
  await inAct(() => wait(30))
  assert.equal(n.container.querySelector('fieldset.folder-roles'), null)
  assert.equal(p.container.querySelector('fieldset.folder-roles'), null)
  assert.deepEqual(calls, [])
})
