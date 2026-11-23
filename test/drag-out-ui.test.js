// SPDX-License-Identifier: GPL-3.0-or-later
// Messages dragged out of the list, the page's side (jsdom): the choice at the dragstart (every source here, under 50
// and 100 MB: out as files; otherwise the internal drag as before, a notice, and the missing sources downloaded for the
// next drag); the row's drag cancelled and the main process asked; letting go of the mouse while the files are written
// starts no drag; a folder takes a Files drag only while our own drag is on, and its drop asks the main process whose
// files they are (a foreign file is no message).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'

setupDom()
window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 40, height: 40, left: 0, right: 200, width: 200, x: 0, y: 0 })
const { createElement: h } = await import('react')
const { FolderTree } = await import('../app/renderer/src/Mail.jsx')
const { createDragOut, DRAG_TYPE } = await import('../app/renderer/src/drag-out.js')

const tick = () => new Promise(r => setTimeout(r, 0))
function transfer(files = null) {
  const data = new Map()
  return {
    data,
    files: files || [],
    setData: (k, v) => data.set(k, v),
    getData: k => data.get(k) || '',
    get types() {
      return files ? ['Files', ...data.keys()] : [...data.keys()]
    },
    effectAllowed: 'all',
    dropEffect: 'none',
  }
}
function dragEvent(dt) {
  let prevented = false
  return { dataTransfer: dt, preventDefault: () => (prevented = true), get prevented() { return prevented } }
}
// a fake main process: dragOut answers when `answer()` is called
function fakeApi({ prepare = { ok: true, token: 't'.repeat(32), count: 1, bytes: 10 }, start = { ok: true }, drop = { ok: true, ids: [5] }, fetch = null } = {}) {
  const calls = []
  let answer = null
  return {
    calls,
    answer: () => answer(),
    api: {
      dragOut: ids => (calls.push(['dragOut', ids]), new Promise(r => (answer = () => r(prepare)))),
      dragStart: token => (calls.push(['dragStart', token]), Promise.resolve(start)),
      dragDrop: (token, files) => (calls.push(['dragDrop', token, files]), Promise.resolve(drop)),
      dragFetch: ids => (calls.push(['dragFetch', ids]), Promise.resolve(fetch || { ok: true, stored: ids, error: null })),
    },
  }
}
// the list rows: stored here, 10 bytes each
const HERE = id => ({ id, stored: 1, size: 10 })
const mouse = (target, type, buttons = 0) => {
  const e = new window.Event(type)
  e.buttons = buttons
  target.dispatchEvent(e)
}

test('the row: drag cancelled, the files asked for, then the native drag; our own drag ends at the next click', async () => {
  const f = fakeApi()
  const target = new window.EventTarget()
  const errors = []
  const ctl = createDragOut({ api: f.api, max: 50, onError: r => errors.push(r), target })
  const e = dragEvent(transfer())
  ctl.start(e, [3, 4], HERE)
  assert.equal(e.prevented, true, 'the HTML drag does not start')
  assert.deepEqual(f.calls, [['dragOut', [3, 4]]])
  assert.equal(ctl.ownFiles(), false, 'not before the files are there')
  f.answer()
  await tick()
  assert.deepEqual(f.calls.at(-1), ['dragStart', 't'.repeat(32)])
  assert.equal(ctl.ownFiles(), true)
  mouse(target, 'mousemove', 0)
  assert.equal(ctl.ownFiles(), true, 'a button-less move (Chromium sends them after a layout change) does not end it')
  mouse(target, 'mousedown', 1)
  assert.equal(ctl.ownFiles(), false, 'the next click ends it')
  assert.deepEqual(errors, [])
})

test('the mouse let go while the files are written: no native drag (it would drop wherever the pointer is)', async () => {
  const f = fakeApi()
  const target = new window.EventTarget()
  const ctl = createDragOut({ api: f.api, max: 50, target })
  ctl.start(dragEvent(transfer()), [3], HERE)
  mouse(target, 'mouseup')
  f.answer()
  await tick()
  assert.deepEqual(f.calls.map(c => c[0]), ['dragOut'])
  assert.equal(ctl.ownFiles(), false)
})

