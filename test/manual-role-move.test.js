// SPDX-License-Identifier: GPL-3.0-or-later
// A role picked by hand moves with its folder in the folder tree too (moveTargetReason, the rename menu): the tree asks
// the same rule as the main process (core/imap/folders.js roleFixed, FolderActions #subtree). An automatic role, and a
// role picked by hand on an automatic candidate (the Inbox, the server's SPECIAL-USE flag, a usual name), stay where
// they are; a role picked by hand on any other folder goes along.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount } from './helpers/react-dom-env.js'
import { moveTargetReason } from '../app/renderer/src/folder-order.js'
import { assignRoles, roleFixed } from '../core/imap/folders.js'

setupDom()
const { createElement: h } = await import('react')
const { FolderMenu } = await import('../app/renderer/src/Mail.jsx')
const { t } = await import('../app/renderer/i18n/index.js')

const row = (path, extra = {}) => ({ path, delimiter: '/', special_use: null, role: null, role_manual: 0, ...extra })
const reason = (folders, from, to) => moveTargetReason(folders, assignRoles(folders), from, to)

test('a role picked by hand on a folder of our own moves with it: the parent moves, and so does the folder itself', () => {
  const folders = [
    row('INBOX', { role: 'inbox' }),
    row('Sent', { special_use: '\\Sent', role: 'sent' }),
    row('Ügyfelek'),
    row('Ügyfelek/Régi', { role: 'archive', role_manual: 1 }),
    row('Projektek'),
  ]
  assert.equal(reason(folders, 'Ügyfelek', 'Projektek'), null, 'the parent of the hand-picked Archive')
  assert.equal(reason(folders, 'Ügyfelek/Régi', 'Projektek'), null, 'the hand-picked Archive itself')
  assert.equal(reason(folders, 'Ügyfelek/Régi', null), null, 'to the top level')
  const roles = assignRoles(folders)
  assert.equal(roleFixed(folders[3], roles), false)
  assert.equal(roleFixed(folders[2], roles), false, 'no role')
})

test('an automatic role stays: the Sent folder of the server, a usual name, and a folder above them', () => {
  const folders = [
    row('INBOX', { role: 'inbox' }),
    row('Sent', { special_use: '\\Sent', role: 'sent' }),
    row('Régi'),
    row('Régi/Trash', { role: 'trash' }),
    row('Projektek'),
  ]
  assert.equal(reason(folders, 'Sent', 'Projektek'), 'role')
  assert.equal(reason(folders, 'Régi', 'Projektek'), 'role', 'an automatic role in the subtree')
  assert.equal(reason(folders, 'INBOX', 'Projektek'), 'role')
  const roles = assignRoles(folders)
  assert.equal(roleFixed(folders[1], roles), true)
})

test('a role picked by hand on an automatic candidate stays (the owner\'s decision): SPECIAL-USE, a usual name, \\Junk picked as archive', () => {
  const folders = [
    row('INBOX', { role: 'inbox' }),
    row('Sent', { special_use: '\\Sent', role: 'sent', role_manual: 1 }),
    row('Elküldött elemek'),
    row('Spam', { special_use: '\\Junk', role: 'archive', role_manual: 1 }),
    row('Projektek'),
  ]
  assert.equal(reason(folders, 'Sent', 'Projektek'), 'role', '\\Sent picked as sent by hand')
  assert.equal(reason(folders, 'Spam', 'Projektek'), 'role', '\\Junk picked as archive by hand')
  // the usual name "Sent" (no flag) next to "Elküldött elemek", picked by hand
  const named = [row('INBOX', { role: 'inbox' }), row('Sent', { role: 'sent', role_manual: 1 }), row('Elküldött elemek'), row('Projektek')]
  assert.equal(reason(named, 'Sent', 'Projektek'), 'role')
})

test('a usual name under a folder of our own is no candidate: picked by hand, it moves; with a "." delimiter under an INBOX. namespace too', () => {
  const own = [row('INBOX', { role: 'inbox' }), row('Ügyfelek'), row('Ügyfelek/Sent', { role: 'sent', role_manual: 1 }), row('Projektek')]
  assert.equal(reason(own, 'Ügyfelek', 'Projektek'), null)
  const dot = (path, extra = {}) => ({ ...row(path, extra), delimiter: '.' })
  const ns = [
    dot('INBOX', { role: 'inbox' }),
    dot('INBOX.Ügyfelek'),
    dot('INBOX.Ügyfelek.Régi', { role: 'archive', role_manual: 1 }),
    dot('INBOX.Sent', { role: 'sent', role_manual: 1 }),
    dot('INBOX.Projektek'),
  ]
  assert.equal(reason(ns, 'INBOX.Ügyfelek', 'INBOX.Projektek'), null, 'a hand-picked Archive under our own folder')
  assert.equal(reason(ns, 'INBOX.Sent', 'INBOX.Projektek'), 'role', 'a usual name right under INBOX is a candidate')
})

test('a hand-picked role that is not the row\'s role now (the sync gave the role elsewhere) is fixed, as in the main process', () => {
  const folders = [row('INBOX', { role: 'inbox' }), row('A'), row('A/Régi', { role: 'trash', role_manual: 1 }), row('Projektek')]
  // the stored role says trash, but assignRoles has the row as trash: the same; a row whose stored role differs is fixed
  assert.equal(reason(folders, 'A', 'Projektek'), null)
  const roles = new Map([['A/Régi', 'archive']])
  assert.equal(roleFixed(folders[2], roles), true)
})

test('the folder menu: rename off only when the role stays with the folder; delete off for every role folder', async () => {
  const state = (label) => {
    const b = [...document.body.querySelectorAll('[role="menuitem"]')].find(x => x.textContent.trim() === label)
    return b.disabled || b.getAttribute('aria-disabled') === 'true'
  }
  const base = { x: 1, y: 1, accountId: 1, path: 'P', label: 'L', siblings: ['P'], imap: false, moveBlocked: null }
  for (const [menu, want, what] of [
    [{ role: 'archive', renameBlocked: false }, [false, true], 'a hand-picked role: rename on, delete off'],
    [{ role: 'sent', renameBlocked: true }, [true, true], 'a role that stays: both off'],
    [{ role: null, renameBlocked: false }, [false, false], 'no role: both on'],
  ]) {
    const v = await mount(h(FolderMenu, { menu: { ...base, ...menu }, onPick: () => {}, onClose: () => {} }))
    assert.deepEqual([state(t.folderMenu.rename), state(t.folderMenu.delete)], want, what)
    await v.unmount()
  }
})
