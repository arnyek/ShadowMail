// Connection test against local fake servers: every failure kind gets its own code (and Hungarian
// text), each within 30 s. No network: everything listens on 127.0.0.1, the unknown host is .invalid.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SMTPServer } from 'smtp-server'
import { onCleanup } from './helpers/tmp.js'
import { startImap, startPop3, startSilent, closedPort, selfSignedCert } from './helpers/fake-servers.js'
import { probeImap, probePop3, probeSmtp, probeAccount, classifyError, PROBE_ERRORS } from '../core/accounts/probe.js'
import { hu } from '../app/renderer/i18n/hu.js'

const USER = 'teszt@example.invalid'
const PASS = 'Helyes-Jelszo-123'
const FAST = { timeoutMs: 3000 }

const imapAcc = (port, over = {}) => ({ type: 'imap', in_host: '127.0.0.1', in_port: port, in_security: 'none', in_user: USER, tls_verify: 1, ...over })
const pop3Acc = (port, over = {}) => ({ type: 'pop3', in_host: '127.0.0.1', in_port: port, in_security: 'none', in_user: USER, tls_verify: 1, ...over })
const smtpAcc = (port, over = {}) => ({ smtp_host: '127.0.0.1', smtp_port: port, smtp_security: 'none', smtp_user: USER, in_user: USER, tls_verify: 1, ...over })

async function startSmtp(t, { secure = false, cert = null } = {}) {
  const server = new SMTPServer({
    secure,
    ...(cert || {}),
    // no STARTTLS at all (hideSTARTTLS only hides it: nodemailer's requireTLS would still try it
    // and hit smtp-server's built-in, expired certificate)
    disabledCommands: secure ? [] : ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN'],
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === USER && auth.password === PASS) cb(null, { user: USER })
      else cb(new Error('Invalid username or password'))
    },
  })
  server.on('error', () => {}) // a client that rejects our test certificate is an expected error
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  onCleanup(t, () => new Promise(r => server.close(r)))
  return server.server.address().port
}

test('IMAP: right password ok, wrong password auth_failed', async t => {
  const port = await startImap(t, { user: USER, pass: PASS })
  assert.equal((await probeImap(imapAcc(port), PASS, FAST)).ok, true)
  const bad = await probeImap(imapAcc(port), 'rossz-jelszo', FAST)
  assert.deepEqual([bad.ok, bad.error], [false, 'auth_failed'])
})

test('POP3: right password ok, wrong password auth_failed; STLS required but not offered -> starttls_unsupported', async t => {
  const port = await startPop3(t, { user: USER, pass: PASS })
  assert.equal((await probePop3(pop3Acc(port), PASS, FAST)).ok, true)
  assert.equal((await probePop3(pop3Acc(port), 'rossz-jelszo', FAST)).error, 'auth_failed')
  assert.equal((await probePop3(pop3Acc(port, { in_security: 'starttls' }), PASS, FAST)).error, 'starttls_unsupported')
})

test('SMTP: right password ok, wrong password auth_failed, STARTTLS required but hidden -> starttls_unsupported', async t => {
  const port = await startSmtp(t)
  assert.equal((await probeSmtp(smtpAcc(port), PASS, FAST)).ok, true)
  assert.equal((await probeSmtp(smtpAcc(port), 'rossz-jelszo', FAST)).error, 'auth_failed')
  assert.equal((await probeSmtp(smtpAcc(port, { smtp_security: 'starttls' }), PASS, FAST)).error, 'starttls_unsupported')
})

test('SMTP without AUTH on offer is not "ok": the password was never checked (auth_not_offered)', async t => {
  const server = new SMTPServer({ disabledCommands: ['STARTTLS', 'AUTH'], logger: false })
  server.on('error', () => {})
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  onCleanup(t, () => new Promise(r => server.close(r)))
  const r = await probeSmtp(smtpAcc(server.server.address().port), PASS, FAST)
  assert.deepEqual([r.ok, r.error], [false, 'auth_not_offered'])
  assert.notEqual(hu.probeError('auth_not_offered'), hu.probeError('auth_failed'))
})

