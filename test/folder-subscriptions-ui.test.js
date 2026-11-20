// SPDX-License-Identifier: GPL-3.0-or-later
// The folder subscriptions UI (jsdom): the dialog lists the server's folders as a tree, ticked = shows in
// the app; a role folder is ticked and locked with the reason; a kept folder carries its note; a tick or an untick
// calls folders:setSubscribed and the row follows; a refusal shows its text. The folder menu has "Unsubscribe" (before
// Delete) and the account menu "Folder subscriptions…" for an IMAP account only; the sidebar tells the menus the type.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'

setupDom()
const calls = []
let listResult = { ok: true, folders: [] }
let setResult = { ok: true }
window.shadowMail = {
  folders: {
    subscriptions: async q => (calls.push(['subscriptions', q]), listResult),
    setSubscribed: async q => (calls.push(['setSubscribed', q]), setResult),
  },
  onStatus: () => () => {},
}
const { createElement: h } = await import('react')
const { SubscriptionsDialog } = await import('../app/renderer/src/Subscriptions.jsx')
const { FolderTree, FolderMenu, AccountMenu } = await import('../app/renderer/src/Mail.jsx')
const { t } = await import('../app/renderer/i18n/index.js')
const wait = ms => new Promise(r => setTimeout(r, ms))
const click = el => inAct(async () => {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(20)
})
const sf = (path, extra = {}) => ({ path, delimiter: '/', subscribed: false, kept: false, role: null, shown: false, ...extra })
const rowOf = (v, path) => v.container.querySelector(`.subscriptions-list li[data-path="${path}"]`)
const boxOf = (v, path) => rowOf(v, path).querySelector('input[type="checkbox"]')

test('the dialog: sorted tree with depth, ticks = shown, role folder locked with the reason, kept note', async t2 => {
  calls.length = 0
  listResult = {
    ok: true,
    folders: [
      sf('Projektek/2024', { subscribed: true, shown: true }),
      sf('INBOX', { role: 'inbox', subscribed: true, shown: true }),
      sf('Régi', { kept: true, shown: true }),
      sf('Projektek'),
      sf('Sent', { role: 'sent', shown: true }),
    ],
  }
  const v = await mount(h(SubscriptionsDialog, { accountId: 4, accountName: 'Munka', onClose() {} }))
  t2.after(v.unmount)
  await inAct(() => wait(30))
  assert.deepEqual(calls, [['subscriptions', { accountId: 4 }]])
  assert.ok(document.body.textContent.includes(t.subscriptions.title('Munka')))
  const lis = [...v.container.querySelectorAll('.subscriptions-list li')]
  assert.deepEqual(lis.map(li => li.dataset.path), ['INBOX', 'Projektek', 'Projektek/2024', 'Régi', 'Sent'])
  assert.equal(rowOf(v, 'Projektek/2024').style.getPropertyValue('--depth'), '1')
  assert.equal(rowOf(v, 'Projektek').style.getPropertyValue('--depth'), '0')
  assert.equal(rowOf(v, 'Projektek/2024').textContent.includes('2024'), true, 'the name is the last part of the path')
  assert.deepEqual(lis.map(li => li.querySelector('input').checked), [true, false, true, true, true])
  for (const p of ['INBOX', 'Sent']) {
    assert.equal(boxOf(v, p).disabled, true, p)
    assert.equal(rowOf(v, p).title, t.subscriptions.roleLocked, p)
  }
  assert.equal(boxOf(v, 'Projektek').disabled, false)
  assert.equal(rowOf(v, 'Régi').querySelector('.subscriptions-kept').textContent, t.subscriptions.kept)
  assert.equal(rowOf(v, 'Projektek').querySelector('.subscriptions-kept'), null)
})

test('a tick subscribes, an untick unsubscribes and drops the kept note; a refusal shows its text and the row stays', async t2 => {
  calls.length = 0
  listResult = { ok: true, folders: [sf('INBOX', { role: 'inbox', subscribed: true, shown: true }), sf('Régi', { kept: true, shown: true }), sf('Új')] }
  setResult = { ok: true }
  const v = await mount(h(SubscriptionsDialog, { accountId: 4, accountName: 'Munka', onClose() {} }))
  t2.after(v.unmount)
  await inAct(() => wait(30))
  await click(boxOf(v, 'Új'))
  await click(boxOf(v, 'Régi'))
  assert.deepEqual(calls.filter(c => c[0] === 'setSubscribed'), [
    ['setSubscribed', { accountId: 4, path: 'Új', subscribed: true }],
    ['setSubscribed', { accountId: 4, path: 'Régi', subscribed: false }],
  ])
  assert.equal(boxOf(v, 'Új').checked, true)
  assert.equal(boxOf(v, 'Régi').checked, false)
  assert.equal(rowOf(v, 'Régi').querySelector('.subscriptions-kept'), null)
  setResult = { ok: false, error: 'server_refused' }
  await click(boxOf(v, 'Új'))
  assert.equal(v.container.querySelector('.subscriptions-error').textContent.includes(t.folderError('server_refused')), true)
  assert.equal(boxOf(v, 'Új').checked, true, 'a refused untick leaves the row ticked')
  setResult = { ok: true }
})

