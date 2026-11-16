// The header's reader-pane switch: one click to the next layout (none -> right -> bottom -> none), the icon is the
// layout on now, the name says what is on and what the click gives; a stored value is checked; the three own glyphs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'

setupDom()
const { createElement: h, useState } = await import('react')
const { ReaderPaneButton, READER_PANES, readerPaneOf, nextReaderPane } = await import('../app/renderer/src/ReaderPaneButton.jsx')
const { Icon, ICONS } = await import('../app/renderer/src/Icon.jsx')
const { hu } = await import('../app/renderer/i18n/hu.js')

test('a stored value: the three layouts as they are, anything else is the default', () => {
  assert.deepEqual(READER_PANES, ['none', 'right', 'bottom'])
  for (const v of READER_PANES) assert.equal(readerPaneOf(v), v)
  for (const v of [undefined, null, '', 'left', 'NONE', 1, {}, ['right']]) assert.equal(readerPaneOf(v), 'none', String(v))
})

test('one click is the next layout, three clicks are the start', () => {
  assert.equal(nextReaderPane('none'), 'right')
  assert.equal(nextReaderPane('right'), 'bottom')
  assert.equal(nextReaderPane('bottom'), 'none')
  assert.equal(nextReaderPane('garbage'), 'right') // a damaged value counts as 'none'
})

test('the button: icon of the layout on now, the name with now and next, a click steps, three clicks go round', async t => {
  const seen = []
  function Host() {
    const [v, setV] = useState('none')
    return h(ReaderPaneButton, {
      value: v,
      onChange: n => {
        seen.push(n)
        setV(n)
      },
    })
  }
  const v = await mount(h(Host))
  t.after(v.unmount)
  const btn = () => v.container.querySelector('button.reader-pane-switch')
  const expect = [
    ['none', 'right', 'layout-none', 'Elrendezés: olvasópanel nélkül. Kattintásra: olvasópanel jobbra'],
    ['right', 'bottom', 'layout-right', 'Elrendezés: olvasópanel jobbra. Kattintásra: olvasópanel alul'],
    ['bottom', 'none', 'layout-bottom', 'Elrendezés: olvasópanel alul. Kattintásra: olvasópanel nélkül'],
    ['none', 'right', 'layout-none', 'Elrendezés: olvasópanel nélkül. Kattintásra: olvasópanel jobbra'],
  ]
  for (const [i, [now, next, glyph, name]] of expect.entries()) {
    const b = btn()
    assert.equal(b.getAttribute('data-pane'), now, `step ${i}`)
    assert.equal(b.getAttribute('aria-label'), name, `step ${i}`)
    assert.equal(b.getAttribute('title'), name, `step ${i}: the tooltip is the name`)
    assert.equal(b.getAttribute('aria-label'), hu.readerPaneButton(now, next))
    assert.equal(b.type, 'button') // a native button: Tab reaches it, Enter and Space press it
    assert.ok(b.querySelector(`svg.own-${glyph}`), `step ${i}: the ${glyph} glyph`)
    if (i < 3) await inAct(() => b.click())
  }
  assert.deepEqual(seen, ['right', 'bottom', 'none'])
})

test('the three own glyphs: Lucide grid and attributes, decorative, each one different', async t => {
  const names = ['layoutNone', 'layoutRight', 'layoutBottom']
  for (const n of names) assert.ok(ICONS[n], n)
  const v = await mount(h('div', null, names.map(n => h(Icon, { key: n, name: n, size: 'm' }))))
  t.after(v.unmount)
  const svgs = [...v.container.querySelectorAll('svg')]
  assert.equal(svgs.length, 3)
  for (const svg of svgs) {
    assert.equal(svg.getAttribute('viewBox'), '0 0 24 24')
    assert.equal(svg.getAttribute('stroke'), 'currentColor')
    assert.equal(svg.getAttribute('stroke-width'), '2')
    assert.equal(svg.getAttribute('fill'), 'none')
    assert.ok(svg.classList.contains('icon') && svg.classList.contains('icon-m'))
    assert.equal(svg.getAttribute('aria-hidden'), 'true')
    assert.ok(svg.querySelector('rect') && svg.querySelector('path'))
  }
  assert.equal(new Set(svgs.map(s => s.innerHTML)).size, 3)
  const w = await mount(h(Icon, { name: 'layoutRight', label: 'Jobbra' }))
  t.after(w.unmount)
  assert.equal(w.container.querySelector('svg').getAttribute('role'), 'img')
  assert.equal(w.container.querySelector('svg').getAttribute('aria-label'), 'Jobbra')
})
