// the "e-mail bomb". The IPC with the real Composer.prepare and a fake window.
// 2.: the composer PAGE measures its sanitized starting body (compose-shape.js, test/compose-shape.test.js);
// here: the window opens hidden, compose:checked shows it, compose:suspect closes it unseen and the MAIN window asks
// (without the quote, or nothing). 1.: the watchdog (no ready in T: closed without a draft, the main window says why).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Composer } from '../app/main/compose.js'
import { registerComposeIpc, SHAPE_LIMIT, SWITCH_LIMIT, READY_TIMEOUT_MS, readyTimeoutFrom } from '../app/main/ipc/compose.js'
import { hu } from '../app/renderer/i18n/hu.js'
import { tempDir } from './helpers/tmp.js'

const cp = n => String.fromCodePoint(n)
const fill = (unit, bytes) => unit.repeat(Math.floor(bytes / Buffer.byteLength(unit)))
const MB2 = 2 * 1024 * 1024
const sleep = ms => new Promise(r => setTimeout(r, ms))

function eml({ html, attachment = false }) {
  const head = 'From: Feladó <felado@example.invalid>\r\nTo: me@example.invalid\r\nSubject: Bomba próba\r\nDate: Fri, 13 Nov 2026 10:00:00 +0100\r\nMessage-ID: <v1@example.invalid>\r\nMIME-Version: 1.0\r\n'
  if (!attachment) return Buffer.from(`${head}Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html}\r\n`)
  return Buffer.from(
    `${head}Content-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html}\r\n` +
      `--B\r\nContent-Type: application/pdf; name="szamla.pdf"\r\nContent-Disposition: attachment; filename="szamla.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('%PDF-1.4 v1').toString('base64')}\r\n--B--\r\n`,
  )
}

const BOMB = `<p>${fill(`x${cp(0x5d0)}`, MB2 - 7)}</p>`

function setup(t, { source, readyTimeoutMs = READY_TIMEOUT_MS, answer = 'cancel' } = {}) {
  const reader = { source: async id => ({ row: { id, account_id: 1, message_id: '<v1@example.invalid>' }, source }) }
  const store = { getRow: () => ({ id: 1, email: 'me@example.invalid' }), list: () => [{ id: 1, email: 'me@example.invalid' }] }
  // an index that knows no row: no open draft is found for an id (sessionOfDraft)
  const composer = new Composer({ index: { get: () => null }, store, contacts: null, storeDir: tempDir(t), withConnection: async () => {}, reader })
  const handlers = new Map()
  const wins = []
  const asked = []
  const stalled = []
  const logged = []
  const mainWin = { name: 'main', isDestroyed: () => false }
  const ipc = registerComposeIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    composer,
    store,
    contacts: { suggest: () => [] },
    openWindow: id => {
      const listeners = {}
      const win = {
        id,
        destroyed: false,
        destroyCalls: 0,
        on: (ev, fn) => (listeners[ev] = fn),
        isDestroyed: () => win.destroyed,
        close: () => {},
        shown: 0,
        show() {
          win.shown++
        },
        destroy() {
          win.destroyCalls++
          win.destroyed = true
          if (listeners.closed) listeners.closed() // like Electron: destroy() emits 'closed' (not 'close')
        },
      }
      wins.push(win)
      return win
    },
    dialog: {},
    // the sender: the main window, or the composer window of the session the event names
    windowOf: e => e.win || mainWin,
    isTrustedSender: e => e.ok,
    log: m => logged.push(m),
    readyTimeoutMs,
    omittedText: hu.composeBodyOmitted,
    askSuspect: async (win, q) => {
      asked.push({ win, ...q })
      return answer
    },
    onStalled: s => stalled.push(s),
  })
  const call = (ch, ...args) => handlers.get(ch)({ ok: true }, ...args)
  const callFrom = (win, ch, ...args) => handlers.get(ch)({ ok: true, win }, ...args)
  // the page of the session's window found its starting body suspect; the question runs on its own: wait for it
  const suspect = async (win, sessionId, ...reason) => {
    const n = asked.length
    const r = await callFrom(win, 'compose:suspect', sessionId, ...reason)
    for (let i = 0; i < 100 && asked.length === n; i++) await sleep(5)
    for (let i = 0; i < 20; i++) await sleep(5) // a reopening (prepare) after the answer
    return r
  }
  return { composer, wins, asked, stalled, logged, ipc, call, callFrom, suspect, mainWin }
}

