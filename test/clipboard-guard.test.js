// the recovery code leaves the clipboard after 60 s, on lock and on quit, but only
// while it is still there. The clipboard and the clock are stand-ins; the clipboard is asynchronous, as
// Electron 45's is (readText / writeText return promises).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClipboardGuard, settleWithin, windowsWrite, CLIPBOARD_CLEAR_MS } from '../app/main/clipboard-guard.js'
import { registerVaultIpc } from '../app/main/ipc/vault.js'
import { hu } from '../app/renderer/i18n/hu.js'

const CODE = '7K3QD-ABCDE-FGH12-JKMNP-QRSTV'

const tick = () => new Promise(resolve => setImmediate(resolve))

function fakeClipboard() {
  const c = { text: '', clears: 0, writeGate: null }
  c.writeText = async t => {
    if (c.writeGate) await c.writeGate
    c.text = String(t)
  }
  c.readText = async () => c.text
  c.clear = () => ((c.text = ''), c.clears++)
  c.userCopies = t => (c.text = t) // another program writes
  return c
}

function fakeClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    setTimeout: (fn, ms) => (timers.set(++seq, { fn, at: now + ms }), seq),
    clearTimeout: id => timers.delete(id),
    async advance(ms) {
      now += ms
      for (const [id, t] of [...timers]) if (t.at <= now) (timers.delete(id), t.fn())
      await tick()
    },
    pending: () => timers.size,
  }
}

const guard = () => {
  const clipboard = fakeClipboard()
  const clock = fakeClock()
  return { clipboard, clock, g: createClipboardGuard({ clipboard, timers: clock }) }
}

test('"Másolás": the code is on the clipboard; after 60 s it is gone', async () => {
  const { clipboard, clock, g } = guard()
  assert.equal(CLIPBOARD_CLEAR_MS, 60_000)
  await g.copy(CODE)
  assert.equal(clipboard.text, CODE)
  await clock.advance(59_999)
  assert.equal(clipboard.text, CODE, 'not before the 60 s')
  await clock.advance(1)
  assert.equal(clipboard.text, '')
  assert.equal(clipboard.clears, 1)
  assert.equal(g.isHolding(), false, 'the code is not kept after it is cleared')
})

test('something else copied in the meantime stays: no clear after 60 s, on lock or on quit', async () => {
  const { clipboard, clock, g } = guard()
  await g.copy(CODE)
  clipboard.userCopies('a felhasználó saját szövege')
  await clock.advance(60_000)
  assert.equal(clipboard.text, 'a felhasználó saját szövege')
  assert.equal(clipboard.clears, 0)
  for (const event of ['lock', 'quit']) {
    await g.copy(CODE)
    clipboard.userCopies(`saját ${event}`)
    await g.clearNow()
    assert.equal(clipboard.text, `saját ${event}`, event)
  }
  assert.equal(clipboard.clears, 0)
})

test('on lock and on quit the code goes at once, and the timer is disarmed', async () => {
  for (const event of ['lock', 'quit']) {
    const { clipboard, clock, g } = guard()
    await g.copy(CODE)
    await clock.advance(10_000)
    await g.clearNow() // main.js: vault.onLock and will-quit
    assert.equal(clipboard.text, '', event)
    assert.equal(clock.pending(), 0, `${event}: no timer left`)
    clipboard.userCopies('később másolt')
    await clock.advance(60_000)
    assert.equal(clipboard.text, 'később másolt', `${event}: a later copy is left alone`)
  }
})

test('a second "Másolás" restarts the 60 s', async () => {
  const { clipboard, clock, g } = guard()
  await g.copy(CODE)
  await clock.advance(50_000)
  await g.copy(CODE)
  await clock.advance(50_000)
  assert.equal(clipboard.text, CODE)
  await clock.advance(10_000)
  assert.equal(clipboard.text, '')
})

test('vault:copyRecoveryCode copies only the code just handed out, only while unlocked; the note text', async () => {
  const handlers = new Map()
  const copied = []
  let unlocked = true
  const vault = { isUnlocked: () => unlocked, isPendingCode: c => c === CODE, status: () => ({ unlocked }) }
  registerVaultIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, vault, isTrustedSender: () => true, copyCode: c => copied.push(c) })
  const call = c => handlers.get('vault:copyRecoveryCode')({}, c)
  assert.equal((await call(CODE)).ok, true)
  assert.deepEqual(await call('barmilyen szoveg'), { ok: false, error: 'bad_recovery_code' })
  unlocked = false
  assert.deepEqual(await call(CODE), { ok: false, error: 'locked' })
  assert.deepEqual(copied, [CODE])
  assert.equal(hu.recoveryClipboardNote, 'A kód 60 mp múlva törlődik a vágólapról.')
})

test('a lock while the code is still being written: the code does not stay behind', async () => {
  const { clipboard, clock, g } = guard()
  let release
  clipboard.writeGate = new Promise(r => (release = r))
  const copying = g.copy(CODE)
  assert.equal(await g.clearNow(), false, 'the lock came before the text landed')
  release()
  await copying
  assert.equal(clipboard.text, '', 'cleared once the write finished')
  assert.equal(clock.pending(), 0)
})

test('the quit waits for the clear, but at most the given time', async () => {
  const clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: t => clearTimeout(t) }
  const t0 = performance.now()
  await settleWithin(new Promise(() => {}), 50, clock)
  assert.ok(performance.now() - t0 < 1000)
  let done = false
  await settleWithin(Promise.resolve().then(() => (done = true)), 5000, clock)
  assert.equal(done, true)
})

test('Windows: the text and the three history / cloud opt-out formats go in ONE write; a failing write falls back to plain text', async () => {
  class FakeItem {
    constructor(record) {
      this.record = record
    }
  }
  const writes = []
  const clipboard = fakeClipboard()
  clipboard.write = async items => (writes.push(items), (clipboard.text = items[0].record['text/plain']))
  const g = createClipboardGuard({ clipboard, timers: fakeClock(), write: windowsWrite(FakeItem) })
  await g.copy(CODE)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].length, 1, 'one item: atomic')
  const rec = writes[0][0].record
  const bytes = async name => [...new Uint8Array(await rec[`electron application/osclipboard;format="${name}"`].arrayBuffer())]
  assert.equal(rec['text/plain'], CODE)
  assert.deepEqual(await bytes('ExcludeClipboardContentFromMonitorProcessing'), [1, 0, 0, 0])
  assert.deepEqual(await bytes('CanIncludeInClipboardHistory'), [0, 0, 0, 0])
  assert.deepEqual(await bytes('CanUploadToCloudClipboard'), [0, 0, 0, 0])
  assert.equal(await g.clearNow(), true)

  const logs = []
  const plain = fakeClipboard()
  const g2 = createClipboardGuard({ clipboard: plain, timers: fakeClock(), write: async () => { throw new Error('no raw formats') }, log: m => logs.push(m) })
  await g2.copy(CODE)
  assert.equal(plain.text, CODE, 'the code is still copied')
  assert.equal(await g2.clearNow(), true)
  assert.equal(logs.length, 1)
})
