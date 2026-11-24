// SPDX-License-Identifier: GPL-3.0-or-later
// Local labels (0.17.0, migration 15). One list for every account; a message has 0..n of them. A label binds to
// (account, label_key) (core/db/label-key.js), not to a row id, and the binding stays when its rows go: every read
// here joins `messages`, so a binding without a row (the message deleted for good) is never counted or shown.
// Only the database is written here. Each label has an IMAP keyword (core/db/label-keyword.js), made on create and kept
// on a rename: the name an IMAP account's server stores the label as.
// What a row shows (0.17.0): on an IMAP account's row the labels whose keyword is among the row's flags (the server's,
// brought by the sync), together with the local bindings; on POP3 and in local folders the local bindings only. The
// keyword is matched in ASCII lower case on both sides: SQLite's lower() folds A-Z only (measured), so the JS side does the
// same (keywordLabelIds); a flag with any other letter never matches a keyword (which is ASCII).
import { labelKeyword } from './label-keyword.js'

export const LABEL_NAME_MAX = 64
export const MAX_LABEL_IDS = 500 // message ids per setLabels call (the same cap as the other mail actions)
export const MAX_LABELS = 1000 // labels in the list: the order of the whole list goes in one call (labels:reorder)
export const MAX_STATE_IDS = 100_000 // message ids per stateOf call: a whole selected folder (the selection's own cap)
const COLOR_RE = /^#[0-9a-f]{6}$/i
// C0, DEL, C1, the line and paragraph separators, and the bidi / zero-width / format controls: a name is one visible line
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/
// what draws nothing: a name made only of these (and spaces) is empty to the eye (U+00AD soft hyphen, U+034F, the Hangul
// fillers, U+2800 braille blank, every format character and space)
const INVISIBLE_RE = /[\p{Cf}\p{Z}\u034f\u115f\u1160\u2800\u3164\uffa0]/gu

export class LabelError extends Error {
  constructor(code, data = {}) {
    super(code)
    this.code = code
    Object.assign(this, data)
  }
}

const isRowId = v => Number.isInteger(v) && v > 0

/** A label name: trimmed, 1..64 characters (code points), no control character. Throws bad_name. */
export function cleanLabelName(name) {
  if (typeof name !== 'string') throw new LabelError('bad_name')
  // NFC: a composed and a decomposed "á" are one name
  const s = name.normalize('NFC').trim()
  const n = [...s].length
  if (n < 1 || n > LABEL_NAME_MAX || CONTROL_RE.test(s) || !s.replace(INVISIBLE_RE, '')) throw new LabelError('bad_name')
  return s
}

/** A label color '#rrggbb', stored lower case. Throws bad_color. */
export function cleanLabelColor(color) {
  if (typeof color !== 'string' || !COLOR_RE.test(color)) throw new LabelError('bad_color')
  return color.toLowerCase()
}

// the name's identity: case-insensitive for every letter (the column's NOCASE folds only A-Z: "Ábel" = "ábel" here)
const nameKey = name => name.toLowerCase()

/** A-Z to a-z and nothing else: what SQLite's lower() does, so a flag compares the same in JS and in SQL. */
export const asciiLower = s => String(s).replace(/[A-Z]+/g, c => c.toLowerCase())

/**
 * The SQL test "the label `l` is on the row `m` through its server keyword": an IMAP account's row whose flags hold the
 * keyword as a whole word, in ASCII lower case. The same rule as keywordLabelIds.
 */
export const KEYWORD_ON_ROW = `(l.keyword IS NOT NULL
  AND instr(' ' || lower(COALESCE(m.flags, '')) || ' ', ' ' || l.keyword || ' ') > 0
  AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = m.account_id AND a.type = 'imap'))`

/**
 * The rows that can carry a label keyword: a flag of no system form (not \\x, not $x; our keywords never start with $).
 * BYTE FOR BYTE the WHERE of the partial index idx_messages_keyword_flags (migration 17): SQLite uses a partial index only
 * for the same expression (test/label-server-read.test.js checks it against sqlite_master).
 */
export const KEYWORD_FLAGS_WHERE = "(' ' || flags) GLOB '* [^\\$]*'"

/** The ids of the labels an IMAP row's flags carry (flags: space-separated, as stored), by Map(keyword -> label id). */
export function keywordLabelIds(flags, byKeyword) {
  const out = []
  for (const word of String(flags || '').split(' ')) {
    const id = word ? byKeyword.get(asciiLower(word)) : undefined
    if (id !== undefined && !out.includes(id)) out.push(id)
  }
  return out
}

