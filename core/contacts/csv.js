// SPDX-License-Identifier: GPL-3.0-or-later
// CSV reader and writer for the address book (since 0.12.0).
// Pure: no I/O, no network, no IPC.
//
// readCsv(input) -> { format, delimiter, charset, cards, errors }
//   input: the file's bytes (Buffer/Uint8Array) or a string. Over IMPORT_LIMITS.maxBytes: ContactsFileError('too_large');
//   over maxCards data rows: ContactsFileError('too_many').
//   RFC 4180 (a quoted field may hold the delimiter, a line break and "" for a quote); a UTF-8 BOM (or UTF-16 LE BOM) is
//   recognized; without a BOM the text is UTF-8 if valid, otherwise Windows-1250. The delimiter (',' or ';') is the
//   more frequent of the two in the header line, outside quotes.
//   format: 'google' (Google CSV, the old "Given Name"/"Family Name" header), 'google-new' ("First Name"/"Last Name" with
//   "E-mail 1 - Value"), 'outlook' (Outlook, English header), 'outlook-hu' (Outlook, Hungarian header) or null (unknown:
//   every data row is an error with code unknown_header).
//   cards: { line, displayName, givenName, familyName, org, title, note, emails, phones, vcardExtra: null }, `line` the
//   row's first physical line (1-based, the header is line 1).
//   errors: { line, code }: line_too_long (a row over maxLine bytes, counted as UTF-8), unterminated_quote, unknown_header.
// writeCsv(people) -> string: the Google CSV header, UTF-8 BOM, CRLF. A cell starting with = + - @ tab or CR gets a
//   leading ' (formula injection); the reader takes that ' off again. Exception: a phone
//   value cell that is wholly '+', then digits, spaces, '-', '(' or ')' (PHONE_SAFE) stays as it is: without a letter,
//   '=', '|' or '!' it cannot call a function, and an import would take "'+36..." for a broken number.

import { IMPORT_LIMITS, ContactsFileError, byteLength, decodeAuto, cleanLabel } from './limits.js'

const norm = h => h.replace(/^﻿/, '').trim().replace(/\s+/g, ' ').toLowerCase()

// Outlook phone columns -> label. Hungarian names: ASSUMPTION (no public source found for the Hungarian Outlook
// export header, 2026-11-13); the e-mail, name, company, title and notes names follow the Outlook export columns.
const OUTLOOK_PHONES = {
  'mobile phone': 'cell',
  'business phone': 'work',
  'business phone 2': 'work',
  'company main phone': 'work',
  'home phone': 'home',
  'home phone 2': 'home',
  'primary phone': null,
  'other phone': 'other',
}
const OUTLOOK_HU_PHONES = {
  mobiltelefon: 'cell',
  'munkahelyi telefon': 'work',
  'munkahelyi telefon 2': 'work',
  'otthoni telefon': 'home',
  'otthoni telefon 2': 'home',
  'elsődleges telefon': null,
  'egyéb telefon': 'other',
}
const FIELDS = {
  google: { name: 'displayName', 'given name': 'givenName', 'family name': 'familyName', 'organization 1 - name': 'org', 'organization 1 - title': 'title', notes: 'note' },
  'google-new': { 'first name': 'givenName', 'last name': 'familyName', 'organization name': 'org', 'organization title': 'title', notes: 'note' },
  outlook: { 'first name': 'givenName', 'last name': 'familyName', company: 'org', 'job title': 'title', notes: 'note' },
  'outlook-hu': { utónév: 'givenName', vezetéknév: 'familyName', cég: 'org', beosztás: 'title', megjegyzések: 'note' },
}
const OUTLOOK_EMAILS = ['e-mail address', 'e-mail 2 address', 'e-mail 3 address']
const OUTLOOK_HU_EMAILS = ['elektronikus levélcím', 'elektronikus levélcím 2', 'elektronikus levélcím 3']

function detectFormat(headers) {
  const h = new Set(headers)
  // Google: any numbered e-mail/phone column or a Google-only name/organization column (a file without e-mail columns
  // is Google too); the new layout has "First Name" / "Organization Name"
  const google =
    headers.some(x => /^(e-mail|phone) \d+ - (value|type|label)$/.test(x)) ||
    ['given name', 'family name', 'organization 1 - name', 'organization name', 'labels'].some(x => h.has(x))
  if (google) return h.has('first name') || h.has('organization name') ? 'google-new' : 'google'
  if (h.has('elektronikus levélcím') || h.has('utónév') || h.has('vezetéknév')) return 'outlook-hu'
  if (h.has('e-mail address') || (h.has('first name') && h.has('last name'))) return 'outlook'
  return null
}

