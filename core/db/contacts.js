// SPDX-License-Identifier: GPL-3.0-or-later
// Address book for the recipient completion: addresses we sent to (with a use
// count) and the senders of received messages. Nothing is imported from elsewhere.
// Since 0.12.0, with `people` (core/db/people.js) the send also adds the new recipients as automatic people, in the same
// transaction, and the completion looks at the people first (their names and every address).
// No branch suggests the address of a deleted person (contact_suppressed, case-insensitive) until it is
// taken back by hand (save / addFromMessage). The filter is in SQL, before the LIMIT, so the suppressed addresses do not
// make the list shorter. Typed by hand, such an address still gets the message, and the send does not take it back.
import { addrKey } from './addr-key.js'

const escapeLike = s => s.replace(/[\\%_]/g, c => `\\${c}`)

export class Contacts {
  constructor(db, { people = null } = {}) {
    this.db = db
    this.people = people
    this.s = {
      upsert: db.prepare(`INSERT INTO contacts (address, name, last_used, use_count) VALUES (@address, @name, @now, 1)
        ON CONFLICT (address) DO UPDATE SET use_count = use_count + 1, last_used = @now,
          name = COALESCE(NULLIF(excluded.name, ''), contacts.name)`),
      fromContacts: db.prepare(`SELECT address, name, use_count, last_used FROM contacts
        WHERE (address LIKE @q ESCAPE '\\' OR name LIKE @q ESCAPE '\\')
          AND NOT EXISTS (SELECT 1 FROM contact_suppressed s WHERE s.address = contacts.address)
        ORDER BY use_count DESC, last_used DESC LIMIT @limit`),
      // two levels: the native lower() groups the rows (ASCII case), then addr_key() (a JS call, Unicode
      // case) merges those groups and checks the suppressed list once per group, not per message: per message it cost
      // +66-81 % on 300 000 messages (measured), per group about none
      fromMessages: db.prepare(`SELECT address, name, n, last FROM (
          SELECT addr_key(addr) AS k, MAX(addr) AS address, MAX(nm) AS name, SUM(cnt) AS n, MAX(lst) AS last FROM (
            SELECT from_addr AS addr, MAX(from_name) AS nm, COUNT(*) AS cnt, MAX(date) AS lst
            FROM messages WHERE from_addr IS NOT NULL AND from_addr <> '' AND (from_addr LIKE @q ESCAPE '\\' OR from_name LIKE @q ESCAPE '\\')
            GROUP BY lower(from_addr))
          GROUP BY addr_key(addr))
        WHERE NOT EXISTS (SELECT 1 FROM contact_suppressed s WHERE s.address = k)
        ORDER BY n DESC, last DESC LIMIT @limit`),
    }
    this.recordTx = db.transaction((list, now, addPeople) => {
      for (const a of list) this.s.upsert.run({ address: addrKey(a.address), name: a.name || '', now })
      if (this.people && addPeople) this.people.autoAdd(list, now)
    })
  }

  /** After a send: every recipient (to, cc, bcc). addPeople false: the suggestion counts only, no new people (an MCP send). */
  recordSent(addresses, now = Date.now(), { addPeople = true } = {}) {
    this.recordTx(addresses.filter(a => a && a.address), now, addPeople)
  }

  /** Suggestions for what was typed (part of a name or an address), the most used first. */
  suggest(term, limit = 8) {
    const t = String(term || '').trim()
    if (t.length < 2) return []
    const q = `%${escapeLike(t)}%`
    const out = []
    const seen = new Set()
    // the people first (a name finds all of the person's addresses), by the use count of the address
    if (this.people)
      for (const r of this.people.suggest(t, limit)) {
        const key = addrKey(r.address)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ name: r.name || '', address: r.address })
      }
    for (const r of this.s.fromContacts.all({ q, limit })) {
      if (out.length >= limit) break
      if (seen.has(addrKey(r.address))) continue
      seen.add(addrKey(r.address))
      out.push({ name: r.name || '', address: r.address })
    }
    for (const r of this.s.fromMessages.all({ q, limit })) {
      if (out.length >= limit) break
      const key = addrKey(r.address)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name: r.name || '', address: r.address })
    }
    return out
  }
}