test('unknown host, closed port, silent server: three different codes, each well within 30 s', async t => {
  const refused = await closedPort()
  const silent = await startSilent(t)
  const t0 = performance.now()
  const results = await Promise.all([
    probeImap(imapAcc(993, { in_host: 'nincs-ilyen-szerver.invalid' }), PASS, FAST),
    probeImap(imapAcc(refused), PASS, FAST),
    probeImap(imapAcc(silent), PASS, { timeoutMs: 1500 }),
    probePop3(pop3Acc(refused), PASS, FAST),
    probeSmtp(smtpAcc(refused), PASS, FAST),
    probeSmtp(smtpAcc(silent), PASS, { timeoutMs: 1500 }),
  ])
  assert.deepEqual(results.map(r => r.error), ['host_not_found', 'connection_refused', 'timeout', 'connection_refused', 'connection_refused', 'timeout'])
  assert.ok(performance.now() - t0 < 30_000)
  const texts = new Set(['host_not_found', 'connection_refused', 'timeout', 'auth_failed'].map(c => hu.probeError(c)))
  assert.equal(texts.size, 4, 'different Hungarian messages')
})

test('the default per-leg limit keeps a silent server under 30 s', async t => {
  const silent = await startSilent(t)
  const r = await probeAccount({ ...imapAcc(silent), ...smtpAcc(silent) }, { incomingPassword: PASS, smtpPassword: PASS })
  assert.equal(r.incoming.error, 'timeout')
  assert.equal(r.smtp.error, 'timeout')
  assert.ok(r.incoming.ms < 30_000 && r.smtp.ms < 30_000, `${r.incoming.ms} / ${r.smtp.ms} ms`)
})

test('TLS: self-signed certificate -> tls_certificate; with verification off it connects; TLS on a plain port -> tls_mismatch', async t => {
  const cert = selfSignedCert(t)
  if (!cert) return t.skip('openssl not available')
  const imapTls = await startImap(t, { user: USER, pass: PASS, tlsCert: cert })
  const pop3Tls = await startPop3(t, { user: USER, pass: PASS, tlsCert: cert, implicitTls: true })
  const smtpTls = await startSmtp(t, { secure: true, cert })
  const plainImap = await startImap(t, { user: USER, pass: PASS })

  assert.equal((await probeImap(imapAcc(imapTls, { in_security: 'tls' }), PASS, FAST)).error, 'tls_certificate')
  assert.equal((await probeImap(imapAcc(imapTls, { in_security: 'tls', tls_verify: 0 }), PASS, FAST)).ok, true)
  assert.equal((await probePop3(pop3Acc(pop3Tls, { in_security: 'tls' }), PASS, FAST)).error, 'tls_certificate')
  assert.equal((await probePop3(pop3Acc(pop3Tls, { in_security: 'tls', tls_verify: 0 }), PASS, FAST)).ok, true)
  assert.equal((await probeSmtp(smtpAcc(smtpTls, { smtp_security: 'tls' }), PASS, FAST)).error, 'tls_certificate')
  assert.equal((await probeSmtp(smtpAcc(smtpTls, { smtp_security: 'tls', tls_verify: 0 }), PASS, FAST)).ok, true)
  assert.equal((await probeImap(imapAcc(plainImap, { in_security: 'tls' }), PASS, FAST)).error, 'tls_mismatch')
})

test('POP3 STLS upgrade works when offered (with verification off for the self-signed test certificate)', async t => {
  const cert = selfSignedCert(t)
  if (!cert) return t.skip('openssl not available')
  const port = await startPop3(t, { user: USER, pass: PASS, tlsCert: cert, offerStls: true })
  assert.equal((await probePop3(pop3Acc(port, { in_security: 'starttls', tls_verify: 0 }), PASS, FAST)).ok, true)
  assert.equal((await probePop3(pop3Acc(port, { in_security: 'starttls' }), PASS, FAST)).error, 'tls_certificate')
})

test('the password never appears in a result detail; every code has a Hungarian text', async t => {
  const port = await startPop3(t, { user: USER, pass: PASS })
  const r = await probePop3(pop3Acc(port), 'Titkos-Rossz-Jelszo', FAST)
  assert.equal(JSON.stringify(r).includes('Titkos-Rossz-Jelszo'), false)
  for (const code of PROBE_ERRORS) assert.ok(hu.probeErrors[code], code)
  assert.equal(classifyError({ code: 'EAUTH' }), 'auth_failed')
  assert.equal(classifyError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), 'tls_certificate')
  assert.equal(classifyError({ code: 'ERR_SSL_WRONG_VERSION_NUMBER', message: 'wrong version number' }), 'tls_mismatch')
})

test('POP3: a server that refuses an unknown user already at USER -> auth_failed, not unknown', async t => {
  const port = await startPop3(t, { user: USER, pass: PASS, rejectUnknownUser: true })
  const res = await probePop3(pop3Acc(port, { in_user: 'nincs-ilyen@example.invalid' }), PASS, FAST)
  assert.equal(res.error, 'auth_failed', res.detail)
  assert.equal((await probePop3(pop3Acc(port), PASS, FAST)).ok, true)
})

