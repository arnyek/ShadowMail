// SPDX-License-Identifier: GPL-3.0-or-later
// The new-mail notice without Electron: the real SyncManager and MailIndex on the fake IMAP server, the notifier wired as
// main.js wires it (index.onInsert, the manager's onRunEnd). The first full sync tells nothing; afterwards a new unread
// inbox message tells one, junk / another folder / a read one nothing, five from one run one summary; locked: nothing.
// The text cleaning, the Start menu shortcut with an injected shell, the switch and its IPC.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount, DAY } from './helpers/fixtures.js'
import { onCleanup } from './helpers/tmp.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { startNewMailNotice, cleanNoticeText, noticesFor, notifyOn, registerNotifyIpc, NOTIFY_KEY, NAME_MAX, SUBJECT_MAX } from '../app/main/new-mail-notify.js'
import { notifyShortcut, shortcutPathOf, APP_USER_MODEL_ID } from '../app/main/notify-shortcut.js'
import { hu } from '../app/renderer/i18n/hu.js'
import { en } from '../app/renderer/i18n/en.js'

const NOW = Date.UTC(2026, 10, 28, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 30_000) => {
  const t0 = performance.now()
  while (!fn()) {
    if (performance.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const texts = { noSubject: hu.noSubject, summary: hu.newMailNotice.summary }
const memSettings = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v), map: m }
}
const okShortcut = () => ({ applies: false, ensure: () => true, write: () => true, remove: () => true })

function setup(t, { setting = 'on' } = {}) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { name: 'Munka', email: 'en@example.invalid' })
  const server = new FakeImapServer().addMailbox('INBOX').addMailbox('Projekt').addMailbox('Spam', { specialUse: '\\Junk' })
  let seq = 0
  const msg = (over = {}) => ({ from: `kuldo${++seq}@example.invalid`, fromName: `Küldő ${seq}`, to: 'en@example.invalid', subject: `Tárgy ${seq}`, messageId: `<m${seq}@x>`, date: NOW - DAY, body: 'szia', ...over })
  server.addMessages('INBOX', Array.from({ length: 30 }, () => msg()))
  server.addMessages('Projekt', Array.from({ length: 3 }, () => msg()))
  const store = { list: () => [row], getRow: id => (id === row.id ? row : null), passwordsFor: () => ({ incoming: 'x' }) }
  const shown = []
  const logs = []
  const settings = memSettings(setting === null ? {} : { [NOTIFY_KEY]: setting })
  const notice = startNewMailNotice({ index, store, settings, shortcut: okShortcut(), show: n => shown.push(n), texts, log: l => logs.push(l) })
  const unwatch = index.onInsert(items => notice.inserted(items))
  let ended = 0
  const manager = new SyncManager({ store, index, log: () => {}, connect: () => server.connect(), now: () => NOW, throttleMs: 5, idleOptions: { retryDelaysMs: [60_000] }, onRunEnd: s => (notice.runEnd(s), ended++) })
  onCleanup(t, async () => {
    unwatch()
    notice.stop()
    await manager.stopAll()
  })
  const runs = () => ended
  // a targeted run of the inbox (what IDLE asks for), waited for
  const targeted = async (folder = 'INBOX') => {
    const n = ended
    manager.requestSync(row.id, [folder])
    await until(() => ended > n)
  }
  return { db, index, row, server, manager, msg, shown, logs, settings, notice, runs, targeted }
}

test('the first full sync tells nothing; then one new unread inbox message tells one: the sender and the subject, the address too', async t => {
  const s = setup(t)
  s.manager.startAll()
  await until(() => s.runs() >= 1)
  assert.equal(s.index.folders(s.row.id).find(f => f.path === 'INBOX').count, 30)
  assert.deepEqual(s.shown, [], 'the mail of the night gives no notice, no summary either')
  s.server.addMessage('INBOX', s.msg({ fromName: 'Kovács Anna', from: 'anna@example.invalid', subject: 'Ajánlat' }))
  await s.targeted()
  assert.equal(s.shown.length, 1, JSON.stringify(s.shown))
  const [n] = s.shown
  assert.equal(n.kind, 'message')
  assert.equal(n.title, 'Kovács Anna <anna@example.invalid>')
  assert.equal(n.body, 'Ajánlat')
  assert.equal(n.accountId, s.row.id)
  assert.equal(n.folder, 'INBOX')
  assert.equal(s.index.get(n.messageId).subject, 'Ajánlat')
  assert.deepEqual(s.logs, ['new mail notice: 1'], 'the number only')
})

