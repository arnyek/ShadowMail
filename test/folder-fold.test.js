// SPDX-License-Identifier: GPL-3.0-or-later
// Folding a folder's subfolders away in the sidebar: the pure helper (folder-fold.js) and the FolderTree (jsdom): the
// toggle only on a folder with children (a placeholder parent too), the subtree hidden, the folded count with the
// hidden unread, the choice kept per account and folder (a remount reads it back), a damaged stored value, and no
// toggles on a sidebar folded to icons.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'
import { buildFolderTree, flattenTree } from '../core/imap/folders.js'
import { foldKey, foldedSet, visibleFolders } from '../app/renderer/src/folder-fold.js'

setupDom()
const { createElement: h } = await import('react')
const { FolderTree } = await import('../app/renderer/src/Mail.jsx')
const { t } = await import('../app/renderer/i18n/index.js')

const folder = (path, extra = {}) => ({ path, delimiter: '/', special_use: null, count: 0, unread: 0, ...extra })
const FOLDERS = [
  folder('INBOX', { unread: 1 }),
  folder('Ügyfelek', { unread: 2 }),
  folder('Ügyfelek/Bp', { unread: 3 }),
  folder('Ügyfelek/Bp/2024', { unread: 4 }),
  folder('Ügyfelek/Debrecen'),
  folder('alma'),
  folder('Régi/2019', { unread: 5 }), // "Régi" is a placeholder (no row of its own)
]
const items = () => flattenTree(buildFolderTree(FOLDERS))
const paths = rows => rows.map(r => r.node.path)

test('helper: nothing folded = flattenTree; a folded folder hides its whole subtree and counts its hidden unread', () => {
  const all = visibleFolders(items(), () => false)
  assert.deepEqual(paths(all), paths(items()))
  assert.deepEqual(all.filter(r => r.hasChildren).map(r => r.node.path), ['Régi', 'Ügyfelek', 'Ügyfelek/Bp'])
  assert.ok(all.every(r => !r.folded && r.hiddenUnread === 0 && r.unread === r.node.unread))

  const f = visibleFolders(items(), p => p === 'Ügyfelek')
  assert.deepEqual(paths(f), ['INBOX', 'alma', 'Régi', 'Régi/2019', 'Ügyfelek'])
  const u = f.find(r => r.node.path === 'Ügyfelek')
  assert.deepEqual([u.folded, u.unread, u.hiddenUnread], [true, 2 + 3 + 4, 7])

  // a folded child under an open parent: only its own subtree goes
  const inner = visibleFolders(items(), p => p === 'Ügyfelek/Bp')
  assert.deepEqual(paths(inner), ['INBOX', 'alma', 'Régi', 'Régi/2019', 'Ügyfelek', 'Ügyfelek/Bp', 'Ügyfelek/Debrecen'])
  assert.equal(inner.find(r => r.node.path === 'Ügyfelek/Bp').unread, 3 + 4)
  // a folded parent over a folded child: the outer one counts everything below
  const both = visibleFolders(items(), p => p === 'Ügyfelek' || p === 'Ügyfelek/Bp')
  assert.equal(both.find(r => r.node.path === 'Ügyfelek').unread, 9)
  // a placeholder parent: its own count is 0, folded it shows the hidden ones
  const ph = visibleFolders(items(), p => p === 'Régi').find(r => r.node.path === 'Régi')
  assert.deepEqual([ph.node.selectable, ph.unread], [false, 5])
  // the selected folder folded away: the folded ancestor that hides it says so, nothing else
  const sel = visibleFolders(items(), p => p === 'Ügyfelek', 'Ügyfelek/Bp/2024')
  assert.deepEqual(sel.filter(r => r.hidesSelected).map(r => r.node.path), ['Ügyfelek'])
  assert.ok(!visibleFolders(items(), p => p === 'Ügyfelek', 'alma').some(r => r.hidesSelected), 'selected outside')
  assert.ok(!visibleFolders(items(), () => false, 'Ügyfelek/Bp').some(r => r.hidesSelected), 'nothing folded')
  assert.ok(!visibleFolders(items(), p => p === 'Ügyfelek', 'Ügyfelek').some(r => r.hidesSelected), 'the folded folder itself is selected: it shows')
  // a folder without children is never folded, whatever the set says
  assert.equal(visibleFolders(items(), () => true).find(r => r.node.path === 'alma').folded, false)
})

test('helper: the stored value; a damaged one is an empty fold', () => {
  assert.equal(foldKey(3, 'A/B'), '3:A/B')
  assert.deepEqual([...foldedSet(['1:A', 7, null, '2:B'])], ['1:A', '2:B'])
  for (const bad of [null, 'x', { a: 1 }, 5]) assert.equal(foldedSet(bad).size, 0)
})

test('helper: linear on a deep and a wide tree', () => {
  const deep = [folder('INBOX')]
  let p = 'D'
  for (let i = 0; i < 2000; i++) {
    deep.push(folder(p, { unread: 1 }))
    p += '/x'
  }
  const wide = [folder('INBOX'), folder('W')]
  for (let i = 0; i < 5000; i++) wide.push(folder(`W/${i}`, { unread: 1 }))
  for (const [rows, top] of [[deep, 'D'], [wide, 'W']]) {
    const list = flattenTree(buildFolderTree(rows))
    const t0 = performance.now()
    const v = visibleFolders(list, path => path === top)
    const ms = performance.now() - t0
    assert.equal(v.find(r => r.node.path === top).unread, rows.reduce((n, r) => n + r.unread, 0))
    assert.ok(ms < 200, `${ms} ms`)
  }
})

