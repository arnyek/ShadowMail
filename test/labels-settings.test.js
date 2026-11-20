// SPDX-License-Identifier: GPL-3.0-or-later
// Beállítások / Címkék (jsdom), against a fake labels:* bridge that keeps the list: the rows (count, the palette as
// the color picker's suggestions, the edges of up / down), rename in place (Enter, leaving the field, Esc, the field
// error of a taken name), one color save after the picker rests, up / down, delete with the real number of messages
// (Cancel changes nothing), New label (the next palette color, the field error), the empty state, and the reload on
// the { kind: 'labels' } event.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct, key } from './helpers/react-dom-env.js'

setupDom()
const calls = []
let store = []
let statusFns = []
let fail = null // an error code the next write answers with
let reorderOverride = null // (ids) => answer: the list changed meanwhile (another window, Claude)
const fold = s => s.normalize('NFC').toLowerCase()
const answer = (op, fn) => async (...args) => {
  calls.push([op, ...args])
  if (fail) {
    const error = fail
    fail = null
    return { ok: false, error }
  }
  return fn(...args)
}
window.shadowMail = {
  labels: {
    list: async () => (calls.push(['list']), { ok: true, labels: store.map(l => ({ ...l })) }),
    create: answer('create', (name, color) => {
      const label = { id: Math.max(0, ...store.map(l => l.id)) + 1, name: name.trim(), color, count: 0 }
      store.push(label)
      return { ok: true, label }
    }),
    rename: answer('rename', (id, name) => {
      if (store.some(l => l.id !== id && fold(l.name) === fold(name))) return { ok: false, error: 'name_taken' }
      store.find(l => l.id === id).name = name
      return { ok: true }
    }),
    setColor: answer('setColor', (id, color) => ((store.find(l => l.id === id).color = color), { ok: true })),
    reorder: answer('reorder', ids => {
      if (reorderOverride) return reorderOverride(ids)
      store = ids.map(id => store.find(l => l.id === id))
      return { ok: true, labels: store.map(l => ({ ...l })) }
    }),
    remove: answer('remove', id => {
      const count = store.find(l => l.id === id).count
      store = store.filter(l => l.id !== id)
      return { ok: true, count }
    }),
  },
  onStatus: fn => (statusFns.push(fn), () => (statusFns = statusFns.filter(f => f !== fn))),
}
const { createElement: h } = await import('react')
const { LabelsSettings } = await import('../app/renderer/src/LabelsSettings.jsx')
const { LABEL_PALETTE } = await import('../app/renderer/src/label-chips.js')
const { t } = await import('../app/renderer/i18n/index.js')
const wait = ms => new Promise(r => setTimeout(r, ms))
const settle = (ms = 20) => inAct(() => wait(ms))
const click = el => inAct(async () => {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(20)
})
const type = (input, text) => inAct(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await wait(5)
})
const press = (el, k) => inAct(async () => {
  key(el, k)
  await wait(20)
})
const fresh = () => {
  calls.length = 0
  fail = null
  reorderOverride = null
  store = [
    { id: 1, name: 'Számla', color: '#d32f2f', count: 3 },
    { id: 2, name: 'Ügyfél', color: '#f57c00', count: 0 },
    { id: 3, name: 'Projekt', color: '#1976d2', count: 1 },
  ]
}
const page = async () => {
  const v = await mount(h(LabelsSettings))
  await settle()
  const rowOf = id => v.container.querySelector(`.labels-row[data-label-id="${id}"]`)
  const order = () => [...v.container.querySelectorAll('.labels-row')].map(r => Number(r.dataset.labelId))
  return { v, rowOf, order }
}
const writes = () => calls.filter(c => c[0] !== 'list')

test('the rows: name, number of messages, the palette offered, the first cannot go up and the last cannot go down', async () => {
  fresh()
  const { v, rowOf, order } = await page()
  assert.deepEqual(order(), [1, 2, 3])
  assert.equal(rowOf(1).querySelector('.labels-name').value, 'Számla')
  assert.equal(rowOf(1).querySelector('.labels-count').textContent, t.labelsPage.count(3))
  assert.equal(rowOf(1).querySelector('.labels-name').getAttribute('aria-label'), t.labelsPage.renameOf('Számla'))
  const color = rowOf(1).querySelector('.labels-color')
  assert.equal(color.value, '#d32f2f')
  assert.equal(color.getAttribute('list'), 'label-palette')
  assert.deepEqual([...v.container.querySelectorAll('#label-palette option')].map(o => o.value), [...LABEL_PALETTE])
  assert.ok(rowOf(1).querySelector('.labels-up').disabled && !rowOf(1).querySelector('.labels-down').disabled)
  assert.ok(!rowOf(3).querySelector('.labels-up').disabled && rowOf(3).querySelector('.labels-down').disabled)
  assert.equal(v.container.querySelector('.labels-empty'), null)
  await v.unmount()
})