test('a refused preparation or start: the error with its numbers, no drag', async () => {
  const f = fakeApi({ prepare: { ok: false, error: 'too_large', bytes: 5, max: 4 } })
  const errors = []
  const ctl = createDragOut({ api: f.api, max: 50, onError: r => errors.push(r), target: new window.EventTarget() })
  ctl.start(dragEvent(transfer()), [3], HERE)
  f.answer()
  await tick()
  assert.deepEqual(errors, [{ ok: false, error: 'too_large', bytes: 5, max: 4 }])
  assert.deepEqual(f.calls.map(c => c[0]), ['dragOut'])
  const g = fakeApi({ start: { ok: false, error: 'not_found' } })
  const ctl2 = createDragOut({ api: g.api, max: 50, onError: r => errors.push(r), target: new window.EventTarget() })
  ctl2.start(dragEvent(transfer()), [3], HERE)
  g.answer()
  await tick()
  await tick()
  assert.deepEqual(errors.at(-1), { ok: false, error: 'not_found' })
  assert.equal(ctl2.ownFiles(), false)
})

// the end of the list's own drag: dropEffect 'none' = not on one of our folders (out, Esc, let go elsewhere)
const endDrag = (target, dropEffect = 'none') => {
  const e = new window.Event('dragend')
  e.dataTransfer = { dropEffect }
  target.dispatchEvent(e)
}

test('over the limit: the internal drag stays (the ids, move); the notice with the numbers only after a drag that ended outside', () => {
  const f = fakeApi()
  const notices = []
  const target = new window.EventTarget()
  const ctl = createDragOut({ api: f.api, max: 50, onNotice: (k, i) => notices.push([k, i]), target })
  const dt = transfer()
  const e = dragEvent(dt)
  const ids = Array.from({ length: 51 }, (_, i) => i + 1)
  let looked = 0
  ctl.start(e, ids, id => (looked++, HERE(id)))
  assert.equal(e.prevented, false)
  assert.equal(dt.getData(DRAG_TYPE), JSON.stringify(ids))
  assert.equal(dt.effectAllowed, 'move')
  assert.deepEqual(notices, [], 'nothing during the drag')
  endDrag(target)
  assert.deepEqual(notices, [['tooMany', { n: 51, max: 50 }]])
  assert.deepEqual(f.calls, [])
  assert.equal(looked, 0, 'over the limit no row is looked up (a whole folder may be selected)')
  // moved onto a folder: exactly as before, no notice
  ctl.start(dragEvent(transfer()), ids, HERE)
  endDrag(target, 'move')
  assert.equal(notices.length, 1)
  // exactly the limit goes out
  ctl.start(dragEvent(transfer()), ids.slice(0, 50), HERE)
  assert.equal(f.calls.length, 1)
})

test('not stored here: the internal drag as before; dropped on a folder no download and no notice (the move does not wait); ended outside: a notice and only the missing ones fetched; the next drag goes out, without a reload', async () => {
  const f = fakeApi()
  const notices = []
  const errors = []
  const target = new window.EventTarget()
  const ctl = createDragOut({ api: f.api, max: 50, onNotice: (k, i) => notices.push([k, i]), onError: r => errors.push(r), target })
  // 3 here, 4 only synced, 5 not loaded on the page
  const rows = { 3: HERE(3), 4: { id: 4, stored: 0, size: 10 } }
  const dt = transfer()
  const e = dragEvent(dt)
  ctl.start(e, [3, 4, 5], id => rows[id])
  assert.equal(e.prevented, false, 'the HTML drag goes on')
  assert.equal(dt.getData(DRAG_TYPE), JSON.stringify([3, 4, 5]), 'a move onto a folder works as before')
  assert.deepEqual([notices, f.calls], [[], []], 'nothing at the dragstart')
  endDrag(target, 'move')
  await tick()
  assert.deepEqual([notices, f.calls], [[], []], 'dropped on a folder: no download (it would hold the move up), no notice')
  ctl.start(dragEvent(transfer()), [3, 4, 5], id => rows[id])
  endDrag(target)
  assert.deepEqual(notices, [['notYet', undefined]])
  assert.deepEqual(f.calls, [['dragFetch', [4, 5]]], 'only the missing ones, no files written')
  assert.equal(ctl.ownFiles(), false)
  await tick()
  // the rows still say "not stored" (no reload): the fetched ones count as here now
  const e2 = dragEvent(transfer())
  ctl.start(e2, [3, 4], id => rows[id])
  assert.equal(e2.prevented, true, 'the second drag goes out')
  assert.deepEqual(f.calls.at(-1), ['dragOut', [3, 4]])
  assert.deepEqual(errors, [])
  // a row not loaded but fetched: its size is not known -> internal, with its own notice after it
  const e3 = dragEvent(transfer())
  ctl.start(e3, [5], id => rows[id])
  assert.equal(e3.prevented, false)
  endDrag(target)
  assert.deepEqual(notices.at(-1), ['noSize', undefined])
})