test('a reply opens a HIDDEN window and asks nothing; compose:checked from its own window shows it', async t => {
  const s = setup(t, { source: eml({ html: BOMB }) })
  const res = await s.call('compose:open', { mode: 'reply', messageId: 7 })
  assert.equal(res.ok, true)
  const [win] = s.wins
  assert.equal(win.shown, 0, 'not shown before the page measured its body')
  assert.equal(s.asked.length, 0, 'the main process does not measure')
  await s.callFrom(s.mainWin, 'compose:checked', res.sessionId) // another window: nothing
  assert.equal(win.shown, 0)
  assert.deepEqual(await s.callFrom(win, 'compose:checked', res.sessionId), { ok: true })
  assert.equal(win.shown, 1)
})

test('compose:suspect: the window goes unseen, the session ends, the MAIN window asks; [Mégse]: nothing more', async t => {
  const s = setup(t, { source: eml({ html: BOMB }), answer: 'cancel' })
  const res = await s.call('compose:open', { mode: 'reply', messageId: 7 })
  const [win] = s.wins
  assert.deepEqual(await s.suspect(win, res.sessionId), { ok: true })
  assert.equal(win.destroyCalls, 1)
  assert.equal(win.shown, 0, 'never shown')
  assert.equal(s.composer.sessions.size, 0, 'no session left')
  assert.equal(s.asked.length, 1)
  assert.equal(s.asked[0].win, s.mainWin, 'asked in the window that asked for the reply (the main window)')
  assert.deepEqual({ mode: s.asked[0].mode, limit: s.asked[0].limit, reason: s.asked[0].reason }, { mode: 'reply', limit: SHAPE_LIMIT, reason: 'run' }, 'no reason given: a run over N')
  assert.equal(s.wins.length, 1, 'no other window')
  assert.ok(s.logged.some(l => /over the limit \(reply\): cancelled/.test(l)))
  assert.ok(!s.logged.join('\n').includes(cp(0x5d0)), 'no text of the message in the log')
  await sleep(50)
  assert.equal(s.stalled.length, 0, 'no watchdog notice after it')
})

test('[Idézet nélkül]: a new hidden window with the header line and the omitted line, no text of the original', async t => {
  const s = setup(t, { source: eml({ html: BOMB }), answer: 'omit' })
  const res = await s.call('compose:open', { mode: 'replyAll', messageId: 7 })
  await s.suspect(s.wins[0], res.sessionId)
  assert.equal(s.wins.length, 2, 'the second window: without the quote')
  assert.equal(s.composer.sessions.size, 1, 'the first session closed, one new')
  const [sid] = s.composer.sessions.keys()
  const init = await s.call('compose:initial', sid)
  assert.match(init.form.quote, /írta:<\/p><blockquote>/)
  assert.ok(init.form.quote.includes(hu.composeBodyOmitted))
  assert.ok(!init.form.quote.includes(cp(0x5d0)), 'not a character of the original body')
  assert.equal(init.form.subject, 'Re: Bomba próba')
  assert.equal(init.form.to, 'Feladó <felado@example.invalid>')
  assert.equal(init.form.inReplyTo, '<v1@example.invalid>')
  assert.equal(s.wins[1].shown, 0, 'hidden until its own page checked it too')
  assert.ok(s.logged.some(l => /over the limit \(reply\): opened without the quote/.test(l)))
})

test('a forward without the quote: the forwarded header and the omitted line; the attachments go once', async t => {
  const s = setup(t, { source: eml({ html: BOMB, attachment: true }), answer: 'omit' })
  const res = await s.call('compose:open', { mode: 'forward', messageId: 7 })
  await s.suspect(s.wins[0], res.sessionId)
  assert.equal(s.asked[0].mode, 'forward')
  const [sid] = s.composer.sessions.keys()
  const init = await s.call('compose:initial', sid)
  assert.match(init.form.quote, /^<p>-------- Továbbított üzenet --------<br>Feladó: /)
  assert.match(init.form.quote, /Tárgy: Bomba próba/)
  assert.ok(init.form.quote.includes(hu.composeBodyOmitted))
  assert.ok(!init.form.quote.includes(cp(0x5d0)))
  assert.deepEqual(init.attachments.map(a => a.filename), ['szamla.pdf'], 'one copy of the attachment (the first session dropped)')
})

