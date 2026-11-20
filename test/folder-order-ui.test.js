// SPDX-License-Identifier: GPL-3.0-or-later
// The sidebar's manual order (jsdom): the pure helpers (folder-order.js), Alt+Up / Alt+Down on a folder and an account
// head, the context-menu payload, and the drags: a folder among its own siblings only (another parent: no line, no
// drop, nothing called), an account head among the heads, and a message drag that still moves messages.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct, key } from './helpers/react-dom-env.js'
import { buildFolderTree } from '../core/imap/folders.js'
import { siblingLists, stepped, dropped } from '../app/renderer/src/folder-order.js'

setupDom()
// every row 40 px high (jsdom rects are 0 high): a sibling's drop zones are its top / middle / bottom (0-10 / 10-30 / 30-40)
window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 40, height: 40, left: 0, right: 200, width: 200, x: 0, y: 0 })
const { createElement: h } = await import('react')
const { FolderTree } = await import('../app/renderer/src/Mail.jsx')

const folder = (path, extra = {}) => ({ path, delimiter: '/', special_use: null, count: 0, unread: 0, ...extra })
const FOLDERS = [folder('INBOX'), folder('Sent', { special_use: '\\Sent' }), folder('Ügyfelek'), folder('Ügyfelek/Bp'), folder('Ügyfelek/Debrecen'), folder('alma'), folder('Régi/2019')]
const ACCOUNTS = [
  { id: 1, name: 'Első', email: 'a@example.invalid', folders: FOLDERS },
  { id: 2, name: 'Második', email: 'b@example.invalid', folders: [folder('INBOX')] },
  { id: 3, name: 'Harmadik', email: 'c@example.invalid', folders: [folder('INBOX')] },
]