test('a drag whose dragend never came (its row went away): a later drag\'s end is not taken for it', async () => {
  const f = fakeApi()
  const notices = []
  const target = new window.EventTarget()
  const ctl = createDragOut({ api: f.api, max: 50, onNotice: (k, i) => notices.push([k, i]), target })
  ctl.start(dragEvent(transfer()), [4], id => ({ id, stored: 0, size: 1 })) // no dragend for this one
  ctl.start(dragEvent(transfer()), [7], HERE) // goes out as files
  endDrag(target)
  await tick()
  assert.deepEqual(notices, [])
  assert.ok(!f.calls.some(c => c[0] === 'dragFetch'), 'the first drag\'s missing message was not fetched by a later end')
})

test('a failed background download: an error line; the ids are not counted as here', async () => {
  const f = fakeApi({ fetch: { ok: true, stored: [], error: 'connection_refused' } })
  const errors = []
  const target = new window.EventTarget()
  const ctl = createDragOut({ api: f.api, max: 50, onError: r => errors.push(r), target })
  ctl.start(dragEvent(transfer()), [4], id => ({ id, stored: 0, size: 1 }))
  endDrag(target)
  await tick()
  assert.deepEqual(errors, [{ ok: false, error: 'connection_refused' }])
  const e = dragEvent(transfer())
  ctl.start(e, [4], id => ({ id, stored: 0, size: 1 }))
  assert.equal(e.prevented, false, 'still internal')
  endDrag(target)
  assert.deepEqual(f.calls.map(c => c[0]), ['dragFetch', 'dragFetch'], 'and fetched again')
})

test('the size: exactly 100 MB goes out, one byte more or an unknown size stays internal with a notice after it', () => {
  const f = fakeApi()
  const notices = []
  const target = new window.EventTarget()
  const ctl = createDragOut({ api: f.api, max: 50, onNotice: (k, i) => notices.push([k, i]), target })
  const half = 50 * 1024 * 1024
  const sized = sizes => id => ({ id, stored: 1, size: sizes[id] })
  const a = dragEvent(transfer())
  ctl.start(a, [1, 2], sized({ 1: half, 2: half }))
  assert.equal(a.prevented, true)
  const b = dragEvent(transfer())
  ctl.start(b, [1, 2], sized({ 1: half, 2: half + 1 }))
  assert.equal(b.prevented, false)
  endDrag(target)
  assert.deepEqual(notices.at(-1), ['tooLarge', { bytes: 2 * half + 1, max: 2 * half }])
  for (const bad of [null, undefined, NaN, '5']) {
    const c = dragEvent(transfer())
    ctl.start(c, [1], () => ({ id: 1, stored: 1, size: bad }))
    assert.equal(c.prevented, false, String(bad))
    endDrag(target)
    assert.deepEqual(notices.at(-1), ['noSize', undefined])
  }
  assert.deepEqual(f.calls.map(c => c[0]), ['dragOut'], 'no fetch for a stored one')
})

