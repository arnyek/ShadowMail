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
  assert.deepEqual(second._meta['shadowmail/data'], { incoming: { ok: true, error: null }, smtp: { ok: true, error: null } })
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
