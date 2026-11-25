#!/usr/bin/env node
// Test-data generator: a data folder with a master password, one IMAP account and N messages
// in its INBOX (plus a few other folders), written straight into the index. For measuring the
// message list (open time, scrolling) without a server. Not part of `npm test`.
//
//   node test/tools/seed-index.mjs <empty data folder> [--count 10000] [--host 127.0.0.1] [--port 1] [--eml <folder>] [--previews]
//
// --eml: every .eml of the folder becomes an unread INBOX message whose full source is already
// in data/store (as if it had been opened once), e.g. test/fixtures/hostile for the reader measurement.
// --previews: three of every four INBOX messages get an indexed text and its list preview.
// --marks: some INBOX messages are marked replied (\Answered) or forwarded ($Forwarded), for the pictures.
//
// The account points at --host:--port (default 127.0.0.1:1, nothing listens there): the sync fails
// fast with "connection refused" and never leaves the machine. The master password is printed;
// the account password is a fixed dummy (no real mailbox is involved).
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { MailIndex } from '../../core/db/mail-index.js'
import { createVaultedDatabase, openSealedStore } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { parseMessage } from '../../core/mime/message.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { count: { type: 'string', default: '10000' }, host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '1' }, eml: { type: 'string' }, previews: { type: 'boolean', default: false }, marks: { type: 'boolean', default: false } },
})
const dataDir = positionals[0]
if (!dataDir) {
  console.error('usage: seed-index.mjs <empty data folder> [--count N] [--host H] [--port P]')
  process.exit(2)
}
const count = Number(values.count)
const MASTER = 'Teszt-mesterjelszo-mero'

fs.mkdirSync(dataDir, { recursive: true })
const { db, vault } = await createVaultedDatabase(dataDir, MASTER) // vault.json + the encrypted mail.sqlite
const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
const sealed = openSealedStore(vault, dataDir)
const { account } = store.save({
  ...newAccountDefaults('imap'),
  name: 'Mérőfiók',
  email: 'meres@example.invalid',
  in_host: values.host,
  in_port: Number(values.port),
  in_security: 'none',
  in_user: 'meres',
  in_password: 'nem-valodi-jelszo',
  smtp_host: values.host,
  smtp_port: Number(values.port),
  smtp_security: 'none',
})

const index = new MailIndex(db)
const now = Date.now()
const folders = [
  ['INBOX', null],
  ['Drafts', '\\Drafts'],
  ['Sent', '\\Sent'],
  ['Trash', '\\Trash'],
  ['Junk', '\\Junk'],
  ['Ügyfelek', null],
  ['Ügyfelek/Példa Kft.', null],
]
for (const [p, specialUse] of folders) {
  index.upsertFolder({ account_id: account.id, path: p, delimiter: '/', special_use: specialUse, uidvalidity: '1', synced_at: now })
}

const names = ['Kovács Anna', 'Nagy Péter', 'Szabó Éva', 'Tóth Gábor', 'Horváth Zsófia', 'Varga István', '', 'Kiss Ödön']
const words = ['ajánlat', 'számla', 'egyeztetés', 'kazán', 'karbantartás', 'szerződés', 'időpont', 'hírlevél', 'rendelés', 'visszaigazolás']
const rows = []
for (let i = 0; i < count; i++) {
  const name = names[i % names.length]
  const addr = `felado${i % 53}@example.invalid`
  const date = now - i * 37 * 60_000
  rows.push({
    account_id: account.id, folder: 'INBOX', uid: i + 1, message_id: `<seed-${i}@example.invalid>`, in_reply_to: null, refs: null,
    from_addr: addr, from_name: name, to_addrs: 'meres@example.invalid', cc_addrs: '',
    subject: `${words[i % words.length]} ${words[(i * 7) % words.length]} #${i}`, date, idate: date,
    flags: [i % 5 ? '\\Seen' : '', i % 17 === 0 ? '\\Flagged' : '', values.marks && i % 7 === 2 ? '\\Answered' : '', values.marks && i % 11 === 4 ? '$Forwarded' : ''].filter(Boolean).join(' '),
    size: 2000, has_attachments: i % 9 === 0 ? 1 : 0, attachments: null, body_state: 3,
    sender_text: name ? `${name} <${addr}>` : addr, recipients_text: 'meres@example.invalid',
  })
}
index.insertMany(rows)
if (values.previews) {
  const texts = [
    'Kedves Bence, küldöm a kért árajánlatot a kazán cseréjére, a részleteket a csatolt fájlban találod.',
    'Szia! A jövő heti egyeztetést áttehetnénk csütörtök délelőttre? Nekem 10 óra lenne a legjobb.',
    'Tisztelt Ügyfelünk! Mellékelten küldjük a novemberi számlát, a fizetési határidő 8 nap.',
    'A karbantartás időpontját visszaigazoljuk: a szerelő kedden 8 és 12 óra között érkezik.',
    'Köszönöm a gyors választ, a szerződés aláírt példányát holnap postázom.',
    'Rendelésed visszaigazolása: a csomag két munkanapon belül átvehető.',
  ]
  const ids = index.listIds({ accountId: account.id, folder: 'INBOX' })
  index.setBodies(ids.filter((_, i) => i % 4 !== 3).map((id, i) => ({ id, text: texts[i % texts.length], state: 1, preview: texts[i % texts.length] })))
}
index.insertMany(Array.from({ length: Math.min(30, rows.length) }, (_, i) => ({ ...rows[i], folder: 'Sent', uid: i + 1, flags: '\\Seen' })))

const emlMessages = []
if (values.eml) {
  const files = fs.readdirSync(values.eml).filter(f => f.endsWith('.eml')).sort()
  let uid = count
  for (const f of files) {
    const source = fs.readFileSync(path.join(values.eml, f))
    const m = await parseMessage(source)
    const from = m.from[0] || { name: '', address: '' }
    uid++
    const date = m.date || now
    index.insertMany([{
      account_id: account.id, folder: 'INBOX', uid, message_id: m.messageId, in_reply_to: null, refs: null,
      from_addr: from.address, from_name: from.name, to_addrs: m.to.map(a => a.address).join(', '), cc_addrs: '',
      subject: m.subject, date: now + uid, idate: date, flags: '', size: source.length,
      has_attachments: m.attachments.some(a => !a.inline) ? 1 : 0, attachments: null, body_state: 0,
      sender_text: from.address, recipients_text: '',
    }])
    const row = index.getByUid(account.id, 'INBOX', uid)
    const rel = `${account.id}/${row.id}.eml`
    sealed.write(rel, source) // sealed, as the app writes it
    index.setStorePath(row.id, rel)
    emlMessages.push({ id: row.id, file: f, subject: m.subject })
  }
}
db.close()
console.log(JSON.stringify({ dataDir, accountId: account.id, messages: count, master: MASTER, eml: emlMessages }))