/** Column plan of a header: { fields: [[index, field]], emails: [{ value, label, fixed }], phones: [...] }. */
function columnPlan(format, headers) {
  const fields = []
  const emails = []
  const phones = []
  const idx = new Map(headers.map((h, i) => [h, i]))
  for (const [h, f] of Object.entries(FIELDS[format])) if (idx.has(h)) fields.push([idx.get(h), f])
  if (format === 'google' || format === 'google-new') {
    for (const [list, word] of [[emails, 'e-mail'], [phones, 'phone']]) {
      for (let n = 1; ; n++) {
        const v = idx.get(`${word} ${n} - value`)
        if (v === undefined) {
          if (n > 50) break
          continue
        }
        list.push({ value: v, label: idx.get(`${word} ${n} - type`) ?? idx.get(`${word} ${n} - label`) })
      }
    }
  } else {
    for (const h of format === 'outlook' ? OUTLOOK_EMAILS : OUTLOOK_HU_EMAILS) if (idx.has(h)) emails.push({ value: idx.get(h) })
    for (const [h, label] of Object.entries(format === 'outlook' ? OUTLOOK_PHONES : OUTLOOK_HU_PHONES)) {
      if (idx.has(h)) phones.push({ value: idx.get(h), fixed: label })
    }
    // in the file's column order
    emails.sort((a, b) => a.value - b.value)
    phones.sort((a, b) => a.value - b.value)
  }
  return { fields, emails, phones }
}

/** The reverse of the writer's formula guard: a leading ' before = + - @ tab CR comes off. */
const unguard = s => (s.length > 1 && s[0] === "'" && /[=+\-@\t\r]/.test(s[1]) ? s.slice(1) : s)
const clean = s => {
  const t = unguard(s ?? '').replace(/\r\n?/g, '\n').trim()
  return t || null
}

/** Google "* Work" (the '*' marks the primary) / "Mobile" -> { label, primary }. */
function googleType(s) {
  let t = (s ?? '').trim()
  const primary = t.startsWith('*')
  t = t.replace(/^\*\s*/, '')
  const label = cleanLabel(t)
  return { label: label === 'mobile' ? 'cell' : label, primary }
}

function rowToCard(format, plan, fields, line) {
  const card = { line, displayName: null, givenName: null, familyName: null, org: null, title: null, note: null, emails: [], phones: [], vcardExtra: null }
  for (const [i, f] of plan.fields) card[f] = clean(fields[i])
  let primaryTaken = false
  for (const e of plan.emails) {
    const v = clean(fields[e.value])
    if (!v) continue
    const { label, primary } = e.label !== undefined ? googleType(fields[e.label]) : { label: null, primary: false }
    // Google may put several values in one cell: "a@x ::: b@y"
    for (const address of v.split(/\s*:::\s*/).map(x => x.trim()).filter(Boolean)) {
      card.emails.push({ address, label, isPrimary: primary && !primaryTaken })
      if (primary) primaryTaken = true
    }
  }
  for (const p of plan.phones) {
    const v = clean(fields[p.value])
    if (!v) continue
    const label = p.fixed !== undefined ? p.fixed : p.label !== undefined ? googleType(fields[p.label]).label : null
    for (const number of v.split(/\s*:::\s*/).map(x => x.trim()).filter(Boolean)) card.phones.push({ number, label })
  }
  // the first address is the primary when the row marks none (Outlook's "E-mail Address", the writer's order)
  if (card.emails.length && !primaryTaken) card.emails[0].isPrimary = true
  if (format === 'outlook-hu' && !card.displayName) {
    // Hungarian name order: family name first
    card.displayName = [card.familyName, card.givenName].filter(Boolean).join(' ') || null
  }
  return card
}

/** The delimiter of the header line: ',' or ';', the more frequent outside quotes (a tie: ','). */
function detectDelimiter(text) {
  let comma = 0
  let semi = 0
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') q = !q
    else if (!q && (c === '\n' || c === '\r')) break
    else if (!q && c === ',') comma++
    else if (!q && c === ';') semi++
  }
  return semi > comma ? ';' : ','
}

/**
 * RFC 4180 rows: [{ fields, line, error }]. A row over maxLine characters is not kept (error line_too_long); a quote
 * not closed until the end of the file: unterminated_quote. Rows with one empty field are skipped.
 */
