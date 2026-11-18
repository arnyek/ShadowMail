// SPDX-License-Identifier: GPL-3.0-or-later
// The address book (since 0.12.0): people with their addresses and phones, in the
// encrypted database. One address belongs to at most one person (UNIQUE). Automatic adding after a send never
// changes an existing person and skips the addresses of deleted ones (contact_suppressed); the senders of
// received mail are not added by themselves, only by hand (addFromMessage).
// Errors are PeopleError with a code (bad_request, address_taken + the person's id, not_found, no_sender).

import { foldForSearch } from '../mime/text.js'
import { addrKey } from './addr-key.js'
import { vcardNameRest } from '../contacts/vcard.js'

export const LIMITS = Object.freeze({ name: 200, note: 10_000, label: 50, phone: 50, address: 320, emails: 20, phones: 20, list: 200 })
const SOURCES = new Set(['auto', 'manual', 'import'])
const collator = new Intl.Collator('hu', { sensitivity: 'base' })

// any character outside ASCII (unknownOf)
const NON_ASCII = /[^\x00-\x7f]/

export class PeopleError extends Error {
  constructor(code, extra = {}) {
    super(code)
    this.name = 'PeopleError'
    this.code = code
    Object.assign(this, extra)
  }
}

const bad = () => new PeopleError('bad_request')
// no control characters in one-line fields (a note may hold line breaks and tabs)
const LINE_CTL = /[\u0000-\u001f\u007f]/
const NOTE_CTL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const isEmail = s => typeof s === 'string' && s.length <= LIMITS.address && /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(s) && !LINE_CTL.test(s)

/**
 * A name that comes from somewhere else (a sent message's recipient, the old contacts table), made one that save() takes
 * unchanged: every run of control characters becomes one space, every run of spaces one space,
 * trimmed, and cut to LIMITS.name (the length save() checks), never inside a surrogate pair. Not a string: ''.
 * A name typed by hand is not cleaned: save() still refuses it (bad_request).
 */
export function cleanName(v) {
  if (typeof v !== 'string') return ''
  let s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  if (s.length > LIMITS.name) {
    let end = LIMITS.name
    const c = s.charCodeAt(end - 1)
    if (c >= 0xd800 && c <= 0xdbff) end-- // a high surrogate whose pair would be cut off
    s = s.slice(0, end).trim()
  }
  return s
}

function oneLine(v, max = LIMITS.name) {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || v.length > max || LINE_CTL.test(v)) throw bad()
  const t = v.trim()
  return t || null
}

/** Checks and normalizes what the page sends to save; throws bad_request. */
export function normalizePerson(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad()
  if (p.id !== undefined && p.id !== null && !(Number.isInteger(p.id) && p.id > 0)) throw bad()
  if (p.note !== undefined && p.note !== null && (typeof p.note !== 'string' || p.note.length > LIMITS.note || NOTE_CTL.test(p.note))) throw bad()
  const emails = p.emails ?? []
  const phones = p.phones ?? []
  if (!Array.isArray(emails) || emails.length > LIMITS.emails || !Array.isArray(phones) || phones.length > LIMITS.phones) throw bad()
  const seen = new Set()
  const outEmails = emails.map((e, i) => {
    const o = typeof e === 'string' ? { address: e } : e
    if (!o || typeof o !== 'object' || typeof o.address !== 'string') throw bad()
    const address = addrKey(o.address)
    if (!isEmail(address) || seen.has(address)) throw bad()
    seen.add(address)
    return { address, label: oneLine(o.label, LIMITS.label), isPrimary: o.isPrimary === true || (i === 0 && !emails.some(x => x && x.isPrimary === true)) }
  })
  const outPhones = phones.map(ph => {
    const o = typeof ph === 'string' ? { number: ph } : ph
    if (!o || typeof o !== 'object') throw bad()
    const number = oneLine(o.number, LIMITS.phone)
    if (!number) throw bad()
    return { number, label: oneLine(o.label, LIMITS.label) }
  })
  const person = {
    id: p.id ?? null,
    displayName: oneLine(p.displayName) || '',
    givenName: oneLine(p.givenName),
    familyName: oneLine(p.familyName),
    org: oneLine(p.org),
    title: oneLine(p.title),
    note: p.note ? p.note.trim() || null : null,
    emails: outEmails,
    phones: outPhones,
  }
  // at least a valid address or a name
  if (!person.emails.length && !person.displayName && !person.givenName && !person.familyName) throw bad()
  if (!person.displayName) person.displayName = [person.givenName, person.familyName].filter(Boolean).join(' ')
  return person
}

