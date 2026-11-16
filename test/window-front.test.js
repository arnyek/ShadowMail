// showMainWindow, the one helper that brings the main window forward (Electron free, with fakes).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { showMainWindow } from '../app/main/window-front.js'

function fakeWin({ minimized = false, destroyed = false } = {}) {
  const calls = []
  const handlers = {}
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    flashFrame: on => calls.push(`flash:${on}`),
    once: (ev, fn) => (handlers[ev] = fn),
    emit: ev => handlers[ev]?.(),
  }
}

test('shown: restore when minimized, then show and focus', () => {
  const w = fakeWin({ minimized: true })
  assert.equal(showMainWindow(w), 'shown')
  assert.deepEqual(w.calls, ['restore', 'show', 'focus'])
  const v = fakeWin()
  assert.equal(showMainWindow(v, { focused: v, keepFocus: () => true }), 'shown', 'the main window itself in focus: shown')
  assert.deepEqual(v.calls, ['show', 'focus'])
})

test('a composer in focus keeps it: the main window only flashes, until it gets the focus', () => {
  const w = fakeWin({ minimized: true })
  const composer = fakeWin()
  assert.equal(showMainWindow(w, { focused: composer, keepFocus: x => x === composer }), 'flashed')
  assert.deepEqual(w.calls, ['flash:true'], 'no restore, show or focus')
  w.emit('focus')
  assert.deepEqual(w.calls, ['flash:true', 'flash:false'])
  // another focused window that is not a composer: shown
  const other = fakeWin()
  const z = fakeWin()
  assert.equal(showMainWindow(z, { focused: other, keepFocus: x => x === composer }), 'shown')
})

test('no window or a destroyed one: not_available', () => {
  assert.throws(() => showMainWindow(null), { code: 'not_available' })
  assert.throws(() => showMainWindow(fakeWin({ destroyed: true })), { code: 'not_available' })
})
