// SPDX-License-Identifier: GPL-3.0-or-later
// The label interface (jsdom): a row's chips (3 + "+N", the tooltip names all, the text color by contrast), the
// picker over several messages (all / some / none from mail:labelState, a click puts on or takes off every one, a typed
// new name makes the label and puts it on, the keyboard), and the reader's chips with the x.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct, key } from './helpers/react-dom-env.js'

setupDom()
let state = { ok: true, total: 3, counts: [] }
let stateCalls = 0
window.shadowMail = {
  mail: { labelState: async () => (stateCalls++, state) },
  onStatus: () => () => {},
}
const { createElement: h } = await import('react')
const { RowChips, LabelChip } = await import('../app/renderer/src/LabelChip.jsx')
const { LabelPicker } = await import('../app/renderer/src/LabelPicker.jsx')
const { t } = await import('../app/renderer/i18n/index.js')
const wait = ms => new Promise(r => setTimeout(r, ms))
const click = el => inAct(async () => {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(20)
})
const LIST = [
  { id: 1, name: 'Számla', color: '#d32f2f' },
  { id: 2, name: 'Ügyfél', color: '#fbc02d' },
  { id: 3, name: 'Nagyon hosszú címkenév', color: '#1976d2' },
  { id: 4, name: 'Negyedik', color: '#388e3c' },
]

test('a row: at most 3 chips in the list order, then +1; the tooltip names all; black text on yellow, white on blue', async () => {
  const v = await mount(h(RowChips, { ids: [4, 3, 2, 1], list: LIST }))
  const chips = [...v.container.querySelectorAll('.label-chip')]
  assert.deepEqual(chips.map(c => c.dataset.labelId), ['1', '2', '3'])
  assert.equal(chips[2].textContent, 'Nagyon hossz…', '12 characters, then the ellipsis')
  assert.equal(chips[2].title, 'Nagyon hosszú címkenév', 'the full name in the chip tooltip')
  assert.equal(v.container.querySelector('.label-chip-more').textContent, '+1')
  // the two "+N": after 3 (chips, 3 dots) and after 1 (1 dot); the CSS shows one of them; each names the rest
  const more3 = v.container.querySelector('.label-more-3')
  const more1 = v.container.querySelector('.label-more-1')
  assert.deepEqual([more3.textContent, more3.title], ['+1', 'Negyedik'])
  assert.deepEqual([more1.textContent, more1.title], ['+3', 'Ügyfél, Nagyon hosszú címkenév, Negyedik'])
  assert.equal(v.container.querySelector('.label-chips-none').textContent, t.labels.group('Számla, Ügyfél, Nagyon hosszú címkenév, Negyedik'))
  const group = v.container.querySelector('.label-chips')
  assert.equal(group.title, 'Számla, Ügyfél, Nagyon hosszú címkenév, Negyedik')
  assert.equal(group.getAttribute('role'), 'group')
  assert.equal(chips[1].style.color, 'rgb(0, 0, 0)', 'yellow: black text')
  assert.equal(chips[2].style.color, 'rgb(255, 255, 255)', 'blue: white text')
  v.unmount()
  const none = await mount(h(RowChips, { ids: [], list: LIST }))
  assert.equal(none.container.innerHTML, '', 'no label: nothing drawn')
  none.unmount()
})

test('the reader chip: the whole name and an x that takes it off', async () => {
  let removed = 0
  const v = await mount(h(LabelChip, { label: LIST[2], full: true, onRemove: () => removed++ }))
  assert.equal(v.container.querySelector('.label-chip-name').textContent, 'Nagyon hosszú címkenév')
  const x = v.container.querySelector('.label-chip-remove')
  assert.equal(x.getAttribute('aria-label'), t.labels.remove('Nagyon hosszú címkenév'))
  await click(x)
  assert.equal(removed, 1)
  v.unmount()
})