const ACCOUNTS = [
  { id: 1, name: 'Első', email: 'a@example.invalid', folders: FOLDERS },
  { id: 2, name: 'Második', email: 'b@example.invalid', folders: [folder('INBOX'), folder('Ügyfelek'), folder('Ügyfelek/Bp')] },
]
const el = (collapsed = false) =>
  h(FolderTree, { accounts: ACCOUNTS, selected: { accountId: 1, folder: 'Ügyfelek/Bp' }, onSelect: () => {}, onDropMessages: () => {}, onFolderMenu: () => {}, onNewFolder: () => {}, collapsed })
const shown = (v, account) => [...v.container.querySelectorAll(`section[data-account="${account}"] .folder`)].map(e => e.dataset.path || e.textContent.replace(/\d+$/, ''))
const toggle = (v, account, label) => [...v.container.querySelectorAll(`section[data-account="${account}"] .folder-fold`)].find(b => b.getAttribute('aria-label').startsWith(`${label}:`))
const click = el => inAct(() => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))

test('FolderTree: a toggle on every folder with children, folding hides the subtree, the count shows the hidden unread', async tc => {
  window.localStorage.clear()
  const v = await mount(el())
  tc.after(v.unmount)
  const toggles = [...v.container.querySelectorAll('section[data-account="1"] .folder-fold')]
  assert.deepEqual(toggles.map(b => b.getAttribute('aria-label')), [t.folderFoldHide('Régi'), t.folderFoldHide('Ügyfelek'), t.folderFoldHide('Bp')])
  assert.ok(toggles.every(b => b.getAttribute('aria-expanded') === 'true' && b.tagName === 'BUTTON' && b.type === 'button'))
  assert.equal(v.container.querySelectorAll('.folder-fold').length, 3 + 1, 'the second account: one parent')

  await click(toggle(v, 1, 'Ügyfelek'))
  assert.deepEqual(shown(v, 1), ['INBOX', 'alma', 'Régi', 'Régi/2019', 'Ügyfelek'])
  const b = toggle(v, 1, 'Ügyfelek')
  assert.equal(b.getAttribute('aria-expanded'), 'false')
  assert.equal(b.getAttribute('aria-label'), t.folderFoldShow('Ügyfelek'))
  const badge = v.container.querySelector('section[data-account="1"] .folder[data-path="Ügyfelek"] .unread-badge')
  assert.equal(badge.textContent, '9')
  assert.ok(badge.classList.contains('with-hidden'))
  assert.equal(badge.getAttribute('aria-label'), t.unreadCountFolded(9))
  assert.deepEqual(shown(v, 2), ['INBOX', 'Ügyfelek', 'Ügyfelek/Bp'], 'the same path in another account stays open')
  // the selected folder (account 1, Ügyfelek/Bp) is hidden under Ügyfelek: a faint mark there, not in account 2
  assert.ok(v.container.querySelector('section[data-account="1"] .folder[data-path="Ügyfelek"]').classList.contains('holds-selected'))
  assert.equal(v.container.querySelectorAll('.holds-selected').length, 1)

  // the placeholder parent folds too, with the hidden count on it
  await click(toggle(v, 1, 'Régi'))
  const ph = v.container.querySelector('section[data-account="1"] .folder.placeholder')
  assert.equal(ph.querySelector('.unread-badge').textContent, '5')
  assert.ok(!shown(v, 1).includes('Régi/2019'))

  assert.equal(v.container.querySelectorAll('.holds-selected').length, 1, 'Régi does not hold the selection')
  // open again: the old rows and counts
  await click(toggle(v, 1, 'Ügyfelek'))
  await click(toggle(v, 1, 'Régi'))
  assert.deepEqual(shown(v, 1), paths(items()))
  const open = v.container.querySelector('section[data-account="1"] .folder[data-path="Ügyfelek"] .unread-badge')
  assert.equal(open.textContent, '2')
  assert.ok(!open.classList.contains('with-hidden'))
  assert.equal(open.getAttribute('aria-label'), t.unreadCount(2))
  assert.equal(v.container.querySelectorAll('.holds-selected').length, 0, 'unfolded: no mark')
})

test('FolderTree: the choice stays (per account and folder) after a remount; a damaged stored value folds nothing', async tc => {
  window.localStorage.clear()
  const a = await mount(el())
  await click(toggle(a, 2, 'Ügyfelek'))
  await a.unmount()
  assert.deepEqual(JSON.parse(window.localStorage.getItem('shadowmail.ui.foldedFolders')), ['2:Ügyfelek'])
  const b = await mount(el())
  tc.after(b.unmount)
  assert.deepEqual(shown(b, 2), ['INBOX', 'Ügyfelek'])
  assert.ok(shown(b, 1).includes('Ügyfelek/Bp'))

  window.localStorage.setItem('shadowmail.ui.foldedFolders', '{"x":1}')
  const c = await mount(el())
  tc.after(c.unmount)
  assert.deepEqual(shown(c, 2), ['INBOX', 'Ügyfelek', 'Ügyfelek/Bp'])
})

test('FolderTree: a sidebar folded to icons has no toggles and shows every folder', async tc => {
  window.localStorage.clear()
  window.localStorage.setItem('shadowmail.ui.foldedFolders', JSON.stringify(['1:Ügyfelek', '1:Régi']))
  const v = await mount(el(true))
  tc.after(v.unmount)
  assert.equal(v.container.querySelectorAll('.folder-fold').length, 0)
  assert.ok(shown(v, 1).includes('Ügyfelek/Bp/2024') && shown(v, 1).includes('Régi/2019'))
})
