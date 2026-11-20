#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Moving a folder under another one on the live test server (not part of `npm test`): what the server does with a
// RENAME that changes a folder's parent. One login, through the side client of live-lib (the first rejected login
// ends the run).
//
//   node test/live/folder-move-live.mjs <test account .env file> [--keep]
//
// Everything lives in folders made for the run (SMLIVE-mv-<run> and its subfolders, one top-level SMLIVE-mv-<run>-top
// and one INBOX child at most), three test messages APPENDed there (to the account's own address, nothing is sent);
// all of it is deleted and unsubscribed at the end (--keep leaves it for a look), and so is anything an earlier, killed
// run of this script left (SMLIVE-mv-*). It measures, for RENAME A/B -> C/B
// with the subfolders B/x (subscribed) and B/y (not subscribed):
// (a) the subscriptions after the RENAME (raw LSUB): do the children keep theirs under the new name, does the old
//     name stay subscribed (a stale entry);
// (b) UIDVALIDITY of the moved folders before and after;
// (c) the messages and their keywords after the move;
// (d) the hierarchy delimiter and the personal namespace (prefix);
// (e) a RENAME to the top level;
// (f) a RENAME onto an existing name: the server's NO text;
// (g) a RENAME under INBOX: taken or not;
// (h) the app's own moveFolder (core/imap/actions.js) for a move and (i) for a rename of a folder with subfolders:
//     the subscribed folders subscribed under their new names, no stale old name, an unsubscribed one left alone.
// Nothing here prints the password or the env file.
import { loadEnv, preflight, sideClient, checker, redactor } from './live-lib.mjs'
import { moveFolder } from '../../core/imap/actions.js'

const [envFile, ...rest] = process.argv.slice(2)
const keep = rest.includes('--keep')
const env = loadEnv(envFile)
const hide = redactor(env)
const check = checker()
const run = Date.now().toString(36)
// every run of this script, a killed earlier one too (its folders are cleaned up at the end)
const prefixOfRuns = 'SMLIVE-mv-'
const KW = 'smlive_mv'

await preflight(env)
const client = await sideClient(env)
const ns = client.namespace || {}
const delimiter = ns.delimiter || (await client.list()).find(f => f.path === 'INBOX')?.delimiter || '.'
console.log(`logged in once; MEASURED (d) personal namespace prefix "${ns.prefix || ''}", delimiter "${delimiter}"`)

const message = subject =>
  Buffer.from([
    `From: ${env.EMAIL}`, `To: ${env.EMAIL}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <smlive-mv-${run}-${Math.random().toString(36).slice(2)}@shadowmail.invalid>`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', '', 'ShadowMail live folder-move test; deleted at the end of the run.', '',
  ].join('\r\n'))
const p = (...parts) => parts.join(delimiter)
// the raw LSUB answer (imapflow's list() drops a subscription without a folder): the subscribed names of this run
const lsub = async () => {
  const names = []
  const res = await client.exec('LSUB', [{ type: 'STRING', value: '' }, { type: 'STRING', value: '*' }], {
    untagged: {
      LSUB: async u => {
        const a = (u && u.attributes) || []
        const name = a[2] && (a[2].value ?? a[2])
        if (typeof name === 'string') names.push(name)
      },
    },
  })
  // imapflow's exec holds the connection's command queue until next() (it hung here without it)
  res.next()
  return names.filter(n => n.includes(prefixOfRuns))
}
const stripNs = s => (ns.prefix && s.startsWith(ns.prefix) ? s.slice(ns.prefix.length) : s)
const statusOf = async path => {
  try {
    const st = await client.status(path, { uidValidity: true, messages: true })
    return { uidValidity: String(st.uidValidity), messages: st.messages }
  } catch (err) {
    return { error: hide(err.responseText || err.message) }
  }
}
const flagsIn = async path => {
  await client.mailboxOpen(path, { readOnly: true })
  const out = []
  for await (const m of client.fetch('1:*', { flags: true, uid: true })) out.push([...m.flags].filter(f => !f.startsWith('\\')).sort())
  return out
}
const exists = async () => (await client.list()).map(f => f.path).filter(x => x.includes(`SMLIVE-mv-${run}`))
const existsAny = async () => (await client.list()).map(f => f.path).filter(x => x.includes(prefixOfRuns))

