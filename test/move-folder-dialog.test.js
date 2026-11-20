// SPDX-License-Identifier: GPL-3.0-or-later
// The folder menu's "Move…" (jsdom): moveTargetReason (the reason of every refusal; moveTarget is its "no reason"),
// the dialog's listbox (the top level and the account's tree, the refused targets disabled with the reason as the
// option's description, the keyboard: Up / Down / Home / End, Enter chooses an allowed target only), the shape the choice
// goes on with, and the menu item (after Rename; off with the reason for a role in the subtree or a flat server).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct, key } from './helpers/react-dom-env.js'
import { moveTarget, moveTargetReason } from '../app/renderer/src/folder-order.js'
import { assignRoles } from '../core/imap/folders.js'

setupDom()
window.HTMLElement.prototype.scrollIntoView = () => {}
const { createElement: h } = await import('react')
const { MoveFolderDialog, moveChoices } = await import('../app/renderer/src/MoveFolderDialog.jsx')
const { FolderTree, FolderMenu } = await import('../app/renderer/src/Mail.jsx')
const { t } = await import('../app/renderer/i18n/index.js')
const wait = ms => new Promise(r => setTimeout(r, ms))

const f = (path, extra = {}) => ({ path, delimiter: '/', special_use: null, count: 0, unread: 0, ...extra })
// INBOX, Trash (with Trash/Régi), Junk, A/B/x, C, a placeholder parent (Hely), a role chosen by hand under K
const ACCOUNT = {
  id: 1,
  name: 'Első',
  type: 'imap',
  folders: [f('INBOX'), f('Trash', { special_use: '\\Trash' }), f('Trash/Régi'), f('Junk', { special_use: '\\Junk' }), f('A'), f('A/B'), f('A/B/x'), f('C'), f('Hely/Alatta'), f('K'), f('K/Arch', { role: 'archive', role_manual: 1 }), f('Lapos', { delimiter: null })],
}
const roles = assignRoles(ACCOUNT.folders)

test('moveTargetReason: every refusal has its reason; moveTarget is "no reason"', () => {
  const r = (from, to) => moveTargetReason(ACCOUNT.folders, roles, from, to)
  assert.equal(r('Lapos', 'C'), 'flat')
  assert.equal(r('Nincs', 'C'), 'flat')
  assert.equal(r('K', 'C'), 'role') // K/Arch below it has a role
  assert.equal(r('C', null), 'top')
  assert.equal(r('A/B', null), null)
  assert.equal(r('A/B', 'Hely'), 'missing') // a placeholder
  assert.equal(r('A', 'A'), 'self')
  assert.equal(r('A', 'A/B/x'), 'self')
  assert.equal(r('A/B', 'A'), 'parent')
  assert.equal(r('A/B', 'Trash'), 'trash')
  assert.equal(r('A/B', 'Trash/Régi'), 'trash')
  assert.equal(r('A/B', 'Junk'), 'trash')
  assert.equal(r('A/B', 'C'), null)
  for (const [from, to] of [['A/B', 'C'], ['A/B', null], ['A', 'A'], ['C', null], ['A/B', 'Trash'], ['K', 'C'], ['Lapos', 'C']]) {
    assert.equal(moveTarget(ACCOUNT.folders, roles, from, to), r(from, to) === null, `${from} -> ${to}`)
  }
})

test('moveChoices: the top level first, then the tree in order with depth; the reasons per target', () => {
  const c = moveChoices(ACCOUNT, 'A/B')
  assert.deepEqual(c[0], { parent: null, label: t.moveDialog.topLevel('Első'), depth: 0, reason: null })
  const by = Object.fromEntries(c.slice(1).map(x => [x.parent, x]))
  assert.equal(by.INBOX.reason, null)
  assert.equal(by.A.reason, 'parent')
  assert.equal(by['A/B'].reason, 'self')
  assert.equal(by['A/B/x'].reason, 'self')
  assert.equal(by.Trash.reason, 'trash')
  assert.equal(by.Hely.reason, 'missing')
  assert.equal(by['Hely/Alatta'].reason, null)
  assert.equal(by.C.reason, null)
  assert.equal(by['A/B/x'].depth, 3)
  assert.equal(by.Trash.label, t.folderRoles.trash)
})

const dialogOf = (from, chosen, cancelled = []) => h(MoveFolderDialog, { account: ACCOUNT, from, label: from, onChoose: c => chosen.push(c), onCancel: () => cancelled.push(1) })
const listbox = () => document.body.querySelector('.move-folder-dialog [role="listbox"]')
const activeOption = () => document.getElementById(listbox().getAttribute('aria-activedescendant'))