// --- import -------------------------------------------------------------------------------------------------------------
// A contact read from a file (core/contacts vcard.js / csv.js) is made one that save() would take: names, org, title
// cleaned like cleanName (control characters out, cut to LIMITS), the note's line breaks kept, invalid addresses left out,
// the same address and the same phone number (by its digits and '+') once. Then, by address (no case):
//   - none of its addresses is known: a new person (source 'import');
//   - all known ones belong to ONE person: merged into it: its fields STAY, only the empty ones are filled; new addresses
//     and phones are added (up to LIMITS), new vcard_extra lines appended (a line once). An N line is added only when the
//     person has none and it carries a middle name, prefix or suffix (the export writes an N for everyone: a re-import of
//     our own export changes nothing);
//   - its addresses belong to TWO or more people: not imported (two_people);
//   - neither a name nor a valid address: not imported (no_name_or_address).
// A later contact of the same file may merge into one made by an earlier one. An automatic person that a merge really
// changes becomes 'import'; 'manual' and 'import' stay; an unchanged one is not written.
// Nothing is left out silently: an imported contact gets a warning (it is still
// imported, and it is not invalid) for addresses / phones over the LIMITS (address_limit, one item for the addresses and
// one for the phones, `dropped` = how many) and for addresses that are not e-mail addresses (invalid_address).

const NOTE_CTL_ALL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const EXTRA_CTL = /[\u0000-\u0008\u000a-\u001f\u007f]/
const NAME_FIELDS = ['displayName', 'givenName', 'familyName', 'org', 'title', 'note']
const isNameLine = l => /^N[;:]/i.test(l)
const phoneKey = n => n.replace(/[^\d+]/g, '') || n

/** Cut to max UTF-16 units, never inside a surrogate pair. */
function cutAt(s, max) {
  if (s.length <= max) return s
  let end = max
  const c = s.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return s.slice(0, end)
}
const importLine = (v, max = LIMITS.name) => cutAt(cleanName(v), max).trim() || null
/** The shown name made of the given and the family name (normalizePerson's rule), cut to LIMITS.name; none: null. */
const composedName = p => cutAt([p.givenName, p.familyName].filter(Boolean).join(' '), LIMITS.name).trim() || null
function importNote(v) {
  if (typeof v !== 'string') return null
  return cutAt(v.replace(/\r\n?/g, '\n').replace(NOTE_CTL_ALL, '').trim(), LIMITS.note).trim() || null
}

/** A read contact -> { displayName, givenName, familyName, org, title, note, emails, phones, extra: [lines] }. */
function candidateOf(card) {
  const c = {
    displayName: importLine(card.displayName),
    givenName: importLine(card.givenName),
    familyName: importLine(card.familyName),
    org: importLine(card.org),
    title: importLine(card.title),
    note: importNote(card.note),
    emails: [],
    phones: [],
    extra: [],
    badAddresses: 0,
  }
  for (const e of Array.isArray(card.emails) ? card.emails : []) {
    const address = addrKey(e?.address || '')
    if (!isEmail(address)) {
      if (address) c.badAddresses++
      continue
    }
    if (c.emails.some(x => x.address === address)) continue
    c.emails.push({ address, label: importLine(e.label, LIMITS.label), isPrimary: e.isPrimary === true })
  }
  for (const ph of Array.isArray(card.phones) ? card.phones : []) {
    const number = importLine(ph?.number, LIMITS.phone)
    if (!number || c.phones.some(x => phoneKey(x.number) === phoneKey(number))) continue
    c.phones.push({ number, label: importLine(ph.label, LIMITS.label) })
  }
  for (const l of String(card.vcardExtra || '').split(/\r\n|\n/)) if (l && !EXTRA_CTL.test(l) && !c.extra.includes(l)) c.extra.push(l)
  // a shown name that is only one of its own addresses is no name (the vCard writer puts the address in FN for a
  // nameless person, because 3.0 needs an FN): a re-import must not turn it into a name
  if (c.displayName && c.emails.some(e => e.address === addrKey(c.displayName))) c.displayName = null
  return c
}

