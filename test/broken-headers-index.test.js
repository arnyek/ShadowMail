// The header repair's row query (MailIndex.brokenHeaderRows and the sync read worker's copy): with a folder it reads
// idx_messages_folder_date (account and folder), before and after ANALYZE, and gives the very rows of the old single
// statement ("@folder IS NULL OR folder = @folder", which read every row of the account for each folder); without a
// folder (the POP3 local repair) the rows are the old ones too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { memoryIndex, addAccount } from './helpers/fixtures.js'

const BAD = String.fromCharCode(0xfffd)
const OLD = `SELECT id, uid, folder, store_path FROM messages
  WHERE account_id = @account_id AND (@folder IS NULL OR folder = @folder) AND (@local = 0 OR uid IS NULL)
    AND (instr(subject, @bad) > 0 OR instr(from_name, @bad) > 0 OR instr(to_addrs, @bad) > 0 OR instr(cc_addrs, @bad) > 0)`
const FOLDERS = ['INBOX', 'Sent', 'Régi', 'Archív/2024', 'Üres']
const oneLine = s => s.replace(/\s+/g, ' ').trim()
const byId = rows => [...rows].sort((x, y) => x.id - y.id)

/** two accounts, IMAP rows (uid) and POP3-like rows (no uid), a broken header column now and then */
function seed(t) {
  const { db, index } = memoryIndex(t)
  const a = addAccount(db)
  const b = addAccount(db)
  const rows = []
  for (let i = 0; i < 6000; i++) {
    const acc = i % 5 ? a.id : b.id
    const local = i % 7 === 0
    const folder = local ? 'INBOX' : FOLDERS[i % 4]
    const bad = i % 13 === 0 ? i % 4 : -1 // which column holds U+FFFD
    rows.push({ account_id: acc, folder, uid: local ? null : i + 1, pop3_uidl: local ? `u${i}` : null, message_id: `<h${i}@x>`, in_reply_to: null, refs: null, from_addr: 'a@example.invalid', from_name: bad === 1 ? `A${BAD}` : 'A', to_addrs: bad === 2 ? `b${BAD} <b@example.invalid>` : 'b@example.invalid', cc_addrs: bad === 3 ? `c${BAD}` : '', subject: bad === 0 ? `T${BAD} ${i}` : `T ${i}`, date: 1_700_000_000_000 + i, idate: 1_700_000_000_000 + i, flags: '', size: 1, has_attachments: 0, attachments: null, store_path: local ? `s/${i}.eml` : null, body_state: 1, sender_text: 'a', recipients_text: 'b' })
  }
  for (let i = 0; i < rows.length; i += 1000) index.insertMany(rows.slice(i, i + 1000))
  return { db, index, a, b }
}

const plan = (db, sql, params) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map(r => r.detail).join(' | ')

test('with a folder: idx_messages_folder_date in the plan (before and after ANALYZE); the rows of the old query', t => {
  const { db, index, a, b } = seed(t)
  const folderSql = index.s.brokenHeadersFolder.source
  const allSql = index.s.brokenHeadersAll.source
  // the worker runs the same folder statement
  const worker = fs.readFileSync(new URL('../core/db/sync-read-worker.js', import.meta.url), 'utf8')
  assert.ok(oneLine(worker).includes(oneLine(folderSql)), 'the worker copy is the folder statement')
  assert.doesNotMatch(worker, /@folder IS NULL/)
  assert.doesNotMatch(folderSql, /IS NULL OR folder/)
  for (const when of ['before ANALYZE', 'after ANALYZE']) {
    if (when === 'after ANALYZE') db.exec('ANALYZE')
    const p = plan(db, folderSql, { account_id: a.id, folder: 'INBOX', local: 0, bad: BAD })
    assert.match(p, /USING (COVERING )?INDEX idx_messages_folder_date \(account_id=\? AND folder=\?\)/, `${when}: ${p}`)
    // the old statement: an account-only index (which one depends on the statistics), every row of the account
    assert.doesNotMatch(plan(db, OLD, { account_id: a.id, folder: 'INBOX', local: 0, bad: BAD }), /folder=\?/, 'the old query did not use the folder')
    let total = 0
    for (const acc of [a.id, b.id]) {
      for (const local of [false, true]) {
        for (const folder of [...FOLDERS, 'nincs ilyen', '']) {
          const got = index.brokenHeaderRows(acc, { folder, local })
          assert.deepEqual(byId(got), byId(db.prepare(OLD).all({ account_id: acc, folder, local: local ? 1 : 0, bad: BAD })), `${when} ${acc} ${folder} ${local}`)
          total += got.length
        }
        // without a folder: every folder, the old rows (the POP3 local repair: local = true)
        const all = index.brokenHeaderRows(acc, { local })
        assert.deepEqual(byId(all), byId(db.prepare(OLD).all({ account_id: acc, folder: null, local: local ? 1 : 0, bad: BAD })), `${when} ${acc} all ${local}`)
        assert.ok(all.length > 0)
        assert.deepEqual(byId(index.brokenHeaderRows(acc, { folder: null, local })), byId(all))
      }
      assert.deepEqual(byId(index.brokenHeaderRows(acc)), byId(db.prepare(OLD).all({ account_id: acc, folder: null, local: 0, bad: BAD })))
    }
    assert.ok(total > 100, 'broken rows are there')
    assert.doesNotMatch(allSql, /folder =/)
  }
})
