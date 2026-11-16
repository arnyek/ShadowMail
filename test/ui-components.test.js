// The ui/ components: each one renders, takes the focus, honours disabled; the
// Menu (and MenuButton/Select built on it) works from the keyboard: arrows, Home/End, Enter, Esc.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct, key } from './helpers/react-dom-env.js'

setupDom()
const { createElement: h, useState } = await import('react')
const ui = await import('../app/renderer/src/ui/index.js')
const { Button, IconButton, Chip, ChipSelect, ChipPanel, ChipMenu, TextField, SearchField, Checkbox, Menu, MenuButton, Select, Modal, Banner, Avatar, initials, avatarColor } = ui

const click = el => inAct(() => el.click())
const press = (el, k) => inAct(() => key(el, k))

test('Button: text is the name, variants, focus, disabled', async t => {
  let n = 0
  const v = await mount(h('div', null, h(Button, { variant: 'primary', icon: 'send', onClick: () => n++ }, 'Küldés'), h(Button, { disabled: true, onClick: () => n++ }, 'Tiltott')))
  t.after(v.unmount)
  const [ok, off] = v.container.querySelectorAll('button')
  assert.equal(ok.getAttribute('type'), 'button')
  assert.match(ok.className, /\bbtn\b.*\bbtn-primary\b/)
  assert.equal(ok.textContent, 'Küldés')
  assert.ok(ok.querySelector('svg.icon[aria-hidden="true"]'), 'decorative icon')
  ok.focus()
  assert.equal(document.activeElement, ok)
  await click(ok)
  await click(off)
  assert.equal(n, 1, 'the disabled one does not fire')
  assert.equal(off.disabled, true)
})

test('IconButton: aria-label and title from the label, required, pressed state, disabled', async t => {
  let n = 0
  const v = await mount(h('div', null, h(IconButton, { icon: 'refresh', label: 'Frissítés', onClick: () => n++ }), h(IconButton, { icon: 'star', label: 'Csillag', pressed: true, disabled: true, onClick: () => n++ })))
  t.after(v.unmount)
  const [a, b] = v.container.querySelectorAll('button.icon-btn')
  assert.equal(a.getAttribute('aria-label'), 'Frissítés')
  assert.equal(a.getAttribute('title'), 'Frissítés')
  assert.equal(a.textContent, '', 'icon only')
  assert.equal(a.hasAttribute('aria-pressed'), false)
  assert.equal(b.getAttribute('aria-pressed'), 'true')
  a.focus()
  assert.equal(document.activeElement, a)
  await click(a)
  await click(b)
  assert.equal(n, 1)
  assert.throws(() => IconButton({ icon: 'close' }), /needs a label/)
})

test('Chip: aria-pressed, check mark when active, drop-down arrow, disabled', async t => {
  const v = await mount(h('div', null, h(Chip, { active: true }, 'Olvasatlan'), h(Chip, { menu: true, disabled: true }, 'Feladó')))
  t.after(v.unmount)
  const [on, off] = v.container.querySelectorAll('button.chip')
  assert.equal(on.getAttribute('aria-pressed'), 'true')
  assert.ok(on.querySelector('[data-icon="check"]'))
  assert.equal(off.getAttribute('aria-pressed'), 'false')
  assert.ok(off.querySelector('[data-icon="chevronDown"]'))
  assert.equal(off.disabled, true)
  on.focus()
  assert.equal(document.activeElement, on)
})

test('TextField: the label names the input, keeps id, error is an alert, disabled', async t => {
  const v = await mount(h('div', null, h(TextField, { label: 'Mesterjelszó', id: 'vault-unlock', type: 'password', error: 'Hibás jelszó.' }), h(TextField, { label: 'Tiltott', disabled: true })))
  t.after(v.unmount)
  const input = v.container.querySelector('#vault-unlock')
  assert.equal(input.closest('label').querySelector('.text-field-label').textContent, 'Mesterjelszó')
  assert.equal(input.getAttribute('aria-invalid'), 'true')
  assert.equal(v.container.querySelector('[role="alert"]').textContent, 'Hibás jelszó.')
  input.focus()
  assert.equal(document.activeElement, input)
  assert.equal(v.container.querySelectorAll('input')[1].disabled, true)
})