/**
 * A new person from a candidate: one primary address (the marked one, else the first), LIMITS kept.
 * { target, droppedEmails, droppedPhones }.
 */
function newTargetOf(c) {
  const emails = c.emails.slice(0, LIMITS.emails)
  const primary = Math.max(0, emails.findIndex(e => e.isPrimary))
  const { badAddresses, ...fields } = c
  return {
    target: {
      id: null,
      isNew: true,
      // no shown name: the given and the family name, as normalizePerson (a manual save) makes it
      person: {
        ...fields,
        displayName: c.displayName || composedName(c),
        emails: emails.map((e, i) => ({ ...e, isPrimary: i === primary })),
        phones: c.phones.slice(0, LIMITS.phones),
        extra: [...c.extra],
      },
    },
    droppedEmails: c.emails.length - emails.length,
    droppedPhones: Math.max(0, c.phones.length - LIMITS.phones),
  }
}

/** Merges a candidate into a target: { changed, droppedEmails, droppedPhones } (over the LIMITS). */
function mergeInto(t, c) {
  const p = t.person
  let changed = false
  let droppedEmails = 0
  let droppedPhones = 0
  for (const f of NAME_FIELDS) {
    if (!p[f] && c[f]) {
      p[f] = c[f]
      changed = true
    }
  }
  for (const e of c.emails) {
    if (p.emails.some(x => x.address === e.address)) continue
    if (p.emails.length >= LIMITS.emails) {
      droppedEmails++
      continue
    }
    p.emails.push({ address: e.address, label: e.label, isPrimary: p.emails.length === 0 })
    changed = true
  }
  for (const ph of c.phones) {
    if (p.phones.some(x => phoneKey(x.number) === phoneKey(ph.number))) continue
    if (p.phones.length >= LIMITS.phones) {
      droppedPhones++
      continue
    }
    p.phones.push(ph)
    changed = true
  }
  for (const l of c.extra) {
    if (p.extra.includes(l)) continue
    if (isNameLine(l) && (p.extra.some(isNameLine) || !/[^;]/.test(vcardNameRest([l])))) continue
    p.extra.push(l)
    changed = true
  }
  // a person without a shown name that has (or just got) a given / family name gets the composed one
  if (!p.displayName && (p.givenName || p.familyName)) {
    p.displayName = composedName(p)
    changed = true
  }
  return { changed, droppedEmails, droppedPhones }
}