test('the dialog: a listbox with the focus, the first allowed target active, refused ones disabled with the reason', async t2 => {
  const chosen = []
  const v = await mount(dialogOf('A/B', chosen))
  t2.after(v.unmount)
  await inAct(() => wait(10))
  assert.equal(document.activeElement, listbox(), 'the listbox has the focus')
  assert.ok(document.body.textContent.includes(t.moveDialog.title('A/B')))
  const options = [...listbox().querySelectorAll('[role="option"]')]
  assert.equal(options.length, moveChoices(ACCOUNT, 'A/B').length)
  assert.equal(activeOption(), options[0], 'the top level (allowed for A/B) is active')
  assert.equal(options[0].getAttribute('aria-selected'), 'true')
  const trash = options.find(o => o.dataset.path === 'Trash')
  assert.equal(trash.getAttribute('aria-disabled'), 'true')
  const why = document.getElementById(trash.getAttribute('aria-describedby'))
  assert.equal(why.textContent, t.moveDialog.reasons.trash, 'the reason is the option\'s description')
  const c = options.find(o => o.dataset.path === 'C')
  assert.equal(c.getAttribute('aria-disabled'), null)
  assert.equal(c.getAttribute('aria-describedby'), null)
})

test('the dialog: Up / Down / Home / End move the active option; Enter on a refused one does nothing, on an allowed one chooses', async t2 => {
  const chosen = []
  const v = await mount(dialogOf('A/B', chosen))
  t2.after(v.unmount)
  await inAct(() => wait(10))
  const lb = listbox()
  const pathOf = () => activeOption().dataset.path
  await inAct(() => key(lb, 'End'))
  assert.equal(pathOf(), 'Lapos')
  await inAct(() => key(lb, 'ArrowDown')) // stays at the end
  assert.equal(pathOf(), 'Lapos')
  await inAct(() => key(lb, 'Home'))
  assert.equal(pathOf(), '')
  // to Trash (refused): Enter does nothing, the OK button is off
  while (pathOf() !== 'Trash') await inAct(() => key(lb, 'ArrowDown'))
  await inAct(() => key(lb, 'Enter'))
  assert.deepEqual(chosen, [])
  const ok = [...document.body.querySelectorAll('.move-folder-dialog button')].find(b => b.textContent === t.moveDialog.ok)
  assert.equal(ok.disabled, true)
  // on to C (allowed)
  while (pathOf() !== 'C') await inAct(() => key(lb, 'ArrowDown'))
  assert.equal(ok.disabled, false)
  await inAct(() => key(lb, 'ArrowUp'))
  await inAct(() => key(lb, 'ArrowDown'))
  await inAct(() => key(lb, 'Enter'))
  assert.equal(chosen.length, 1)
  assert.equal(chosen[0].parent, 'C')
  assert.equal(chosen[0].reason, null)
})

test('the dialog: the top level chosen gives parent null; Esc cancels', async t2 => {
  const chosen = []
  const cancelled = []
  const v = await mount(dialogOf('A/B', chosen, cancelled))
  t2.after(v.unmount)
  await inAct(() => wait(10))
  await inAct(() => key(listbox(), 'Enter'))
  assert.equal(chosen.length, 1)
  assert.equal(chosen[0].parent, null)
  await inAct(() => key(listbox(), 'Escape'))
  assert.equal(cancelled.length, 1)
})

test('the folder menu: "Move…" right after Rename; off with the reason when the folder cannot move at all', async t2 => {
  const picks = []
  const base = { x: 10, y: 10, accountId: 1, path: 'A/B', label: 'B', role: null, siblings: ['A/B'], imap: true, moveBlocked: null }
  let v = await mount(h(FolderMenu, { menu: base, onPick: (op, m) => picks.push([op, m.path]), onClose: () => {} }))
  const labels = () => [...document.body.querySelectorAll('[role="menuitem"]')].map(b => b.textContent.trim())
  const item = () => [...document.body.querySelectorAll('[role="menuitem"]')].find(b => b.textContent.trim() === t.folderMenu.move)
  assert.equal(labels().indexOf(t.folderMenu.move), labels().indexOf(t.folderMenu.rename) + 1)
  assert.equal(labels().indexOf(t.folderMenu.unsubscribe), labels().indexOf(t.folderMenu.delete) - 1, 'Unsubscribe still right before Delete')
  assert.equal(item().disabled || item().getAttribute('aria-disabled') === 'true', false)
  await inAct(async () => {
    item().dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await wait(10)
  })
  assert.deepEqual(picks, [['move', 'A/B']])
  await v.unmount()
  v = await mount(h(FolderMenu, { menu: { ...base, path: 'K', moveBlocked: 'role' }, onPick: () => {}, onClose: () => {} }))
  t2.after(v.unmount)
  assert.ok(item().disabled || item().getAttribute('aria-disabled') === 'true', 'off')
  assert.equal(item().getAttribute('title'), t.moveDialog.reasons.role)
})

test('the tree tells the menu whether the folder can move (a role below it, a flat folder: blocked)', async t2 => {
  const menus = []
  const v = await mount(h(FolderTree, { accounts: [ACCOUNT], selected: { accountId: 1, folder: 'INBOX' }, onSelect: () => {}, onDropMessages: () => {}, onFolderMenu: m => menus.push(m), onNewFolder: () => {} }))
  t2.after(v.unmount)
  const open = async path => inAct(async () => {
    v.container.querySelector(`.folder[data-path="${path}"]`).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await wait(5)
  })
  for (const p of ['A/B', 'C', 'K', 'Lapos']) await open(p)
  assert.deepEqual(menus.map(m => [m.path, m.moveBlocked]), [['A/B', null], ['C', null], ['K', 'role'], ['Lapos', 'flat']])
})
