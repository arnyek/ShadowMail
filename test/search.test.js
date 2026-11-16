// Global search: the local index over an IMAP and a POP3 account with the filter panel, the
// "Keresés a szerveren is" job (fake IMAP: TEXT + BEFORE, CHARSET refusal, cancel), and the POP3
// "Keresés a régi levelek szövegében is" job (data/store files, no index), through the IPC layer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { FakePop3Server } from './helpers/fake-pop3.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { registerSearchIpc, parseSearchRequest, matchesFilters, SEARCH_CHANNELS } from '../app/main/ipc/search.js'
import { serverSearch, searchFolderUids } from '../core/imap/server-search.js'
import { searchOldPop3 } from '../core/pop3/local-search.js'
import { Pop3Client } from '../core/pop3/client.js'
import { Pop3Fetcher } from '../core/pop3/fetcher.js'
import { searchWords, foldForSearch } from '../core/mime/text.js'

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}

function eml({ subject, body, date, from = 'Feladó Ferenc <ferenc@example.invalid>', attachment = false }) {
  const head = [`From: ${from}`, 'To: teszt@example.invalid', `Subject: ${subject}`, `Date: ${new Date(date).toUTCString()}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@example.invalid>`, 'MIME-Version: 1.0']
  if (!attachment) return Buffer.from(`${head.join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`)
  return Buffer.from(`${head.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n--B\r\nContent-Type: application/pdf; name="a.pdf"\r\nContent-Disposition: attachment; filename="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQ=\r\n--B--\r\n`)
}

function fakeIpc() {
  const handlers = new Map()
  return { handle: (ch, fn) => handlers.set(ch, fn), call: (ch, ...args) => handlers.get(ch)({ senderFrame: { url: 'app' } }, ...args), handlers }
}

/** An IMAP account (fake server, synced) and a POP3 account (fake TCP server, downloaded), one index. */
async function setup(t, { imapMessages = [], pop3Messages = [], imapLimitDays = 1095, pop3LimitDays = 1095 } = {}) {
  const { db, index } = memoryIndex(t)
  const storeDir = path.join(tempDir(t), 'store')
  const imapRow = addAccount(db, { name: 'IMAP-fiók', body_index_days: imapLimitDays })
  const imap = new FakeImapServer().addMailbox('INBOX').addMailbox('Archív')
  for (const m of imapMessages) imap.addMessage(m.folder || 'INBOX', m)
  const pop = await new FakePop3Server().listen()
  onCleanup(t, () => pop.close())
  for (const m of pop3Messages) pop.add(eml(m))
  const popRow = addAccount(db, { name: 'POP3-fiók', type: 'pop3', in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, body_index_days: pop3LimitDays })
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: pop.pass }),
  }
  const events = []
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), notify: () => {}, connect: () => imap.connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => manager.entries.get(imapRow.id).idle.connected && manager.status().find(s => s.accountId === popRow.id).lastFinished)
  const ipc = fakeIpc()
  registerSearchIpc({ ipcMain: ipc, db, index, store, manager, sealed: sealedStore(storeDir), notify: e => events.push(e), isTrustedSender: () => true, now: () => NOW })
  const local = q => ipc.call('search:local', { query: '', ...q })
  const job = async (channel, q) => {
    const res = await ipc.call(channel, { query: '', ...q })
    assert.equal(res.ok, true, JSON.stringify(res))
    await until(() => events.some(e => e.jobId === res.jobId && e.finished))
    const mine = events.filter(e => e.jobId === res.jobId)
    return { jobId: res.jobId, hits: mine.flatMap(e => e.hits || []), finished: mine.find(e => e.finished).finished, progress: mine.filter(e => e.progress).map(e => e.progress) }
  }
  return { db, index, imap, pop, imapRow, popRow, manager, ipc, local, job, events, storeDir }
}

