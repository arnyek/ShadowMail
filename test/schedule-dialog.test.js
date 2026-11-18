// "Küldés később": the composer's dialog (Composer.jsx ScheduleDialog) in jsdom, local time Europe/Budapest: the quick
// choices of the moment, the custom date and time, a day that does not exist, the note, Mégse.
process.env.TZ = 'Europe/Budapest'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'

setupDom()
window.shadowMail = { compose: {}, language: 'hu' }
const { createElement: h } = await import('react')
const { ScheduleDialog } = await import('../app/renderer/src/Composer.jsx')
const { hu } = await import('../app/renderer/i18n/hu.js')
const ts = hu.schedule

const WED_9 = new Date(2026, 10, 18, 9).getTime()
const modal = () => document.querySelector('.compose-schedule-modal')
const choices = () => [...document.querySelectorAll('.compose-schedule-choice')].map(l => [l.dataset.choice, l.textContent])
const click = el => inAct(async () => el.click())
const setValue = (el, v) =>
  inAct(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(el, v)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  })

test('the quick choices of the moment, the first chosen; the note; Időzítés gives that time', async t => {
  const picked = []
  const v = await mount(h(ScheduleDialog, { now: WED_9, onPick: at => picked.push(at), onCancel: () => picked.push('cancel') }))
  t.after(v.unmount)
  assert.ok(modal())
  assert.deepEqual(choices(), [['today18', ts.today18], ['tomorrow8', ts.tomorrow8], ['monday8', ts.monday8], ['custom', ts.custom]])
  assert.equal(document.querySelector('.compose-schedule-note').textContent, ts.note)
  assert.equal(document.querySelector('input[value="today18"]').checked, true)
  await click(document.querySelector('.compose-schedule-ok'))
  assert.deepEqual(picked, [new Date(2026, 10, 18, 18).getTime()])
  await click(document.querySelector('input[value="monday8"]'))
  await click(document.querySelector('.compose-schedule-ok'))
  assert.equal(picked[1], new Date(2026, 10, 23, 8).getTime())
})

test('a custom date and time; a day that does not exist is refused in the dialog; Mégse picks nothing', async t => {
  const picked = []
  const v = await mount(h(ScheduleDialog, { now: WED_9, onPick: at => picked.push(at), onCancel: () => picked.push('cancel') }))
  t.after(v.unmount)
  assert.equal(document.querySelector('.compose-schedule-date'), null, 'no date field until custom is chosen')
  await click(document.querySelector('input[value="custom"]'))
  assert.equal(document.querySelector('.compose-schedule-date').value, '2026-11-19')
  assert.equal(document.querySelector('.compose-schedule-time').value, '08:00')
  await setValue(document.querySelector('.compose-schedule-date'), '2026-12-24')
  await setValue(document.querySelector('.compose-schedule-time'), '07:45')
  await click(document.querySelector('.compose-schedule-ok'))
  assert.deepEqual(picked, [new Date(2026, 11, 24, 7, 45).getTime()])
  await setValue(document.querySelector('.compose-schedule-date'), '2026-11-31')
  await click(document.querySelector('.compose-schedule-ok'))
  assert.equal(picked.length, 1, 'not picked')
  assert.equal(document.querySelector('.compose-schedule-modal [role="alert"]').textContent, ts.badTime)
  await click([...modal().querySelectorAll('button')].find(b => b.textContent === ts.cancel))
  assert.deepEqual(picked.slice(1), ['cancel'])
})

test('in the evening after 18:00 there is no "today" choice', async t => {
  const v = await mount(h(ScheduleDialog, { now: new Date(2026, 10, 18, 19).getTime(), onPick: () => {}, onCancel: () => {} }))
  t.after(v.unmount)
  assert.deepEqual(choices().map(c => c[0]), ['tomorrow8', 'monday8', 'custom'])
  assert.equal(document.querySelector('input[value="tomorrow8"]').checked, true)
})