test('drop: our own drag -> the main process names the ids; once only; nothing while no drag is on', async () => {
  const f = fakeApi()
  const ctl = createDragOut({ api: f.api, max: 50, target: new window.EventTarget() })
  assert.equal(await ctl.drop(['F']), null)
  ctl.start(dragEvent(transfer()), [5], HERE)
  f.answer()
  await tick()
  assert.deepEqual(await ctl.drop(['F']), [5])
  assert.deepEqual(f.calls.at(-1), ['dragDrop', 't'.repeat(32), ['F']])
  assert.equal(ctl.ownFiles(), false)
  assert.equal(await ctl.drop(['F']), null)
  const g = fakeApi({ drop: { ok: false, error: 'not_own' } })
  const ctl2 = createDragOut({ api: g.api, max: 50, target: new window.EventTarget() })
  ctl2.start(dragEvent(transfer()), [5], HERE)
  g.answer()
  await tick()
  assert.equal(await ctl2.drop(['X']), null)
})

const folder = (path, extra = {}) => ({ path, delimiter: '/', special_use: null, count: 0, unread: 0, ...extra })
const ACCOUNTS = [
  { id: 1, name: 'Első', email: 'a@example.invalid', folders: [folder('INBOX'), folder('alma'), folder('Sent', { special_use: '\\Sent' })] },
  { id: 2, name: 'Második', email: 'b@example.invalid', folders: [folder('INBOX'), folder('körte')] },
]
function domDrag(target, type, dt) {
  const e = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: dt })
  Object.defineProperty(e, 'clientY', { value: 20 })
  target.dispatchEvent(e)
  return e
}

test('folder: a Files drag only while our own drag is on, into another folder of the shown account; the drop hands the files over', async t => {
  let own = false
  const drops = []
  const moves = []
  const v = await mount(
    h(FolderTree, {
      accounts: ACCOUNTS,
      selected: { accountId: 1, folder: 'INBOX' },
      onSelect: () => {},
      onDropMessages: (ids, path) => moves.push({ ids, path }),
      ownFileDrag: () => own,
      onDropFiles: (files, path) => drops.push({ files, path }),
      onFolderMenu: () => {},
      onNewFolder: () => {},
    }),
  )
  t.after(v.unmount)
  const el = (account, path) => v.container.querySelector(`section[data-account="${account}"] .folder[data-path="${path}"]`)
  const files = ['F1', 'F2']
  // a foreign file drag (Explorer): no drop target, nothing handed over
  let e = await inAct(() => domDrag(el(1, 'alma'), 'dragover', transfer(files)))
  assert.equal(e.defaultPrevented, false)
  await inAct(() => domDrag(el(1, 'alma'), 'drop', transfer(files)))
  assert.deepEqual(drops, [])
  // our own drag
  own = true
  e = await inAct(() => domDrag(el(1, 'alma'), 'dragover', transfer(files)))
  assert.equal(e.defaultPrevented, true)
  const over = transfer(files)
  await inAct(() => domDrag(el(1, 'alma'), 'dragover', over))
  assert.equal(over.dropEffect, 'none', "the native drag's own drop effect stays")
  e = await inAct(() => domDrag(el(1, 'alma'), 'drop', transfer(files)))
  assert.equal(e.defaultPrevented, true)
  assert.deepEqual(drops, [{ files, path: 'alma' }])
  // the shown folder itself, and another account: no
  for (const [acc, p] of [[1, 'INBOX'], [2, 'körte']]) {
    e = await inAct(() => domDrag(el(acc, p), 'dragover', transfer(files)))
    assert.equal(e.defaultPrevented, false, `${acc} ${p}`)
    await inAct(() => domDrag(el(acc, p), 'drop', transfer(files)))
  }
  assert.equal(drops.length, 1)
  // the internal message drag works as before, and wins over Files
  const msg = transfer()
  msg.setData(DRAG_TYPE, JSON.stringify([7]))
  await inAct(() => domDrag(el(1, 'alma'), 'drop', msg))
  assert.deepEqual(moves, [{ ids: [7], path: 'alma' }])
  assert.equal(drops.length, 1)
})