test('rename in place: Enter saves the trimmed name on the same id; an unchanged name writes nothing; leaving the field saves; Esc gives the old one back', async () => {
  fresh()
  const { v, rowOf } = await page()
  const input = () => rowOf(1).querySelector('.labels-name')
  await type(input(), '  Számlák ')
  await press(input(), 'Enter')
  assert.deepEqual(writes(), [['rename', 1, 'Számlák']])
  assert.equal(store[0].name, 'Számlák')
  await settle()
  calls.length = 0
  await press(input(), 'Enter')
  assert.deepEqual(writes(), [], 'the same name: no call')
  await type(input(), 'Számlázás')
  await inAct(async () => (input().dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })), await wait(20)))
  assert.deepEqual(writes(), [['rename', 1, 'Számlázás']], 'leaving the field saves')
  calls.length = 0
  await type(input(), 'Valami más')
  await press(input(), 'Escape')
  assert.equal(input().value, 'Számlázás', 'Esc: the old name back')
  assert.deepEqual(writes(), [])
  await v.unmount()
})

test('a taken name in another case: the field error under the row, aria-invalid, nothing changed; Esc clears it', async () => {
  fresh()
  const { v, rowOf } = await page()
  const input = rowOf(2).querySelector('.labels-name')
  await type(input, 'SZÁMLA')
  await press(input, 'Enter')
  assert.equal(rowOf(2).querySelector('.labels-row-error').textContent, t.labels.error('name_taken'))
  assert.equal(input.getAttribute('aria-invalid'), 'true')
  assert.equal(store[1].name, 'Ügyfél')
  await press(input, 'Escape')
  assert.equal(rowOf(2).querySelector('.labels-row-error'), null)
  assert.equal(input.value, 'Ügyfél')
  await v.unmount()
})

test('the color: many values while the picker moves, one save with the last after it rests', async () => {
  fresh()
  const { v, rowOf } = await page()
  const color = rowOf(3).querySelector('.labels-color')
  for (const c of ['#000001', '#000002', '#00897b']) await type(color, c)
  assert.deepEqual(writes(), [], 'nothing while it moves')
  await settle(300)
  assert.deepEqual(writes(), [['setColor', 3, '#00897b']])
  await v.unmount()
})

test('up / down: the whole order in one call; a failure shows the error and loads the list again', async () => {
  fresh()
  const { v, rowOf, order } = await page()
  await click(rowOf(3).querySelector('.labels-up'))
  assert.deepEqual(writes(), [['reorder', [1, 3, 2]]])
  assert.deepEqual(order(), [1, 3, 2])
  calls.length = 0
  await click(rowOf(1).querySelector('.labels-down'))
  assert.deepEqual(writes(), [['reorder', [3, 1, 2]]])
  assert.deepEqual(order(), [3, 1, 2])
  calls.length = 0
  fail = 'order_mismatch'
  await click(rowOf(2).querySelector('.labels-up'))
  await settle()
  assert.equal(v.container.querySelector('.labels-error').textContent, t.labels.error('order_mismatch'))
  assert.ok(calls.some(c => c[0] === 'list'), 'loaded again')
  assert.deepEqual(order(), [3, 1, 2])
  await v.unmount()
})

test('delete: the question names the real number of messages, Cancel (with the focus) changes nothing, Delete takes it off', async () => {
  fresh()
  const { v, rowOf, order } = await page()
  await click(rowOf(1).querySelector('.labels-delete'))
  const modal = document.querySelector('.labels-delete-modal')
  assert.equal(modal.getAttribute('role'), 'alertdialog')
  assert.equal(modal.querySelector('.confirm-text').textContent, t.labelsPage.deleteText('Számla', 3))
  assert.equal(document.activeElement, modal.querySelector('.labels-delete-cancel'), 'the focus on Cancel')
  await click(modal.querySelector('.labels-delete-cancel'))
  assert.equal(document.querySelector('.labels-delete-modal'), null)
  assert.deepEqual(writes(), [])
  await click(rowOf(1).querySelector('.labels-delete'))
  await click(document.querySelector('.labels-delete-yes'))
  await settle()
  assert.deepEqual(writes(), [['remove', 1]])
  assert.deepEqual(order(), [2, 3])
  await v.unmount()
})

test('New label: the next palette color, made at the end; the error in the field; Cancel closes the form', async () => {
  fresh()
  const { v, order } = await page()
  await click(v.container.querySelector('.labels-add'))
  const form = v.container.querySelector('.labels-new')
  assert.equal(form.querySelector('input[type="color"]').value, LABEL_PALETTE[3], 'three labels: the fourth color')
  assert.equal(document.activeElement, form.querySelector('.labels-new-name input'), 'the focus in the name')
  await type(form.querySelector('.labels-new-name input'), 'számla')
  await click(form.querySelector('.labels-create'))
  assert.deepEqual(writes(), [['create', 'számla', LABEL_PALETTE[3]]])
  await settle()
  assert.deepEqual(order(), [1, 2, 3, 4])
  assert.equal(v.container.querySelector('.labels-new'), null, 'the form closes after a made label')
  await click(v.container.querySelector('.labels-add'))
  fail = 'too_many'
  const again = v.container.querySelector('.labels-new')
  await type(again.querySelector('.labels-new-name input'), 'Ötödik')
  await click(again.querySelector('.labels-create'))
  assert.ok(again.querySelector('.labels-new-name').textContent.includes(t.labels.error('too_many')))
  assert.deepEqual(order(), [1, 2, 3, 4])
  const cancel = [...again.querySelectorAll('button')].find(b => b.textContent === t.labelsPage.cancel)
  await click(cancel)
  assert.equal(v.container.querySelector('.labels-new'), null)
  assert.ok(v.container.querySelector('.labels-add'))
  await v.unmount()
})

