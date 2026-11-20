// SPDX-License-Identifier: GPL-3.0-or-later
// Moving a folder by dragging it in the tree, the pure parts: the drop zone of a row (before / after / into), which
// folders take a moved one (moveTarget, the same refusals as the main process), the path that follows a move or a
// rename (followPath) and the folded set that follows it (movedFolded).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropZone, moveTarget, followPath } from '../app/renderer/src/folder-order.js'
import { movedFolded, foldKey } from '../app/renderer/src/folder-fold.js'
import { assignRoles } from '../core/imap/folders.js'

const rowAt = (top, height) => ({ getBoundingClientRect: () => ({ top, height, bottom: top + height }) })

test('dropZone: a sibling row is before / into / after in quarters; any other row is into', () => {
  const el = rowAt(100, 40)
  const at = y => dropZone({ clientY: y }, el, true)
  assert.equal(at(100), 'before')
  assert.equal(at(109.9), 'before')
  assert.equal(at(110), 'into')
  assert.equal(at(120), 'into')
  assert.equal(at(130), 'into')
  assert.equal(at(130.1), 'after')
  assert.equal(at(139), 'after')
  for (const y of [100, 120, 139]) assert.equal(dropZone({ clientY: y }, el, false), 'into')
})

// INBOX, Trash (with Trash/Régi), Junk, Sent, A/B/x, C/c, Kézi (a role chosen by hand)
const rows = [
  { path: 'INBOX', delimiter: '/' },
  { path: 'Trash', delimiter: '/', role: 'trash' },
  { path: 'Trash/Régi', delimiter: '/' },
  { path: 'Junk', delimiter: '/', role: 'junk' },
  { path: 'Sent', delimiter: '/', role: 'sent' },
  { path: 'A', delimiter: '/' },
  { path: 'A/B', delimiter: '/' },
  { path: 'A/B/x', delimiter: '/' },
  { path: 'C', delimiter: '/' },
  { path: 'C/c', delimiter: '/' },
  { path: 'Kézi', delimiter: '/', role: 'archive' },
  { path: 'Lapos', delimiter: null },
]

test('moveTarget: the targets a dragged folder may go into, and every refusal', () => {
  const roles = assignRoles(rows)
  const ok = (from, to) => moveTarget(rows, roles, from, to)
  assert.equal(ok('A/B', 'C'), true)
  assert.equal(ok('A/B', 'C/c'), true)
  assert.equal(ok('A/B', 'INBOX'), true)
  assert.equal(ok('A/B', null), true, 'to the top level')
  assert.equal(ok('C', 'A/B/x'), true)
  assert.equal(ok('A/B', 'A/B'), false, 'itself')
  assert.equal(ok('A', 'A/B/x'), false, 'under itself')
  assert.equal(ok('A/B', 'A'), false, 'its present parent')
  assert.equal(ok('A', null), false, 'the top level, where it is already')
  assert.equal(ok('A/B', 'Nincs'), false, 'a placeholder / no row')
  assert.equal(ok('A/B', 'Trash'), false)
  assert.equal(ok('A/B', 'Trash/Régi'), false)
  assert.equal(ok('A/B', 'Junk'), false)
  for (const role of ['INBOX', 'Trash', 'Sent', 'Kézi']) assert.equal(ok(role, 'C'), false, `a role folder moved: ${role}`)
  assert.equal(ok('Lapos', 'C'), false, 'no delimiter')
  assert.equal(ok('Nincs', 'C'), false, 'no such folder')
  // a role anywhere in the moved subtree
  const withRole = rows.map(r => (r.path === 'A/B/x' ? { ...r, role: 'archive' } : r.path === 'Kézi' ? { ...r, role: null } : r))
  assert.equal(moveTarget(withRole, assignRoles(withRole), 'A', 'C'), false)
})