const idList = (ids, max) => {
  if (!Array.isArray(ids) || ids.length > max || !ids.every(isRowId)) throw new LabelError('bad_request')
  return [...new Set(ids)]
}

export class Labels {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db
    this.now = now
    const p = sql => db.prepare(sql)
    this.s = {
      list: p('SELECT id, name, color, sort_order, keyword FROM labels ORDER BY sort_order, name COLLATE NOCASE, id'),
      // the count (list()): messages, not rows (the same message in two folders of one account is one), and only the ones
      // with a row: the (account, label_key) pairs bound here, together with the pairs of the IMAP rows carrying the keyword
      localPairs: p(`SELECT ml.label_id, ml.account_id, ml.label_key FROM message_labels ml
        WHERE EXISTS (SELECT 1 FROM messages m WHERE m.account_id = ml.account_id AND m.label_key = ml.label_key)`),
      // the IMAP rows that have a flag of no system form (not \\x, not $x): only these can carry a label keyword. One pass
      // over the rows for every label at once (per label in SQL it was 3.7 s on 100 000 rows, measured)
      // (the column names unqualified: the WHERE must be the index's own text)
      keywordRows: p(`SELECT account_id, label_key, flags FROM accounts a
          CROSS JOIN messages ON account_id = a.id
        WHERE a.type = 'imap' AND ${KEYWORD_FLAGS_WHERE}`),
      get: p('SELECT id, name, color, sort_order, keyword FROM labels WHERE id = ?'),
      keywords: p('SELECT keyword FROM labels WHERE keyword IS NOT NULL'),
      names: p('SELECT id, name FROM labels'),
      ids: p('SELECT id FROM labels ORDER BY sort_order, id'),
      count: p('SELECT COUNT(*) AS n FROM labels'),
      nextOrder: p('SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM labels'),
      insert: p('INSERT INTO labels (name, color, sort_order, created_at, keyword) VALUES (?, ?, ?, ?, ?)'),
      rename: p('UPDATE labels SET name = ? WHERE id = ?'),
      setColor: p('UPDATE labels SET color = ? WHERE id = ?'),
      setOrder: p('UPDATE labels SET sort_order = ? WHERE id = ?'),
      remove: p('DELETE FROM labels WHERE id = ?'),
      // The id lists come as json_each(?) and are looked up by the primary key: CROSS JOIN fixes that order (SQLite
      // keeps the left table outside). With "id IN (SELECT value FROM json_each(?))" the planner, after an ANALYZE,
      // read the whole table with a Bloom filter instead (measured on a small table; it does not know json_each's size).
      // the (account, key) pairs of the given rows: the thing a label binds to
      keysOf: p(`SELECT DISTINCT m.account_id, m.label_key FROM json_each(?) j CROSS JOIN messages m ON m.id = j.value
        WHERE m.label_key IS NOT NULL`),
      foundIds: p('SELECT COUNT(DISTINCT m.id) AS n FROM json_each(?) j CROSS JOIN messages m ON m.id = j.value'),
      // the picker's state reads the chosen rows ONCE (each pass over a 100 000-id list costs ~200 ms on the encrypted
      // file, measured), each with its local bindings by the primary key: only what the chosen rows carry (reading the
      // whole binding table made one chosen row cost as much as every binding: 300 000 of them ~300 ms, measured). The
      // list comes without repeats; a row comes once per binding (once with label_id NULL without one), its lines in a run
      stateRows: p(`SELECT m.id, m.account_id, m.flags, ml.label_id FROM json_each(?) j CROSS JOIN messages m ON m.id = j.value
        LEFT JOIN message_labels ml ON ml.account_id = m.account_id AND ml.label_key = m.label_key`),
      imapAccounts: p("SELECT id FROM accounts WHERE type = 'imap'"),
      bind: p('INSERT OR IGNORE INTO message_labels (account_id, label_key, label_id, created_at) VALUES (?, ?, ?, ?)'),
      unbind: p('DELETE FROM message_labels WHERE account_id = ? AND label_key = ? AND label_id = ?'),
      // every folder that shows one of the pairs: the other copy of the same message too. No DISTINCT (the caller's Set
      // takes the repeats): with it SQLite picks idx_messages_folder_date and reads every row of the account (measured:
      // 4 ms per call on 20 000 rows, growing with the account), without it idx_messages_label_key
      foldersOf: p('SELECT folder FROM messages WHERE account_id = ? AND label_key = ?'),
      // per label, how many of the given rows carry it (the picker's all / some / none); rows, not messages: the picker
      // counts what is selected
      // the local bindings of the given rows
      localOfRows: p(`SELECT m.id, ml.label_id FROM json_each(?) j
          CROSS JOIN messages m ON m.id = j.value
          JOIN message_labels ml ON ml.account_id = m.account_id AND ml.label_key = m.label_key`),
      // the flags of the given rows that are on an IMAP account (only those can carry a server keyword)
      imapFlagsOfRows: p(`SELECT m.id, m.flags FROM json_each(?) j
          CROSS JOIN messages m ON m.id = j.value
          CROSS JOIN accounts a ON a.id = m.account_id AND a.type = 'imap'
        WHERE m.flags IS NOT NULL AND m.flags != ''`),
      // every label with its keyword, in the list's order
      ordered: p('SELECT id, keyword FROM labels ORDER BY sort_order, name COLLATE NOCASE, id'),
      // what a write needs of the given rows: the account's type, the folder's UIDVALIDITY (the UIDs belong to it)
      writeRows: p(`SELECT m.id, m.account_id, m.folder, m.uid, a.type, f.uidvalidity FROM json_each(?) j
          CROSS JOIN messages m ON m.id = j.value
          JOIN accounts a ON a.id = m.account_id
          LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder`),
      flagsOf: p('SELECT flags FROM messages WHERE id = ?'),
      // the IMAP rows whose flags hold a keyword (whole word, ASCII lower case): a label deleted from the server too.
      // The keyword-carrying rows through the partial index (the WHERE is its own text), then the word itself
      keywordHolders: p(`SELECT messages.id AS id, account_id, folder, uid FROM accounts a
          CROSS JOIN messages ON account_id = a.id
        WHERE a.type = 'imap' AND ${KEYWORD_FLAGS_WHERE} AND instr(' ' || lower(flags) || ' ', ' ' || ? || ' ') > 0`),
      uidvalidityOf: p('SELECT uidvalidity FROM folders WHERE account_id = ? AND path = ?'),
      // an IMAP account's local bindings of labels that have a keyword (the upload), and the rows of one key
      bindingsOf: p(`SELECT ml.label_key, ml.label_id, l.keyword FROM message_labels ml JOIN labels l ON l.id = ml.label_id
        WHERE ml.account_id = ? AND l.keyword IS NOT NULL ORDER BY ml.label_key, ml.label_id`),
      rowsOfKey: p('SELECT id, folder, uid FROM messages WHERE account_id = ? AND label_key = ?'),
      // the stored copies of one message in one folder (a draft saved again: its old copies' labels)
      flagsInFolder: p('SELECT flags FROM messages WHERE account_id = ? AND folder = ? AND label_key = ?'),
      setFlags: p('UPDATE messages SET flags = ? WHERE id = ?'),
    }
    const holder = name => this.s.names.all().find(l => nameKey(l.name) === nameKey(name)) || null
    this.createTx = db.transaction((name, color) => {
      if (this.s.count.get().n >= MAX_LABELS) throw new LabelError('too_many')
      if (holder(name)) throw new LabelError('name_taken')
      const keyword = labelKeyword(name, new Set(this.s.keywords.all().map(r => r.keyword)))
      const id = Number(this.s.insert.run(name, color, this.s.nextOrder.get().n, this.now(), keyword).lastInsertRowid)
      return this.s.get.get(id)
    })
    this.renameTx = db.transaction((id, name) => {
      if (!this.s.get.get(id)) throw new LabelError('not_found')
      const other = holder(name)
      if (other && other.id !== id) throw new LabelError('name_taken')
      this.s.rename.run(name, id)
      return this.s.get.get(id)
    })
    this.reorderTx = db.transaction(ids => {
      const have = this.s.ids.all().map(r => r.id)
      const set = new Set(ids)
      if (ids.length !== have.length || set.size !== ids.length || !have.every(id => set.has(id))) {
        throw new LabelError('order_mismatch')
      }
      ids.forEach((id, i) => this.s.setOrder.run(i, id))
      return ids.length
    })
    this.setLabelsTx = db.transaction((ids, add, remove) => {
      // every label must exist, checked inside the write's transaction: an unknown one changes nothing
      for (const id of [...add, ...remove]) if (!this.s.get.get(id)) throw new LabelError('bad_request', { label: id })
      const json = JSON.stringify(ids)
      if (this.s.foundIds.get(json).n !== ids.length) throw new LabelError('not_found')
      const pairs = this.s.keysOf.all(json)
      const at = this.now()
      let changed = 0
      for (const { account_id: acc, label_key: key } of pairs) {
        for (const label of remove) changed += this.s.unbind.run(acc, key, label).changes
        for (const label of add) changed += this.s.bind.run(acc, key, label, at).changes
      }
      const folders = new Map()
      if (changed) {
        for (const { account_id: acc, label_key: key } of pairs) {
          for (const { folder } of this.s.foldersOf.all(acc, key)) {
            if (!folders.has(acc)) folders.set(acc, new Set())
            folders.get(acc).add(folder)
          }
        }
      }
      return { changed, folders: [...folders].map(([accountId, set]) => ({ accountId, folders: [...set] })) }
    })
    this.keywordsTx = db.transaction((ids, add, remove) => {
      let changed = 0
      for (const id of ids) {
        const row = this.s.flagsOf.get(id)
        if (!row) continue
        const words = String(row.flags || '').split(' ').filter(Boolean)
        const kept = words.filter(w => !remove.has(asciiLower(w)))
        const had = new Set(kept.map(asciiLower))
        let n = words.length - kept.length
        for (const k of add) {
          if (!had.has(k)) {
            kept.push(k)
            had.add(k)
            n++
          }
        }
        if (n) {
          this.s.setFlags.run(kept.join(' '), id)
          changed += n
        }
      }
      return changed
    })
  }

  /** Every label in the user's order: { id, name, color, sort_order, keyword, count } (count = messages with a row). */
  list() {
    const labels = this.s.list.all()
    const pairs = new Map(labels.map(l => [l.id, new Set()]))
    const pair = (account, key) => `${account}\u0000${key}`
    for (const { label_id: label, account_id: acc, label_key: key } of this.s.localPairs.all()) pairs.get(label)?.add(pair(acc, key))
    const byKeyword = new Map(labels.filter(l => l.keyword).map(l => [l.keyword, l.id]))
    if (byKeyword.size) {
      for (const { account_id: acc, label_key: key, flags } of this.s.keywordRows.all()) {
        for (const label of keywordLabelIds(flags, byKeyword)) pairs.get(label).add(pair(acc, key))
      }
    }
    return labels.map(l => ({ ...l, count: pairs.get(l.id).size }))
  }

  get(id) {
    return isRowId(id) ? this.s.get.get(id) || null : null
  }

  /** The label of this name by the list's own rule (trimmed, NFC, any case), or null (an unusable name too). */
  byName(name) {
    let s
    try {
      s = cleanLabelName(name)
    } catch {
      return null
    }
    const hit = this.s.names.all().find(l => nameKey(l.name) === nameKey(s))
    return hit ? this.get(hit.id) : null
  }

  /** A new label at the end of the list. Errors: bad_name, bad_color, name_taken (case-insensitive), too_many (1000). */
  create(name, color) {
    return this.createTx(cleanLabelName(name), cleanLabelColor(color))
  }

  rename(id, name) {
    if (!isRowId(id)) throw new LabelError('bad_request')
    return this.renameTx(id, cleanLabelName(name))
  }

  setColor(id, color) {
    if (!isRowId(id)) throw new LabelError('bad_request')
    const c = cleanLabelColor(color)
    if (!this.s.setColor.run(c, id).changes) throw new LabelError('not_found')
    return this.s.get.get(id)
  }

  /** The whole list in a new order: exactly the existing ids, once each. Errors: bad_request, order_mismatch. */
  reorder(ids) {
    if (!Array.isArray(ids) || !ids.every(isRowId)) throw new LabelError('bad_request')
    return this.reorderTx(ids)
  }

  /** Deletes a label; its bindings go with it (ON DELETE CASCADE). Returns the number of messages it was on. */
  remove(id) {
    if (!isRowId(id)) throw new LabelError('bad_request')
    const label = this.list().find(l => l.id === id)
    if (!label) throw new LabelError('not_found')
    this.s.remove.run(id)
    return label.count
  }

  /**
   * Map(row id -> [label id] in the list's order); rows without a label are left out. A row's labels: its local
   * bindings, and on an IMAP account the labels whose keyword is among its flags (each label once).
   */
  labelsOfRows(ids) {
    const out = new Map()
    if (!Array.isArray(ids) || !ids.length) return out
    // once each: json_each gives every repeat of an id as a row of its own (the CROSS JOIN would repeat the labels)
    const json = JSON.stringify([...new Set(ids.filter(isRowId))])
    const ordered = this.s.ordered.all()
    const rank = new Map(ordered.map((l, i) => [l.id, i]))
    const byKeyword = new Map(ordered.filter(l => l.keyword).map(l => [l.keyword, l.id]))
    const sets = new Map()
    const add = (id, label) => {
      if (!sets.has(id)) sets.set(id, new Set())
      sets.get(id).add(label)
    }
    for (const { id, label_id: label } of this.s.localOfRows.all(json)) add(id, label)
    if (byKeyword.size) for (const { id, flags } of this.s.imapFlagsOfRows.all(json)) for (const label of keywordLabelIds(flags, byKeyword)) add(id, label)
    for (const [id, set] of [...sets].sort((a, b) => a[0] - b[0])) out.set(id, [...set].sort((a, b) => rank.get(a) - rank.get(b)))
    return out
  }

  /**
   * The picker's state over the chosen rows (<= 100 000 ids, repeats counted once): { total: the rows that exist,
   * counts: Map(label id -> rows carrying it) }. Errors: bad_request.
   */
  stateOf(ids) {
    const rows = idList(ids, MAX_STATE_IDS)
    // the rule of labelsOfRows (local bindings + an IMAP row's keywords, each label once per row), in one pass
    const ordered = this.s.ordered.all()
    const rank = new Map(ordered.map((l, i) => [l.id, i]))
    const byKeyword = new Map(ordered.filter(l => l.keyword).map(l => [l.keyword, l.id]))
    const imap = new Set(this.s.imapAccounts.pluck().all())
    const counts = new Map()
    // the lowest row carrying each label: the counts come in labelsOfRows' order (rows by id, a row's labels by rank)
    const firstRow = new Map()
    const row = new Set()
    let total = 0
    let cur = null
    const flush = () => {
      for (const label of row) {
        counts.set(label, (counts.get(label) || 0) + 1)
        if (!(firstRow.get(label) <= cur)) firstRow.set(label, cur)
      }
      row.clear()
    }
    for (const { id, account_id: acc, flags, label_id: label } of this.s.stateRows.all(JSON.stringify(rows))) {
      if (id !== cur) {
        flush()
        cur = id
        total++
        if (byKeyword.size && flags && imap.has(acc)) for (const k of keywordLabelIds(flags, byKeyword)) row.add(k)
      }
      if (label !== null) row.add(label)
    }
    flush()
    const order = [...counts.keys()].sort((a, b) => firstRow.get(a) - firstRow.get(b) || rank.get(a) - rank.get(b))
    return { total, counts: new Map(order.map(label => [label, counts.get(label)])) }
  }

  /** The rows with a `labels: [label id]` field each (one query for the whole page); the rows' own objects stay as they are. */
  attach(rows) {
    const of = this.labelsOfRows(rows.map(r => r.id))
    return rows.map(r => ({ ...r, labels: of.get(r.id) || [] }))
  }

  /**
   * Puts labels on and takes labels off the messages of the given rows (any account, any folder, <= 500 ids): on the
   * (account, label_key) pair of each row, so every copy of the message in that account gets it. A label in both lists
   * ends up on. Errors (nothing changes): bad_request (bad ids or an unknown label), not_found (a row that is not there).
   * Returns { changed, folders: [{ accountId, folders }] }: the folders showing a changed message (for onChange).
   */
  setLabels(ids, { add = [], remove = [] } = {}) {
    const rows = idList(ids, MAX_LABEL_IDS)
    if (!rows.length) throw new LabelError('bad_request')
    const on = idList(add, Infinity)
    const off = idList(remove, Infinity).filter(id => !on.includes(id))
    return this.setLabelsTx(rows, on, off)
  }

  /**
   * The plan of a label write (the checks of setLabels, nothing written): { add, remove: [{ id, keyword }] (a label in
   * both lists ends up on), local: [row id] (POP3 and local folders: the bindings), groups: [{ accountId, folder,
   * uidvalidity, rows: [{ id, uid }] }] (an IMAP account's rows by folder: the server). An IMAP row without a UID goes
   * the local way. Errors: bad_request, not_found.
   */
  writePlan(ids, { add = [], remove = [] } = {}) {
    const rows = idList(ids, MAX_LABEL_IDS)
    if (!rows.length) throw new LabelError('bad_request')
    const on = idList(add, Infinity)
    const off = idList(remove, Infinity).filter(id => !on.includes(id))
    const labelOf = id => {
      const l = this.s.get.get(id)
      if (!l) throw new LabelError('bad_request', { label: id })
      return { id, keyword: l.keyword || null }
    }
    const plan = { add: on.map(labelOf), remove: off.map(labelOf), local: [], groups: [] }
    const found = this.s.writeRows.all(JSON.stringify(rows))
    if (found.length !== rows.length) throw new LabelError('not_found')
    const groups = new Map()
    for (const r of found) {
      if (r.type !== 'imap' || !Number.isInteger(r.uid)) {
        plan.local.push(r.id)
        continue
      }
      const key = `${r.account_id}\u0000${r.folder}`
      if (!groups.has(key)) groups.set(key, { accountId: r.account_id, folder: r.folder, uidvalidity: r.uidvalidity ?? null, rows: [] })
      groups.get(key).rows.push({ id: r.id, uid: r.uid })
    }
    plan.groups = [...groups.values()]
    return plan
  }

  /**
   * The IMAP rows that carry the label's keyword, by account + folder: [{ accountId, folder, uidvalidity, rows: [{ id,
   * uid }] }] (a deletion takes it off the server first). A label without a keyword has none.
   */
  keywordGroups(id) {
    const label = this.get(id)
    if (!label || !label.keyword) return []
    const groups = new Map()
    for (const r of this.s.keywordHolders.all(label.keyword)) {
      if (!Number.isInteger(r.uid)) continue
      const key = `${r.account_id}\u0000${r.folder}`
      if (!groups.has(key)) groups.set(key, { accountId: r.account_id, folder: r.folder, uidvalidity: (this.s.uidvalidityOf.get(r.account_id, r.folder) || {}).uidvalidity ?? null, rows: [] })
      groups.get(key).rows.push({ id: r.id, uid: r.uid })
    }
    return [...groups.values()]
  }

  /**
   * An IMAP account's local bindings to upload: [{ key, labelId, keyword, rows: [{ id, folder, uid }] }], only the ones
   * with a row (a binding whose message is gone is left alone).
   */
  uploadPlan(accountId) {
    const out = []
    for (const b of this.s.bindingsOf.all(accountId)) {
      const rows = this.s.rowsOfKey.all(accountId, b.label_key)
      if (rows.length) out.push({ key: b.label_key, labelId: b.label_id, keyword: b.keyword, rows })
    }
    return out
  }

  uidvalidity(accountId, folder) {
    return (this.s.uidvalidityOf.get(accountId, folder) || {}).uidvalidity ?? null
  }

  /**
   * The keywords of the defined labels that the stored copies of a message in a folder carry (the account, folder and
   * label_key): a draft saved again (a new APPEND) takes them over. Our own lower-case keywords, each once.
   */
  keywordsOfCopies(accountId, folder, labelKey) {
    const byKeyword = new Map(this.s.ordered.all().filter(l => l.keyword).map(l => [l.keyword, l.id]))
    if (!byKeyword.size || !labelKey) return []
    const ids = new Set()
    for (const { flags } of this.s.flagsInFolder.all(accountId, folder, labelKey)) for (const id of keywordLabelIds(flags, byKeyword)) ids.add(id)
    return [...byKeyword].filter(([, id]) => ids.has(id)).map(([keyword, id]) => ({ id, keyword }))
  }

  /** A local binding by key (a message whose row is not there yet: a draft saved without its keywords). */
  bindKey(accountId, labelKey, labelId) {
    return this.s.bind.run(accountId, labelKey, labelId, this.now()).changes
  }

  /** Drops one local binding (an uploaded one). */
  unbindKey(accountId, key, labelId) {
    return this.s.unbind.run(accountId, key, labelId).changes
  }

  /** Every spelling of these keywords (ASCII lower case) among the rows' flags, the keywords themselves too. */
  keywordSpellings(ids, keywords) {
    const want = new Set(keywords)
    const out = new Set(keywords)
    for (const id of ids) {
      const row = this.s.flagsOf.get(id)
      for (const w of String((row && row.flags) || '').split(' ')) if (w && want.has(asciiLower(w))) out.add(w)
    }
    return [...out]
  }

  /**
   * After the server said yes: the rows' stored flags get the keywords (unless some spelling is there) and lose every
   * spelling of the removed ones, in one transaction, read fresh (a sync may have written meanwhile). Returns the number
   * of (row, keyword) changes.
   */
  setRowKeywords(ids, { add = [], remove = [] } = {}) {
    if (!ids.length || !(add.length + remove.length)) return 0
    return this.keywordsTx(ids, add.map(asciiLower), new Set(remove.map(asciiLower)))
  }
}