test('POP3: CR/LF in the user or the password never reaches the server as a second command', async t => {
  const port = await startPop3(t, { user: USER, pass: PASS })
  assert.equal((await probePop3(pop3Acc(port, { in_user: `${USER}\r\nDELE 1` }), PASS, FAST)).error, 'auth_failed')
  assert.equal((await probePop3(pop3Acc(port), `${PASS}\r\nDELE 1`, FAST)).error, 'auth_failed')
})

// --- 0.17.0: custom keywords (PERMANENTFLAGS of a SELECT INBOX in the probe's own login), only for information --------
const WRITES = ['STORE', 'UID', 'APPEND', 'EXPUNGE', 'CREATE', 'DELETE', 'RENAME', 'COPY', 'MOVE', 'SUBSCRIBE']
const count = (cmds, name) => cmds.filter(c => c === name || c.startsWith(`${name} `)).length

test('custom keywords: \\* in PERMANENTFLAGS = allowed, without it = not allowed; one LOGIN, one SELECT INBOX (read-write, not EXAMINE), no write', async t => {
  for (const [select, custom, flags] of [['star', true, ['\\Seen', '\\Flagged', '\\*']], ['nostar', false, ['\\Seen', '\\Flagged']]]) {
    const commands = []
    const port = await startImap(t, { user: USER, pass: PASS, select, commands })
    const res = await probeImap(imapAcc(port), PASS, FAST)
    assert.equal(res.ok, true, select)
    assert.deepEqual(res.keywords, { custom, flags }, select)
    assert.equal(count(commands, 'LOGIN'), 1, `${select}: one login`)
    assert.deepEqual(commands.filter(c => /^(SELECT|EXAMINE) /.test(c)), ['SELECT INBOX'], `${select}: ${commands.join(',')}`)
    assert.ok(!commands.some(c => WRITES.includes(c.split(' ')[0])), `${select}: no write: ${commands.join(',')}`)
    assert.equal(count(commands, 'LOGOUT'), 1)
  }
})

test('custom keywords not measurable: SELECT NO, no PERMANENTFLAGS line, a silent SELECT; the probe stays ok, still one login', async t => {
  for (const select of ['no', 'none']) {
    const commands = []
    const port = await startImap(t, { user: USER, pass: PASS, select, commands })
    const res = await probeImap(imapAcc(port), PASS, FAST)
    assert.deepEqual([res.ok, res.keywords], [true, { custom: null, flags: null }], select)
    assert.equal(count(commands, 'LOGIN'), 1, select)
  }
  const commands = []
  const closes = { n: 0 }
  const port = await startImap(t, { user: USER, pass: PASS, select: 'hang', commands, closes })
  const t0 = Date.now()
  const res = await probeImap(imapAcc(port), PASS, { ...FAST, keywordsMs: 300 })
  assert.deepEqual([res.ok, res.keywords], [true, { custom: null, flags: null }], 'a silent SELECT: unknown, not a failed probe')
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms: the SELECT's own limit, not the probe's`)
  assert.equal(count(commands, 'LOGOUT'), 0, 'the busy connection is closed, no LOGOUT behind the silent SELECT')
  await new Promise(r => setTimeout(r, 300))
  assert.equal(closes.n, 1, 'the connection is gone, not left open behind the silent SELECT')
})

test('custom keywords: a refused login sends no SELECT and gives no keywords; odd flag names are cut to printable ASCII, at most 30', async t => {
  const commands = []
  const port = await startImap(t, { user: USER, pass: PASS, select: 'star', commands })
  const bad = await probeImap(imapAcc(port), 'rossz-jelszo', FAST)
  assert.deepEqual([bad.ok, bad.keywords], [false, undefined])
  assert.equal(commands.filter(c => c.startsWith('SELECT')).length, 0)
  const many = `(${Array.from({ length: 40 }, (_, i) => `$K${i}`).join(' ')} \\*)`
  const port2 = await startImap(t, { user: USER, pass: PASS, select: many })
  const res = await probeImap(imapAcc(port2), PASS, FAST)
  assert.equal(res.keywords.custom, true, 'the \\* is read from the whole list')
  assert.equal(res.keywords.flags.length, 30)
  // POP3 has no keywords line
  const pop = await startPop3(t, { user: USER, pass: PASS })
  assert.equal((await probePop3(pop3Acc(pop), PASS, FAST)).keywords, undefined)
})
