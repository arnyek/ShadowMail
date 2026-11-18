// "Küldés később", the "Időzített" view (Scheduled.jsx) in jsdom, local time Europe/Budapest: the rows and their
// states, the actions and what they call, an interrupted row asks before Küldés most, a row open in a composer or
// being sent offers only what it may, the time picker as "Időpont módosítása", the list reloads on the main process's
// event, and the main window's sidebar entry (only while there are rows) opens the view.
process.env.TZ = 'Europe/Budapest'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'

setupDom()
const calls = []
let statusListeners = []
let listRows = []
let answer = { ok: true }
window.shadowMail = {
  language: 'hu',
  onStatus: fn => {
    statusListeners.push(fn)
    return () => (statusListeners = statusListeners.filter(f => f !== fn))
  },
  compose: { open: async req => (calls.push(['compose.open', req]), answer) },
  scheduled: {
    list: async () => (calls.push(['list']), { ok: true, rows: listRows }),
    reschedule: async (id, at) => (calls.push(['reschedule', id, at]), answer),
    sendNow: async id => (calls.push(['sendNow', id]), answer),
    cancel: async id => (calls.push(['cancel', id]), answer),
  },
}
const { createElement: h } = await import('react')
const { ScheduledList, useScheduledRows, stateText } = await import('../app/renderer/src/Scheduled.jsx')
const { hu } = await import('../app/renderer/i18n/hu.js')
const ts = hu.scheduledList

const AT = new Date(2026, 10, 20, 8).getTime()
const NOW = new Date(2026, 10, 18, 9).getTime()
const row = (over = {}) => ({ id: 1, accountId: 1, accountName: 'Munka', accountEmail: 'sajat@example.invalid', sendAt: AT, state: 'waiting', attempts: 0, nextTryAt: null, lastError: null, subject: 'Ajánlat', recipients: 'anna@example.invalid', claude: false, held: false, ...over })
const click = el => inAct(async () => el.click())
const q = (sel, root = document) => root.querySelector(sel)
const rowEl = id => q(`.scheduled-row[data-id="${id}"]`)
const flush = () => inAct(async () => new Promise(r => setTimeout(r, 0)))

function listOf(rows, extra = {}) {
  const notices = []
  const errors = []
  return { notices, errors, el: h(ScheduledList, { rows, onNotice: n => notices.push(n), onError: e => e && errors.push(e), now: () => NOW, ...extra }) }
}

