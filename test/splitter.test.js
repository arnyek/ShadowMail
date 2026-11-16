// the Splitter component in jsdom: the separator role and
// its aria values, the keyboard (arrows 16 px, Home = default), the double click, a pointer drag (the variable while
// dragging, the pref only at the end), the clamping (min, the caller's max, a saved value on load and on a resize).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct, key } from './helpers/react-dom-env.js'

setupDom()
const { createElement: h } = await import('react')
const { Splitter, SPLIT_STEP } = await import('../app/renderer/src/ui/index.js')
const { getPref, setPref } = await import('../app/renderer/src/prefs.js')

const frame = () => new Promise(r => setTimeout(r, 40))
const rootStyle = v => document.documentElement.style.getPropertyValue(v)
const reset = () => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('style')
  for (const a of [...document.documentElement.attributes]) if (a.name.startsWith('data-split-')) document.documentElement.removeAttribute(a.name)
}
const pointer = (el, type, x) => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: x, button: 0 }))

async function setup(t, { size = 300, max = 500, saved, orientation = 'vertical' } = {}) {
  reset()
  if (saved !== undefined) setPref('split.test', saved)
  const state = { size, max }
  // the "pane" follows the variable, like the grid does
  const measure = () => {
    const v = parseFloat(rootStyle('--test-w'))
    return Number.isFinite(v) ? v : state.size
  }
  const v = await mount(h(Splitter, { name: 'test', cssVar: '--test-w', label: 'Teszt sáv', min: 180, max: () => state.max, measure, orientation }))
  t.after(() => {
    v.unmount()
    reset()
  })
  await inAct(frame)
  return { el: v.container.querySelector('[role="separator"]'), state }
}

test('the separator: role, orientation, name, tab stop, aria-valuemin/max/now', async t => {
  const { el } = await setup(t)
  assert.equal(el.getAttribute('aria-orientation'), 'vertical')
  assert.equal(el.getAttribute('aria-label'), 'Teszt sáv')
  assert.equal(el.getAttribute('title'), 'Teszt sáv')
  assert.equal(el.tabIndex, 0)
  assert.equal(el.getAttribute('aria-valuemin'), '180')
  assert.equal(el.getAttribute('aria-valuemax'), '500')
  assert.equal(el.getAttribute('aria-valuenow'), '300', 'the pane as it is, no size set')
  assert.equal(rootStyle('--test-w'), '', 'nothing set until it is moved')
  assert.match(el.className, /\bsplitter\b.*\bsplitter-vertical\b/)
})

test('the keyboard: arrows move 16 px and save; Home gives back the default; the limits hold', async t => {
  const { el } = await setup(t)
  el.focus()
  await inAct(() => key(el, 'ArrowRight'))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), `${300 + SPLIT_STEP}px`)
  assert.ok(document.documentElement.hasAttribute('data-split-test'))
  assert.equal(getPref('split.test', null), 316)
  assert.equal(el.getAttribute('aria-valuenow'), '316')
  await inAct(() => key(el, 'ArrowLeft'))
  await inAct(() => key(el, 'ArrowLeft'))
  await inAct(frame)
  assert.equal(getPref('split.test', null), 284)
  // at the maximum and the minimum it stops
  for (let i = 0; i < 30; i++) await inAct(() => key(el, 'ArrowRight'))
  await inAct(frame)
  assert.equal(getPref('split.test', null), 500)
  for (let i = 0; i < 40; i++) await inAct(() => key(el, 'ArrowLeft'))
  await inAct(frame)
  assert.equal(getPref('split.test', null), 180)
  // ArrowUp/Down do nothing on a vertical divider
  await inAct(() => key(el, 'ArrowDown'))
  assert.equal(getPref('split.test', null), 180)
  await inAct(() => key(el, 'Home'))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '')
  assert.equal(document.documentElement.hasAttribute('data-split-test'), false)
  assert.equal(getPref('split.test', 'x'), null)
  assert.equal(el.getAttribute('aria-valuenow'), '300')
})

test('a horizontal divider: ArrowUp / ArrowDown, row orientation', async t => {
  const { el } = await setup(t, { orientation: 'horizontal' })
  assert.equal(el.getAttribute('aria-orientation'), 'horizontal')
  await inAct(() => key(el, 'ArrowDown'))
  await inAct(frame)
  assert.equal(getPref('split.test', null), 316)
  await inAct(() => key(el, 'ArrowRight'))
  assert.equal(getPref('split.test', null), 316, 'left/right do nothing here')
})

