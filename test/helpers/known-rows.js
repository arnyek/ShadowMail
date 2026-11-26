// A folder whose messages the index already holds (headers only, no flags, outside the body limit and already marked
// so, body_state 3, as after their first sync): the next sync
// against a server with the same UIDVALIDITY and UIDs asks nothing but their flags. For the imap-wire server, whose
// messages have no envelope (a sync that saw a NEW UID would ask for one).

/** n rows (UID 1..n) of `path` with the date `date` (ms), and the folder row with `uidvalidity`; -> the UIDs */
export function seedKnownRows(index, accountId, path, n, { uidvalidity = 7, date }) {
  index.upsertFolder({ account_id: accountId, path, delimiter: '.', special_use: null, uidvalidity: String(uidvalidity), last_uid: n, highest_modseq: null, synced_at: 1 })
  const uids = Array.from({ length: n }, (_, i) => i + 1)
  const rows = uids.map(uid => ({
    account_id: accountId, folder: path, uid, message_id: `<k${uid}@x>`, in_reply_to: null, refs: null, from_addr: 'a@example.invalid', from_name: 'A',
    to_addrs: 'b@example.invalid', cc_addrs: '', subject: `K ${uid}`, date, idate: date, flags: '', size: 1, has_attachments: 0, attachments: null,
    body_state: 3, sender_text: 'a', recipients_text: 'b',
  }))
  for (let i = 0; i < rows.length; i += 5000) index.insertMany(rows.slice(i, i + 5000))
  return uids
}
