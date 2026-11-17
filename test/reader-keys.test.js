// SPDX-License-Identifier: GPL-3.0-or-later
// The reader keys: the pure steps (neighbor, the next message after a removal, where an Archive goes, which key is
// ours) and the main process's filter for the keys typed inside the message frame.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { neighbor, afterRemoval, archiveFor, readerKeyOf } from '../app/renderer/src/reader-nav.js'
import { frameReaderKey } from '../app/main/reader-keys.js'

test('neighbor: one step in the list order, null at the edges and for an unlisted id', () => {
  const ids = [5, 9, 2, 7]
  assert.equal(neighbor(ids, 9, 1), 2)
  assert.equal(neighbor(ids, 9, -1), 5)
  assert.equal(neighbor(ids, 5, -1), null, 'the first: Up does nothing')
  assert.equal(neighbor(ids, 7, 1), null, 'the last: Down does nothing')
  assert.equal(neighbor(ids, 42, 1), null)
  assert.equal(neighbor([], 1, 1), null)
})

test('afterRemoval: the one below that stays, at the end the one above, else none; untouched when the open one stays', () => {
  const ids = [1, 2, 3, 4, 5]
  assert.equal(afterRemoval(ids, 3, [3]), 4)
  assert.equal(afterRemoval(ids, 3, [3, 4]), 5, 'a removed neighbour is skipped')
  assert.equal(afterRemoval(ids, 5, [5]), 4, 'the last: the one above')
  assert.equal(afterRemoval(ids, 4, [4, 5]), 3, 'the rest below goes too: the one above')
  assert.equal(afterRemoval(ids, 3, [1, 2, 3, 4, 5]), null, 'nothing left')
  assert.equal(afterRemoval([7], 7, [7]), null)
  assert.equal(afterRemoval(ids, 3, [1, 2]), undefined, 'the open one stays: nothing changes')
  assert.equal(afterRemoval(ids, 9, [9]), null, 'the open one not listed: no guess')
})

const f = (path, extra = {}) => ({ path, delimiter: '/', special_use: null, ...extra })

test('archiveFor: the Archive role folder; no Archive or inside it: the reason', () => {
  const withArchive = [f('INBOX'), f('Archive', { special_use: '\\Archive' }), f('Archive/2024'), f('Archived old')]
  assert.deepEqual(archiveFor(withArchive, 'INBOX'), { archive: 'Archive' })
  assert.deepEqual(archiveFor(withArchive, 'Archived old'), { archive: 'Archive' }, 'a name prefix is not inside')
  assert.deepEqual(archiveFor(withArchive, 'Archive'), { reason: 'in_archive' })
  assert.deepEqual(archiveFor(withArchive, 'Archive/2024'), { reason: 'in_archive' })
  assert.deepEqual(archiveFor([f('INBOX'), f('Projects')], 'INBOX'), { reason: 'no_archive' })
  assert.deepEqual(archiveFor([f('INBOX'), f('Régi', { role: 'archive' })], 'INBOX'), { archive: 'Régi' }, 'a stored role counts')
})

test('readerKeyOf: Up, Down, Delete (Shift too), End; any other key or modifier is not ours', () => {
  const k = (key, mods = {}) => readerKeyOf({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods })
  assert.equal(k('ArrowUp'), 'up')
  assert.equal(k('ArrowDown'), 'down')
  assert.equal(k('Delete'), 'delete')
  assert.equal(k('Delete', { shiftKey: true }), 'delete', 'Shift+Delete deleted before too')
  assert.equal(k('End'), 'archive')
  for (const key of ['Home', 'PageUp', 'PageDown', ' ', 'ArrowLeft', 'Backspace', 'Enter', 'a']) assert.equal(k(key), null, key)
  assert.equal(k('ArrowUp', { altKey: true }), null, 'Alt+Up: the folder order')
  assert.equal(k('ArrowDown', { shiftKey: true }), null)
  assert.equal(k('End', { ctrlKey: true }), null)
  assert.equal(k('Delete', { metaKey: true }), null)
})

test('frameReaderKey: only a keyDown inside the mail-view: frame, the same keys and modifiers as the page', () => {
  const input = (key, mods = {}) => ({ type: 'keyDown', key, control: false, alt: false, meta: false, shift: false, ...mods })
  const frame = 'mail-view://view/abc'
  assert.equal(frameReaderKey(input('ArrowDown'), frame), 'down')
  assert.equal(frameReaderKey(input('ArrowUp'), frame), 'up')
  assert.equal(frameReaderKey(input('Delete', { shift: true }), frame), 'delete')
  assert.equal(frameReaderKey(input('End'), frame), 'archive')
  assert.equal(frameReaderKey(input('PageDown'), frame), null, 'the frame still scrolls with PageDown')
  assert.equal(frameReaderKey(input(' '), frame), null, 'and Space')
  assert.equal(frameReaderKey(input('Home'), frame), null)
  assert.equal(frameReaderKey({ ...input('ArrowDown'), type: 'keyUp' }, frame), null, 'one event per press')
  assert.equal(frameReaderKey(input('ArrowDown', { control: true }), frame), null)
  assert.equal(frameReaderKey(input('End', { shift: true }), frame), null)
  // the page's own keys stay with the page (its handler knows the focus: fields, dividers, menus)
  assert.equal(frameReaderKey(input('ArrowDown'), 'file:///app/index.html'), null)
  assert.equal(frameReaderKey(input('ArrowDown'), null), null)
  assert.equal(frameReaderKey(input('ArrowDown'), 'mail-viewer://x'), null)
  assert.equal(frameReaderKey(null, frame), null)
})