test('a pointer drag: the variable follows (clamped), the pref is written only when it ends; a double click resets', async t => {
  const { el } = await setup(t)
  await inAct(() => pointer(el, 'pointerdown', 1000))
  assert.ok(document.documentElement.classList.contains('splitting') && document.documentElement.classList.contains('splitting-col'))
  await inAct(() => pointer(el, 'pointermove', 1050))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '350px')
  assert.equal(getPref('split.test', null), null, 'not saved while dragging')
  await inAct(() => pointer(el, 'pointermove', 2000))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '500px', 'not over the maximum')
  await inAct(() => pointer(el, 'pointermove', 0))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '180px', 'not under the minimum')
  await inAct(() => pointer(el, 'pointermove', 1020))
  await inAct(() => pointer(el, 'pointerup', 1020))
  await inAct(frame)
  assert.equal(getPref('split.test', null), 320)
  assert.equal(document.documentElement.classList.contains('splitting'), false)
  // a move without a press does nothing
  await inAct(() => pointer(el, 'pointermove', 1300))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '320px')
  await inAct(() => el.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '')
  assert.equal(getPref('split.test', 'x'), null)
  // a right button press is not a drag
  await inAct(() => el.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 10, button: 2 })))
  assert.equal(document.documentElement.classList.contains('splitting'), false)
})

test('a saved size is clamped on load and on a window resize; the saved value itself stays', async t => {
  const { el, state } = await setup(t, { saved: 900 })
  assert.equal(rootStyle('--test-w'), '500px', 'clamped to the max on load')
  assert.equal(getPref('split.test', null), 900, 'the saved value is kept')
  state.max = 400
  await inAct(() => window.dispatchEvent(new window.Event('resize')))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '400px')
  assert.equal(el.getAttribute('aria-valuemax'), '400')
  state.max = 1000
  await inAct(() => window.dispatchEvent(new window.Event('resize')))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '900px', 'a larger window gets it back')
  // a max under the min: the min wins
  state.max = 50
  await inAct(() => window.dispatchEvent(new window.Event('resize')))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '180px')
})

test('a broken saved value is ignored', async t => {
  for (const bad of ['x', -5, 0, null, { a: 1 }]) {
    const { el } = await setup(t, { saved: bad })
    assert.equal(rootStyle('--test-w'), '', JSON.stringify(bad))
    assert.equal(el.getAttribute('aria-valuenow'), '300')
  }
})

test('a resize of the observed container (another divider moved) re-fits the size, without a window resize', async t => {
  reset()
  const observers = []
  globalThis.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb
      observers.push(this)
    }
    observe(el) {
      this.el = el
    }
    disconnect() {
      this.gone = true
    }
  }
  t.after(() => delete globalThis.ResizeObserver)
  setPref('split.test', 450)
  const state = { max: 500 }
  const box = { current: document.createElement('div') }
  const measure = () => parseFloat(rootStyle('--test-w')) || 300
  const v = await mount(h(Splitter, { name: 'test', cssVar: '--test-w', label: 'Teszt', min: 180, max: () => state.max, measure, observe: box }))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '450px')
  const ro = observers.find(o => o.el === box.current)
  assert.ok(ro, 'the container is observed')
  // the sidebar grew: the panes got narrower, the max fell
  state.max = 320
  await inAct(() => ro.cb([]))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '320px', 're-fitted without a window resize')
  const el = v.container.querySelector('[role="separator"]')
  assert.equal(el.getAttribute('aria-valuemax'), '320')
  state.max = 600
  await inAct(() => ro.cb([]))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '450px', 'the saved size comes back with the room')
  v.unmount()
  assert.equal(ro.gone, true, 'disconnected on unmount')
  reset()
})

test('no saved size: a default that does not fit is clamped for display only; with room again the default returns', async t => {
  const { el, state } = await setup(t, { size: 256, max: 204 })
  assert.equal(rootStyle('--test-w'), '204px', 'the default (256) clamped to max()')
  assert.ok(document.documentElement.hasAttribute('data-split-test'))
  assert.equal(el.getAttribute('aria-valuenow'), '204')
  assert.equal(getPref('split.test', null), null, 'nothing saved')
  // a wider window: the default fits again, the variable goes, the stylesheet's default is back
  state.max = 500
  window.dispatchEvent(new window.Event('resize'))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '')
  assert.ok(!document.documentElement.hasAttribute('data-split-test'))
  assert.equal(el.getAttribute('aria-valuenow'), '256')
  assert.equal(getPref('split.test', null), null)
  // narrow again: clamped again, still nothing saved
  state.max = 220
  window.dispatchEvent(new window.Event('resize'))
  await inAct(frame)
  assert.equal(rootStyle('--test-w'), '220px')
  assert.equal(getPref('split.test', null), null)
})

test('no saved size: a default under the minimum is raised to it; a default that fits is left alone', async t => {
  const narrow = await setup(t, { size: 120, max: 500 })
  assert.equal(rootStyle('--test-w'), '180px')
  assert.equal(narrow.el.getAttribute('aria-valuenow'), '180')
  assert.equal(getPref('split.test', null), null)
})

test('Home with a default that does not fit: the saved size goes, the default shows clamped, nothing saved', async t => {
  const { el, state } = await setup(t, { size: 256, max: 500, saved: 400 })
  assert.equal(rootStyle('--test-w'), '400px')
  state.max = 204
  el.focus()
  await inAct(() => key(el, 'Home'))
  await inAct(frame)
  assert.equal(getPref('split.test', null), null)
  assert.equal(rootStyle('--test-w'), '204px', 'the default (256) clamped')
  assert.equal(el.getAttribute('aria-valuenow'), '204')
})