const recent = NOW - 10 * DAY
const fourYears = NOW - 4 * 365 * DAY

test('local: an IMAP and a POP3 message with the same word: both without a filter, one with the account filter; accents optional', async t => {
  const s = await setup(t, {
    imapMessages: [{ from: 'anna@example.invalid', to: 'en@example.invalid', subject: 'Ajánlat', messageId: '<i1@x>', date: recent, body: 'A kazánkarbantartás ára' }],
    pop3Messages: [{ subject: 'Kérdés', body: 'Mennyi a kazánkarbantartás?', date: recent }],
  })
  const all = await s.local({ query: 'kazankarbantartas' })
  assert.deepEqual(all.rows.map(r => r.account).sort(), ['IMAP-fiók', 'POP3-fiók'])
  assert.ok(all.rows.every(r => r.snip && r.snip.includes('«')), 'highlighted snippet')
  assert.deepEqual(all.scope, { imap: true, pop3: true })
  const one = await s.local({ query: 'kazánkarbantartás', accountId: s.popRow.id })
  assert.deepEqual(one.rows.map(r => r.account), ['POP3-fiók'])
  assert.deepEqual(one.scope, { imap: false, pop3: true }, 'POP3 only: no server button')
  const imapOnly = await s.local({ query: 'kazán', accountId: s.imapRow.id })
  assert.deepEqual(imapOnly.scope, { imap: true, pop3: false }, 'IMAP only: no POP3 button')
})

test('local: sender, date, attachment and unread filters each narrow correctly', async t => {
  const s = await setup(t, {
    pop3Messages: [
      { subject: 'Egy', body: 'közös szó: gyöngyház', date: NOW - 5 * DAY, from: 'Kovács Anna <anna@example.invalid>' },
      { subject: 'Kettő', body: 'közös szó: gyöngyház', date: NOW - 50 * DAY, from: 'Nagy Béla <bela@example.invalid>', attachment: true },
      { subject: 'Három', body: 'közös szó: gyöngyház', date: NOW - 100 * DAY, from: 'Szabó Éva <eva@example.invalid>' },
    ],
  })
  const subjects = async q => (await s.local({ query: 'gyongyhaz', ...q })).rows.map(r => r.subject).sort()
  assert.deepEqual(await subjects({}), ['Egy', 'Három', 'Kettő'])
  // this step failed ONCE (Windows build, 2026-11-13, [] instead of ['Három']); 1600 runs since (Linux and
  // Windows, alone and 12 at once) never failed, so the cause is not known. On a failure it says what the index held then
  // and 300 ms later (rows, FTS sender column, sync state, the same query again).
  const bySender = await subjects({ from: 'Szabo' })
  if (JSON.stringify(bySender) !== JSON.stringify(['Három'])) {
    const dump = () => ({
      rows: s.db.prepare('SELECT id, subject, from_name, from_addr, body_state FROM messages ORDER BY id').all(),
      fts: s.db.prepare('SELECT rowid, subject, sender, length(body) AS body FROM messages_fts ORDER BY rowid').all(),
      status: s.manager.status().map(x => ({ id: x.accountId, running: x.running, busy: x.busy, runsEnded: x.runsEnded, lastFinished: x.lastFinished ? 1 : 0, lastError: x.lastError })),
      again: s.index.search({ query: 'gyongyhaz', from: 'Szabo', limit: 50 }).map(r => r.subject),
    })
    const at = dump()
    await sleep(300)
    t.diagnostic(`lost LF: ${JSON.stringify({ got: bySender, at, later: dump() })}`)
    console.log(`DIAG0942 ${JSON.stringify({ got: bySender, at })}`)
  }
  assert.deepEqual(bySender, ['Három'])
  assert.deepEqual(await subjects({ since: NOW - 60 * DAY }), ['Egy', 'Kettő'])
  assert.deepEqual(await subjects({ before: NOW - 60 * DAY }), ['Három'])
  assert.deepEqual(await subjects({ hasAttachment: true }), ['Kettő'])
  const egy = s.index.search({ query: 'Egy' })[0]
  s.index.setFlagsById(egy.id, '\\Seen')
  assert.deepEqual(await subjects({ unread: true }), ['Három', 'Kettő'])
  assert.equal((await s.local({ query: 'gyongyhaz', sort: 'date' })).rows[0].subject, 'Egy', 'date order: newest first')
})