test('SearchField: a searchbox with a name, the clear button only with text', async t => {
  let cleared = 0
  function Box({ initial }) {
    const [value, setValue] = useState(initial)
    return h(SearchField, { label: 'Keresés', clearLabel: 'Keresés törlése', value, onChange: e => setValue(e.target.value), onClear: () => (cleared++, setValue('')) })
  }
  const v = await mount(h(Box, { initial: 'kazán' }))
  t.after(v.unmount)
  const input = v.container.querySelector('input')
  assert.equal(input.type, 'search')
  assert.equal(input.getAttribute('aria-label'), 'Keresés')
  const clear = v.container.querySelector('button[aria-label="Keresés törlése"]')
  assert.ok(clear)
  await click(clear)
  assert.equal(cleared, 1)
  assert.equal(input.value, '')
  assert.equal(v.container.querySelector('button'), null, 'no clear button when empty')
  input.focus()
  assert.equal(document.activeElement, input)
})

test('Checkbox: a real (hidden) input, label, focusable, indeterminate, disabled', async t => {
  let changes = 0
  const v = await mount(h('div', null, h(Checkbox, { label: 'Mind kijelölése', hideLabel: true, indeterminate: true, checked: false, onChange: () => changes++ }), h(Checkbox, { label: 'Tiltott', disabled: true })))
  t.after(v.unmount)
  const [box, off] = v.container.querySelectorAll('input[type="checkbox"]')
  assert.equal(box.indeterminate, true)
  assert.equal(box.closest('label').querySelector('.sr-only').textContent, 'Mind kijelölése')
  assert.ok(box.closest('label').querySelector('[data-icon="minus"]'))
  box.focus()
  assert.equal(document.activeElement, box)
  await click(box)
  assert.equal(changes, 1)
  assert.equal(off.disabled, true)
})

test('Menu: focus on the first item, arrows wrap and skip disabled, Home/End, Enter selects, Esc closes', async t => {
  const picked = []
  const closed = []
  const items = [
    { key: 'a', label: 'Olvasott', icon: 'markRead', onSelect: () => picked.push('a') },
    { key: 'b', label: 'Tiltott', disabled: true, onSelect: () => picked.push('b') },
    { separator: true },
    { key: 'c', label: 'Törlés', danger: true, onSelect: () => picked.push('c') },
  ]
  const v = await mount(h(Menu, { items, label: 'Műveletek', onClose: r => closed.push(r) }))
  t.after(v.unmount)
  const menu = v.container.querySelector('[role="menu"]')
  assert.equal(menu.getAttribute('aria-label'), 'Műveletek')
  const focused = () => document.activeElement.dataset.key
  assert.equal(focused(), 'a')
  await press(document.activeElement, 'ArrowDown')
  assert.equal(focused(), 'c', 'disabled item skipped')
  await press(document.activeElement, 'ArrowDown')
  assert.equal(focused(), 'a', 'wraps')
  await press(document.activeElement, 'ArrowUp')
  assert.equal(focused(), 'c')
  await press(document.activeElement, 'Home')
  assert.equal(focused(), 'a')
  await press(document.activeElement, 'End')
  assert.equal(focused(), 'c')
  // Enter on a <button> activates it (the browser turns it into a click)
  await click(document.activeElement)
  assert.deepEqual(picked, ['c'])
  assert.deepEqual(closed, ['select'])
  await press(menu.querySelector('[data-key="a"]'), 'Escape')
  assert.deepEqual(closed, ['select', 'escape'])
  assert.equal(menu.querySelector('[data-key="b"]').disabled, true)
  assert.equal(menu.querySelectorAll('[role="separator"]').length, 1)
})

test('MenuButton: opens with click and ArrowDown, Esc closes and gives the focus back', async t => {
  let moved = null
  const items = [
    { key: 'INBOX', label: 'Beérkezett', onSelect: () => (moved = 'INBOX') },
    { key: 'Archive', label: 'Archívum', onSelect: () => (moved = 'Archive') },
  ]
  const v = await mount(h(MenuButton, { icon: 'move', label: 'Áthelyezés', items }))
  t.after(v.unmount)
  const trigger = v.container.querySelector('button.icon-btn')
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu')
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
  await click(trigger)
  assert.equal(trigger.getAttribute('aria-expanded'), 'true')
  assert.equal(document.activeElement.dataset.key, 'INBOX')
  await press(document.activeElement, 'Escape')
  assert.equal(v.container.querySelector('[role="menu"]'), null)
  assert.equal(document.activeElement, trigger, 'focus back on the button')
  await press(trigger, 'ArrowDown')
  assert.ok(v.container.querySelector('[role="menu"]'))
  await press(document.activeElement, 'ArrowDown')
  await click(document.activeElement)
  assert.equal(moved, 'Archive')
  assert.equal(v.container.querySelector('[role="menu"]'), null)
  assert.equal(document.activeElement, trigger)
})

