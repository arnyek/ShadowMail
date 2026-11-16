// The sidebar's folder tree: role icons (3.3), the unread count only above 0 and
// on the right, aria-current on the selected folder, folding an account (kept in the view
// settings), and the icon-only mode with tooltips; the e2e hooks stay (.folder[data-path],
// .folder-tree .account-name, .folder-label).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'
import { folderIcon } from '../app/renderer/src/folder-icons.js'

setupDom()
const { createElement: h } = await import('react')
const { FolderTree } = await import('../app/renderer/src/Mail.jsx')

const folder = (path, extra = {}) => ({ path, delimiter: '/', special_use: null, count: 3, unread: 0, ...extra })
const ACCOUNT = {
  id: 'a1',
  name: 'Mérőfiók',
  email: 'meres@example.invalid',
  folders: [
    folder('INBOX', { unread: 28 }),
    folder('Drafts', { special_use: '\\Drafts' }),
    folder('Sent', { special_use: '\\Sent' }),
    folder('Trash', { special_use: '\\Trash' }),
    folder('Spam', { special_use: '\\Junk', unread: 2 }),
    folder('Archívum'), // role by name, no SPECIAL-USE
    folder('Ügyfelek'),
    folder('Ügyfelek/Példa Kft.'),
  ],
}
const noop = () => {}
const tree = (props = {}) => h(FolderTree, { accounts: [ACCOUNT], selected: { accountId: 'a1', folder: 'INBOX' }, onSelect: noop, onDropMessages: noop, onFolderMenu: noop, onNewFolder: noop, ...props })

test('folderIcon: every special-use role its own icon, everything else the folder icon', () => {
  assert.deepEqual(
    ['inbox', 'drafts', 'sent', 'trash', 'junk', 'archive'].map(folderIcon),
    ['inbox', 'drafts', 'sent', 'trash', 'junk', 'archive'],
  )
  for (const other of [null, undefined, '', 'all', 'flagged', 'whatever']) assert.equal(folderIcon(other), 'folder')
})

test('the tree: icons by role, counts only above 0, aria-current on the selection', async t => {
  window.localStorage.clear()
  const v = await mount(tree())
  t.after(v.unmount)
  const icon = path => v.container.querySelector(`.folder[data-path="${path}"] svg`).dataset.icon
  assert.deepEqual(
    ['INBOX', 'Drafts', 'Sent', 'Trash', 'Spam', 'Archívum', 'Ügyfelek', 'Ügyfelek/Példa Kft.'].map(icon),
    ['inbox', 'drafts', 'sent', 'trash', 'junk', 'archive', 'folder', 'folder'],
  )
  const badge = path => v.container.querySelector(`.folder[data-path="${path}"] .unread-badge`)
  assert.equal(badge('INBOX').textContent, '28')
  assert.equal(badge('INBOX').getAttribute('aria-label'), '28 olvasatlan')
  assert.equal(badge('Spam').textContent, '2')
  assert.equal(badge('Sent'), null, 'no count at 0')
  assert.equal(v.container.querySelector('.folder[data-path="INBOX"]').getAttribute('aria-current'), 'true')
  assert.equal(v.container.querySelectorAll('[aria-current]').length, 1)
  assert.equal(v.container.querySelector('.folder-tree .account-name').textContent, 'Mérőfiók')
  const plus = v.container.querySelector('button.new-folder')
  assert.equal(plus.getAttribute('aria-label'), 'Új mappa: Mérőfiók')
  assert.equal(plus.getAttribute('title'), 'Új mappa: Mérőfiók')
  assert.equal(v.container.querySelector('.folder[data-path="Ügyfelek/Példa Kft."]').style.getPropertyValue('--depth'), '1')
  assert.equal(v.container.querySelectorAll('button:not([class])').length, 0, 'no unstyled native button')
})

test('folding an account hides its folders and is remembered', async t => {
  window.localStorage.clear()
  const v = await mount(tree())
  const toggle = v.container.querySelector('.account-toggle')
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  await inAct(() => toggle.click())
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(v.container.querySelectorAll('.folder').length, 0)
  await v.unmount()
  const w = await mount(tree())
  t.after(w.unmount)
  assert.equal(w.container.querySelector('.account-toggle').getAttribute('aria-expanded'), 'false', 'kept after a remount')
  assert.equal(w.container.querySelectorAll('.folder').length, 0)
  await inAct(() => w.container.querySelector('.account-toggle').click())
  assert.equal(w.container.querySelectorAll('.folder').length, 8)
})

test('icon-only (collapsed): names stay for the accessible name and become tooltips; no depth', async t => {
  window.localStorage.clear()
  const v = await mount(tree({ collapsed: true }))
  t.after(v.unmount)
  const inbox = v.container.querySelector('.folder[data-path="INBOX"]')
  assert.ok(v.container.querySelector('.folder-tree.collapsed'))
  assert.equal(inbox.getAttribute('title'), 'Beérkezett (28 olvasatlan)')
  assert.equal(v.container.querySelector('.folder[data-path="Sent"]').getAttribute('title'), 'Elküldött')
  assert.equal(inbox.querySelector('.folder-label').textContent, 'Beérkezett')
  assert.equal(v.container.querySelector('.folder[data-path="Ügyfelek/Példa Kft."]').style.getPropertyValue('--depth'), '0')
})

test('no account: the hint, no tree', async t => {
  const v = await mount(tree({ accounts: [] }))
  t.after(v.unmount)
  assert.equal(v.container.querySelector('.folder-tree'), null)
  assert.ok(v.container.querySelector('.hint'))
})

test('a damaged folded-accounts value does not take the tree down', async t => {
  for (const bad of ['{"a":1}', '"szöveg"', '42', 'null', '[1, {"x": 2}]']) {
    window.localStorage.setItem('shadowmail.ui.foldedAccounts', bad)
    const v = await mount(tree())
    assert.equal(v.container.querySelectorAll('.folder').length, 8, bad)
    await v.unmount()
  }
  window.localStorage.clear()
})