test('local: bad requests are refused; the header-only line counts the messages beyond the limit', async t => {
  const s = await setup(t, { pop3LimitDays: 365, pop3Messages: [{ subject: 'Régi', body: 'x', date: fourYears }] })
  for (const bad of [null, { query: 5 }, { query: 'x'.repeat(501) }, { query: 'a', accountId: -1 }, { query: 'a', sort: 'rank; DROP' }, { query: 'a', since: 'tegnap' }]) {
    assert.deepEqual(await s.ipc.call('search:local', bad), { ok: false, error: 'bad_request' })
  }
  const res = await s.local({ query: 'Régi' })
  assert.deepEqual(res.headersOnly, [{ accountId: s.popRow.id, name: 'POP3-fiók', type: 'pop3', count: 1 }])
})

test('server: a 4-year-old unopened message is found on the server only, marked, no duplicates of messages inside the limit', async t => {
  const s = await setup(t, {
    imapMessages: [
      { from: 'a@example.invalid', to: 'en@example.invalid', subject: 'Régi levél', messageId: '<o1@x>', date: fourYears, body: 'Benne van: mandulavirágzás' },
      { from: 'b@example.invalid', to: 'en@example.invalid', subject: 'Friss levél', messageId: '<n1@x>', date: recent, body: 'Ebben is: mandulavirágzás' },
      { folder: 'Archív', from: 'c@example.invalid', to: 'en@example.invalid', subject: 'Archív régi', messageId: '<o2@x>', date: fourYears, body: 'mandulavirágzás az archívban' },
    ],
  })
  const local = await s.local({ query: 'mandulavirágzás' })
  assert.deepEqual(local.rows.map(r => r.subject), ['Friss levél'], 'locally only the one inside the limit')
  const res = await s.job('search:server', { query: 'mandulavirágzás' })
  assert.deepEqual(res.hits.map(r => r.subject).sort(), ['Archív régi', 'Régi levél'])
  assert.equal(res.finished.cancelled, false)
  assert.deepEqual(res.finished.errors, [])
  // EXAMINE only, BEFORE the limit
  assert.ok(s.imap.searchLog.every(e => e.before && e.before.getTime() === NOW - 1095 * DAY))
  assert.ok(s.imap.openLog.filter(o => o.via === 'lock').slice(-2).every(o => o.readOnly === true))
  // the message stays out of the full-text index
  const old = s.index.search({ query: 'Régi levél' })[0]
  assert.equal(s.index.get(old.id).body_state, 3)
  assert.equal((await s.local({ query: 'mandulavirágzás' })).rows.length, 1)
})

test('server: every word must match (AND), each word one SEARCH', async t => {
  const s = await setup(t, {
    imapMessages: [
      { from: 'a@example.invalid', to: 'en@example.invalid', subject: 'A', messageId: '<a@x>', date: fourYears, body: 'körte és szilva' },
      { from: 'b@example.invalid', to: 'en@example.invalid', subject: 'B', messageId: '<b@x>', date: fourYears, body: 'csak körte' },
    ],
  })
  const res = await s.job('search:server', { query: 'körte szilva' })
  assert.deepEqual(res.hits.map(r => r.subject), ['A'])
})