test('the list call fails: the error, no list; Done closes', async t2 => {
  listResult = { ok: false, error: 'pop3_local' }
  let closed = 0
  const v = await mount(h(SubscriptionsDialog, { accountId: 4, accountName: 'Munka', onClose: () => closed++ }))
  t2.after(v.unmount)
  await inAct(() => wait(30))
  assert.equal(v.container.querySelector('.subscriptions-list'), null)
  assert.equal(v.container.querySelector('.subscriptions-error').textContent.includes(t.folderError('pop3_local')), true)
  const done = [...v.container.querySelectorAll('button')].find(b => b.textContent === t.subscriptions.close)
  await click(done)
  assert.equal(closed, 1)
})

const items = v => [...v.container.querySelectorAll('[role="menuitem"]')].map(b => b.dataset.key)
const base = { x: 10, y: 10, accountId: 1, label: 'Ügyfelek', siblings: ['Ügyfelek'], path: 'Ügyfelek', parentKey: null, ids: [1] }

test('folder menu: Unsubscribe before Delete for IMAP only, locked on a role folder; account menu: subscriptions for IMAP only', async t2 => {
  const picks = []
  const onPick = (op, m) => picks.push([op, m.path ?? m.accountId])
  const imap = await mount(h(FolderMenu, { menu: { ...base, imap: true }, onPick, onClose() {} }))
  t2.after(imap.unmount)
  assert.deepEqual(items(imap), ['create', 'rename', 'move', 'moveUp', 'moveDown', 'unsubscribe', 'delete'])
  await click(imap.container.querySelector('[data-key="unsubscribe"]'))
  assert.deepEqual(picks, [['unsubscribe', 'Ügyfelek']])
  const role = await mount(h(FolderMenu, { menu: { ...base, path: 'Sent', role: 'sent', imap: true }, onPick, onClose() {} }))
  t2.after(role.unmount)
  const un = role.container.querySelector('[data-key="unsubscribe"]')
  assert.equal(un.disabled, true)
  assert.equal(un.title, t.subscriptions.roleLocked)
  const pop = await mount(h(FolderMenu, { menu: { ...base, imap: false }, onPick, onClose() {} }))
  t2.after(pop.unmount)
  assert.equal(items(pop).includes('unsubscribe'), false)
  const accImap = await mount(h(AccountMenu, { menu: { ...base, imap: true }, onPick, onClose() {} }))
  t2.after(accImap.unmount)
  assert.equal(items(accImap).at(-1), 'subscriptions')
  await click(accImap.container.querySelector('[data-key="subscriptions"]'))
  assert.deepEqual(picks.at(-1), ['subscriptions', 'Ügyfelek'], 'the picked menu payload')
  const accPop = await mount(h(AccountMenu, { menu: { ...base, imap: false }, onPick, onClose() {} }))
  t2.after(accPop.unmount)
  assert.equal(items(accPop).includes('subscriptions'), false)
})

test('the sidebar tells both menus whether the account is IMAP', async t2 => {
  const folder = path => ({ path, delimiter: '/', special_use: null, count: 0, unread: 0 })
  const got = { folder: [], account: [] }
  const v = await mount(h(FolderTree, {
    accounts: [
      { id: 1, name: 'I', email: 'i@example.invalid', type: 'imap', folders: [folder('INBOX'), folder('alma')] },
      { id: 2, name: 'P', email: 'p@example.invalid', type: 'pop3', folders: [folder('INBOX'), folder('körte')] },
    ],
    selected: { accountId: 1, folder: 'INBOX' },
    onSelect() {},
    onDropMessages() {},
    onFolderMenu: m => got.folder.push([m.accountId, m.imap]),
    onAccountMenu: m => got.account.push([m.accountId, m.imap]),
    onNewFolder() {},
    onReorderFolders() {},
    onReorderAccounts() {},
  }))
  t2.after(v.unmount)
  const ctx = el => inAct(() => el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  await ctx(v.container.querySelector('section[data-account="1"] .folder[data-path="alma"]'))
  await ctx(v.container.querySelector('section[data-account="2"] .folder[data-path="körte"]'))
  await ctx(v.container.querySelector('section[data-account="1"] .account-head'))
  await ctx(v.container.querySelector('section[data-account="2"] .account-head'))
  assert.deepEqual(got.folder, [[1, true], [2, false]])
  assert.deepEqual(got.account, [[1, true], [2, false]])
})