test('followPath: the folder itself and every path under it follow; others and look-alike prefixes do not', () => {
  assert.equal(followPath('A/B', 'A/B', 'C/B', '/'), 'C/B')
  assert.equal(followPath('A/B/x', 'A/B', 'C/B', '/'), 'C/B/x')
  assert.equal(followPath('A/Bx', 'A/B', 'C/B', '/'), null)
  assert.equal(followPath('A', 'A/B', 'C/B', '/'), null)
  assert.equal(followPath('INBOX.A.B', 'INBOX.A', 'INBOX.Z', '.'), 'INBOX.Z.B')
  assert.equal(followPath('A/B/x', 'A/B', 'C/B', null), null)
})

test('movedFolded: the subtree\'s folded keys follow, the new parent opens, other accounts and paths stay', () => {
  const set = new Set([foldKey(1, 'A/B'), foldKey(1, 'A/B/x'), foldKey(1, 'A/Bx'), foldKey(1, 'C'), foldKey(12, 'A/B'), foldKey(1, 'D')])
  const next = movedFolded(set, 1, 'A/B', 'C/B', '/', 'C')
  assert.deepEqual([...next].sort(), [foldKey(1, 'A/Bx'), foldKey(1, 'C/B'), foldKey(1, 'C/B/x'), foldKey(1, 'D'), foldKey(12, 'A/B')].sort())
  const same = new Set([foldKey(1, 'D')])
  assert.equal(movedFolded(same, 1, 'A/B', 'C/B', '/', null), same, 'nothing to change: the same set')
})

// ---- the tree (jsdom): the "into" zone, the account head, and every place that takes no moved folder
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'
setupDom()
window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 40, height: 40, left: 0, right: 200, width: 200, x: 0, y: 0 })
const { createElement: h } = await import('react')
const { FolderTree } = await import('../app/renderer/src/Mail.jsx')

const f = (path, extra = {}) => ({ path, delimiter: '/', special_use: null, count: 0, unread: 0, ...extra })
const TREE_ACCOUNTS = [
  { id: 1, name: 'Első', email: 'a@example.invalid', folders: [f('INBOX'), f('Trash', { special_use: '\\Trash' }), f('Trash/Régi'), f('Junk', { special_use: '\\Junk' }), f('A'), f('A/B'), f('A/B/x'), f('C'), f('Hely/Alatta')] },
  { id: 2, name: 'Második', email: 'b@example.invalid', folders: [f('INBOX'), f('Más')] },
]
const transfer = () => {
  const data = new Map()
  return { data, setData: (k, v) => data.set(k, v), getData: k => data.get(k) || '', get types() { return [...data.keys()] }, effectAllowed: 'all', dropEffect: 'none' }
}
const fire = (target, type, dt, clientY = 20) => {
  const e = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: dt })
  Object.defineProperty(e, 'clientY', { value: clientY })
  target.dispatchEvent(e)
  return e
}
const treeOf = moves => h(FolderTree, { accounts: TREE_ACCOUNTS, selected: { accountId: 1, folder: 'INBOX' }, onSelect: () => {}, onDropMessages: () => {}, onFolderMenu: () => {}, onNewFolder: () => {}, onReorderFolders: r => moves.push({ reorder: r }), onMoveFolder: m => moves.push(m) })
const rowEl = (v, account, path) => v.container.querySelector(`section[data-account="${account}"] .folder[data-path="${path}"]`)
const placeholderEl = (v, account, label) => [...v.container.querySelectorAll(`section[data-account="${account}"] .folder.placeholder`)].find(x => x.textContent.includes(label))
const intoCount = v => v.container.querySelectorAll('.drop-into').length