test('a read message, one in another folder and one in junk tell nothing; five from one run tell one summary', async t => {
  const s = setup(t)
  s.manager.startAll()
  await until(() => s.runs() >= 1)
  s.server.addMessage('INBOX', s.msg({ flags: ['\\Seen'] }))
  await s.targeted()
  s.server.addMessage('Projekt', s.msg())
  await s.targeted('Projekt')
  s.server.addMessage('Spam', s.msg())
  await s.targeted('Spam')
  assert.deepEqual(s.shown, [], JSON.stringify(s.shown))
  for (let i = 0; i < 5; i++) s.server.addMessage('INBOX', s.msg())
  await s.targeted()
  assert.equal(s.shown.length, 1)
  assert.deepEqual({ ...s.shown[0] }, { kind: 'summary', title: '5 új levél (Munka)', body: '', accountId: s.row.id, folder: 'INBOX', count: 5 })
  // three still one by one
  for (let i = 0; i < 3; i++) s.server.addMessage('INBOX', s.msg())
  await s.targeted()
  assert.equal(s.shown.length, 4)
  assert.ok(s.shown.slice(1).every(n => n.kind === 'message'))
})

test('locked (the notice stopped): nothing more; a failed first full run primes nothing', async t => {
  const s = setup(t)
  s.manager.startAll()
  await until(() => s.runs() >= 1)
  s.notice.stop()
  s.server.addMessage('INBOX', s.msg())
  await s.targeted()
  // a full run of a manager still going (the lock stops both): a stopped notice is not primed again by it
  const before = s.runs()
  s.manager.requestSync(s.row.id)
  await until(() => s.runs() > before)
  s.server.addMessage('INBOX', s.msg())
  await s.targeted()
  assert.deepEqual(s.shown, [])
  // the rule itself: only a full (or POP3) run that ended well primes the account
  const shown = []
  const index = { get: id => ({ id, account_id: 7, folder: 'INBOX', flags: '', from_addr: 'a@x', subject: 's' }), folderList: () => [{ path: 'INBOX' }] }
  const n = startNewMailNotice({ index, store: { getRow: () => ({ id: 7, name: 'A' }) }, settings: memSettings({ [NOTIFY_KEY]: 'on' }), shortcut: okShortcut(), show: x => shown.push(x), texts })
  n.inserted([{ id: 1, account_id: 7, folder: 'INBOX' }])
  n.runEnd({ accountId: 7, kind: 'full', result: 'connection_lost' })
  n.inserted([{ id: 2, account_id: 7, folder: 'INBOX' }])
  n.runEnd({ accountId: 7, kind: 'targeted', result: 'ok' })
  n.inserted([{ id: 4, account_id: 7, folder: 'INBOX' }])
  n.runEnd({ accountId: 7, kind: 'targeted', result: 'ok' })
  assert.equal(shown.length, 0, 'not primed: a failed full run and a targeted one (nor after a targeted one)')
  n.runEnd({ accountId: 7, kind: 'pop3', result: 'ok' })
  n.inserted([{ id: 3, account_id: 7, folder: 'INBOX' }])
  n.runEnd({ accountId: 7, kind: 'pop3', result: 'ok' })
  assert.deepEqual(shown.map(x => x.messageId), [3], 'a POP3 run primes too')
})

test('the switch OFF (the default: missing or broken is off): nothing is told', async t => {
  for (const v of [null, 'off', 'ON', '1', 'true']) {
    assert.equal(notifyOn(v), false, String(v))
  }
  assert.equal(notifyOn('on'), true)
  const s = setup(t, { setting: null })
  s.manager.startAll()
  await until(() => s.runs() >= 1)
  s.server.addMessage('INBOX', s.msg())
  await s.targeted()
  assert.deepEqual(s.shown, [])
  assert.equal(s.notice.enabled(), false)
})

