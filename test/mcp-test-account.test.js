// MCP test_account and repeated logins. The login attempts are counted by the fake
// servers (POP3: FakePop3Server.loginAttempts, SMTP: smtp-server's onAuth), the real probe runs:
// a stopped account, a locked one (an auth_failed this tool got) and a second call within 60 s make 0 attempts;
// The user's step unlocks, and after 60 s the tool tries again. The UI's own Kapcsolat próbája is not limited.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SMTPServer } from 'smtp-server'
import { FakePop3Server } from './helpers/fake-pop3.js'
import { createMcpTools, TEST_LOCKED_TEXT, ACCOUNT_STOPPED_TEXT } from '../app/main/mcp/tools.js'
import { createDispatcher } from '../app/main/mcp/protocol.js'
import { testAccountConnection } from '../app/main/ipc/accounts.js'
import { accountEditorForm } from '../core/accounts/defaults.js'

async function setup(t) {
  const pop = await new FakePop3Server({ user: 'u', pass: 'jo-pop' }).listen()
  t.after(() => pop.close?.())
  let smtpAuths = 0
  const smtp = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN'],
    logger: false,
    onAuth: (auth, _s, cb) => (smtpAuths++, auth.password === 'jo-smtp' ? cb(null, { user: auth.username }) : cb(new Error('Invalid username or password'))),
  })
  smtp.on('error', () => {})
  await new Promise(r => smtp.listen(0, '127.0.0.1', r))
  t.after(() => smtp.close())
  const row = {
    id: 1, type: 'pop3', name: 'P', email: 'p@example.invalid', display_name: '', in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: 'u',
    smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none', smtp_user: 'u', smtp_same_password: 0, tls_verify: 0,
    index_years: 3, sync_interval_min: 15, save_sent_to_server: 0, pop3_delete_after_days: 0, signature: '',
  }
  const pw = { incoming: 'rossz-pop', smtp: 'jo-smtp' }
  const store = { list: () => [row], getRow: id => (id === row.id ? row : null), passwordsFor: () => ({ ...pw }) }
  let stopped = false
  const manager = { status: () => [{ accountId: row.id, stopped, errorCode: stopped ? 'auth_failed' : null }] }
  let clock = Date.UTC(2026, 10, 13, 6, 0, 0)
  const tools = createMcpTools({ appVersion: 't', store, index: null, reader: null, manager, testAccount: id => testAccountConnection(accountEditorForm(store.getRow(id)), { store }), now: () => clock })
  const dispatch = createDispatcher({ serverInfo: { name: 's', version: '1' }, tools, log: () => {} })
  let n = 0
  const call = async () => (await dispatch(JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name: 'test_account', arguments: { account_id: row.id } } }))).result
  const attempts = () => pop.loginAttempts + smtpAuths
  return { tools, call, attempts, pw, tick: ms => (clock += ms), stop: v => (stopped = v) }
}

test('test_account: stopped 0, locked after auth_failed 0, within 60 s 0; the user unlocks, 60 s later it tries again', async t => {
  const s = await setup(t)

  s.stop(true)
  const stoppedRes = await s.call()
  assert.equal(stoppedRes._meta['shadowmail/data'].error, 'account_stopped')
  // 0.11.1: the code is in the text too, for the model
  assert.equal(stoppedRes.content[0].text, `${ACCOUNT_STOPPED_TEXT} (hiba: account_stopped)`)
  assert.equal(s.attempts(), 0, '(a) stopped: no login')
  s.stop(false)

  const first = await s.call()
  assert.equal(first.isError, false)
  assert.deepEqual(first._meta['shadowmail/data'].incoming, { ok: false, error: 'auth_failed' })
  const afterFirst = s.attempts()
  assert.ok(afterFirst >= 1)

  s.tick(61_000)
  const locked = await s.call()
  assert.equal(locked._meta['shadowmail/data'].error, 'account_locked_auth')
  assert.equal(locked.content[0].text, `${TEST_LOCKED_TEXT} (hiba: account_locked_auth)`)
  assert.equal(s.attempts(), afterFirst, '(b) locked: no login')

  s.tools.unlockTestAccount(1) // Frissítés / saving the account / a successful Kapcsolat próbája
  s.pw.incoming = 'jo-pop'
  const second = await s.call()
  assert.equal(second.isError, false)
  assert.deepEqual(second._meta['shadowmail/data'], { incoming: { ok: true, error: null }, smtp: { ok: true, error: null }, custom_keywords: null }, 'POP3: no keywords')
  const afterSecond = s.attempts()
  assert.ok(afterSecond > afterFirst)

  s.tick(10_000)
  const limited = await s.call()
  assert.equal(limited._meta['shadowmail/data'].error, 'rate_limited')
  assert.equal(limited._meta['shadowmail/data'].retry_after_s, 50)
  assert.equal(s.attempts(), afterSecond, '(c) within 60 s: no login')

  s.tick(51_000)
  const third = await s.call()
  assert.equal(third.isError, false)
  assert.ok(s.attempts() > afterSecond, 'after 60 s it tries again')
})