test('the tree: the middle of a folder takes the dragged folder (framed), the drop asks the move; the account head = the top level', async t => {
  window.localStorage.clear()
  const moves = []
  const v = await mount(treeOf(moves))
  t.after(v.unmount)
  const dt = transfer()
  await inAct(() => fire(rowEl(v, 1, 'A/B'), 'dragstart', dt))
  let over = await inAct(() => fire(rowEl(v, 1, 'C'), 'dragover', dt, 20))
  assert.equal(over.defaultPrevented, true)
  assert.ok(rowEl(v, 1, 'C').parentElement.classList.contains('drop-into'), 'the target framed')
  assert.equal(v.container.querySelectorAll('.drop-before, .drop-after').length, 0, 'no line')
  await inAct(() => fire(rowEl(v, 1, 'C'), 'drop', dt, 20))
  assert.deepEqual(moves, [{ accountId: 1, path: 'A/B', parent: 'C', label: 'B', targetLabel: 'C', subfolders: 1, delimiter: '/' }])
  assert.equal(intoCount(v), 0, 'the frame goes with the drop')
  // onto the account head: the top level, with the account's name as the target
  await inAct(() => fire(rowEl(v, 1, 'A/B'), 'dragstart', dt))
  over = await inAct(() => fire(v.container.querySelector('section[data-account="1"] .account-head'), 'dragover', dt))
  assert.equal(over.defaultPrevented, true)
  assert.ok(v.container.querySelector('section[data-account="1"] .account-head').classList.contains('drop-into'))
  await inAct(() => fire(v.container.querySelector('section[data-account="1"] .account-head'), 'drop', dt))
  assert.deepEqual(moves[1], { accountId: 1, path: 'A/B', parent: null, label: 'B', targetLabel: 'Első', subfolders: 1, delimiter: '/' })
})

test('the tree: no frame, no drop and no call where the move is not allowed', async t => {
  window.localStorage.clear()
  const moves = []
  const v = await mount(treeOf(moves))
  t.after(v.unmount)
  const dt = transfer()
  const refused = async (from, el, what) => {
    await inAct(() => fire(rowEl(v, 1, from), 'dragstart', dt))
    const over = await inAct(() => fire(el, 'dragover', dt, 20))
    assert.equal(over.defaultPrevented, false, `${what}: dragover not taken`)
    assert.equal(intoCount(v), 0, `${what}: no frame`)
    await inAct(() => fire(el, 'drop', dt, 20))
    assert.deepEqual(moves, [], `${what}: nothing called`)
  }
  await refused('A', rowEl(v, 1, 'A'), 'itself')
  await refused('A', rowEl(v, 1, 'A/B/x'), 'a folder under itself')
  await refused('A/B', rowEl(v, 1, 'A'), 'its present parent')
  await refused('A/B', placeholderEl(v, 1, 'Hely'), 'a placeholder')
  await refused('A/B', rowEl(v, 1, 'Trash'), 'the Trash')
  await refused('A/B', rowEl(v, 1, 'Trash/Régi'), 'under the Trash')
  await refused('A/B', rowEl(v, 1, 'Junk'), 'the Junk folder')
  await refused('Trash', rowEl(v, 1, 'C'), 'a role folder moved')
  await refused('A/B', rowEl(v, 2, 'Más'), 'another account')
  await refused('A', v.container.querySelector('section[data-account="1"] .account-head'), 'the top level, where it is already')
  await refused('A/B', v.container.querySelector('section[data-account="2"] .account-head'), 'another account head')
})

test('the tree: a sibling\'s top and bottom quarter keep the manual order (a line, a reorder), its middle is "into"', async t => {
  window.localStorage.clear()
  const moves = []
  const v = await mount(treeOf(moves))
  t.after(v.unmount)
  const dt = transfer()
  await inAct(() => fire(rowEl(v, 1, 'A'), 'dragstart', dt))
  await inAct(() => fire(rowEl(v, 1, 'C'), 'dragover', dt, 2))
  assert.ok(rowEl(v, 1, 'C').parentElement.classList.contains('drop-before'))
  await inAct(() => fire(rowEl(v, 1, 'C'), 'dragover', dt, 38))
  assert.ok(rowEl(v, 1, 'C').parentElement.classList.contains('drop-after'))
  await inAct(() => fire(rowEl(v, 1, 'C'), 'dragover', dt, 20))
  assert.ok(rowEl(v, 1, 'C').parentElement.classList.contains('drop-into'))
  await inAct(() => fire(rowEl(v, 1, 'C'), 'drop', dt, 38))
  assert.equal(moves.length, 1)
  assert.ok(moves[0].reorder, 'the bottom quarter: a reorder, no move')
})