test('no label: the sentence and New label; the { kind: labels } event loads the list again', async () => {
  fresh()
  store = []
  const { v, order } = await page()
  assert.equal(v.container.querySelector('.labels-empty').textContent, t.labelsPage.empty)
  assert.ok(v.container.querySelector('.labels-add'))
  assert.equal(v.container.querySelector('.labels-list'), null)
  store = [{ id: 7, name: 'Máshonnan', color: '#616161', count: 2 }]
  await inAct(async () => {
    for (const fn of statusFns) fn({ kind: 'labels' })
    await wait(20)
  })
  assert.deepEqual(order(), [7])
  assert.equal(v.container.querySelector('.labels-empty'), null)
  const lists = calls.filter(c => c[0] === 'list').length
  await inAct(async () => {
    for (const fn of statusFns) fn({ kind: 'mail' })
    await wait(20)
  })
  assert.equal(calls.filter(c => c[0] === 'list').length, lists, 'another kind: no reload')
  await v.unmount()
  assert.equal(statusFns.length, 0, 'unmounted: no listener left')
})

test('the focus after a move: the same button while it is enabled; at the edge the row\'s other button; a row alone (the other label gone meanwhile) the row itself', async () => {
  fresh()
  const { v, rowOf } = await page()
  const press = async el => {
    el.focus()
    await click(el)
    await settle()
  }
  await press(rowOf(3).querySelector('.labels-up'))
  assert.equal(document.activeElement, rowOf(3).querySelector('.labels-up'), 'in the middle: the same button')
  await press(rowOf(3).querySelector('.labels-up'))
  assert.ok(rowOf(3).querySelector('.labels-up').disabled, 'at the top: Up disabled')
  assert.equal(document.activeElement, rowOf(3).querySelector('.labels-down'), 'at the top: the row\'s Down')
  // the order is 3, 1, 2: label 1 down to the bottom
  await press(rowOf(1).querySelector('.labels-down'))
  assert.ok(rowOf(1).querySelector('.labels-down').disabled, 'at the bottom: Down disabled')
  assert.equal(document.activeElement, rowOf(1).querySelector('.labels-up'), 'at the bottom: the row\'s Up')
  // the list changed meanwhile: only the moved label is left, both its buttons disabled -> the row
  reorderOverride = () => ((store = store.filter(l => l.id === 3)), { ok: true, labels: store.map(l => ({ ...l })) })
  await press(rowOf(3).querySelector('.labels-down'))
  assert.ok(rowOf(3).querySelector('.labels-up').disabled && rowOf(3).querySelector('.labels-down').disabled)
  assert.equal(document.activeElement, rowOf(3), 'one label: the row')
  assert.equal(rowOf(3).getAttribute('tabindex'), '-1', 'the row takes the focus, but is not a tab stop')
  await v.unmount()
})

test('a color picked just before leaving the page (another tab) is sent at once, not dropped; nothing pending: nothing sent', async () => {
  fresh()
  const { v, rowOf } = await page()
  await type(rowOf(2).querySelector('.labels-color'), '#123456')
  await settle(30)
  assert.deepEqual(writes(), [], 'inside the wait nothing went yet')
  await v.unmount()
  assert.deepEqual(writes(), [['setColor', 2, '#123456']], 'the unmount sent it')
  assert.equal(store.find(l => l.id === 2).color, '#123456')
  fresh()
  const second = await page()
  await type(second.rowOf(2).querySelector('.labels-color'), '#654321')
  await settle(300)
  assert.deepEqual(writes(), [['setColor', 2, '#654321']])
  await second.v.unmount()
  assert.deepEqual(writes(), [['setColor', 2, '#654321']], 'already saved: the unmount sends nothing more')
})

test('the delete question says the count as it is NOW: a label put on meanwhile (the list, Claude) and the labels event', async () => {
  fresh()
  const { v, rowOf } = await page()
  await click(rowOf(1).querySelector('.labels-delete'))
  const text = () => document.querySelector('.labels-delete-modal .confirm-text').textContent
  assert.equal(text(), t.labelsPage.deleteText('Számla', 3))
  store.find(l => l.id === 1).count = 5
  await inAct(async () => {
    for (const fn of statusFns) fn({ kind: 'labels' })
    await wait(20)
  })
  assert.equal(text(), t.labelsPage.deleteText('Számla', 5), 'the fresh count in the open question')
  assert.equal(rowOf(1).querySelector('.labels-count').textContent, t.labelsPage.count(5), 'and in the row')
  await click(document.querySelector('.labels-delete-cancel'))
  await v.unmount()
})