test('server: when CHARSET UTF-8 is refused, the word is retried without accents (and without CHARSET)', async t => {
  const server = new FakeImapServer().addMailbox('INBOX')
  server.addMessage('INBOX', { from: 'a@x.invalid', to: 'b@x.invalid', subject: 's', messageId: '<c@x>', date: fourYears, body: 'szamla nelkul ekezet' })
  server.rejectCharset = true
  const client = await server.connect()
  await client.getMailboxLock('INBOX', { readOnly: true })
  const uids = await searchFolderUids(client, ['számla'], new Date(NOW))
  assert.deepEqual(uids, [1])
  assert.deepEqual(server.searchLog.map(e => e.text), ['számla', 'szamla'])
  // a refusal that is not about the charset (ASCII word) is reported as a failed folder
  server.rejectCharset = false
  const orig = client.search.bind(client)
  client.search = async () => false
  assert.equal(await searchFolderUids(client, ['ascii'], new Date(NOW)), null)
  client.search = orig
})

test('server: cancel stops within 2 s, no SEARCH left running, the connection is usable again', async t => {
  const s = await setup(t, {
    imapMessages: [{ from: 'a@example.invalid', to: 'en@example.invalid', subject: 'Lassú', messageId: '<s@x>', date: fourYears, body: 'csigalassú szerver' }],
  })
  s.imap.searchDelayMs = 10_000
  const res = await s.ipc.call('search:server', { query: 'csigalassú' })
  await until(() => s.imap.runningSearches === 1)
  const t0 = performance.now()
  await s.ipc.call('search:cancel', res.jobId)
  await until(() => s.events.some(e => e.jobId === res.jobId && e.finished))
  const ms = performance.now() - t0
  assert.ok(ms < 2000, `stopped in ${Math.round(ms)} ms`)
  assert.equal(s.events.find(e => e.jobId === res.jobId && e.finished).finished.cancelled, true)
  await until(() => s.imap.runningSearches === 0, 2000)
  s.imap.searchDelayMs = 0
  const again = await s.job('search:server', { query: 'csigalassú' })
  assert.deepEqual(again.hits.map(r => r.subject), ['Lassú'], 'the next search works (reconnected)')
})

test('pop3 old text: found only by the button, accents optional, every word (AND), no duplicates, stays out of the index', async t => {
  const s = await setup(t, {
    pop3LimitDays: 365,
    pop3Messages: [
      { subject: 'Régi egy', body: 'A pitypangméz és a hársfatea', date: fourYears },
      { subject: 'Régi kettő', body: 'Csak pitypangméz', date: fourYears },
      { subject: 'Friss', body: 'Friss pitypangméz és hársfatea', date: recent },
    ],
  })
  assert.deepEqual((await s.local({ query: 'pitypangmez' })).rows.map(r => r.subject), ['Friss'])
  const one = await s.job('search:pop3Old', { query: 'pitypangmez harsfatea' })
  assert.deepEqual(one.hits.map(r => r.subject), ['Régi egy'], 'both words: only the first old one; the fresh one is not repeated')
  const both = await s.job('search:pop3Old', { query: 'PITYPANGMÉZ' })
  assert.deepEqual(both.hits.map(r => r.subject).sort(), ['Régi egy', 'Régi kettő'])
  assert.equal(both.finished.total, 2)
  for (const r of both.hits) assert.equal(s.index.get(r.id).body_state, 3, 'still headers only')
  assert.equal((await s.local({ query: 'pitypangmez' })).rows.length, 1)
})