test('the text: control, direction and zero-width characters out; the name at most 64, the subject at most 120 with an ellipsis', () => {
  const cp = n => String.fromCodePoint(n)
  const dirty = `Bank${cp(0x202e)}gpj.exe${cp(0x200b)}${cp(0x0007)} a${cp(0x2066)}b${cp(0xfeff)}c${cp(0x0085)}d${cp(0x2028)}e`
  const clean = cleanNoticeText(dirty, 200)
  assert.equal(clean, 'Bank gpj.exe a b c d e')
  for (const c of [0x202e, 0x200b, 0x7, 0x2066, 0xfeff, 0x85, 0x2028, 0x200e, 0x61c]) assert.ok(!clean.includes(cp(c)))
  const long = 'x'.repeat(300)
  const cut = cleanNoticeText(long, SUBJECT_MAX)
  assert.equal(Array.from(cut).length, 120)
  assert.ok(cut.endsWith('…'))
  assert.equal(cleanNoticeText('😀'.repeat(130), SUBJECT_MAX), `${'😀'.repeat(119)}…`, 'code points, a pair never split')
  const rows = [{ id: 1, account_id: 2, folder: 'INBOX', from_name: `${'N'.repeat(70)}${cp(0x202e)}`, from_addr: 'n@x.invalid', subject: long }]
  const [n] = noticesFor(rows, { id: 2, name: 'Munka' }, texts)
  assert.equal(Array.from(n.title).length, NAME_MAX, 'a long name: the name alone, cut')
  assert.equal(Array.from(n.body).length, SUBJECT_MAX)
  const [noName] = noticesFor([{ id: 1, account_id: 2, folder: 'INBOX', from_name: '', from_addr: 'csak@cim.invalid', subject: '' }], { id: 2 }, texts)
  assert.deepEqual([noName.title, noName.body], ['csak@cim.invalid', hu.noSubject])
  assert.equal(en.newMailNotice.summary(5, 'Work'), '5 new messages (Work)')
  assert.equal(en.newMailNotice.summary(1, 'Work'), '1 new message (Work)')
})

// --- the Start menu shortcut -------------------------------------------------------------------------------------------

function fakeShell(initial = null) {
  const calls = []
  let link = initial
  return {
    calls,
    get link() {
      return link
    },
    writeShortcutLink(file, op, opts) {
      calls.push({ op: 'write', file, mode: op, opts })
      link = { target: opts.target, appUserModelId: opts.appUserModelId }
      return this.writeResult ?? true
    },
    readShortcutLink(file) {
      calls.push({ op: 'read', file })
      if (!link) throw new Error('missing')
      return link
    },
  }
}
const fakeFs = shell => ({ mkdirSync: () => {}, unlinkSync: () => ((shell.unlinked = (shell.unlinked || 0) + 1), void 0) })
const WIN = { platform: 'win32', isPackaged: true, execPath: 'C:\\ShadowMail\\ShadowMail.exe', appData: 'D:\\Profile\\AppData\\Roaming' }

test('the shortcut: a development / test run or another platform NEVER touches one', () => {
  for (const env of [{ ...WIN, isPackaged: false }, { ...WIN, platform: 'linux' }, { ...WIN, platform: 'darwin' }]) {
    const shell = fakeShell()
    const sc = notifyShortcut({ shell, fs: fakeFs(shell), ...env })
    assert.equal(sc.applies, false)
    assert.equal(sc.write(), true)
    assert.equal(sc.ensure(), true)
    assert.equal(sc.remove(), true)
    assert.deepEqual(shell.calls, [], JSON.stringify(env))
  }
})