test('MenuButton with text, disabled', async t => {
  const v = await mount(h(MenuButton, { text: 'Feladó', label: 'Feladó', items: [], disabled: true }))
  t.after(v.unmount)
  const b = v.container.querySelector('button')
  assert.equal(b.disabled, true)
  assert.ok(b.textContent.includes('Feladó'))
})

test('Select: replaces <select>; radio items, the current one checked and focused, keyboard choice', async t => {
  function Pick() {
    const [value, setValue] = useState('all')
    return h(Select, {
      label: 'Fiók',
      value,
      onChange: setValue,
      options: [
        { value: 'all', label: 'Minden fiók' },
        { value: 'a1', label: 'IMAP-fiók' },
        { value: 'a2', label: 'POP3-fiók' },
      ],
    })
  }
  const v = await mount(h(Pick))
  t.after(v.unmount)
  assert.equal(v.container.querySelector('select'), null)
  const trigger = v.container.querySelector('button.select-trigger')
  assert.equal(trigger.getAttribute('aria-label'), 'Fiók')
  assert.equal(trigger.textContent, 'Minden fiók')
  await press(trigger, 'ArrowDown')
  const radios = v.container.querySelectorAll('[role="menuitemradio"]')
  assert.equal(radios.length, 3)
  assert.equal(radios[0].getAttribute('aria-checked'), 'true')
  assert.equal(document.activeElement, radios[0])
  await press(document.activeElement, 'End')
  await click(document.activeElement)
  assert.equal(trigger.textContent, 'POP3-fiók')
  assert.equal(document.activeElement, trigger)
  await click(trigger)
  assert.equal(document.activeElement.textContent, 'POP3-fiók', 'opens on the current value')
  await press(document.activeElement, 'Escape')
  assert.equal(trigger.textContent, 'POP3-fiók', 'Esc changes nothing')
})

test('Select disabled does not open', async t => {
  const v = await mount(h(Select, { label: 'Fiók', value: 'x', onChange: () => {}, options: [{ value: 'x', label: 'X' }], disabled: true }))
  t.after(v.unmount)
  const trigger = v.container.querySelector('button')
  assert.equal(trigger.disabled, true)
  await click(trigger)
  assert.equal(v.container.querySelector('[role="menu"]'), null)
})

test('Modal: labelled dialog, autofocus, Tab stays inside, Esc closes, focus returns', async t => {
  const opener = document.createElement('button')
  document.body.appendChild(opener)
  opener.focus()
  let closed = 0
  const v = await mount(
    h(Modal, {
      title: 'Törlés',
      role: 'alertdialog',
      onClose: () => closed++,
      actions: [h(Button, { key: 'n' }, 'Mégse'), h(Button, { key: 'y', variant: 'danger', 'data-autofocus': true }, 'Törlés'), h(Button, { key: 'd', disabled: true }, 'Tiltott')],
    }, h('p', null, 'Biztos?')),
  )
  t.after(() => opener.remove())
  const dialog = v.container.querySelector('[role="alertdialog"]')
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
  assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Törlés')
  assert.equal(document.activeElement.textContent, 'Törlés', 'data-autofocus wins')
  await press(document.activeElement, 'Tab')
  assert.equal(document.activeElement.textContent, 'Mégse', 'Tab wraps to the first (the disabled one is skipped)')
  await inAct(() => key(document.activeElement, 'Tab', { shiftKey: true }))
  assert.equal(document.activeElement.textContent, 'Törlés', 'Shift+Tab wraps to the last')
  await press(document.activeElement, 'Escape')
  assert.equal(closed, 1)
  await v.unmount()
  assert.equal(document.activeElement, opener, 'focus back')
})