const top = `SMLIVE-mv-${run}`
const A = p(top, 'A'), AB = p(top, 'A', 'B'), ABx = p(top, 'A', 'B', 'x'), ABy = p(top, 'A', 'B', 'y'), C = p(top, 'C')
const CB = p(top, 'C', 'B'), CBx = p(top, 'C', 'B', 'x'), CBy = p(top, 'C', 'B', 'y')
const topLevel = `${top}-top`
let made = false
try {
  for (const f of [top, A, AB, ABx, ABy, C]) await client.mailboxCreate(f)
  made = true
  for (const f of [top, A, AB, ABx, C]) await client.mailboxSubscribe(f)
  await client.mailboxUnsubscribe(ABy).catch(() => {})
  for (let i = 0; i < 3; i++) {
    const r = await client.append(AB, message(`SMLIVE-mv ${run} ${i}`), [])
    await client.mailboxOpen(AB)
    await client.messageFlagsAdd(String(r.uid), [KW], { uid: true })
  }
  await client.append(ABx, message(`SMLIVE-mv ${run} x`), [])
  const before = { B: await statusOf(AB), x: await statusOf(ABx), y: await statusOf(ABy) }
  const subBefore = (await lsub()).filter(n => n.includes(`SMLIVE-mv-${run}`)).map(stripNs).sort()
  console.log(`before: subscribed ${JSON.stringify(subBefore)}; status ${JSON.stringify(before)}`)
  await client.mailboxOpen('INBOX')

  // the move
  const moved = await client.mailboxRename(AB, CB)
  console.log(`RENAME ${AB} -> ${CB}: ${JSON.stringify(moved)}`)
  const after = { B: await statusOf(CB), x: await statusOf(CBx), y: await statusOf(CBy) }
  const subAfter = (await lsub()).filter(n => n.includes(`SMLIVE-mv-${run}`)).map(stripNs).sort()
  const listed = (await exists()).map(stripNs).sort()
  console.log(`after: folders ${JSON.stringify(listed)}`)
  console.log(`after: subscribed ${JSON.stringify(subAfter)}; status ${JSON.stringify(after)}`)
  // (a)
  const has = n => subAfter.includes(n)
  console.log(`MEASURED (a) subscribed after the move: C/B ${has(CB)}, C/B/x ${has(CBx)}, C/B/y ${has(CBy)}; the old names still subscribed: A/B ${has(AB)}, A/B/x ${has(ABx)}`)
  check('(a) the subtree came along (C/B/x and C/B/y exist, A/B is gone)', listed.includes(CBx) && listed.includes(CBy) && !listed.includes(AB))
  // (b)
  for (const k of ['B', 'x', 'y']) console.log(`MEASURED (b) UIDVALIDITY ${k}: ${before[k].uidValidity} -> ${after[k].uidValidity} (${before[k].uidValidity === after[k].uidValidity ? 'same' : 'CHANGED'})`)
  // (c)
  const kws = await flagsIn(CB)
  console.log(`MEASURED (c) C/B: ${after.B.messages} messages (before ${before.B.messages}), keywords ${JSON.stringify(kws)}; C/B/x: ${after.x.messages} (before ${before.x.messages})`)
  check('(c) the messages and their keyword came along', after.B.messages === 3 && kws.length === 3 && kws.every(k => k.includes(KW)) && after.x.messages === 1)
  await client.mailboxOpen('INBOX')

  // (e) to the top level
  try {
    const r = await client.mailboxRename(CB, topLevel)
    const l = (await exists()).map(stripNs)
    console.log(`MEASURED (e) RENAME to the top level: ${JSON.stringify(r)}; listed: ${l.filter(x => x.startsWith(topLevel)).join(', ')}`)
  } catch (err) {
    console.log(`MEASURED (e) RENAME to the top level refused: ${hide(err.responseText || err.message)}`)
  }
  // (f) onto an existing name (C exists)
  try {
    await client.mailboxRename(topLevel, C)
    console.log('MEASURED (f) RENAME onto an existing name: TAKEN (!)')
  } catch (err) {
    console.log(`MEASURED (f) RENAME onto an existing name: ${err.responseStatus || ''} "${hide(err.responseText || err.message)}"`)
  }
  // (g) under INBOX
  const inboxChild = `INBOX${delimiter}${top}-g`
  try {
    const r = await client.mailboxRename(topLevel, inboxChild)
    console.log(`MEASURED (g) RENAME under INBOX: taken ${JSON.stringify(r)}`)
    // back, so the cleanup finds it under the run's names as well
    await client.mailboxRename(inboxChild, topLevel).catch(err => console.log(`(g) back: ${hide(err.responseText || err.message)}`))
  } catch (err) {
    console.log(`MEASURED (g) RENAME under INBOX refused: ${err.responseStatus || ''} "${hide(err.responseText || err.message)}"`)
  }
  // (h), (i): the app's own code path
  const P = `${top}-p`, PQ = p(P, 'Q'), PQr = p(P, 'Q', 'r'), PQs = p(P, 'Q', 's'), D = p(P, 'D')
  for (const f of [P, PQ, PQr, PQs, D]) await client.mailboxCreate(f)
  for (const f of [P, PQ, PQr, D]) await client.mailboxSubscribe(f)
  await client.mailboxUnsubscribe(PQs).catch(() => {})
  await client.mailboxOpen('INBOX')
  const subOf = async root => (await lsub()).filter(n => n.startsWith(root)).map(stripNs).sort()
  const DQ = p(D, 'Q')
  const movedTo = await moveFolder(client, PQ, DQ, [PQ, PQr])
  const subH = await subOf(P)
  console.log(`MEASURED (h) moveFolder ${PQ} -> ${movedTo}; subscribed under ${P}: ${JSON.stringify(subH)}`)
  check('(h) moveFolder: the moved subscribed folders subscribed under the new names, no stale old name, s left unsubscribed', JSON.stringify(subH) === JSON.stringify([P, D, DQ, p(D, 'Q', 'r')].sort()), JSON.stringify(subH))
  const DQuj = p(D, 'Quj')
  const renamedTo = await moveFolder(client, DQ, DQuj, [DQ, p(D, 'Q', 'r')])
  const subI = await subOf(P)
  console.log(`MEASURED (i) rename via moveFolder ${DQ} -> ${renamedTo}; subscribed under ${P}: ${JSON.stringify(subI)}`)
  check('(i) rename of a folder with subfolders: Quj and Quj.r subscribed, no Q name left, s unsubscribed', JSON.stringify(subI) === JSON.stringify([P, D, DQuj, p(D, 'Quj', 'r')].sort()), JSON.stringify(subI))
  const listedI = (await existsAny()).map(stripNs).filter(x => x.startsWith(P)).sort()
  check('(i) the subtree is on the server under the new name (r and s)', listedI.includes(p(D, 'Quj', 'r')) && listedI.includes(p(D, 'Quj', 's')), JSON.stringify(listedI))
} catch (err) {
  check('the run finished', false, hide(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)))
} finally {
  if (!keep) {
    await client.mailboxOpen('INBOX').catch(() => {})
    // deepest first; then every subscription of this run that is left (a stale one has no folder)
    const all = (await client.list()).map(f => f.path).filter(x => x.includes(prefixOfRuns))
    all.sort((a, b) => b.split(delimiter).length - a.split(delimiter).length)
    for (const f of all) await client.mailboxDelete(f).catch(err => console.log(hide(`delete ${f}: ${err.message}`)))
    for (const s of await lsub()) await client.mailboxUnsubscribe(s).catch(err => console.log(hide(`unsubscribe ${s}: ${err.message}`)))
    const leftFolders = await existsAny()
    const leftSubs = await lsub()
    check('cleanup: no folder and no subscription of the run left', leftFolders.length === 0 && leftSubs.length === 0, JSON.stringify({ leftFolders, leftSubs }))
  }
  await client.logout().catch(() => {})
}
process.exit(check.summary() ? 1 : 0)