test('the shortcut on the packaged Windows program: written once with this exe and our AUMID; at start a missing or moved one is written again; ours untouched', () => {
  const logs = []
  const shell = fakeShell()
  const sc = notifyShortcut({ shell, fs: fakeFs(shell), ...WIN, log: l => logs.push(l) })
  assert.equal(sc.applies, true)
  assert.equal(sc.write(), true)
  const writes = () => shell.calls.filter(c => c.op === 'write')
  assert.equal(writes().length, 1)
  const [w] = writes()
  assert.equal(w.file, path.join(WIN.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ShadowMail.lnk'))
  assert.equal(w.file, shortcutPathOf(WIN.appData))
  assert.equal(w.mode, 'create')
  assert.equal(w.opts.target, WIN.execPath)
  assert.equal(w.opts.appUserModelId, APP_USER_MODEL_ID)
  assert.equal(w.opts.icon, WIN.execPath)
  assert.equal(sc.ensure(), true)
  assert.equal(writes().length, 1, 'ours as it is: not written again')
  const moved = fakeShell({ target: 'D:\\Regi\\ShadowMail.exe', appUserModelId: APP_USER_MODEL_ID })
  assert.equal(notifyShortcut({ shell: moved, fs: fakeFs(moved), ...WIN }).ensure(), true)
  assert.equal(moved.calls.filter(c => c.op === 'write').length, 1, 'the folder moved: written again to this exe')
  assert.equal(moved.link.target, WIN.execPath)
  const missing = fakeShell()
  assert.equal(notifyShortcut({ shell: missing, fs: fakeFs(missing), ...WIN }).ensure(), true)
  assert.equal(missing.calls.filter(c => c.op === 'write').length, 1)
  const refused = fakeShell()
  refused.writeResult = false
  assert.equal(notifyShortcut({ shell: refused, fs: fakeFs(refused), ...WIN, log: l => logs.push(l) }).write(), false)
  assert.deepEqual(logs, ['notify shortcut: written', 'notify shortcut: failed (not_written)'])
  assert.ok(logs.every(l => !l.includes('Roaming') && !l.includes('.lnk')))
})

test('the shortcut removed only when it is ours: another target or another AUMID stays', () => {
  const ours = fakeShell({ target: 'c:\\shadowmail\\SHADOWMAIL.exe', appUserModelId: APP_USER_MODEL_ID })
  assert.equal(notifyShortcut({ shell: ours, fs: fakeFs(ours), ...WIN }).remove(), true)
  assert.equal(ours.unlinked, 1, 'the same exe (case and slashes as Windows reads them)')
  for (const link of [{ target: 'C:\\Masik\\Program.exe', appUserModelId: APP_USER_MODEL_ID }, { target: WIN.execPath, appUserModelId: 'Valaki.Mas' }, null]) {
    const shell = fakeShell(link)
    assert.equal(notifyShortcut({ shell, fs: fakeFs(shell), ...WIN }).remove(), true)
    assert.equal(shell.unlinked, undefined, JSON.stringify(link))
  }
})

// --- the switch ---------------------------------------------------------------------------------------------------------

function switchSetup({ setting, ensure = true, write = true, applies = true } = {}) {
  const calls = { ensure: 0, write: 0, remove: 0 }
  const shortcut = { applies, ensure: () => (calls.ensure++, ensure), write: () => (calls.write++, write), remove: () => (calls.remove++, true) }
  const settings = memSettings(setting ? { [NOTIFY_KEY]: setting } : {})
  const index = { get: id => ({ id, account_id: 1, folder: 'INBOX', flags: '', from_addr: 'a@x.invalid', subject: 's' }), folderList: () => [{ path: 'INBOX' }] }
  const shown = []
  const timers = []
  let clock = 1000
  const logs = []
  const n = startNewMailNotice({
    index, store: { getRow: () => ({ id: 1, name: 'A' }) }, settings, shortcut, show: x => shown.push(x), texts, log: l => logs.push(l),
    now: () => clock, settleMs: 3000, setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimer: () => {},
  })
  return { n, calls, settings, shown, timers, logs, tick: ms => (clock += ms) }
}

test('the switch: OFF by default; ON writes the shortcut once then turns on (kept in the settings); a failed write stays OFF with its error; OFF removes it', () => {
  const s = switchSetup()
  assert.deepEqual(s.n.status(), { enabled: false, lost: false })
  assert.equal(s.calls.ensure, 0, 'off: no shortcut is looked at')
  assert.deepEqual(s.n.setEnabled(true), { enabled: true })
  assert.equal(s.calls.write, 1)
  assert.equal(s.settings.get(NOTIFY_KEY), 'on')
  assert.deepEqual(s.n.setEnabled(false), { enabled: false })
  assert.equal(s.calls.remove, 1)
  assert.equal(s.settings.get(NOTIFY_KEY), 'off')
  const f = switchSetup({ write: false })
  assert.deepEqual(f.n.setEnabled(true), { enabled: false, error: 'shortcut_failed' })
  assert.equal(f.settings.get(NOTIFY_KEY), null, 'nothing stored')
  assert.deepEqual(s.logs, ['new mail notice switch on', 'new mail notice switch off'])
})

test('the switch at start: ON checks the shortcut; one that cannot be written turns it OFF and says so (lost)', () => {
  const ok = switchSetup({ setting: 'on' })
  assert.equal(ok.calls.ensure, 1)
  assert.deepEqual(ok.n.status(), { enabled: true, lost: false })
  const bad = switchSetup({ setting: 'on', ensure: false })
  assert.deepEqual(bad.n.status(), { enabled: false, lost: true })
  assert.equal(bad.settings.get(NOTIFY_KEY), 'off')
  bad.n.setEnabled(true)
  assert.equal(bad.n.status().lost, false)
})

test('the first notice after a shortcut write waits until Windows took it in (settleMs); later ones at once', () => {
  const s = switchSetup()
  s.n.setEnabled(true)
  const tell = id => {
    s.n.runEnd({ accountId: 1, kind: 'full', result: 'ok' })
    s.n.inserted([{ id, account_id: 1, folder: 'INBOX' }])
    s.n.runEnd({ accountId: 1, kind: 'targeted', result: 'ok' })
  }
  tell(1)
  assert.equal(s.shown.length, 0)
  assert.equal(s.timers.length, 1)
  assert.equal(s.timers[0].ms, 3000)
  s.timers[0].fn()
  assert.equal(s.shown.length, 1)
  s.tick(3000)
  tell(2)
  assert.equal(s.shown.length, 2, 'after the wait: at once')
  // the switch turned off meanwhile: a waiting notice is dropped
  const t2 = switchSetup()
  t2.n.setEnabled(true)
  t2.n.runEnd({ accountId: 1, kind: 'full', result: 'ok' })
  t2.n.inserted([{ id: 5, account_id: 1, folder: 'INBOX' }])
  t2.n.runEnd({ accountId: 1, kind: 'targeted', result: 'ok' })
  t2.n.setEnabled(false)
  t2.timers[0].fn()
  assert.equal(t2.shown.length, 0)
})

test('IPC: notify:status and notify:setEnabled; a bad argument is bad_request, an untrusted sender is refused, the write error shows', async () => {
  const handlers = new Map()
  const s = switchSetup()
  registerNotifyIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, notice: s.n, isTrustedSender: e => e.ok })
  const call = (c, ...a) => handlers.get(c)({ ok: true }, ...a)
  assert.deepEqual(await call('notify:status'), { ok: true, enabled: false, lost: false })
  assert.deepEqual(await call('notify:status', 1), { ok: false, error: 'bad_request' })
  for (const bad of [[], ['on'], [1], [true, 2]]) assert.deepEqual(await call('notify:setEnabled', ...bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
  assert.deepEqual(await handlers.get('notify:setEnabled')({ ok: false }, true), { ok: false, error: 'untrusted_sender' })
  assert.equal(s.calls.write, 0)
  assert.deepEqual(await call('notify:setEnabled', true), { ok: true, enabled: true })
  const f = switchSetup({ write: false })
  const h2 = new Map()
  registerNotifyIpc({ ipcMain: { handle: (c, fn) => h2.set(c, fn) }, notice: f.n, isTrustedSender: () => true })
  assert.deepEqual(await h2.get('notify:setEnabled')({}, true), { ok: false, error: 'shortcut_failed', enabled: false })
})