test('helpers: the displayed sibling lists (real folders only), one step, a drop', () => {
  const lists = siblingLists(buildFolderTree(FOLDERS))
  assert.deepEqual(lists.get('alma'), { parentKey: null, paths: ['INBOX', 'Sent', 'alma', 'Ügyfelek'] }, 'the placeholder Régi is not in the list')
  assert.equal(lists.get('Régi'), lists.get('INBOX'), 'the placeholder itself sits in the top-level list')
  assert.deepEqual(lists.get('Ügyfelek/Bp'), { parentKey: 'Ügyfelek', paths: ['Ügyfelek/Bp', 'Ügyfelek/Debrecen'] })
  assert.deepEqual(lists.get('Régi/2019'), { parentKey: 'Régi', paths: ['Régi/2019'] })
  assert.deepEqual(stepped(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c'])
  assert.deepEqual(stepped(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b'])
  assert.equal(stepped(['a', 'b', 'c'], 'a', -1), null, 'the top edge')
  assert.equal(stepped(['a', 'b', 'c'], 'c', 1), null, 'the bottom edge')
  assert.equal(stepped(['a', 'b'], 'x', 1), null)
  assert.deepEqual(dropped(['a', 'b', 'c', 'd'], 'a', 'c', true), ['b', 'c', 'a', 'd'])
  assert.deepEqual(dropped(['a', 'b', 'c', 'd'], 'd', 'b', false), ['a', 'd', 'b', 'c'])
  assert.equal(dropped(['a', 'b', 'c'], 'a', 'b', false), null, 'the same place')
  assert.equal(dropped(['a', 'b', 'c'], 'b', 'a', true), null, 'the same place, after the one above')
  assert.equal(dropped(['a', 'b'], 'a', 'a', true), null)
  assert.equal(dropped(['a', 'b'], 'a', 'x', true), null)
})

function setup(t) {
  const calls = { folders: [], accounts: [], messages: [], folderMenu: [], accountMenu: [] }
  const el = () =>
    h(FolderTree, {
      accounts: ACCOUNTS,
      selected: { accountId: 1, folder: 'INBOX' },
      onSelect: () => {},
      onDropMessages: (ids, path) => calls.messages.push({ ids, path }),
      onFolderMenu: m => calls.folderMenu.push(m),
      onAccountMenu: m => calls.accountMenu.push(m),
      onNewFolder: () => {},
      onReorderFolders: r => calls.folders.push(r),
      onReorderAccounts: (ids, focus) => calls.accounts.push({ ids, focus }),
    })
  return { el, calls }
}
const folderEl = (v, account, path) => v.container.querySelector(`section[data-account="${account}"] .folder[data-path="${path}"]`)
const headEl = (v, account) => v.container.querySelector(`section[data-account="${account}"] .account-head`)

test('Alt+Up / Alt+Down: a folder steps in its own list, an account head among the accounts; the edges and other keys do nothing', async t => {
  window.localStorage.clear()
  const { el, calls } = setup(t)
  const v = await mount(el())
  t.after(v.unmount)
  await inAct(() => key(folderEl(v, 1, 'alma'), 'ArrowUp', { altKey: true }))
  await inAct(() => key(folderEl(v, 1, 'Ügyfelek/Debrecen'), 'ArrowUp', { altKey: true }))
  await inAct(() => key(folderEl(v, 1, 'INBOX'), 'ArrowUp', { altKey: true })) // the top
  await inAct(() => key(folderEl(v, 1, 'Ügyfelek'), 'ArrowDown', { altKey: true })) // the last real folder
  await inAct(() => key(folderEl(v, 1, 'alma'), 'ArrowDown')) // no Alt
  await inAct(() => key(folderEl(v, 1, 'alma'), 'ArrowDown', { altKey: true, ctrlKey: true }))
  assert.deepEqual(calls.folders, [
    { accountId: 1, parentKey: null, paths: ['INBOX', 'alma', 'Sent', 'Ügyfelek'], focus: 'alma' },
    { accountId: 1, parentKey: 'Ügyfelek', paths: ['Ügyfelek/Debrecen', 'Ügyfelek/Bp'], focus: 'Ügyfelek/Debrecen' },
  ])
  const toggle = id => v.container.querySelector(`section[data-account="${id}"] .account-toggle`)
  await inAct(() => key(toggle(2), 'ArrowDown', { altKey: true }))
  await inAct(() => key(toggle(1), 'ArrowUp', { altKey: true }))
  await inAct(() => key(toggle(3), 'ArrowUp', { altKey: true }))
  assert.deepEqual(calls.accounts, [{ ids: [1, 3, 2], focus: 2 }, { ids: [1, 3, 2], focus: 3 }])
})

test('the context menus get the list and the parent', async t => {
  const { el, calls } = setup(t)
  const v = await mount(el())
  t.after(v.unmount)
  await inAct(() => folderEl(v, 1, 'Ügyfelek/Bp').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  assert.equal(calls.folderMenu[0].parentKey, 'Ügyfelek')
  assert.deepEqual(calls.folderMenu[0].siblings, ['Ügyfelek/Bp', 'Ügyfelek/Debrecen'])
  await inAct(() => headEl(v, 2).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  assert.deepEqual([calls.accountMenu[0].accountId, calls.accountMenu[0].ids, calls.accountMenu[0].label], [2, [1, 2, 3], 'Második'])
})

// jsdom has no DataTransfer: a small one, and drag events with it (React reads nativeEvent.dataTransfer)
function transfer() {
  const data = new Map()
  return { data, setData: (k, v) => data.set(k, v), getData: k => data.get(k) || '', get types() { return [...data.keys()] }, effectAllowed: 'all', dropEffect: 'none' }
}
function drag(target, type, dt, clientY = 0) {
  const e = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: dt })
  Object.defineProperty(e, 'clientY', { value: clientY })
  target.dispatchEvent(e)
  return e
}

test('folder drag: among its own siblings a line and a reorder; another parent, itself or a placeholder: no line, no drop, nothing called', async t => {
  const { el, calls } = setup(t)
  const v = await mount(el())
  t.after(v.unmount)
  const dt = transfer()
  await inAct(() => drag(folderEl(v, 1, 'Ügyfelek'), 'dragstart', dt))
  assert.ok(dt.types.includes('application/x-shadowmail-folder'))
  assert.ok(!dt.types.includes('application/x-shadowmail-ids'), 'not a message drag')
  // another parent's folder: not accepted
  let over = await inAct(() => drag(folderEl(v, 1, 'Ügyfelek/Bp'), 'dragover', dt))
  assert.equal(over.defaultPrevented, false)
  assert.equal(v.container.querySelectorAll('.drop-before, .drop-after').length, 0, 'no line under another parent')
  // a browser fires no drop where the dragover was not accepted; forced anyway, it reorders nothing and ends the drag
  await inAct(() => drag(folderEl(v, 1, 'Ügyfelek/Bp'), 'drop', dt))
  assert.deepEqual(calls.folders, [])
  await inAct(() => drag(folderEl(v, 1, 'Ügyfelek'), 'dragstart', dt))
  // itself, another account's folder
  over = await inAct(() => drag(folderEl(v, 1, 'Ügyfelek'), 'dragover', dt))
  assert.equal(over.defaultPrevented, false)
  over = await inAct(() => drag(folderEl(v, 2, 'INBOX'), 'dragover', dt))
  assert.equal(over.defaultPrevented, false)
  // a sibling: the line before it (its top quarter), then after it (its bottom quarter)
  over = await inAct(() => drag(folderEl(v, 1, 'Sent'), 'dragover', dt, 0))
  assert.equal(over.defaultPrevented, true)
  assert.ok(folderEl(v, 1, 'Sent').parentElement.classList.contains('drop-before'))
  await inAct(() => drag(folderEl(v, 1, 'Sent'), 'dragover', dt, 35))
  assert.ok(folderEl(v, 1, 'Sent').parentElement.classList.contains('drop-after'))
  assert.equal(v.container.querySelectorAll('.drop-before, .drop-after').length, 1, 'one line')
  // the drag moves on over a place that takes no folder: the line goes at once (not only at the drag end)
  for (const [what, el] of [
    ['an account head', headEl(v, 2)],
    ['the tree background', v.container.querySelector('nav.folder-tree')],
    ['a folder under another parent', folderEl(v, 1, 'Ügyfelek/Bp')],
    ['outside the tree', document.body],
  ]) {
    await inAct(() => drag(folderEl(v, 1, 'Sent'), 'dragover', dt, 0))
    assert.equal(v.container.querySelectorAll('.drop-before, .drop-after').length, 1, `${what}: the line was there`)
    await inAct(() => drag(el, 'dragover', dt))
    assert.equal(v.container.querySelectorAll('.drop-before, .drop-after').length, 0, `${what}: no line left`)
  }
  await inAct(() => drag(folderEl(v, 1, 'Sent'), 'dragover', dt, 0))
  await inAct(() => drag(folderEl(v, 1, 'Sent'), 'drop', dt, 0))
  assert.deepEqual(calls.folders, [{ accountId: 1, parentKey: null, paths: ['INBOX', 'Ügyfelek', 'Sent', 'alma'], focus: 'Ügyfelek' }])
  assert.equal(v.container.querySelectorAll('.drop-before, .drop-after').length, 0, 'the line goes with the drop')
  assert.deepEqual(calls.messages, [], 'no message moved')

  // the placeholder (no row) is no target; a drag that ends outside leaves no line
  const dt2 = transfer()
  await inAct(() => drag(folderEl(v, 1, 'alma'), 'dragstart', dt2))
  const placeholder = v.container.querySelector('section[data-account="1"] .folder.placeholder')
  over = await inAct(() => drag(placeholder, 'dragover', dt2))
  assert.equal(over.defaultPrevented, false)
  await inAct(() => drag(folderEl(v, 1, 'INBOX'), 'dragover', dt2, 0))
  await inAct(() => drag(folderEl(v, 1, 'alma'), 'dragend', dt2))
  assert.equal(v.container.querySelectorAll('.drop-before, .drop-after').length, 0)
  assert.equal(calls.folders.length, 1)
})

test('account drag: among the heads; a folder is no target for it; a message drag still moves messages', async t => {
  const { el, calls } = setup(t)
  const v = await mount(el())
  t.after(v.unmount)
  const dt = transfer()
  await inAct(() => drag(headEl(v, 3), 'dragstart', dt))
  assert.ok(dt.types.includes('application/x-shadowmail-account'))
  let over = await inAct(() => drag(folderEl(v, 1, 'alma'), 'dragover', dt))
  assert.equal(over.defaultPrevented, false, 'a folder is no target for an account')
  over = await inAct(() => drag(headEl(v, 3), 'dragover', dt))
  assert.equal(over.defaultPrevented, false, 'itself')
  over = await inAct(() => drag(headEl(v, 1), 'dragover', dt, 0))
  assert.equal(over.defaultPrevented, true)
  assert.ok(headEl(v, 1).classList.contains('drop-before'))
  // on over a folder (no target for an account): the line goes
  await inAct(() => drag(folderEl(v, 2, 'INBOX'), 'dragover', dt))
  assert.equal(v.container.querySelectorAll('.drop-before, .drop-after').length, 0, 'no account line over a folder')
  await inAct(() => drag(headEl(v, 1), 'dragover', dt, 0))
  await inAct(() => drag(headEl(v, 1), 'drop', dt, 0))
  assert.deepEqual(calls.accounts, [{ ids: [3, 1, 2], focus: 3 }])
  assert.deepEqual(calls.folders, [])

  // messages from the list (their own type): as before, into another folder of the selected account
  const msg = transfer()
  msg.setData('application/x-shadowmail-ids', JSON.stringify([7, 8]))
  over = await inAct(() => drag(folderEl(v, 1, 'alma'), 'dragover', msg))
  assert.equal(over.defaultPrevented, true)
  assert.equal(v.container.querySelectorAll('.drop-before, .drop-after').length, 0, 'no order line for messages')
  await inAct(() => drag(folderEl(v, 1, 'alma'), 'drop', msg))
  assert.deepEqual(calls.messages, [{ ids: [7, 8], path: 'alma' }])
  assert.deepEqual([calls.folders.length, calls.accounts.length], [0, 1])
})
