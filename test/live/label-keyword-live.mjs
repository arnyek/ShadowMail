#!/usr/bin/env node
// Label keywords on the live test server (not part of `npm test`): what the server does with the IMAP keywords a
// label would be stored as. One login, through the side client of live-lib (the first rejected login ends the run).
//
//   node test/live/label-keyword-live.mjs <test account .env file> [--keep]
//
// Everything is written into a folder made for the run (SMLIVE-kw-<run> and one subfolder under it), into one test
// message APPENDed there (to the account's own address, nothing is sent); both folders are deleted at the end
// (--keep leaves them for a look). It measures:
// (a) PERMANENTFLAGS on SELECT of INBOX, Sent, Drafts, Trash and the subfolder;
// (b) the form a lower-case keyword comes back in (FETCH FLAGS), and whether the same keyword in upper case is another one;
// (c) whether the keyword is kept in the target of a COPY and of a MOVE;
// (d) 30 different keywords in one folder: \* still in PERMANENTFLAGS after them (a new SELECT), and all 30 come back;
// (e) whether a 50- and a 51-character keyword is taken (the label keyword is at most 50).
// Nothing here prints the password or the env file.
import { loadEnv, preflight, sideClient, checker, redactor } from './live-lib.mjs'

const [envFile, ...rest] = process.argv.slice(2)
const keep = rest.includes('--keep')
const env = loadEnv(envFile)
const hide = redactor(env)
const check = checker()
const run = Date.now().toString(36)
const KW = 'sz=c3=a1mla'

await preflight(env)
const client = await sideClient(env)
console.log(`logged in once; server capabilities: MOVE ${client.capabilities.has('MOVE')}, UIDPLUS ${client.capabilities.has('UIDPLUS')}`)

const flagsOf = async uid => {
  const msg = await client.fetchOne(String(uid), { flags: true }, { uid: true })
  return msg ? [...msg.flags] : null
}
const permanentOf = async path => {
  const box = await client.mailboxOpen(path)
  return [...(box.permanentFlags || [])]
}
const message = subject =>
  Buffer.from([
    `From: ${env.EMAIL}`, `To: ${env.EMAIL}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <smlive-kw-${run}-${Math.random().toString(36).slice(2)}@shadowmail.invalid>`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', '', 'ShadowMail live keyword test; deleted at the end of the run.', '',
  ].join('\r\n'))