export class People {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db
    this.now = now
    this.s = {
      byAddress: db.prepare('SELECT person_id FROM person_emails WHERE address = ?'),
      suppressed: db.prepare('SELECT 1 FROM contact_suppressed WHERE address = ?'),
      suppress: db.prepare('INSERT OR IGNORE INTO contact_suppressed (address, created_at) VALUES (?, ?)'),
      unsuppress: db.prepare('DELETE FROM contact_suppressed WHERE address = ?'),
      insertPerson: db.prepare(`INSERT INTO people (display_name, given_name, family_name, org, title, note, source, created_at, updated_at)
        VALUES (@displayName, @givenName, @familyName, @org, @title, @note, @source, @now, @now)`),
      updatePerson: db.prepare(`UPDATE people SET display_name = @displayName, given_name = @givenName, family_name = @familyName,
        org = @org, title = @title, note = @note, updated_at = @now WHERE id = @id`),
      insertEmail: db.prepare('INSERT INTO person_emails (person_id, address, label, is_primary) VALUES (?, ?, ?, ?)'),
      insertPhone: db.prepare('INSERT INTO person_phones (person_id, number, label) VALUES (?, ?, ?)'),
      clearEmails: db.prepare('DELETE FROM person_emails WHERE person_id = ?'),
      clearPhones: db.prepare('DELETE FROM person_phones WHERE person_id = ?'),
      person: db.prepare('SELECT * FROM people WHERE id = ?'),
      emails: db.prepare('SELECT address, label, is_primary FROM person_emails WHERE person_id = ? ORDER BY is_primary DESC, rowid'),
      phones: db.prepare('SELECT number, label FROM person_phones WHERE person_id = ? ORDER BY rowid'),
      emailsOf: db.prepare('SELECT address FROM person_emails WHERE person_id = ?'),
      extraOf: db.prepare('SELECT vcard_extra FROM people WHERE id = ?'),
      setExtra: db.prepare('UPDATE people SET vcard_extra = ? WHERE id = ?'),
      // an automatic person an import really changed is an imported one; manual and import stay
      autoToImport: db.prepare("UPDATE people SET source = 'import' WHERE id = ? AND source = 'auto'"),
      remove: db.prepare('DELETE FROM people WHERE id = ?'),
      count: db.prepare('SELECT count(*) AS n FROM people'),
      // the search runs in JS over these (foldForSearch: no case, no accents): SQLite's LIKE folds ASCII only, so "ödön"
      // would not find "Ödön"
      listAll: db.prepare(`SELECT p.id, p.display_name, p.source,
          (SELECT address FROM person_emails e WHERE e.person_id = p.id ORDER BY is_primary DESC, rowid LIMIT 1) AS address,
          concat_ws(' ', p.display_name, p.given_name, p.family_name, p.org,
            (SELECT group_concat(address, ' ') FROM person_emails e WHERE e.person_id = p.id)) AS search
        FROM people p`),
      // the completion: a person's name or ANY of their addresses; ranked by the use count of that address
      suggestAll: db.prepare(`SELECT p.display_name AS name, concat_ws(' ', p.display_name, p.given_name, p.family_name) AS names, e.address,
          COALESCE(c.use_count, 0) AS uses, COALESCE(c.last_used, 0) AS last, e.is_primary AS prim
        FROM person_emails e JOIN people p ON p.id = e.person_id LEFT JOIN contacts c ON c.address = e.address
        WHERE NOT EXISTS (SELECT 1 FROM contact_suppressed s WHERE s.address = e.address)`),
    }
    this.autoTx = db.transaction((list, now) => {
      let added = 0
      for (const r of list) {
        const address = addrKey(r.address || '')
        if (!isEmail(address) || this.s.byAddress.get(address) || this.s.suppressed.get(address)) continue
        const name = cleanName(r.name)
        const id = this.s.insertPerson.run({ displayName: name, givenName: null, familyName: null, org: null, title: null, note: null, source: 'auto', now }).lastInsertRowid
        this.s.insertEmail.run(id, address, null, 1)
        added++
      }
      return added
    })
    this.saveTx = db.transaction((p, source, now) => {
      for (const e of p.emails) {
        const owner = this.s.byAddress.get(e.address)
        if (owner && owner.person_id !== p.id) throw new PeopleError('address_taken', { personId: owner.person_id, address: e.address })
      }
      let id = p.id
      if (id) {
        if (!this.s.person.get(id)) throw new PeopleError('not_found')
        this.s.updatePerson.run({ ...p, now })
        this.s.clearEmails.run(id)
        this.s.clearPhones.run(id)
      } else id = Number(this.s.insertPerson.run({ ...p, source, now }).lastInsertRowid)
      for (const e of p.emails) {
        this.s.insertEmail.run(id, e.address, e.label, e.isPrimary ? 1 : 0)
        // saved by hand: the address may come again automatically
        this.s.unsuppress.run(e.address)
      }
      for (const ph of p.phones) this.s.insertPhone.run(id, ph.number, ph.label)
      return id
    })
    // the import's writes, one transaction; the plan is made again inside it, against the database as it is now
    this.importTx = db.transaction((cards, now) => {
      const plan = this.planImport(cards)
      for (const t of plan.targets) {
        const p = t.person
        const fields = { displayName: p.displayName || '', givenName: p.givenName, familyName: p.familyName, org: p.org, title: p.title, note: p.note, now }
        let id = t.id
        if (t.isNew) id = Number(this.s.insertPerson.run({ ...fields, source: 'import' }).lastInsertRowid)
        else {
          this.s.updatePerson.run({ ...fields, id })
          // only changed people are written (plan.targets): an unchanged one keeps its source too
          this.s.autoToImport.run(id)
          this.s.clearEmails.run(id)
          this.s.clearPhones.run(id)
        }
        this.s.setExtra.run(p.extra.length ? p.extra.join('\r\n') : null, id)
        for (const e of p.emails) {
          this.s.insertEmail.run(id, e.address, e.label, e.isPrimary ? 1 : 0)
          // an imported address may come again automatically
          this.s.unsuppress.run(e.address)
        }
        for (const ph of p.phones) this.s.insertPhone.run(id, ph.number, ph.label)
      }
      return plan.counts
    })
    this.deleteTx = db.transaction((ids, now) => {
      let removed = 0
      for (const id of ids) {
        for (const e of this.s.emailsOf.all(id)) this.s.suppress.run(e.address, now)
        removed += this.s.remove.run(id).changes
      }
      return removed
    })
  }

  /** After a send, in the send's transaction (Contacts.recordSent): new automatic people; returns how many. */
  autoAdd(recipients, now = this.now()) {
    return this.autoTx(recipients.filter(r => r && r.address), now)
  }

  /** { items: [{ id, name, address, source }], total }: by display name (or address), Hungarian order (Intl.Collator('hu')). */
  list({ q = '', offset = 0, limit = 100 } = {}) {
    const t = foldForSearch(String(q || '').trim())
    const all = this.s.listAll.all()
    const rows = t ? all.filter(r => foldForSearch(r.search).includes(t)) : all
    const key = r => r.display_name || r.address || ''
    rows.sort((a, b) => collator.compare(key(a), key(b)) || (a.address || '').localeCompare(b.address || '') || a.id - b.id)
    return { total: rows.length, items: rows.slice(offset, offset + limit).map(r => ({ id: r.id, name: r.display_name, address: r.address || null, source: r.source })) }
  }

  get(id) {
    const p = this.s.person.get(id)
    if (!p) throw new PeopleError('not_found')
    return {
      id: p.id,
      displayName: p.display_name,
      givenName: p.given_name,
      familyName: p.family_name,
      org: p.org,
      title: p.title,
      note: p.note,
      source: p.source,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      emails: this.s.emails.all(id).map(e => ({ address: e.address, label: e.label, isPrimary: e.is_primary === 1 })),
      phones: this.s.phones.all(id).map(ph => ({ number: ph.number, label: ph.label })),
    }
  }

  /** New (no id: source manual) or changed person; returns its id. address_taken when an address is another person's. */
  save(input, { source = 'manual' } = {}) {
    if (!SOURCES.has(source)) throw bad()
    return this.saveTx(normalizePerson(input), source, this.now())
  }

  /** Deletes; their addresses go to the suppressed list. Returns how many went. */
  delete(ids) {
    return this.deleteTx(ids, this.now())
  }

  /**
   * The sender of a message, by hand: a new manual person, or the one that already has the address; either way
   * the address leaves the suppressed list. { id, created }.
   */
  addSender({ address, name }) {
    const a = addrKey(address || '')
    if (!isEmail(a)) throw new PeopleError('no_sender')
    const owner = this.s.byAddress.get(a)
    if (owner) {
      this.s.unsuppress.run(a)
      return { id: owner.person_id, created: false }
    }
    // the sender's name is cleaned as the migration and the automatic adding do
    return { id: this.save({ displayName: cleanName(name), emails: [a] }), created: true }
  }

  /**
   * The addresses of `list` that are NOT in the address book (any source: manual, import, auto), compared as addrKey of
   * the NFKC form (case-free, the name does not count). An address with any non-ASCII character (local part or an IDN
   * not in punycode) is always unknown, shown as given: lowercasing maps some of them onto an ASCII address (the Kelvin
   * sign U+212A -> k) while the server delivers to another mailbox. Each once, in order.
   */
  unknownOf(list) {
    const out = []
    const seen = new Set()
    for (const raw of list) {
      const given = String(raw || '').trim()
      const a = addrKey(given.normalize('NFKC'))
      if (!a) continue
      const odd = NON_ASCII.test(given)
      const key = odd ? given : a
      if (seen.has(key)) continue
      seen.add(key)
      if (odd || !this.s.byAddress.get(a)) out.push(key)
    }
    return out
  }

  /**
   * The import plan for read contacts (nothing is written): { results: [{ line, kind: new|merged|unchanged|invalid,
   * reason?, target? }], warnings: [{ line, reason: address_limit|invalid_address, dropped }], targets: [the people to
   * write], counts: { new, merged, unchanged, invalid, warnings } }.
   */
  planImport(cards) {
    const byAddr = new Map() // address -> target, for the addresses this plan already places
    const existing = new Map() // person id -> target
    const created = []
    const results = []
    const warnings = []
    const targetOfAddress = address => {
      const t = byAddr.get(address)
      if (t) return t
      const row = this.s.byAddress.get(address)
      if (!row) return null
      let e = existing.get(row.person_id)
      if (!e) {
        const p = this.get(row.person_id)
        const extra = (this.s.extraOf.get(row.person_id).vcard_extra || '').split(/\r\n|\n/).filter(Boolean)
        e = { id: p.id, isNew: false, dirty: false, person: { ...p, extra } }
        existing.set(p.id, e)
      }
      return e
    }
    for (const card of cards) {
      const c = candidateOf(card)
      if (!c.emails.length && !c.displayName && !c.givenName && !c.familyName) {
        results.push({ line: card.line, kind: 'invalid', reason: 'no_name_or_address' })
        continue
      }
      const owners = new Set(c.emails.map(e => targetOfAddress(e.address)).filter(Boolean))
      if (owners.size > 1) {
        results.push({ line: card.line, kind: 'invalid', reason: 'two_people' })
        continue
      }
      let t
      let dropped
      if (owners.size === 1) {
        t = [...owners][0]
        dropped = mergeInto(t, c)
        if (dropped.changed) t.dirty = true
        results.push({ line: card.line, kind: dropped.changed ? 'merged' : 'unchanged', target: t })
      } else {
        dropped = newTargetOf(c)
        t = dropped.target
        created.push(t)
        results.push({ line: card.line, kind: 'new', target: t })
      }
      if (dropped.droppedEmails) warnings.push({ line: card.line, reason: 'address_limit', dropped: dropped.droppedEmails })
      if (dropped.droppedPhones) warnings.push({ line: card.line, reason: 'address_limit', dropped: dropped.droppedPhones })
      if (c.badAddresses) warnings.push({ line: card.line, reason: 'invalid_address', dropped: c.badAddresses })
      for (const e of t.person.emails) byAddr.set(e.address, t)
    }
    const counts = { new: 0, merged: 0, unchanged: 0, invalid: 0, warnings: warnings.length }
    for (const r of results) counts[r.kind]++
    return { results, warnings, counts, targets: [...created, ...[...existing.values()].filter(t => t.dirty)] }
  }

  /** Writes an import in one transaction (the plan is made again inside it); any error writes nothing. The counts. */
  applyImport(cards) {
    return this.importTx(cards, this.now())
  }

  /** Every person (ids null) or the given ones, with vcardExtra, in the list's order: for the export. */
  exportPeople(ids = null) {
    const all = this.s.listAll.all()
    const want = ids ? new Set(ids) : null
    const rows = all.filter(r => !want || want.has(r.id))
    const key = r => r.display_name || r.address || ''
    rows.sort((a, b) => collator.compare(key(a), key(b)) || (a.address || '').localeCompare(b.address || '') || a.id - b.id)
    return rows.map(r => ({ ...this.get(r.id), vcardExtra: this.s.extraOf.get(r.id).vcard_extra || null }))
  }

  count() {
    return this.s.count.get().n
  }

  /** the person that has this address (no case), or null; the reader shows "Címlistához ad" only without one. */
  personOf(address) {
    const a = addrKey(address || '')
    if (!isEmail(a)) return null
    const row = this.s.byAddress.get(a)
    return row ? row.person_id : null
  }

  /** Completion rows from the people (name or any address, no case, no accents), the most used address first. */
  suggest(term, limit) {
    const t = foldForSearch(String(term || '').trim())
    if (!t) return []
    return this.s.suggestAll
      .all()
      .filter(r => foldForSearch(r.names).includes(t) || r.address.toLowerCase().includes(t))
      .sort((a, b) => b.uses - a.uses || b.last - a.last || b.prim - a.prim)
      .slice(0, limit)
  }
}
