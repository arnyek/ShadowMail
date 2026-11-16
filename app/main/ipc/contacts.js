// SPDX-License-Identifier: GPL-3.0-or-later
// IPC of the address book: contacts:list|get|save|delete|addFromMessage|count.
// Every argument is checked here; the errors go back as codes (bad_request, address_taken + personId, not_found,
// no_sender). The log gets counts and codes only, never a name or an address.
// Import and export: contacts:importPreview|importApply|export. The preview also lists warnings: what an imported contact
// leaves out (address_limit, invalid_address); a warned contact is still imported. The file is chosen in the main process's own dialog and
// read here (the page never sees a path); the read contacts wait in memory under a preview token (5 minutes, one use);
// the apply plans again against the database as it is then and writes in one transaction (People.applyImport). The
// export goes only to the file the user chose, written atomically (a temporary file next to it, then a rename).
import { noRecent } from '../dialog-options.js'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { PeopleError, LIMITS } from '../../../core/db/people.js'
import { errCode } from '../../../core/log-safe.js'
import { readVcards, writeVcards } from '../../../core/contacts/vcard.js'
import { readCsv, writeCsv } from '../../../core/contacts/csv.js'
import { IMPORT_LIMITS, ContactsFileError } from '../../../core/contacts/limits.js'
import { t } from '../../renderer/i18n/index.js'

export const CONTACTS_CHANNELS = Object.freeze([
  'contacts:list', 'contacts:get', 'contacts:save', 'contacts:delete', 'contacts:addFromMessage', 'contacts:count',
  'contacts:importPreview', 'contacts:importApply', 'contacts:export', 'contacts:lookup',
])
export const PREVIEW_TTL_MS = 5 * 60 * 1000
const MAX_PREVIEWS = 3 // each holds up to a 10 MB file's contacts
const MAX_INVALID = 50
const MAX_SAMPLE = 20
const EXTENSIONS = { vcf: 'vcf', vcard: 'vcf', csv: 'csv' }

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const isId = v => Number.isInteger(v) && v > 0
const MAX_DELETE = 10_000

class BadRequest extends Error {}
class IoError extends Error {
  constructor(code, cause) {
    super(code)
    this.code = code
    this.cause = cause
  }
}

/** The whole file, through one descriptor: a regular file, at most `max` bytes (else too_large, nothing read). */
function readFileLimited(file, max) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch (err) {
    throw new IoError('read_failed', err)
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) throw new IoError('unsupported_file')
    if (st.size > max) throw new ContactsFileError('too_large')
    const buf = Buffer.alloc(st.size)
    let got = 0
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got)
      if (n === 0) break
      got += n
    }
    return buf.subarray(0, got)
  } catch (err) {
    if (err instanceof IoError || err instanceof ContactsFileError) throw err
    throw new IoError('read_failed', err)
  } finally {
    fs.closeSync(fd)
  }
}

/** Atomic write: a temporary file in the same folder, fsync, rename; on failure the temporary file goes. */
export function writeFileAtomic(file, bytes) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  try {
    const fd = fs.openSync(tmp, 'wx')
    try {
      fs.writeSync(fd, bytes)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw new IoError('write_failed', err)
  }
}

const pad = n => String(n).padStart(2, '0')
/** <base>-<YYYY-MM-DD>.<ext>, the local date; base: the interface language's (t.contactsExportBase), no default. */
export function exportFileName(ms, format, base) {
  if (typeof base !== 'string' || !base) throw new TypeError('exportFileName: base is required')
  const d = new Date(ms)
  return `${base}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.${format}`
}

/**
 * @param people     People (core/db/people.js)
 * @param index      MailIndex (the sender of a message for addFromMessage)
 * @param dialog     Electron dialog (showOpenDialog, showSaveDialog), injected for the tests; without it the import and
 *                   the export answer not_available
 * @param getWindow  () => BrowserWindow | null, the dialogs' parent
 */
