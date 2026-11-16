import crypto from 'node:crypto'
import path from 'node:path'
import { onCleanup, tempDir } from './tmp.js'
import { openMailDatabase } from '../../core/db/index.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { SealedStore } from '../../core/store/sealed-file.js'

export const DAY = 86_400_000

// In-memory mail database with the full schema, closed when the test ends. SHADOWMAIL_TEST_ENCRYPTED=1:
// an encrypted file database instead, so a whole test file can run on what the app uses (the search tests).
export function memoryIndex(t) {
  const encrypted = process.env.SHADOWMAIL_TEST_ENCRYPTED === '1'
  const { db } = encrypted ? openMailDatabase(path.join(tempDir(t), 'mail.sqlite'), { key: crypto.randomBytes(32) }) : openMailDatabase(':memory:')
  onCleanup(t, () => db.close())
  return { db, index: new MailIndex(db) }
}

/**
 * data/store sealed, as the app's modules read and write it. Tests only: the key comes from the
 * folder path, so every instance on the same folder (fetcher, reader, composer, the test) shares it.
 */
export function sealedStore(dir) {
  return new SealedStore(dir, crypto.createHash('sha256').update(`test-store-key|${path.resolve(dir)}`).digest())
}

let accountSeq = 0
export function addAccount(db, overrides = {}) {
  accountSeq++
  const row = {
    name: `Teszt ${accountSeq}`,
    email: `teszt${accountSeq}@example.invalid`,
    type: 'imap',
    in_host: 'imap.example.invalid',
    in_port: 993,
    in_security: 'tls',
    in_user: `teszt${accountSeq}`,
    body_index_days: 1095,
    created_at: 0,
    ...overrides,
  }
  const cols = Object.keys(row)
  const info = db
    .prepare(`INSERT INTO accounts (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`)
    .run(row)
  return { id: Number(info.lastInsertRowid), ...row }
}

// A message row as the Syncer would build it, with an optional body.
export function addMessage(index, accountId, m) {
  const row = {
    account_id: accountId,
    folder: 'INBOX',
    uid: m.uid,
    message_id: m.messageId || null,
    in_reply_to: m.inReplyTo || null,
    refs: m.refs || null,
    from_addr: m.fromAddr || 'kuldo@example.invalid',
    from_name: m.fromName || null,
    to_addrs: m.to || 'cimzett@example.invalid',
    cc_addrs: '',
    subject: m.subject || '',
    date: m.date || 0,
    idate: m.idate || m.date || 0,
    flags: m.flags || '',
    size: 100,
    has_attachments: 0,
    attachments: null,
    body_state: 0,
    sender_text: m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr || 'kuldo@example.invalid',
    recipients_text: m.to || 'cimzett@example.invalid',
  }
  index.insertMany([row])
  const stored = index.getByUid(accountId, row.folder, row.uid)
  if (m.body) index.setBodies([{ id: stored.id, text: m.body, state: 1, preview: m.body.slice(0, 200) }])
  return stored.id
}