test('0.17.0 test_account: custom_keywords true / false / null from the IMAP probe, in the text too; the log line without host and user', async () => {
  const row = {
    id: 1, type: 'imap', name: 'I', email: 'i@example.invalid', display_name: '', in_host: 'imap.titkos-szerver.invalid', in_port: 993, in_security: 'tls', in_user: 'titkos-felhasznalo-77',
    smtp_host: 'smtp.titkos-szerver.invalid', smtp_port: 465, smtp_security: 'tls', smtp_user: 'titkos-felhasznalo-77', smtp_same_password: 1, tls_verify: 1,
    index_years: 3, sync_interval_min: 15, save_sent_to_server: 1, pop3_delete_after_days: 0, signature: '',
  }
  const store = { list: () => [row], getRow: id => (id === row.id ? row : null), passwordsFor: () => ({ incoming: 'x', smtp: null }) }
  let incoming = null
  const probe = async () => ({ incoming, smtp: { ok: true, error: null } })
  const logs = []
  let clock = Date.UTC(2026, 10, 18, 12, 0, 0)
  const tools = createMcpTools({ appVersion: 't', store, index: null, reader: null, manager: { status: () => [] }, testAccount: id => testAccountConnection(accountEditorForm(store.getRow(id)), { store, probe, log: m => logs.push(m) }), now: () => clock })
  const dispatch = createDispatcher({ serverInfo: { name: 's', version: '1' }, tools, log: () => {} })
  let n = 0
  const call = async () => (await dispatch(JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name: 'test_account', arguments: { account_id: row.id } } }))).result
  const cases = [
    [{ ok: true, error: null, keywords: { custom: true, flags: ['\\Seen', '\\*'] } }, true, 'enged (a címkék ennél a fióknál a szerveren tárolódnak).', 'imap probe: custom keywords yes, permanentflags=(\\Seen \\*)'],
    [{ ok: true, error: null, keywords: { custom: false, flags: ['\\Seen'] } }, false, 'nem enged (a címkék ennél a fióknál csak ezen a gépen tárolódnak).', 'imap probe: custom keywords no, permanentflags=(\\Seen)'],
    [{ ok: true, error: null, keywords: { custom: null, flags: null } }, null, 'nem mérhető.', 'imap probe: custom keywords unknown, permanentflags=()'],
  ]
  for (const [inc, want, word, line] of cases) {
    incoming = inc
    clock += 61_000
    const r = await call()
    assert.equal(r.isError, false, r.content[0].text)
    assert.equal(r._meta['shadowmail/data'].custom_keywords, want)
    assert.ok(r.content[0].text.endsWith(` Egyéni címkét a szerver: ${word}`), r.content[0].text)
    assert.doesNotMatch(r.content[0].text, /tájékoztató|helyben tárol/)
    assert.equal(logs.at(-1), line)
  }
  const desc = tools.list().find(x => x.name === 'test_account').description
  assert.match(desc, /with true this account's labels are stored on the server, with false only in this program/)
  assert.doesNotMatch(desc, /only for information|labels are local/)
  // a failed login: not measured, no line in the text, no log line
  incoming = { ok: false, error: 'timeout', detail: 'x' }
  clock += 61_000
  const failed = await call()
  assert.equal(failed._meta['shadowmail/data'].custom_keywords, null)
  assert.doesNotMatch(failed.content[0].text, /Egyéni címkét/)
  assert.equal(logs.length, 3)
  for (const l of logs) for (const secret of ['titkos-szerver', 'titkos-felhasznalo']) assert.ok(!l.includes(secret), l)
})
