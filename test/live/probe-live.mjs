// Live connection test against the dedicated test mailbox. Not part of `npm test`.
//
//   node test/live/probe-live.mjs <path to the test account .env>
//
// The file is parsed here (util.parseEnv), NOT loaded with --env-file: its USER key would lose against
// the shell's own USER variable there.
//
// Keys: IMAP_HOST IMAP_PORT IMAP_SECURITY (ssl|starttls), POP3_HOST POP3_PORT POP3_SECURITY,
//       SMTP_HOST SMTP_PORT SMTP_SECURITY, USER, PASS, EMAIL.
// It creates the account as IMAP and as POP3 in a temporary database (vault + AccountStore, like the
// app does), runs the connection test for the configured settings and for every security mode on its
// default port, checks wrong password / host / port, then deletes the accounts. It never prints the
// password or the env file's content.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'
import net from 'node:net'
import tls from 'node:tls'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore, newAccountDefaults, defaultPort } from '../../core/accounts/model.js'
import { probeAccount } from '../../core/accounts/probe.js'

const envFile = process.argv[2]
if (!envFile || !fs.existsSync(envFile)) {
  console.error('usage: node test/live/probe-live.mjs <test account .env file>')
  process.exit(2)
}
const env = parseEnv(fs.readFileSync(envFile, 'utf8'))
const need = ['IMAP_HOST', 'IMAP_PORT', 'IMAP_SECURITY', 'POP3_HOST', 'POP3_PORT', 'POP3_SECURITY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURITY', 'USER', 'PASS', 'EMAIL']
const missing = need.filter(k => !env[k])
if (missing.length) {
  console.error(`missing keys in the file: ${missing.join(', ')}`)
  process.exit(2)
}
const sec = v => ({ ssl: 'tls', tls: 'tls', starttls: 'starttls', none: 'none' })[String(v).toLowerCase()] || 'invalid'
const PASS = env.PASS
const redact = s => String(s).split(PASS).join('***')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-live-'))
const { db, vault } = await createVaultedDatabase(dir, `live-${Date.now()}-master`) // vault.json + encrypted mail.sqlite
const store = new AccountStore(db, vault, { storeDir: path.join(dir, 'store') })

const form = type => ({
  ...newAccountDefaults(type),
  name: `Tesztfiók (${type})`,
  email: env.EMAIL,
  in_host: type === 'imap' ? env.IMAP_HOST : env.POP3_HOST,
  in_port: Number(type === 'imap' ? env.IMAP_PORT : env.POP3_PORT),
  in_security: sec(type === 'imap' ? env.IMAP_SECURITY : env.POP3_SECURITY),
  in_user: env.USER,
  in_password: PASS,
  smtp_host: env.SMTP_HOST,
  smtp_port: Number(env.SMTP_PORT),
  smtp_security: sec(env.SMTP_SECURITY),
  smtp_same_password: true,
})

const line = (label, r) => `${label}: incoming ${r.incoming.ok ? 'ok' : r.incoming.error} (${r.incoming.ms} ms), smtp ${r.smtp.ok ? 'ok' : r.smtp.error} (${r.smtp.ms} ms)`
const out = []
const results = {}
// Mail servers ban an IP after a few failed logins (measured on a test server): the first
// rejected login stops the whole run, and the wrong-password case is tried exactly once.
const rejected = r => ['auth_failed', 'auth_not_offered'].includes(r.incoming.error) || ['auth_failed', 'auth_not_offered'].includes(r.smtp.error)
let stopped = null

const run = async (key, label, account, passwords) => {
  const r = await probeAccount(account, passwords)
  results[key] = r
  out.push(line(label, r))
  if (rejected(r)) stopped = `${label}: login rejected, stopping here to avoid a lockout`
  return r
}

const accounts = {}
for (const type of ['imap', 'pop3']) {
  const { account } = store.save(form(type))
  accounts[type] = { row: store.getRow(account.id), pw: store.passwordsFor(account.id) }
}