function parseRows(text, delim, maxLine) {
  const rows = []
  const n = text.length
  let i = 0
  let line = 1
  while (i < n) {
    const start = i
    const startLine = line
    const fields = []
    let error = null
    for (;;) {
      let field = ''
      if (text[i] === '"') {
        i++
        for (;;) {
          const q = text.indexOf('"', i)
          if (q < 0) {
            error = 'unterminated_quote'
            const chunk = text.slice(i)
            for (let k = 0; k < chunk.length; k++) if (chunk[k] === '\n') line++
            field += chunk
            i = n
            break
          }
          const chunk = text.slice(i, q)
          for (let k = 0; k < chunk.length; k++) if (chunk[k] === '\n') line++
          field += chunk
          if (text[q + 1] === '"') {
            field += '"'
            i = q + 2
            continue
          }
          i = q + 1
          break
        }
        // tolerated: characters after the closing quote, up to the delimiter
        while (i < n && text[i] !== delim && text[i] !== '\r' && text[i] !== '\n') field += text[i++]
      } else {
        while (i < n && text[i] !== delim && text[i] !== '\r' && text[i] !== '\n') field += text[i++]
      }
      fields.push(field)
      if (error) break
      if (i - start > maxLine) {
        // skip to the end of the row without building it
        error = 'line_too_long'
      }
      if (text[i] === delim) {
        i++
        if (error) {
          // the rest of an over-long row: fast forward over quoted parts too
          let q = false
          while (i < n) {
            const c = text[i]
            if (c === '"') q = !q
            else if (!q && (c === '\n' || c === '\r')) break
            else if (c === '\n') line++
            i++
          }
        } else continue
      }
      break
    }
    if (text[i] === '\r') i++
    if (text[i] === '\n') i++
    if (i <= n) line++
    // the limit is in bytes (UTF-8); a row over maxLine characters is over it anyway (checked above)
    if (!error && i - start > maxLine / 4 && Buffer.byteLength(text.slice(start, i), 'utf8') > maxLine) error = 'line_too_long'
    if (error) rows.push({ fields: null, line: startLine, error })
    else if (!(fields.length === 1 && fields[0] === '')) rows.push({ fields, line: startLine, error: null })
  }
  return rows
}

function decodeInput(input) {
  if (typeof input === 'string') return { text: input.replace(/^﻿/, ''), charset: 'utf-8' }
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(b.subarray(3)), charset: 'utf-8' }
  if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), charset: 'utf-16le' }
  return decodeAuto(b)
}

export function readCsv(input, limits = IMPORT_LIMITS) {
  if (byteLength(input) > limits.maxBytes) throw new ContactsFileError('too_large')
  const { text, charset } = decodeInput(input)
  const delimiter = detectDelimiter(text)
  const rows = parseRows(text, delimiter, limits.maxLine)
  const cards = []
  const errors = []
  if (!rows.length) return { format: null, delimiter, charset, cards, errors }
  const [header, ...data] = rows
  if (data.length > limits.maxCards) throw new ContactsFileError('too_many')
  const headers = header.fields ? header.fields.map(norm) : []
  const format = header.fields ? detectFormat(headers) : null
  if (header.error) errors.push({ line: header.line, code: header.error })
  const plan = format ? columnPlan(format, headers) : null
  for (const r of data) {
    if (r.error) errors.push({ line: r.line, code: r.error })
    else if (!format) errors.push({ line: r.line, code: 'unknown_header' })
    else cards.push(rowToCard(format, plan, r.fields, r.line))
  }
  return { format, delimiter, charset, cards, errors }
}

// --- writer ---------------------------------------------------------------------------------------------------------

// a phone number that may start with '+' unguarded: at least one digit, nothing that can make a formula call
const PHONE_SAFE = /^\+[0-9 ()-]{1,31}$/

/**
 * A cell: the formula guard first (a `phone` cell matching PHONE_SAFE is the one exception), then quoted when it
 * holds a quote, a delimiter, a line break or an edge space.
 */
export function csvCell(v, { phone = false } = {}) {
  let s = v === null || v === undefined ? '' : String(v)
  const safePhone = phone && PHONE_SAFE.test(s) && /[0-9]/.test(s)
  if (!safePhone && /^[=+\-@\t\r]/.test(s)) s = "'" + s
  if (/[",;\r\n]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function writeCsv(people) {
  const list = [...people]
  const nEmails = Math.max(1, ...list.map(p => (p.emails || []).length))
  const nPhones = Math.max(1, ...list.map(p => (p.phones || []).length))
  const head = ['Name', 'Given Name', 'Family Name', 'Notes', 'Organization 1 - Name', 'Organization 1 - Title']
  for (let i = 1; i <= nEmails; i++) head.push(`E-mail ${i} - Type`, `E-mail ${i} - Value`)
  for (let i = 1; i <= nPhones; i++) head.push(`Phone ${i} - Type`, `Phone ${i} - Value`)
  const rows = [head.map(h => csvCell(h)).join(',')]
  for (const p of list) {
    // the primary address first (Google and the reader take the first as the primary)
    const emails = [...(p.emails || [])].sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0))
    const cells = [p.displayName, p.givenName, p.familyName, p.note, p.org, p.title]
    for (let i = 0; i < nEmails; i++) cells.push(emails[i]?.label ?? '', emails[i]?.address ?? '')
    const phoneCells = new Set()
    for (let i = 0; i < nPhones; i++) {
      cells.push(p.phones?.[i]?.label ?? '', p.phones?.[i]?.number ?? '')
      phoneCells.add(cells.length - 1)
    }
    rows.push(cells.map((c, i) => csvCell(c, { phone: phoneCells.has(i) })).join(','))
  }
  return '﻿' + rows.join('\r\n') + '\r\n'
}
