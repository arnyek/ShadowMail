#!/usr/bin/env node
// The longest keyword the live test server takes (not part of `npm test`; the (e) part of label-keyword-live.mjs,
// with the server's own answer). One login; a folder made for the run, one APPENDed message, deleted at the end.
//
//   node test/live/label-keyword-length-live.mjs <test account .env file>
//
// Tries keywords of 50, 51, 64 and 100 characters with a raw STORE (imapflow's exec, so nothing is dropped on the client
// side) and prints the tagged answer of each, and whether the keyword comes back in FETCH FLAGS. Only the STORE answers
// are printed, never the login.
import { loadEnv, preflight, sideClient, checker, redactor } from './live-lib.mjs'

const [envFile] = process.argv.slice(2)
const env = loadEnv(envFile)
const hide = redactor(env)
const check = checker()
const run = Date.now().toString(36)

await preflight(env)
const client = await sideClient(env)
const top = `SMLIVE-kwlen-${run}`
let created = false
try {
  await client.mailboxCreate(top)
  created = true
  const msg = Buffer.from([`From: ${env.EMAIL}`, `To: ${env.EMAIL}`, `Subject: SMLIVE-kwlen ${run}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <smlive-kwlen-${run}@shadowmail.invalid>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
    'ShadowMail live keyword length test; deleted at the end of the run.', ''].join('\r\n'))
  const { uid } = await client.append(top, msg, [])
  await client.mailboxOpen(top)
  const results = {}
  for (const len of [50, 51, 64, 100]) {
    const kw = `smlive_${'x'.repeat(len - 7)}`
    let answer
    try {
      const res = await client.exec('UID STORE', [{ type: 'SEQUENCE', value: String(uid) }, { type: 'ATOM', value: '+FLAGS' }, [{ type: 'ATOM', value: kw }]])
      answer = `OK ${res.response && res.response.attributes ? res.response.attributes.map(a => a.value).filter(v => typeof v === 'string').join(' ') : ''}`.trim()
      if (res.next) res.next()
    } catch (err) {
      answer = `${err.responseStatus || 'ERROR'} ${err.responseText || err.message}`
    }
    const flags = [...((await client.fetchOne(String(uid), { flags: true }, { uid: true }))?.flags || [])]
    results[len] = flags.includes(kw)
    console.log(hide(`MEASURED ${len}-character keyword: STORE answer "${answer}"; back in FETCH FLAGS: ${results[len]}`))
  }
  check('a 50-character keyword (the label keyword maximum) is taken', results[50])
} catch (err) {
  check('the run finished', false, hide(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)))
} finally {
  if (created) {
    await client.mailboxOpen('INBOX').catch(() => {})
    await client.mailboxDelete(top).catch(err => console.log(hide(`delete ${top}: ${err.message}`)))
    const left = (await client.list()).filter(f => f.path.startsWith(top))
    check('cleanup: the test folder is gone from the server', left.length === 0, left.map(f => f.path).join(', '))
  }
  await client.logout().catch(() => {})
}
process.exit(check.summary() ? 1 : 0)