// 0. pre-flight without logging in: every configured port must accept a connection and
//    send a greeting. If one refuses (e.g. an active ban), no login is attempted at all.
const greet = (host, port, security) =>
  new Promise(resolve => {
    const t0 = Date.now()
    const done = (ok, what) => {
      socket.destroy()
      resolve({ ok, what, ms: Date.now() - t0 })
    }
    const socket = security === 'tls'
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false })
      : net.connect({ host, port })
    socket.setTimeout(10_000, () => done(false, 'timeout'))
    socket.once('error', err => done(false, err.code || err.message))
    socket.once('data', d => done(true, String(d).slice(0, 3)))
  })
const preflight = [
  ['imap', env.IMAP_HOST, Number(env.IMAP_PORT), sec(env.IMAP_SECURITY)],
  ['pop3', env.POP3_HOST, Number(env.POP3_PORT), sec(env.POP3_SECURITY)],
  ['smtp', env.SMTP_HOST, Number(env.SMTP_PORT), sec(env.SMTP_SECURITY)],
]
for (const [name, host, port, security] of preflight) {
  const g = await greet(host, port, security)
  out.push(`pre-flight ${name} ${security}:${port}: ${g.ok ? `greeting (${g.what}...)` : `NO CONNECTION (${g.what})`} ${g.ms} ms`)
  if (!g.ok) stopped = `pre-flight: ${name} port ${port} does not answer, no login attempted`
}

// 1. the configured settings, IMAP then POP3
for (const type of ['imap', 'pop3']) {
  if (stopped) break
  const { row, pw } = accounts[type]
  await run(`${type}:configured`, `${type.toUpperCase()} as configured (${row.in_security}:${row.in_port}, smtp ${row.smtp_security}:${row.smtp_port})`, row, { incomingPassword: pw.incoming, smtpPassword: pw.smtp })
}

// 2. the other security modes on their default ports (only with credentials known to work)
for (const type of ['imap', 'pop3']) {
  for (const s of ['tls', 'starttls', 'none']) {
    if (stopped) break
    const { row, pw } = accounts[type]
    if (s === row.in_security && defaultPort(type, s) === row.in_port) continue
    const variant = { ...row, in_security: s, in_port: defaultPort(type, s), smtp_security: s, smtp_port: defaultPort('smtp', s) }
    await run(`${type}:${s}`, `  ${type} ${s} (${variant.in_port}, smtp ${variant.smtp_port})`, variant, { incomingPassword: pw.incoming, smtpPassword: pw.smtp })
  }
}

// 3. failure kinds against the configured IMAP settings; the wrong password exactly once
if (!stopped) {
  const base = accounts.imap.row
  const t0 = Date.now()
  const wrong = await probeAccount(base, { incomingPassword: 'szandekosan-rossz-jelszo', smtpPassword: 'szandekosan-rossz-jelszo' })
  const [host, port] = await Promise.all([
    probeAccount({ ...base, in_host: 'nincs-ilyen-szerver.invalid', smtp_host: 'nincs-ilyen-szerver.invalid' }, { incomingPassword: PASS, smtpPassword: PASS }),
    probeAccount({ ...base, in_port: 1, smtp_port: 1 }, { incomingPassword: PASS, smtpPassword: PASS }),
  ])
  out.push(line('wrong password', wrong))
  out.push(line('wrong host', host))
  out.push(line('wrong port (1)', port))
  out.push(`the three failure cases answered within ${Date.now() - t0} ms`)
}
if (stopped) out.push(`STOPPED: ${stopped}`)

// the password is only in the vault
db.pragma('wal_checkpoint(TRUNCATE)')
const inDb = [file, `${file}-wal`].filter(f => fs.existsSync(f)).some(f => fs.readFileSync(f).includes(Buffer.from(PASS)))
out.push(`password in mail.sqlite: ${inDb ? 'YES (FAIL)' : 'no'}`)

// delete both accounts: no rows left
for (const a of store.list()) store.remove(a.id)
const left = ['messages', 'folders', 'account_secrets'].map(tb => `${tb}=${db.prepare(`SELECT count(*) AS n FROM ${tb}`).get().n}`)
out.push(`after delete: ${left.join(', ')}`)

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(redact(out.join('\n')))
const details = Object.entries(results).flatMap(([k, r]) => ['incoming', 'smtp'].filter(s => !r[s].ok).map(s => `${k} ${s}: ${r[s].detail}`))
if (details.length) console.log(redact(`\nfailure details:\n${details.join('\n')}`))