test('the picker over 3 messages, 1 labelled: indeterminate; a click puts it on all, again takes it off all; a failure goes back', async () => {
  state = { ok: true, total: 3, counts: [[1, 1], [2, 3]] }
  const calls = []
  let ok = true
  const v = await mount(h(LabelPicker, { ids: [10, 11, 12], list: LIST, onToggle: async (id, action) => (calls.push([id, action]), ok), onCreate: async () => ({}), onClose: () => {} }))
  await inAct(() => wait(30))
  const box = id => v.container.querySelector(`.label-picker-item[data-label-id="${id}"] input`)
  const stateOf = id => v.container.querySelector(`.label-picker-item[data-label-id="${id}"]`).dataset.state
  assert.deepEqual([stateOf(1), stateOf(2), stateOf(3)], ['some', 'all', 'none'])
  assert.equal(box(1).indeterminate, true)
  assert.equal(box(2).checked, true)
  await click(box(1))
  assert.deepEqual(calls.at(-1), [1, 'add'])
  assert.equal(stateOf(1), 'all')
  await click(box(1))
  assert.deepEqual(calls.at(-1), [1, 'remove'])
  assert.equal(stateOf(1), 'none')
  ok = false
  const asked = stateCalls
  await click(box(2))
  assert.deepEqual(calls.at(-1), [2, 'remove'])
  assert.equal(stateOf(2), 'all', 'the failed change went back')
  assert.equal(stateCalls, asked + 1, 'and the state asked again (a batch before the failure may be stored)')
  v.unmount()
})

test('the picker: the filter, "New label: <name>" makes it and puts it on; Enter in the filter; the arrows; Esc closes', async () => {
  state = { ok: true, total: 1, counts: [] }
  const calls = []
  let closed = 0
  const made = []
  const onCreate = async name => (made.push(name), { label: { id: 9, name, color: '#616161' } })
  const v = await mount(h(LabelPicker, { ids: [10], list: LIST, onToggle: async (id, a) => (calls.push([id, a]), true), onCreate, onClose: () => closed++ }))
  await inAct(() => wait(30))
  const input = v.container.querySelector('.label-picker-filter input')
  assert.equal(document.activeElement, input, 'the filter has the focus')
  const type = async text => inAct(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, text)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await wait(10)
  })
  await type('ügy')
  assert.deepEqual([...v.container.querySelectorAll('.label-picker-item')].map(li => li.dataset.labelId), ['2'], 'case-insensitive filter')
  await type('Teszt')
  assert.ok(v.container.querySelector('.label-picker-nomatch'))
  const create = v.container.querySelector('.label-picker-create')
  assert.equal(create.textContent, t.labels.create('Teszt'))
  // a real click focuses the button first (jsdom's dispatched click does not): that is the focus the button takes away
  await inAct(async () => create.focus())
  await click(create)
  await inAct(() => wait(20))
  assert.deepEqual(made, ['Teszt'])
  assert.deepEqual(calls.at(-1), [9, 'add'], 'made and put on in one step')
  assert.equal(document.activeElement, input, 'the focus back in the filter (the New label button is gone)')
  // Enter on an exact name toggles it
  await type('számla')
  await inAct(async () => { key(input, 'Enter'); await wait(20) })
  assert.deepEqual(calls.at(-1), [1, 'add'])
  // the arrows move between the boxes, Enter toggles the focused one
  await type('')
  await inAct(async () => { key(input, 'ArrowDown'); await wait(5) })
  const boxes = [...v.container.querySelectorAll('.label-picker-list input')]
  assert.equal(document.activeElement, boxes[0])
  await inAct(async () => { key(boxes[0], 'ArrowDown'); await wait(5) })
  assert.equal(document.activeElement, boxes[1])
  await inAct(async () => { key(boxes[1], 'ArrowUp'); await wait(5) })
  assert.equal(document.activeElement, boxes[0])
  await inAct(async () => { key(boxes[0], 'Escape'); await wait(5) })
  assert.equal(closed, 1, 'Esc closes')
  v.unmount()
})