test('pop3 old text: missing and broken files are skipped and counted; cancel stops it', async t => {
  const s = await setup(t, {
    pop3LimitDays: 365,
    pop3Messages: Array.from({ length: 30 }, (_, i) => ({ subject: `Régi ${i}`, body: `tölgyfa ${i}`, date: fourYears - i * DAY })),
  })
  const rows = s.db.prepare('SELECT id, store_path FROM messages WHERE account_id = ? ORDER BY idate DESC').all(s.popRow.id)
  fs.rmSync(path.join(s.storeDir, rows[0].store_path))
  fs.rmSync(path.join(s.storeDir, rows[1].store_path))
  fs.mkdirSync(path.join(s.storeDir, rows[2].store_path + '.dir'))
  s.db.prepare('UPDATE messages SET store_path = ? WHERE id = ?').run(rows[2].store_path + '.dir', rows[2].id) // a folder, not a file
  s.db.prepare('UPDATE messages SET store_path = ? WHERE id = ?').run('../../kivul.eml', rows[3].id) // outside data/store
  const res = await s.job('search:pop3Old', { query: 'tolgyfa' })
  assert.equal(res.finished.skipped, 4)
  assert.equal(res.hits.length, 26)

  const controller = new AbortController()
  const t0 = performance.now()
  let seen = 0
  const p = searchOldPop3({ db: s.db, sealed: sealedStore(s.storeDir), accountIds: [s.popRow.id], query: 'tolgyfa', signal: controller.signal, onHit: () => ++seen === 3 && controller.abort() })
  const st = await p
  assert.equal(st.cancelled, true)
  assert.ok(st.done < 30)
  assert.ok(performance.now() - t0 < 2000)
})

test('filters on rows found outside the index; request parsing; word splitting', () => {
  const row = { account_id: 1, folder: 'INBOX', date: 1000, has_attachments: 0, flags: '\\Seen', from_name: 'Szabó Éva', from_addr: 'eva@x.invalid', to_addrs: 'en@x.invalid', cc_addrs: '' }
  const f = parseSearchRequest({ query: 'x' })
  assert.equal(matchesFilters(row, f), true)
  assert.equal(matchesFilters(row, { ...f, accountId: 2 }), false)
  assert.equal(matchesFilters(row, { ...f, from: 'szabo' }), true)
  assert.equal(matchesFilters(row, { ...f, from: 'kovacs' }), false)
  assert.equal(matchesFilters(row, { ...f, unread: true }), false)
  assert.equal(matchesFilters(row, { ...f, hasAttachment: true }), false)
  assert.equal(matchesFilters(row, { ...f, since: 2000 }), false)
  assert.equal(matchesFilters(row, { ...f, folder: 'inbox' }), true)
  assert.deepEqual(searchWords('"számla" OR díjbekérő, (2026)'), ['számla', 'díjbekérő', '2026'])
  assert.equal(foldForSearch('ÁRVÍZTŰRŐ Tükörfúrógép'), 'arvizturo tukorfurogep')
  assert.deepEqual([...SEARCH_CHANNELS].sort(), ['search:cancel', 'search:local', 'search:pop3Old', 'search:server'])
})

test('server search: a folder gone from the server is listed as failed, the other folders are still searched', async t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db, { body_index_days: 365 })
  const NOW2 = Date.UTC(2026, 10, 12)
  const old = NOW2 - 800 * 86_400_000
  const server = new FakeImapServer().addMailbox('INBOX').addMailbox('Z-last')
  server.addMessages('Z-last', [{ from: 'a@x.invalid', to: 'b@x.invalid', subject: 's', messageId: '<z@x>', date: old, body: 'kulcsszo' }])
  index.insertMany([{ account_id: acc.id, folder: 'Z-last', uid: 1, message_id: null, in_reply_to: null, refs: null, from_name: null, to_addrs: '', cc_addrs: '', attachments: null, from_addr: 'a@x.invalid', subject: 's', date: old, idate: old, flags: '', size: 1, has_attachments: 0, body_state: 3 }])
  const client = await server.connect()
  const res = await serverSearch({ client, index, account: { id: acc.id }, query: 'kulcsszo', cutoffMs: NOW2 - 365 * 86_400_000, folders: ['INBOX', 'Gone', 'Z-last'] })
  assert.deepEqual(res.failedFolders, ['Gone'])
  assert.equal(res.done, 3)
  assert.equal(res.hits, 1, 'Z-last after the missing folder was searched')
})