const list = await client.list()
const delimiter = (list.find(f => f.path === 'INBOX') || list[0]).delimiter || '.'
const top = `SMLIVE-kw-${run}`
const sub = `${top}${delimiter}sub`
const byUse = use => list.find(f => f.specialUse === use)?.path
let created = false
try {
  await client.mailboxCreate(top)
  created = true
  await client.mailboxCreate(sub)
  console.log(`test folders: ${top}, ${sub} (delimiter "${delimiter}")`)

  // (a)
  const folders = [['INBOX', 'INBOX'], ['Sent', byUse('\\Sent')], ['Drafts', byUse('\\Drafts')], ['Trash', byUse('\\Trash')], ['subfolder', sub]]
  const perm = {}
  for (const [name, path] of folders) {
    if (!path) {
      console.log(`MEASURED (a) ${name}: no such folder on the server`)
      continue
    }
    perm[name] = await permanentOf(path)
    console.log(`MEASURED (a) ${name} (${path}) PERMANENTFLAGS: ${perm[name].join(' ')}`)
  }
  check('(a) every measured folder has \\* in PERMANENTFLAGS', Object.values(perm).length && Object.values(perm).every(p => p.includes('\\*')))

  // (b)
  await client.mailboxOpen(top)
  const one = await client.append(top, message(`SMLIVE-kw ${run} b`), [])
  const uid = one.uid
  const added = await client.messageFlagsAdd(String(uid), [KW], { uid: true })
  const afterLower = await flagsOf(uid)
  console.log(`MEASURED (b) lower-case ${KW} stored: ${added}; FETCH FLAGS: ${JSON.stringify(afterLower)}`)
  const addedUpper = await client.messageFlagsAdd(String(uid), [KW.toUpperCase()], { uid: true })
  const afterUpper = await flagsOf(uid)
  const kwForms = afterUpper.filter(f => f.toLowerCase() === KW)
  console.log(`MEASURED (b) upper-case ${KW.toUpperCase()} stored: ${addedUpper}; FETCH FLAGS: ${JSON.stringify(afterUpper)}; forms of the keyword: ${kwForms.length}`)
  check('(b) the lower-case keyword comes back', afterLower.some(f => f.toLowerCase() === KW), JSON.stringify(afterLower))

  // (c)
  const copied = await client.messageCopy(String(uid), sub, { uid: true })
  const copyUid = copied && copied.uidMap ? copied.uidMap.get(uid) : null
  await client.mailboxOpen(sub)
  const copyFlags = copyUid ? await flagsOf(copyUid) : null
  console.log(`MEASURED (c) COPY: target uid ${copyUid}; FETCH FLAGS in the target: ${JSON.stringify(copyFlags)}`)
  check('(c) COPY keeps the keyword', copyFlags && copyFlags.some(f => f.toLowerCase() === KW), JSON.stringify(copyFlags))
  await client.mailboxOpen(top)
  const moved = await client.messageMove(String(uid), sub, { uid: true })
  const moveUid = moved && moved.uidMap ? moved.uidMap.get(uid) : null
  await client.mailboxOpen(sub)
  const moveFlags = moveUid ? await flagsOf(moveUid) : null
  console.log(`MEASURED (c) MOVE: target uid ${moveUid}; FETCH FLAGS in the target: ${JSON.stringify(moveFlags)}`)
  check('(c) MOVE keeps the keyword', moveFlags && moveFlags.some(f => f.toLowerCase() === KW), JSON.stringify(moveFlags))

  // (d) 30 keywords on 3 messages of the top folder (10 each), then a new SELECT
  await client.mailboxOpen(top)
  const words = Array.from({ length: 30 }, (_, i) => `smlive_kw${String(i + 1).padStart(2, '0')}`)
  const uids = []
  for (let m = 0; m < 3; m++) uids.push((await client.append(top, message(`SMLIVE-kw ${run} d${m}`), [])).uid)
  await client.mailboxOpen(top)
  const stored = []
  for (let i = 0; i < words.length; i++) stored.push(await client.messageFlagsAdd(String(uids[Math.floor(i / 10)]), [words[i]], { uid: true }))
  const permAfter = await permanentOf(top)
  const seen = new Set()
  for (const u of uids) for (const f of (await flagsOf(u)) || []) seen.add(f.toLowerCase())
  const back = words.filter(w => seen.has(w))
  console.log(`MEASURED (d) STORE results: ${stored.filter(Boolean).length}/30 true; PERMANENTFLAGS after a new SELECT (${permAfter.length} items): ${permAfter.join(' ')}`)
  console.log(`MEASURED (d) keywords back in FETCH FLAGS: ${back.length}/30`)
  check('(d) \\* is still in PERMANENTFLAGS after 30 keywords', permAfter.includes('\\*'))
  check('(d) all 30 keywords come back', back.length === 30, `${back.length}/30`)

  // (e) the label keyword is at most 50 characters (core/db/label-keyword.js); 51 is measured, not required (the server's
  // own answer to it: test/live/label-keyword-length-live.mjs)
  const taken = {}
  for (const len of [50, 51]) {
    const kw = `smlive_${'x'.repeat(len - 7)}`
    const ok = await client.messageFlagsAdd(String(uids[0]), [kw], { uid: true })
    taken[len] = ((await flagsOf(uids[0])) || []).some(f => f.toLowerCase() === kw)
    console.log(`MEASURED (e) a ${len}-character keyword: STORE ${ok}, back in FETCH FLAGS: ${taken[len]}`)
  }
  check('(e) a 50-character keyword (the label keyword maximum) is taken', taken[50])
} catch (err) {
  check('the run finished', false, hide(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)))
} finally {
  if (created && !keep) {
    await client.mailboxOpen('INBOX').catch(() => {})
    await client.mailboxDelete(sub).catch(err => console.log(hide(`delete ${sub}: ${err.message}`)))
    await client.mailboxDelete(top).catch(err => console.log(hide(`delete ${top}: ${err.message}`)))
    const left = (await client.list()).filter(f => f.path.startsWith(top))
    check('cleanup: the test folders are gone from the server', left.length === 0, left.map(f => f.path).join(', '))
  }
  await client.logout().catch(() => {})
}
process.exit(check.summary() ? 1 : 0)