test('a draft and a mailto link: only cancel (nothing to leave out), even if the answer were "omit"', async t => {
  const s = setup(t, { source: eml({ html: BOMB }), answer: 'omit' })
  s.composer.prepare = async () => ({ accountId: 1, draftHtml: BOMB })
  const res = await s.call('compose:open', { mode: 'draft', messageId: 7 })
  await s.suspect(s.wins[0], res.sessionId)
  assert.equal(s.asked[0].mode, 'draft')
  assert.equal(s.wins.length, 1, 'no second window')
  assert.equal(s.composer.sessions.size, 0)
  const m = setup(t, { answer: 'omit' })
  assert.equal(m.ipc.openMailto('mailto:a@example.invalid?body=x'), true)
  const [mid] = m.composer.sessions.keys()
  await m.suspect(m.wins[0], mid)
  assert.deepEqual({ mode: m.asked[0].mode, win: m.asked[0].win }, { mode: 'mailto', win: null })
  assert.equal(m.wins.length, 1)
})

test('compose:suspect from another window, or after the watchdog: nothing', async t => {
  const s = setup(t, { source: eml({ html: '<p>rövid</p>' }), readyTimeoutMs: 60 })
  const a = await s.call('compose:open', { mode: 'reply', messageId: 7 })
  const b = await s.call('compose:open', { mode: 'reply', messageId: 7 })
  const [winA, winB] = s.wins
  await s.callFrom(winB, 'compose:suspect', a.sessionId)
  assert.equal(winA.destroyCalls, 0, 'B cannot speak for A')
  assert.equal(s.asked.length, 0)
  await sleep(120) // both stalled now
  assert.equal(s.stalled.length, 2)
  assert.deepEqual(await s.callFrom(winB, 'compose:suspect', b.sessionId), { ok: true })
  await sleep(30)
  assert.equal(s.asked.length, 0, 'too late: no question')
})

test('compose:suspect after the page already said ready: nothing (the window stays, no question)', async t => {
  const s = setup(t, { source: eml({ html: '<p>rövid</p>' }) })
  const r = await s.call('compose:open', { mode: 'reply', messageId: 7 })
  const [win] = s.wins
  await s.callFrom(win, 'compose:checked', r.sessionId)
  await s.callFrom(win, 'compose:ready', r.sessionId)
  await s.callFrom(win, 'compose:suspect', r.sessionId)
  await sleep(30)
  assert.equal(win.destroyCalls, 0)
  assert.equal(s.asked.length, 0)
})

test('no ready in T: the window is destroyed (no close question), the session ends, the main window is told; a late ready does nothing', async t => {
  const s = setup(t, { source: eml({ html: '<p>rövid</p>' }), readyTimeoutMs: 80 })
  const res = await s.call('compose:open', { mode: 'forward', messageId: 7 })
  const [win] = s.wins
  await sleep(40)
  assert.equal(win.destroyCalls, 0)
  await sleep(100)
  assert.equal(win.destroyCalls, 1)
  assert.equal(s.composer.sessions.size, 0, 'the session ended')
  assert.deepEqual(s.stalled, [{ kind: 'forward', seconds: 0.08 }])
  assert.deepEqual(await s.callFrom(win, 'compose:ready', res.sessionId), { ok: true })
  await sleep(100)
  assert.equal(win.destroyCalls, 1)
  assert.equal(s.stalled.length, 1)
})

test('a ready in time stops the watchdog; only the window of that session can say it', async t => {
  const s = setup(t, { source: eml({ html: '<p>rövid</p>' }), readyTimeoutMs: 80 })
  const a = await s.call('compose:open', { mode: 'reply', messageId: 7 })
  const b = await s.call('compose:open')
  const [winA, winB] = s.wins
  await s.callFrom(winB, 'compose:ready', a.sessionId) // the wrong window: nothing
  await s.callFrom(winB, 'compose:ready', b.sessionId)
  await sleep(150)
  assert.equal(winA.destroyCalls, 1, 'A never said it was ready')
  assert.equal(winB.destroyCalls, 0)
  assert.deepEqual(s.stalled, [{ kind: 'reply', seconds: 0.08 }])
  assert.deepEqual(await s.call('compose:ready', 'nem-session'), { ok: false, error: 'bad_request' })
})

test('a new message and a mailto: link are watched too; T is 5 s by default', async t => {
  assert.equal(READY_TIMEOUT_MS, 5000)
  assert.equal(SHAPE_LIMIT, 40_000)
  const s = setup(t, { readyTimeoutMs: 50 })
  await s.call('compose:open')
  assert.equal(s.ipc.openMailto('mailto:a@example.invalid?body=x'), true)
  await sleep(120)
  assert.deepEqual(s.stalled, [{ kind: 'new', seconds: 0.05 }, { kind: 'mailto', seconds: 0.05 }])
})

