// SPDX-License-Identifier: GPL-3.0-or-later
// The taskbar badge of one session (app/main/taskbar.js): the overlay calls, the stored switch, the IPC.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoryIndex, addAccount, addMessage } from './helpers/fixtures.js'
import { badgeImage, overlayApplier, startTaskbarBadge, registerTaskbarIpc, TASKBAR_CHANNELS } from '../app/main/taskbar.js'
import { openSettings } from '../app/main/settings.js'
import { BADGE_SIZES } from '../core/unread-badge.js'

// nativeImage's two calls, recording what they got
function fakeNativeImage() {
  return {
    createFromBitmap(buffer, opts) {
      const reps = [{ ...opts, bytes: buffer.length }]
      return { reps, addRepresentation: o => reps.push({ scaleFactor: o.scaleFactor, width: o.width, height: o.height, bytes: o.buffer.length }), getScaleFactors: () => reps.map(r => r.scaleFactor) }
    },
  }
}

function fakeWindow() {
  const calls = []
  return { calls, isDestroyed: () => false, setOverlayIcon: (image, text) => calls.push([image ? image.reps.map(r => r.width) : null, text]) }
}

const settle = ms => new Promise(r => setTimeout(r, ms))

test('the badge image: one representation for every taskbar scale, BGRA bytes of its size; none at 0', () => {
  const img = badgeImage(fakeNativeImage(), 42)
  assert.deepEqual(img.reps.map(r => [r.width, r.height, r.scaleFactor, r.bytes]), BADGE_SIZES.map(s => [s, s, s / 16, s * s * 4]))
  assert.equal(badgeImage(fakeNativeImage(), 0), null)
})

test('the overlay: Windows only, null at 0, the description from the dictionary; elsewhere nothing, the test log still watches', () => {
  const win = fakeWindow()
  const apply = overlayApplier({ getWindow: () => win, nativeImage: fakeNativeImage(), describe: n => `${n} olvasatlan levél`, platform: 'win32' })
  apply(3)
  apply(0)
  assert.deepEqual(win.calls, [[BADGE_SIZES, '3 olvasatlan levél'], [null, '']])

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-overlay-'))
  const file = path.join(dir, 'overlay.jsonl')
  const linux = fakeWindow()
  const watched = overlayApplier({ getWindow: () => linux, nativeImage: fakeNativeImage(), describe: String, platform: 'linux', testLog: file })
  watched(120)
  watched(0)
  assert.deepEqual(linux.calls, [], 'no overlay off Windows')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(lines.map(l => [l.n, l.scales]), [[120, [1, 1.25, 1.5, 2]], [null, []]])
  fs.rmSync(dir, { recursive: true, force: true })

  // no window, a destroyed one, or a throwing setOverlayIcon: nothing breaks, the log gets a code, never the number
  const logged = []
  const broken = overlayApplier({ getWindow: () => ({ isDestroyed: () => false, setOverlayIcon: () => { throw Object.assign(new Error('x'), { code: 'EBADF' }) } }), nativeImage: fakeNativeImage(), describe: String, platform: 'win32', log: m => logged.push(m) })
  broken(77)
  assert.deepEqual(logged, ['taskbar badge failed: EBADF'])
  overlayApplier({ getWindow: () => null, nativeImage: fakeNativeImage(), describe: String, platform: 'win32' })(5)
  overlayApplier({ getWindow: () => ({ isDestroyed: () => true }), nativeImage: fakeNativeImage(), describe: String, platform: 'win32' })(5)
})

test('the session badge: counts at once, follows a write, the switch is stored (missing or damaged = on), stop clears and unhooks', async t => {
  const { db, index } = memoryIndex(t)
  const a = addAccount(db, { type: 'pop3', email: 'a@example.invalid' })
  index.ensureLocalFolders(a.id, [{ path: 'INBOX' }])
  addMessage(index, a.id, { uid: 1, flags: '' })
  const settings = openSettings(db)
  const applied = []
  const logged = []
  const badge = startTaskbarBadge({ db, settings, apply: n => applied.push(n), log: m => logged.push(m), delayMs: 10 })
  assert.deepEqual(applied, [1], 'no stored switch: on, counted at once')
  assert.equal(badge.enabled(), true)
  addMessage(index, a.id, { uid: 2, flags: '' })
  await settle(40)
  assert.deepEqual(applied, [1, 2])

  badge.setEnabled(false)
  assert.equal(settings.get('taskbar_unread'), 'off')
  assert.deepEqual(applied, [1, 2, 0], 'off: the badge goes at once')
  addMessage(index, a.id, { uid: 3, flags: '' })
  await settle(40)
  assert.deepEqual(applied, [1, 2, 0], 'off: no recount after a write')
  badge.stop()

  // a new session (after a lock) reads the stored OFF
  const again = []
  const off = startTaskbarBadge({ db, settings, apply: n => again.push(n), delayMs: 10 })
  assert.equal(off.enabled(), false)
  assert.deepEqual(again, [])
  off.setEnabled(true)
  assert.deepEqual(again, [3], 'on: the right number at once')
  off.stop()
  assert.deepEqual(again, [3, 0], 'stop (lock, quit): the badge goes')
  addMessage(index, a.id, { uid: 4, flags: '' })
  await settle(40)
  assert.deepEqual(again, [3, 0], 'stopped: the triggers are gone')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM temp.sqlite_master WHERE type = 'trigger'").get().n, 0)

  settings.set('taskbar_unread', 'x')
  const damaged = startTaskbarBadge({ db, settings, apply: () => {}, delayMs: 10 })
  assert.equal(damaged.enabled(), true, 'a damaged value is on')
  damaged.stop()
  assert.deepEqual(logged, ['taskbar badge switch off'], 'the log has the switch, never a number')
})

test('the IPC: status and setEnabled, a boolean only, an untrusted sender refused', async () => {
  const handlers = new Map()
  const ipcMain = { handle: (c, fn) => handlers.set(c, fn) }
  let on = true
  const taskbar = { enabled: () => on, setEnabled: v => (on = v) }
  registerTaskbarIpc({ ipcMain, taskbar, isTrustedSender: e => e.trusted })
  assert.deepEqual([...handlers.keys()].sort(), [...TASKBAR_CHANNELS].sort())
  const call = (c, ...args) => handlers.get(c)({ trusted: true }, ...args)
  assert.deepEqual(await call('taskbar:status'), { ok: true, enabled: true })
  assert.deepEqual(await call('taskbar:setEnabled', false), { ok: true, enabled: false })
  for (const bad of [[], ['off'], [0], [null], [true, 1]]) assert.deepEqual(await call('taskbar:setEnabled', ...bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
  assert.deepEqual(await call('taskbar:status', 1), { ok: false, error: 'bad_request' })
  assert.deepEqual(await handlers.get('taskbar:setEnabled')({ trusted: false }, true), { ok: false, error: 'untrusted_sender' })
  assert.equal(on, false)
})