test('the rows: time, subject, recipients, account and state; the Claude mark; an empty list says so', async t => {
  const rows = [
    row({ id: 1 }),
    row({ id: 2, subject: '', recipients: '', state: 'failed', lastError: 'interrupted' }),
    row({ id: 3, state: 'late', claude: true }),
    row({ id: 4, state: 'failed', lastError: 'auth_failed' }),
    row({ id: 5, attempts: 1, nextTryAt: new Date(2026, 10, 20, 8, 1).getTime(), lastError: 'timeout' }),
    row({ id: 6, held: true }),
    row({ id: 7, state: 'sending' }),
    row({ id: 8, state: 'failed', lastError: 'uncertain' }),
  ]
  const { el } = listOf(rows)
  const v = await mount(el)
  t.after(v.unmount)
  assert.equal(q('.page-title').textContent, ts.title)
  const r1 = rowEl(1)
  assert.equal(r1.dataset.state, 'waiting')
  assert.match(q('.scheduled-when', r1).textContent, /2026\. nov\. 20\..*8:00/)
  assert.equal(q('.scheduled-subject', r1).textContent, 'Ajánlat')
  assert.equal(q('.scheduled-recipients', r1).textContent, 'anna@example.invalid')
  assert.equal(q('.scheduled-account', r1).textContent, 'Munka')
  assert.equal(q('.scheduled-state', r1).textContent, ts.states.waiting)
  assert.equal(rowEl(2).dataset.state, 'interrupted')
  assert.equal(q('.scheduled-subject', rowEl(2)).textContent, ts.noSubject)
  assert.equal(q('.scheduled-recipients', rowEl(2)).textContent, ts.noRecipients)
  assert.equal(q('.scheduled-state', rowEl(2)).textContent, ts.states.interrupted)
  assert.equal(q('.scheduled-state', rowEl(3)).textContent, ts.states.late)
  assert.ok(q('.claude-mark', rowEl(3)))
  assert.ok(!q('.claude-mark', r1))
  assert.equal(q('.scheduled-state', rowEl(4)).textContent, ts.failed('auth_failed'))
  assert.ok(q('.scheduled-state', rowEl(4)).classList.contains('warn'))
  assert.match(q('.scheduled-state', rowEl(5)).textContent, /^Újrapróbálás: .*8:01 \(/)
  assert.equal(rowEl(6).dataset.state, 'held')
  assert.equal(q('.scheduled-state', rowEl(6)).textContent, ts.states.held)
  assert.equal(q('.scheduled-state', rowEl(7)).textContent, ts.states.sending)
  assert.equal(rowEl(8).dataset.state, 'uncertain')
  assert.equal(q('.scheduled-state', rowEl(8)).textContent, ts.states.uncertain)
  await v.rerender(listOf([]).el)
  assert.equal(q('.scheduled-empty').textContent, ts.empty)
  assert.equal(stateText(row({ state: 'failed', lastError: 'no_such_code' })), ts.failed('no_such_code'))
})

test('a held row can only be opened (its window comes forward); a sending row nothing; the others everything', async t => {
  const { el } = listOf([row({ id: 1 }), row({ id: 6, held: true }), row({ id: 7, state: 'sending' })])
  const v = await mount(el)
  t.after(v.unmount)
  const enabled = id => ['.scheduled-open', '.scheduled-reschedule', '.scheduled-send-now', '.scheduled-cancel'].map(s => !q(s, rowEl(id)).disabled)
  assert.deepEqual(enabled(1), [true, true, true, true])
  assert.deepEqual(enabled(6), [true, false, false, false])
  assert.deepEqual(enabled(7), [false, false, false, false])
  assert.equal(q('.scheduled-actions', rowEl(1)).getAttribute('aria-label'), ts.actionsOf('Ajánlat'))
})

test('Megnyitás, Küldés most, Időzítés törlése call the main process; a refusal shows its text; a cancel says where the message went', async t => {
  calls.length = 0
  answer = { ok: true }
  const { el, notices, errors } = listOf([row({ id: 1 })])
  const v = await mount(el)
  t.after(v.unmount)
  await click(q('.scheduled-open', rowEl(1)))
  await click(q('.scheduled-send-now', rowEl(1)))
  await click(q('.scheduled-cancel', rowEl(1)))
  assert.deepEqual(calls, [['compose.open', { mode: 'scheduled', scheduledId: 1 }], ['sendNow', 1], ['cancel', 1]])
  assert.deepEqual(notices, [ts.cancelled('Ajánlat')])
  answer = { ok: false, error: 'scheduled_open' }
  await click(q('.scheduled-send-now', rowEl(1)))
  answer = { ok: false, error: 'too_soon' }
  await click(q('.scheduled-cancel', rowEl(1)))
  assert.deepEqual(errors, [ts.errors.scheduled_open, hu.composeErrors.too_soon])
  answer = { ok: true }
})

test('Küldés most on an uncertain row (no answer after the data) asks first too', async t => {
  calls.length = 0
  const { el } = listOf([row({ id: 8, state: 'failed', lastError: 'uncertain' })])
  const v = await mount(el)
  t.after(v.unmount)
  await click(q('.scheduled-send-now', rowEl(8)))
  assert.ok(q('.scheduled-interrupted-modal'))
  assert.deepEqual(calls, [])
  await click(q('.scheduled-interrupted-yes'))
  assert.deepEqual(calls, [['sendNow', 8]])
})

test('Küldés most on an interrupted row asks first; Mégse sends nothing, the yes sends', async t => {
  calls.length = 0
  const { el } = listOf([row({ id: 2, state: 'failed', lastError: 'interrupted' })])
  const v = await mount(el)
  t.after(v.unmount)
  await click(q('.scheduled-send-now', rowEl(2)))
  const modal = q('.scheduled-interrupted-modal')
  assert.ok(modal)
  assert.equal(modal.getAttribute('role'), 'alertdialog')
  assert.ok(modal.textContent.includes(ts.interruptedText))
  assert.equal(document.activeElement.textContent, ts.interruptedNo, 'the focus on Mégse')
  await click(document.activeElement)
  assert.equal(q('.scheduled-interrupted-modal'), null)
  assert.deepEqual(calls, [])
  await click(q('.scheduled-send-now', rowEl(2)))
  await click(q('.scheduled-interrupted-yes'))
  assert.deepEqual(calls, [['sendNow', 2]])
})

test('Időpont módosítása: the time picker with its own title and button; the chosen time goes to the main process', async t => {
  calls.length = 0
  const { el } = listOf([row({ id: 1 })])
  const v = await mount(el)
  t.after(v.unmount)
  await click(q('.scheduled-reschedule', rowEl(1)))
  const modal = q('.scheduled-move-modal')
  assert.ok(modal)
  assert.ok(modal.textContent.includes(ts.reschedule))
  assert.equal(q('.compose-schedule-ok', modal).textContent, ts.rescheduleOk)
  await inAct(async () => q('form', modal) ? q('form', modal).requestSubmit() : q('.compose-schedule-ok', modal).click())
  assert.equal(q('.scheduled-move-modal'), null)
  assert.deepEqual(calls, [['reschedule', 1, new Date(2026, 10, 18, 18).getTime()]], 'today 18:00, the first quick choice')
})

test('useScheduledRows: loads at mount and again on the main process\'s list event (and a scheduled notice)', async t => {
  calls.length = 0
  listRows = [row({ id: 1 })]
  let seen = null
  const Probe = () => {
    seen = useScheduledRows()
    return null
  }
  const v = await mount(h(Probe))
  t.after(v.unmount)
  await flush()
  assert.deepEqual(seen.map(r => r.id), [1])
  listRows = [row({ id: 1 }), row({ id: 2 })]
  await inAct(async () => statusListeners.forEach(f => f({ kind: 'mail' })))
  await flush()
  assert.equal(seen.length, 1, 'another event: no reload')
  await inAct(async () => statusListeners.forEach(f => f({ kind: 'scheduledList' })))
  await flush()
  assert.deepEqual(seen.map(r => r.id), [1, 2])
  listRows = []
  await inAct(async () => statusListeners.forEach(f => f({ kind: 'scheduled', event: 'sent', id: 2 })))
  await flush()
  assert.deepEqual(seen, [])
  assert.equal(calls.filter(c => c[0] === 'list').length, 3)
})