test('the test switch can only make T shorter: 100..T, anything else is T', () => {
  assert.equal(readyTimeoutFrom('200'), 200)
  assert.equal(readyTimeoutFrom(' 100 '), 100)
  assert.equal(readyTimeoutFrom('5000'), 5000)
  for (const v of [undefined, null, '', '0', '99', '-200', '5001', '60000', 'abc', '2e3', '1.5', '0x100', '200ms', 200, '9999999']) {
    assert.equal(readyTimeoutFrom(v), READY_TIMEOUT_MS, String(v))
  }
})

test('the texts of the card', () => {
  assert.equal(
    hu.composeStalled('reply', 5),
    'A levél hibás vagy káros tartalmú lehet: a válasz szerkesztője 5 másodperc alatt sem nyílt meg, ezért bezártam. Az eredeti levél nem változott.',
  )
  assert.match(hu.composeStalled('forward', 5), /: a továbbítás szerkesztője 5 másodperc/)
  assert.match(hu.composeStalled('draft', 5), /: a piszkozat szerkesztője 5 másodperc/)
  assert.match(hu.composeStalled('reply', 0.2), /szerkesztője 0,2 másodperc alatt/, 'the test switch: the real T')
  assert.equal(hu.composeStalled('new', 5), 'Az új levél szerkesztője 5 másodperc alatt sem nyílt meg, ezért bezártam.')
  assert.equal(hu.composeStalled('mailto', 5), 'A levélhivatkozásból nyitott szerkesztő 5 másodperc alatt sem nyílt meg, ezért bezártam. A hivatkozás hibás vagy káros tartalmú lehet.')
  assert.equal(
    hu.composeSuspectText('reply', 40_000).replace(/ /g, ' '),
    'A levél hibás vagy káros tartalmú lehet: egyetlen, 40 000 karakternél hosszabb, tördeletlen szövegrészt tartalmaz. Megnyitod a választ az eredeti szöveg idézése nélkül?',
  )
  assert.match(hu.composeSuspectText('forward', 40_000), /Megnyitod a továbbítást az eredeti szöveg idézése nélkül\?$/)
  assert.match(hu.composeSuspectText('draft', 40_000), /A piszkozat ezért nem nyílik meg\.$/)
  assert.equal(hu.composeSuspectText('mailto', 40_000).replace(/\u00a0/g, ' '), 'A levélhivatkozás hibás vagy káros tartalmú lehet: egyetlen, 40 000 karakternél hosszabb, tördeletlen szövegrészt tartalmaz. A szerkesztő ezért nem nyílik meg.')
  assert.match(hu.composeSuspectText('new', 40_000), /^A levél .*A szerkesztő ezért nem nyílik meg\.$/)
  assert.equal(hu.composeBodyOmitted, '[Az eredeti levél szövege kimaradt: hibás vagy káros tartalmú lehet.]')
})

test('one draft, one composer: opening the same draft again brings its shown window forward; a hidden one stays hidden', async t => {
  const s = setup(t, { source: eml({ html: '<p>rövid</p>' }) })
  const ids = { 7: '<d1@example.invalid>', 8: 'd2@example.invalid' }
  s.composer.index = { get: id => (ids[id] ? { id, account_id: 1, message_id: ids[id] } : null) }
  s.composer.prepare = async (sid, req) => {
    const ses = s.composer.sessions.get(sid)
    ses.messageId = `<${String(ids[req.messageId]).replace(/^<|>$/g, '')}>` // as the real draft branch stores it
    ses.draftAccountId = 1
    return { accountId: 1, draftHtml: '<p>x</p>' }
  }
  const watch = win => Object.assign(win, { focused: 0, isMinimized: () => false, restore() {}, focus() { win.focused++ } })
  const a = await s.call('compose:open', { mode: 'draft', messageId: 7 })
  const [win] = s.wins
  watch(win)
  const again = await s.call('compose:open', { mode: 'draft', messageId: 7 })
  assert.deepEqual({ ok: again.ok, sessionId: again.sessionId, existing: again.existing }, { ok: true, sessionId: a.sessionId, existing: true })
  assert.equal(s.wins.length, 1, 'no second window')
  assert.equal(win.shown, 0, 'still being checked by its page: not shown early')
  await s.callFrom(win, 'compose:checked', a.sessionId)
  assert.equal(win.shown, 1)
  await s.call('compose:open', { mode: 'draft', messageId: 7 })
  assert.deepEqual({ windows: s.wins.length, shown: win.shown, focused: win.focused }, { windows: 1, shown: 2, focused: 1 })
  const other = await s.call('compose:open', { mode: 'draft', messageId: 8 })
  assert.equal(s.wins.length, 2, 'another draft: its own window')
  assert.notEqual(other.sessionId, a.sessionId)
  win.destroy()
  const reopened = await s.call('compose:open', { mode: 'draft', messageId: 7 })
  assert.equal(s.wins.length, 3, 'its window closed: a new one')
  assert.notEqual(reopened.sessionId, a.sessionId)
})

