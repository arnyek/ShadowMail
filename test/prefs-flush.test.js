// The view settings go to disk at once: after a setPref the renderer asks the main process to write the window's
// storage (app:flushPrefs), once for a burst of changes; the IPC takes no argument and flushes the asking window's
// session.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom } from './helpers/react-dom-env.js'
import { registerPrefsIpc, PREFS_CHANNEL } from '../app/main/ipc/prefs.js'

setupDom()
let flushes = 0
let failNext = false
window.shadowMail = {
  flushPrefs: async () => {
    flushes++
    if (failNext) throw new Error('flush failed')
    return { ok: true }
  },
}
mock.timers.enable({ apis: ['setTimeout'] })
const { getPref, setPref, FLUSH_DELAY_MS } = await import('../app/renderer/src/prefs.js')

test('20 changes within 100 ms: one flush, FLUSH_DELAY_MS after the last; a later change flushes again', () => {
  flushes = 0
  for (let i = 0; i < 20; i++) {
    if (i) mock.timers.tick(5) // 20 changes over 95 ms
    setPref('split.list', 300 + i)
  }
  assert.equal(flushes, 0, 'not during the burst')
  mock.timers.tick(FLUSH_DELAY_MS - 1)
  assert.equal(flushes, 0, 'not before the delay after the last change')
  mock.timers.tick(1)
  assert.equal(flushes, 1)
  assert.equal(getPref('split.list', null), 319, 'the value itself is stored at once, as before')
  mock.timers.tick(10 * FLUSH_DELAY_MS)
  assert.equal(flushes, 1, 'nothing more without a change')
  setPref('theme', 'dark')
  mock.timers.tick(FLUSH_DELAY_MS)
  assert.equal(flushes, 2)
})

test('a failed flush and a page without the bridge are quiet; the value is still stored', async () => {
  flushes = 0
  failNext = true
  setPref('readerPane', 'right')
  mock.timers.tick(FLUSH_DELAY_MS)
  await Promise.resolve()
  assert.equal(flushes, 1)
  failNext = false
  const bridge = window.shadowMail
  window.shadowMail = undefined
  setPref('readerPane', 'bottom')
  assert.doesNotThrow(() => mock.timers.tick(FLUSH_DELAY_MS))
  window.shadowMail = bridge
  assert.equal(getPref('readerPane', null), 'bottom')
})

test('app:flushPrefs: the asking window\'s session is flushed; an argument is a bad request; a stranger is refused', async () => {
  const handlers = new Map()
  const logs = []
  registerPrefsIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, isTrustedSender: e => e.trusted, log: m => logs.push(m) })
  let flushed = 0
  const event = (extra = {}) => ({ trusted: true, sender: { session: { flushStorageData: () => flushed++ } }, ...extra })
  const call = (e, ...a) => handlers.get(PREFS_CHANNEL)(e, ...a)
  assert.deepEqual(await call(event()), { ok: true })
  assert.equal(flushed, 1)
  assert.deepEqual(await call(event(), 'x'), { ok: false, error: 'bad_request' })
  assert.deepEqual(await call(event(), undefined), { ok: false, error: 'bad_request' }, 'any argument, even undefined')
  assert.deepEqual(await call(event({ trusted: false })), { ok: false, error: 'untrusted_sender' })
  assert.equal(flushed, 1, 'nothing flushed for those')
  const broken = { trusted: true, sender: { session: { flushStorageData: () => { throw new Error('boom') } } } }
  assert.deepEqual(await call(broken), { ok: false, error: 'internal' })
  assert.ok(logs.some(l => l.startsWith('app:flushPrefs failed:')), logs.join(' | '))
})