test('Modal with onSubmit is a form', async t => {
  let submitted = 0
  const v = await mount(h(Modal, { title: 'Új mappa', onSubmit: () => submitted++, actions: h(Button, { type: 'submit', variant: 'primary' }, 'Létrehozás') }, h(TextField, { label: 'Név' })))
  t.after(v.unmount)
  const form = v.container.querySelector('form[role="dialog"]')
  assert.ok(form)
  assert.equal(document.activeElement, form.querySelector('input'), 'first focusable')
  await inAct(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(submitted, 1)
})

test('Banner: kind sets role and icon, close button needs a label', async t => {
  let closed = 0
  const v = await mount(h('div', null, h(Banner, { kind: 'warning', onClose: () => closed++, closeLabel: 'Bezárás', actions: h(Button, null, 'Beállítások') }, 'Figyelem'), h(Banner, { kind: 'error' }, 'Hiba')))
  t.after(v.unmount)
  const [warn, err] = v.container.querySelectorAll('.banner')
  assert.equal(warn.getAttribute('role'), 'status')
  assert.ok(warn.querySelector('[data-icon="warning"]'))
  assert.equal(err.getAttribute('role'), 'alert')
  const close = warn.querySelector('button[aria-label="Bezárás"]')
  close.focus()
  assert.equal(document.activeElement, close)
  await click(close)
  assert.equal(closed, 1)
  assert.throws(() => Banner({ onClose: () => {} }), /closeLabel/)
})

test('Avatar: initials, stable color slot, decorative', async t => {
  assert.equal(initials('Kovács Anna', 'anna@example.invalid'), 'KA')
  assert.equal(initials('Ödön', 'x@example.invalid'), 'Ö')
  assert.equal(initials('"Nagy Péter" <np@example.invalid>', ''), 'NP')
  assert.equal(initials('', 'bence@example.invalid'), 'B')
  assert.equal(initials('', ''), '?')
  const c = avatarColor('anna@example.invalid')
  assert.ok(c >= 1 && c <= 8)
  assert.equal(avatarColor('ANNA@example.invalid'), c, 'case-insensitive')
  const slots = new Set(Array.from({ length: 200 }, (_, i) => avatarColor(`user${i}@example.invalid`)))
  assert.equal(slots.size, 8, 'all eight colors are used')
  const v = await mount(h(Avatar, { name: 'Kovács Anna', address: 'anna@example.invalid' }))
  t.after(v.unmount)
  const el = v.container.querySelector('.avatar')
  assert.equal(el.getAttribute('aria-hidden'), 'true')
  assert.equal(el.textContent, 'KA')
  assert.ok(el.classList.contains(`avatar-c${c}`))
})

test('ChipSelect: label when nothing chosen, the value with a check mark when active, menu by keyboard', async t => {
  function Pick() {
    const [value, setValue] = useState(null)
    return h(ChipSelect, { label: 'Fiók', value, onChange: setValue, options: [{ value: null, label: 'Minden fiók' }, { value: 1, label: 'IMAP-fiók' }, { value: 2, label: 'POP3-fiók' }] })
  }
  const v = await mount(h(Pick))
  t.after(v.unmount)
  const chip = v.container.querySelector('button.chip')
  assert.equal(chip.textContent, 'Fiók')
  assert.equal(chip.getAttribute('aria-pressed'), 'false')
  assert.equal(chip.getAttribute('aria-haspopup'), 'menu')
  await press(chip, 'ArrowDown')
  assert.equal(v.container.querySelector('[role="menu"]').getAttribute('aria-label'), 'Fiók')
  assert.equal(document.activeElement.textContent, 'Minden fiók')
  await press(document.activeElement, 'End')
  await click(document.activeElement)
  assert.equal(chip.getAttribute('aria-pressed'), 'true')
  assert.equal(chip.textContent, 'Fiók: POP3-fiók', 'the accessible name starts with the label')
  assert.equal(chip.querySelector('.sr-only').textContent, 'Fiók: ')
  assert.ok(chip.querySelector('[data-icon="check"]'))
  assert.equal(document.activeElement, chip)
  await click(chip)
  await press(document.activeElement, 'Escape')
  assert.equal(v.container.querySelector('[role="menu"]'), null)
  assert.equal(chip.textContent, 'Fiók: POP3-fiók')
})

test('ChipSelect showValue: "label: value" also for the first option, never active', async t => {
  const v = await mount(h(ChipSelect, { label: 'Rendezés', value: 'relevance', showValue: true, onChange: () => {}, options: [{ value: 'relevance', label: 'Relevancia' }, { value: 'date', label: 'Dátum' }] }))
  t.after(v.unmount)
  const chip = v.container.querySelector('button.chip')
  assert.equal(chip.textContent, 'Rendezés: Relevancia')
  assert.equal(chip.getAttribute('aria-pressed'), 'false')
})

test('ChipPanel: opens a labelled panel, focus on the first field, Esc and an outside click close it', async t => {
  const v = await mount(h(ChipPanel, { label: 'Feladó', active: true, value: 'anna' }, h(TextField, { label: 'Feladó' }), h(TextField, { label: 'Címzett' })))
  t.after(v.unmount)
  const chip = v.container.querySelector('button.chip')
  assert.equal(chip.textContent, 'Feladó: anna')
  assert.equal(chip.getAttribute('aria-pressed'), 'true')
  assert.equal(chip.getAttribute('aria-haspopup'), 'dialog')
  await click(chip)
  const panel = v.container.querySelector('[role="dialog"]')
  assert.equal(panel.getAttribute('aria-label'), 'Feladó')
  assert.equal(chip.getAttribute('aria-expanded'), 'true')
  assert.equal(document.activeElement, panel.querySelector('input'))
  await press(document.activeElement, 'Escape')
  assert.equal(v.container.querySelector('[role="dialog"]'), null)
  assert.equal(document.activeElement, chip)
  await click(chip)
  assert.ok(v.container.querySelector('[role="dialog"]'))
  await inAct(() => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })))
  assert.equal(v.container.querySelector('[role="dialog"]'), null, 'an outside click closes it')
})