test('one draft, one composer: requests that come while its composer is being prepared get that one, not a second window', async t => {
  const s = setup(t, { source: eml({ html: '<p>rövid</p>' }) })
  s.composer.index = { get: id => (id === 7 ? { id, account_id: 1, message_id: '<d1@example.invalid>' } : null) }
  let prepares = 0
  let fail = false
  s.composer.prepare = async sid => {
    prepares++
    await sleep(30) // the second click comes while this one still reads the draft
    if (fail) throw new Error('read_failed')
    const ses = s.composer.sessions.get(sid)
    ses.messageId = '<d1@example.invalid>'
    ses.draftAccountId = 1
    return { accountId: 1, draftHtml: '<p>x</p>' }
  }
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => s.call('compose:open', { mode: 'draft', messageId: 7 })))
  assert.deepEqual({ windows: s.wins.length, prepares }, { windows: 1, prepares: 1 }, 'three requests at once: one prepare, one window')
  assert.equal(a.existing, undefined)
  assert.deepEqual([b, c].map(r => ({ sessionId: r.sessionId, existing: r.existing })), [{ sessionId: a.sessionId, existing: true }, { sessionId: a.sessionId, existing: true }])
  s.wins[0].destroy()
  // the first open fails: the waiting one tries itself (and fails the same way), nothing is left waiting
  fail = true
  const both = await Promise.all([1, 2].map(() => s.call('compose:open', { mode: 'draft', messageId: 7 })))
  assert.deepEqual(both.map(r => r.ok), [false, false], JSON.stringify(both))
  assert.deepEqual({ windows: s.wins.length, prepares, sessions: s.composer.sessions.size }, { windows: 1, prepares: 3, sessions: 0 })
  fail = false
  const later = await s.call('compose:open', { mode: 'draft', messageId: 7 })
  assert.equal(s.wins.length, 2, 'then a new window opens as usual')
  assert.notEqual(later.sessionId, a.sessionId)
})

test('compose:suspect with the reason "switches": the question names B and its own text; any other reason is a run over N', async t => {
  for (const [given, want, limit, logged] of [
    [['switches'], 'switches', SWITCH_LIMIT, /a block with too many direction switches \(reply\): cancelled/],
    [['run'], 'run', SHAPE_LIMIT, /a run of text over the limit \(reply\): cancelled/],
    [['x'], 'run', SHAPE_LIMIT, /a run of text over the limit/],
    [[{ reason: 'switches' }], 'run', SHAPE_LIMIT, /a run of text over the limit/],
  ]) {
    const s = setup(t, { source: eml({ html: BOMB }), answer: 'cancel' })
    const res = await s.call('compose:open', { mode: 'reply', messageId: 7 })
    const [win] = s.wins
    assert.deepEqual(await s.suspect(win, res.sessionId, ...given), { ok: true })
    assert.deepEqual([s.asked[0].reason, s.asked[0].limit], [want, limit], JSON.stringify(given))
    assert.ok(s.logged.some(l => logged.test(l)), JSON.stringify(s.logged))
    assert.equal(win.shown, 0, 'never shown')
  }
  assert.equal(SWITCH_LIMIT, 50_000)
  assert.equal(
    hu.composeSuspectSlowText('reply'),
    'A levél hibás vagy káros tartalmú lehet: egyetlen bekezdése túl sok, lassan megjeleníthető karaktert tartalmaz. Megnyitod a választ az eredeti szöveg idézése nélkül?',
  )
  assert.match(hu.composeSuspectSlowText('forward'), /Megnyitod a továbbítást az eredeti szöveg idézése nélkül\?$/)
  assert.match(hu.composeSuspectSlowText('draft'), /: egyetlen bekezdése .*A piszkozat ezért nem nyílik meg\.$/)
  assert.match(hu.composeSuspectSlowText('mailto'), /^A levélhivatkozás .*A szerkesztő ezért nem nyílik meg\.$/)
  assert.match(hu.composeSuspectSlowText('new'), /^A levél .*A szerkesztő ezért nem nyílik meg\.$/)
})
