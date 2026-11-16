// Lock with open composers: they save first, at most 10 s in all; a failure or a
// timeout never stops the lock; the next unlock tells how many drafts were not saved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { saveBeforeLock } from '../app/main/lock.js'
import { registerComposeIpc } from '../app/main/ipc/compose.js'
import { registerVaultIpc } from '../app/main/ipc/vault.js'
import { Composer } from '../app/main/compose.js'
import { Vault } from '../core/vault/vault.js'
import { tempDir } from './helpers/tmp.js'
import { hu } from '../app/renderer/i18n/hu.js'

const FAST = { N: 2 ** 12, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const flush = () => new Promise(r => setImmediate(r))

/** registerComposeIpc with fake windows; answer(sessionId, sent) decides how each page reacts. */
function composeSetup(t, answer) {
  const composer = new Composer({ index: null, store: null, contacts: null, storeDir: tempDir(t), withConnection: async () => {} })
  const handlers = new Map()
  const wins = []
  const ipc = registerComposeIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    composer,
    store: { list: () => [] },
    contacts: { suggest: () => [] },
    openWindow: id => {
      const listeners = {}
      const win = {
        id,
        closed: false,
        sent: [],
        on: (ev, fn) => (listeners[ev] = fn),
        isDestroyed: () => win.closed,
        // like Electron: close() emits 'closed', which takes the window out of the composer's list
        close() {
          this.closed = true
          if (listeners.closed) listeners.closed()
        },
        destroy() {
          this.close()
        },
        webContents: { send: ch => (win.sent.push(ch), answer(id, ch, ok => handlers.get('compose:lockDone')({ ok: true }, id, ok))) },
      }
      wins.push(win)
      return win
    },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    windowOf: () => null,
    isTrustedSender: e => e.ok,
  })
  const open = () => handlers.get('compose:open')({ ok: true })
  return { ipc, wins, open, handlers }
}

test('every open composer is asked to save; the answers decide "failed"; then every window closes without asking', async t => {
  const plan = []
  const s = composeSetup(t, (id, ch, reply) => {
    const how = plan[s.wins.findIndex(w => w.id === id)]
    if (how === 'ok') reply(true)
    else if (how === 'fail') reply(false)
    // 'silent': never answers
  })
  plan.push('ok', 'fail')
  await s.open()
  await s.open()
  const res = await s.ipc.saveAllForLock({ timeoutMs: 2000 })
  assert.deepEqual(res, { failed: 1 })
  assert.ok(s.wins.every(w => w.sent.includes('compose:lockRequested')))
  assert.ok(s.wins.every(w => w.closed && w.__allowClose), 'closed, the close question skipped')
  assert.deepEqual(await s.ipc.saveAllForLock(), { failed: 0 }, 'no window: nothing to wait for')
})

test('keepFailed (a change of language): a saved composer closes, one whose save failed stays open', async t => {
  const plan = []
  const s = composeSetup(t, (id, ch, reply) => reply(plan[s.wins.findIndex(w => w.id === id)] === 'ok'))
  plan.push('ok', 'fail')
  await s.open()
  await s.open()
  assert.deepEqual(await s.ipc.saveAllForLock({ timeoutMs: 2000, keepFailed: true }), { failed: 1 })
  assert.ok(s.wins.every(w => w.sent.includes('compose:lockRequested')))
  assert.deepEqual(s.wins.map(w => Boolean(w.closed)), [true, false], 'the failed one is left open with its text')
  assert.ok(!s.wins[1].__allowClose, 'its close question still works')
})

test('a composer that does not answer: the wait ends after 10 s (default), it counts as failed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = composeSetup(t, () => {})
  await s.open()
  let done = null
  s.ipc.saveAllForLock().then(r => (done = r))
  await flush()
  t.mock.timers.tick(9_999)
  await flush()
  assert.equal(done, null, 'still waiting before 10 s')
  t.mock.timers.tick(1)
  await flush()
  await flush()
  assert.deepEqual(done, { failed: 1 })
  assert.ok(s.wins[0].closed)
})

test('saveBeforeLock: a failing or hanging save never stops the lock; one log line without content', async t => {
  const logs = []
  assert.equal(await saveBeforeLock({ saveAll: null, log: l => logs.push(l) }), 0)
  assert.equal(await saveBeforeLock({ saveAll: async () => ({ failed: 2 }), log: l => logs.push(l) }), 2)
  assert.equal(await saveBeforeLock({ saveAll: async () => { throw Object.assign(new Error('Tárgy: titkos szöveg'), { code: 'EIO' }) }, log: l => logs.push(l) }), 1)
  assert.deepEqual(logs, ['lock: 2 draft(s) not saved, locking anyway', 'lock: saving the drafts failed (EIO), locking anyway'])
  assert.ok(!logs.join('').includes('titkos'), 'never the error message')
  // a save that never settles: the safety net lets the lock through after timeoutMs + 1 s
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let got = null
  saveBeforeLock({ saveAll: () => new Promise(() => {}), log: l => logs.push(l) }).then(n => (got = n))
  await flush()
  t.mock.timers.tick(11_000)
  await flush()
  await flush()
  assert.equal(got, 1)
  assert.match(logs.at(-1), /failed \(timeout\), locking anyway/)
})

test('vault:lock with a failing save still locks; the next unlock tells the count once (the bar)', async t => {
  const vault = new Vault(path.join(tempDir(t), 'vault.json'), { kdfParams: FAST, failDelayMs: 0 })
  const handlers = new Map()
  let failNext = 1
  registerVaultIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    vault,
    isTrustedSender: e => e.trusted,
    beforeLock: async () => {
      if (failNext === 'throw') throw new Error('broken')
      return failNext
    },
  })
  const call = (ch, ...a) => handlers.get(ch)({ trusted: true }, ...a)
  await call('vault:create', 'Mesterjelszo-zarolas-1')
  const locked = await call('vault:lock')
  assert.deepEqual(locked, { ok: true, status: { exists: true, unlocked: false, recoveryConfirmed: null, resetPending: false, vaultProblem: null } })
  assert.deepEqual(await call('vault:lockNotice'), { ok: false, error: 'locked' })
  await call('vault:unlock', 'Mesterjelszo-zarolas-1')
  assert.deepEqual(await call('vault:lockNotice'), { ok: true, failedDrafts: 1 })
  assert.deepEqual(await call('vault:lockNotice'), { ok: true, failedDrafts: 0 }, 'told once')
  assert.equal(hu.lockDraftsFailed(1), 'A zároláskor 1 piszkozat mentése nem sikerült; a legutóbbi automatikus mentés a Piszkozatokban van.')
  failNext = 'throw' // even a beforeLock that throws: the vault locks
  assert.equal((await call('vault:lock')).status.unlocked, false)
  assert.deepEqual(await handlers.get('vault:lockNotice')({ trusted: false }), { ok: false, error: 'untrusted_sender' })
})