test('a second click on the trigger closes the menu; aria-controls names the menu', async t => {
  const items = [{ key: 'a', label: 'A', onSelect: () => {} }]
  const pick = h(Select, { label: 'Fiók', value: 'x', onChange: () => {}, options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] })
  const chip = h(ChipSelect, { label: 'Fiók', value: null, onChange: () => {}, options: [{ value: null, label: 'Minden' }, { value: 1, label: 'Egy' }] })
  const v = await mount(h('div', null, h(MenuButton, { icon: 'more', label: 'További', items }), pick, chip))
  t.after(v.unmount)
  // a real click: pointerdown first (the menu's outside check runs on it), then click
  const realClick = el =>
    inAct(() => {
      el.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
      el.click()
    })
  for (const sel of ['button.icon-btn', 'button.select-trigger', 'button.chip']) {
    const trigger = v.container.querySelector(sel)
    await realClick(trigger)
    assert.equal(trigger.getAttribute('aria-expanded'), 'true', `${sel}: opens`)
    if (sel === 'button.icon-btn') {
      const menu = v.container.querySelector('[role="menu"]')
      assert.ok(menu.id && trigger.getAttribute('aria-controls') === menu.id, 'aria-controls points at the menu')
    }
    await realClick(trigger)
    assert.equal(trigger.getAttribute('aria-expanded'), 'false', `${sel}: the second click closes`)
    assert.equal(v.container.querySelector('[role="menu"]'), null)
  }
})

test('ChipMenu (0.10.1): its own items with checks, by click and by keyboard; a pick closes it, the focus back on the chip', async t => {
  function Order() {
    const [sort, setSort] = useState('date')
    const items = ['date', 'from'].map(k => ({ key: k, label: k === 'date' ? 'Dátum' : 'Feladó', checked: sort === k, onSelect: () => setSort(k) }))
    return h(ChipMenu, { label: 'Rendezés', text: `Rendezés: ${sort === 'date' ? 'Dátum' : 'Feladó'}`, items: [...items, { separator: true }, { key: 'rev', label: 'Fordított', checked: false, onSelect: () => {} }] })
  }
  const v = await mount(h(Order))
  t.after(v.unmount)
  const chip = v.container.querySelector('button.chip')
  assert.equal(chip.textContent, 'Rendezés: Dátum')
  assert.equal(chip.getAttribute('aria-haspopup'), 'menu')
  assert.equal(chip.getAttribute('aria-disabled'), null, 'no disabled chips any more (0.10.1)')
  await press(chip, 'ArrowDown')
  const menu = v.container.querySelector('[role="menu"]')
  assert.equal(menu.getAttribute('aria-label'), 'Rendezés')
  assert.equal(menu.querySelectorAll('[role="menuitemradio"]').length, 3)
  assert.equal(document.activeElement.textContent, 'Dátum', 'the checked item has the focus')
  await press(document.activeElement, 'ArrowDown')
  await click(document.activeElement)
  assert.equal(v.container.querySelector('[role="menu"]'), null)
  assert.equal(chip.textContent, 'Rendezés: Feladó')
  assert.equal(document.activeElement, chip)
  await click(chip)
  assert.equal(chip.getAttribute('aria-expanded'), 'true')
})