export function registerContactsIpc({ ipcMain, people, index, isTrustedSender, dialog = null, getWindow = () => null, now = () => Date.now(), log = () => {} }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        return { ok: true, ...(await fn(...args)) }
      } catch (err) {
        if (err instanceof BadRequest) return { ok: false, error: 'bad_request' }
        if (err instanceof PeopleError) return { ok: false, error: err.code, ...(err.personId ? { personId: err.personId } : {}) }
        if (err instanceof ContactsFileError) return { ok: false, error: err.code }
        if (err instanceof IoError) {
          log(`${channel} failed: ${err.code}${err.cause ? ` (${errCode(err.cause)})` : ''}`)
          return { ok: false, error: err.code }
        }
        log(`${channel} failed: ${errCode(err)}`)
        return { ok: false, error: 'internal' }
      }
    })
  const showDialog = async (kind, opts) => {
    if (!dialog) throw new IoError('not_available')
    const win = getWindow()
    return win ? dialog[kind](win, noRecent(opts)) : dialog[kind](noRecent(opts))
  }
  // token -> { cards, parseErrors, at }
  const previews = new Map()
  const prune = () => {
    for (const [k, v] of previews) if (now() - v.at > PREVIEW_TTL_MS) previews.delete(k)
  }

  handle('contacts:list', async (q = {}) => {
    if (!isPlainObject(q)) throw new BadRequest()
    const { q: text = '', offset = 0, limit = 100 } = q
    if (typeof text !== 'string' || text.length > LIMITS.name) throw new BadRequest()
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.list) throw new BadRequest()
    return people.list({ q: text, offset, limit })
  })
  handle('contacts:get', async id => {
    if (!isId(id)) throw new BadRequest()
    return { person: people.get(id) }
  })
  handle('contacts:save', async person => {
    if (!isPlainObject(person)) throw new BadRequest()
    const id = people.save(person)
    log(`contacts: saved 1 (${person.id ? 'changed' : 'new'})`)
    return { id }
  })
  handle('contacts:delete', async ids => {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_DELETE || !ids.every(isId)) throw new BadRequest()
    const removed = people.delete([...new Set(ids)])
    log(`contacts: deleted ${removed}`)
    return { removed }
  })
  handle('contacts:addFromMessage', async messageId => {
    if (!isId(messageId)) throw new BadRequest()
    const row = index.get(messageId)
    if (!row) throw new PeopleError('not_found')
    const res = people.addSender({ address: row.from_addr, name: row.from_name })
    log(`contacts: sender added (${res.created ? 'new' : 'already there'})`)
    return res
  })
  handle('contacts:count', async () => ({ count: people.count() }))
  // is this address someone's? (the reader's "Címlistához ad")
  handle('contacts:lookup', async address => {
    if (typeof address !== 'string' || address.length > LIMITS.address) throw new BadRequest()
    return { personId: people.personOf(address) }
  })

  handle('contacts:importPreview', async () => {
    const res = await showDialog('showOpenDialog', { properties: ['openFile'], filters: [{ name: t.fileFilterContacts, extensions: ['vcf', 'vcard', 'csv'] }] })
    if (res.canceled || !res.filePaths?.length) return { canceled: true }
    const file = res.filePaths[0]
    const format = EXTENSIONS[path.extname(file).slice(1).toLowerCase()]
    if (!format) throw new IoError('unsupported_file')
    const bytes = readFileLimited(file, IMPORT_LIMITS.maxBytes)
    const parsed = format === 'vcf' ? readVcards(bytes) : readCsv(bytes)
    const plan = people.planImport(parsed.cards)
    const invalid = [
      ...parsed.errors.map(e => ({ row: e.line, reason: e.code })),
      ...plan.results.filter(r => r.kind === 'invalid').map(r => ({ row: r.line, reason: r.reason })),
    ].sort((a, b) => a.row - b.row)
    const counts = { ...plan.counts, invalid: invalid.length }
    // what is left out of an imported contact; it is still imported, not invalid
    const warnings = plan.warnings.map(w => ({ row: w.line, reason: w.reason, dropped: w.dropped }))
    const sample = plan.results
      .filter(r => r.kind === 'new' || r.kind === 'merged')
      .slice(0, MAX_SAMPLE)
      .map(r => {
        const p = r.target.person
        const primary = p.emails.find(e => e.isPrimary) || p.emails[0]
        return { kind: r.kind, name: p.displayName || [p.givenName, p.familyName].filter(Boolean).join(' ') || null, address: primary ? primary.address : null }
      })
    prune()
    while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value)
    const token = crypto.randomBytes(16).toString('hex')
    previews.set(token, { cards: parsed.cards, parseErrors: parsed.errors.length, at: now() })
    log(`contacts: import preview (${format}, ${bytes.length} bytes): new ${counts.new}, merged ${counts.merged}, unchanged ${counts.unchanged}, invalid ${counts.invalid}, warnings ${counts.warnings}`)
    return { token, format, counts, invalid: invalid.slice(0, MAX_INVALID), warnings: warnings.slice(0, MAX_INVALID), sample }
  })

  handle('contacts:importApply', async token => {
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) throw new BadRequest()
    prune()
    const entry = previews.get(token)
    if (!entry) throw new PeopleError('preview_expired')
    previews.delete(token)
    const counts = people.applyImport(entry.cards)
    counts.invalid += entry.parseErrors
    log(`contacts: imported: new ${counts.new}, merged ${counts.merged}, unchanged ${counts.unchanged}, invalid ${counts.invalid}, warnings ${counts.warnings}`)
    return { counts }
  })

  handle('contacts:export', async (opts = {}) => {
    if (!isPlainObject(opts)) throw new BadRequest()
    const { ids, all = false, format } = opts
    if (format !== 'vcf' && format !== 'csv') throw new BadRequest()
    if (all === true) {
      if (ids !== undefined) throw new BadRequest()
    } else if (!(Array.isArray(ids) && ids.length && ids.length <= MAX_DELETE && ids.every(isId))) throw new BadRequest()
    const list = people.exportPeople(all === true ? null : [...new Set(ids)])
    if (!list.length) throw new PeopleError('nothing_to_export')
    const res = await showDialog('showSaveDialog', {
      defaultPath: exportFileName(now(), format, t.contactsExportBase),
      filters: [format === 'vcf' ? { name: 'vCard (.vcf)', extensions: ['vcf'] } : { name: 'CSV (.csv)', extensions: ['csv'] }],
    })
    if (res.canceled || !res.filePath) return { saved: false }
    const text = format === 'vcf' ? writeVcards(list) : writeCsv(list)
    writeFileAtomic(res.filePath, Buffer.from(text, 'utf8'))
    log(`contacts: exported ${list.length} (${format}, ${Buffer.byteLength(text, 'utf8')} bytes)`)
    return { saved: true, count: list.length }
  })
}
