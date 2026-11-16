// contacts:importPreview / importApply /
// export with a fake dialog on a real (memory) database: the merge by address, one transaction, the preview token, the
// atomic export, and a log without names and addresses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from './helpers/tmp.js'
import { memoryIndex } from './helpers/fixtures.js'
import { People } from '../core/db/people.js'
import { registerContactsIpc, PREVIEW_TTL_MS, exportFileName } from '../app/main/ipc/contacts.js'
import { hu } from '../app/renderer/i18n/hu.js'
import { en } from '../app/renderer/i18n/en.js'
import { readVcards } from '../core/contacts/vcard.js'
import { readCsv } from '../core/contacts/csv.js'

const TABLES = ['people', 'person_emails', 'person_phones', 'contact_suppressed']
const dumpAll = db => TABLES.map(t => JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).join('\n')

function setup(t, { files = {} } = {}) {
  const { db, index } = memoryIndex(t)
  let clock = Date.UTC(2026, 10, 13, 12, 0, 0)
  const people = new People(db, { now: () => clock })
  const dir = tempDir(t)
  const handlers = new Map()
  const logs = []
  const dialog = {
    open: null, // the next file the open dialog "chooses"
    saved: [],
    async showOpenDialog(...args) {
      this.openOpts = args[args.length - 1]
      return this.open ? { canceled: false, filePaths: [this.open] } : { canceled: true, filePaths: [] }
    },
    async showSaveDialog(...args) {
      const opts = args[args.length - 1]
      this.saved.push(opts.defaultPath)
      return this.cancelSave ? { canceled: true } : { canceled: false, filePath: path.join(dir, opts.defaultPath) }
    },
  }
  registerContactsIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, people, index, isTrustedSender: () => true, dialog, now: () => clock, log: m => logs.push(m) })
  const call = (channel, ...args) => handlers.get(channel)({}, ...args)
  const file = (name, content) => {
    const f = path.join(dir, name)
    fs.writeFileSync(f, content)
    return f
  }
  for (const [n, c] of Object.entries(files)) file(n, c)
  const preview = async f => {
    dialog.open = f
    return call('contacts:importPreview')
  }
  const importFile = async f => {
    const p = await preview(f)
    assert.equal(p.ok, true, JSON.stringify(p))
    return { preview: p, apply: await call('contacts:importApply', p.token) }
  }
  return { db, people, dir, dialog, call, file, preview, importFile, logs, tick: ms => (clock += ms) }
}

const vcard = (...cards) => cards.map(c => `BEGIN:VCARD\r\nVERSION:3.0\r\n${c}\r\nEND:VCARD\r\n`).join('')

test('the same file imported twice: the second preview is new: 0, and its apply changes nothing', async t => {
  const s = setup(t)
  const f = s.file('a.vcf', fs.readFileSync(new URL('./fixtures/contacts/gmail-3.0.vcf', import.meta.url)))
  const first = await s.importFile(f)
  assert.deepEqual(first.preview.counts, { new: 2, merged: 0, unchanged: 0, invalid: 0, warnings: 0 })
  assert.deepEqual(first.apply, { ok: true, counts: { new: 2, merged: 0, unchanged: 0, invalid: 0, warnings: 0 } })
  const before = dumpAll(s.db)
  s.tick(1000)
  const second = await s.importFile(f)
  assert.deepEqual(second.preview.counts, { new: 0, merged: 0, unchanged: 2, invalid: 0, warnings: 0 })
  assert.deepEqual(second.apply.counts, { new: 0, merged: 0, unchanged: 2, invalid: 0, warnings: 0 })
  assert.equal(dumpAll(s.db), before, 'the database is unchanged (updated_at too)')
  // what the first import wrote: source import, the vcard_extra lines
  const p = s.people.exportPeople()
  assert.deepEqual(p.map(x => [x.displayName, x.source]), [['Árvíztűrő Tükörfúrógép', 'import'], ['Kiss Éva', 'import']])
  assert.ok(p[0].vcardExtra.includes('ADR;TYPE=HOME:;;Fő utca 1.;Budapest;;1011;Magyarország') && p[0].vcardExtra.includes('BDAY:1980-05-17'))
})

test('merge: an existing person keeps its name and note; the phone, the empty fields and a new address are added', async t => {
  const s = setup(t)
  const id = s.people.save({ displayName: 'Kiss Anna', note: 'saját megjegyzés', emails: ['anna@example.invalid'] })
  s.people.delete([s.people.save({ displayName: 'Törölt', emails: ['uj@example.invalid'] })]) // uj@ is on the suppressed list now
  const f = s.file('m.vcf', vcard('FN:Kovács Anna\r\nN:Kovács;Anna;;;\r\nORG:Cég Kft.\r\nNOTE:import megjegyzés\r\nEMAIL:ANNA@example.invalid\r\nEMAIL:uj@example.invalid\r\nTEL;TYPE=cell:+36 30 111 2222\r\nBDAY:1990-01-01'))
  const r = await s.importFile(f)
  assert.deepEqual(r.preview.counts, { new: 0, merged: 1, unchanged: 0, invalid: 0, warnings: 0 })
  assert.deepEqual(r.preview.sample, [{ kind: 'merged', name: 'Kiss Anna', address: 'anna@example.invalid' }])
  const p = s.people.get(id)
  assert.equal(p.displayName, 'Kiss Anna')
  assert.equal(p.note, 'saját megjegyzés')
  assert.equal(p.org, 'Cég Kft.', 'an empty field is filled')
  assert.equal(p.givenName, 'Anna')
  assert.equal(p.familyName, 'Kovács')
  assert.equal(p.source, 'manual')
  assert.deepEqual(p.emails, [{ address: 'anna@example.invalid', label: null, isPrimary: true }, { address: 'uj@example.invalid', label: null, isPrimary: false }])
  assert.deepEqual(p.phones, [{ number: '+36 30 111 2222', label: 'cell' }])
  assert.equal(s.people.exportPeople([id])[0].vcardExtra, 'BDAY:1990-01-01', 'the N without a middle name, prefix or suffix is not kept on a merge')
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM contact_suppressed').get().n, 0, 'the imported address left the suppressed list')
  // the same phone written otherwise is not added again; a second import of the file changes nothing
  const again = await s.importFile(s.file('m2.vcf', vcard('FN:X\r\nEMAIL:anna@example.invalid\r\nTEL:+36-30-111-2222')))
  assert.deepEqual(again.preview.counts, { new: 0, merged: 0, unchanged: 1, invalid: 0, warnings: 0 })
})

test('an error in the middle of the apply (injected): nothing is written', async t => {
  const s = setup(t)
  s.people.save({ displayName: 'Meglévő', emails: ['m@example.invalid'] })
  const f = s.file('x.vcf', vcard('FN:Egy\r\nEMAIL:egy@example.invalid\r\nTEL:1', 'FN:Kettő\r\nEMAIL:ketto@example.invalid\r\nTEL:2', 'FN:M\r\nEMAIL:m@example.invalid\r\nTEL:3'))
  const p = await s.preview(f)
  assert.deepEqual(p.counts, { new: 2, merged: 1, unchanged: 0, invalid: 0, warnings: 0 })
  const before = dumpAll(s.db)
  const orig = s.people.s.insertPhone
  let calls = 0
  s.people.s.insertPhone = { run: (...a) => (++calls === 2 ? (() => { throw new Error('injected') })() : orig.run(...a)) }
  const r = await s.call('contacts:importApply', p.token)
  s.people.s.insertPhone = orig
  assert.deepEqual(r, { ok: false, error: 'internal' })
  assert.equal(calls, 2, 'the error came after the first person was written')
  assert.equal(dumpAll(s.db), before, '0 rows changed')
  // the token is used up: a new preview is needed
  assert.deepEqual(await s.call('contacts:importApply', p.token), { ok: false, error: 'preview_expired' })
})

test('an expired or unknown token: preview_expired, nothing written; a bad token: bad_request', async t => {
  const s = setup(t)
  const p = await s.preview(s.file('a.vcf', vcard('FN:A\r\nEMAIL:a@example.invalid')))
  const before = dumpAll(s.db)
  s.tick(PREVIEW_TTL_MS + 1)
  assert.deepEqual(await s.call('contacts:importApply', p.token), { ok: false, error: 'preview_expired' })
  assert.deepEqual(await s.call('contacts:importApply', '0'.repeat(32)), { ok: false, error: 'preview_expired' })
  for (const bad of [undefined, 5, 'x', 'A'.repeat(32), '0'.repeat(33)]) assert.deepEqual(await s.call('contacts:importApply', bad), { ok: false, error: 'bad_request' })
  assert.equal(dumpAll(s.db), before)
  // within the 5 minutes it works
  const q = await s.preview(s.file('b.vcf', vcard('FN:B\r\nEMAIL:b@example.invalid')))
  s.tick(PREVIEW_TTL_MS - 1)
  assert.deepEqual((await s.call('contacts:importApply', q.token)).counts, { new: 1, merged: 0, unchanged: 0, invalid: 0, warnings: 0 })
})

test('the plan: two people -> invalid, no name and no address -> invalid, a name only -> new, duplicates inside one file merge', async t => {
  const s = setup(t)
  s.people.save({ displayName: 'Első', emails: ['egy@example.invalid'] })
  s.people.save({ displayName: 'Második', emails: ['ketto@example.invalid'] })
  const f = s.file('p.vcf', vcard(
    'FN:Mindkettő\r\nEMAIL:egy@example.invalid\r\nEMAIL:ketto@example.invalid',
    'NOTE:semmi más',
    'FN:Csak név',
    'FN:Új\r\nEMAIL:uj@example.invalid',
    'FN:Új másképp\r\nEMAIL:UJ@example.invalid\r\nEMAIL:uj2@example.invalid\r\nTEL:5',
    'EMAIL:nem-cim',
  ) + 'BEGIN:VCARD\r\nFN:Vég nélkül\r\n')
  const p = await s.preview(f)
  assert.deepEqual(p.counts, { new: 2, merged: 1, unchanged: 0, invalid: 4, warnings: 0 })
  assert.deepEqual(p.invalid, [
    { row: 1, reason: 'two_people' },
    { row: 7, reason: 'no_name_or_address' },
    { row: 27, reason: 'no_name_or_address' },
    { row: 31, reason: 'missing_end' },
  ])
  assert.deepEqual(p.sample, [
    { kind: 'new', name: 'Csak név', address: null },
    { kind: 'new', name: 'Új', address: 'uj@example.invalid' },
    { kind: 'merged', name: 'Új', address: 'uj@example.invalid' },
  ])
  const r = await s.call('contacts:importApply', p.token)
  assert.deepEqual(r.counts, { new: 2, merged: 1, unchanged: 0, invalid: 4, warnings: 0 })
  const uj = s.people.exportPeople().find(x => x.displayName === 'Új')
  assert.deepEqual(uj.emails.map(e => [e.address, e.isPrimary]), [['uj@example.invalid', true], ['uj2@example.invalid', false]])
  assert.deepEqual(uj.phones, [{ number: '5', label: null }])
  assert.equal(s.people.count(), 4)
})

test('the plan is made again at the apply: a person saved between the preview and the apply is merged into, not duplicated', async t => {
  const s = setup(t)
  const p = await s.preview(s.file('a.vcf', vcard('FN:Import\r\nEMAIL:a@example.invalid\r\nTEL:1')))
  assert.deepEqual(p.counts, { new: 1, merged: 0, unchanged: 0, invalid: 0, warnings: 0 })
  const id = s.people.save({ displayName: 'Közben', emails: ['a@example.invalid'] })
  const r = await s.call('contacts:importApply', p.token)
  assert.deepEqual(r.counts, { new: 0, merged: 1, unchanged: 0, invalid: 0, warnings: 0 })
  assert.equal(s.people.count(), 1)
  assert.equal(s.people.get(id).displayName, 'Közben')
  assert.deepEqual(s.people.get(id).phones, [{ number: '1', label: null }])
})

test('import cleaning: control characters, over-long fields and too many addresses become what save() takes', async t => {
  const s = setup(t)
  const many = Array.from({ length: 25 }, (_, i) => `EMAIL:m${i}@example.invalid`).join('\r\n')
  const f = s.file('c.vcf', vcard(`FN:${'Á'.repeat(250)}\r\nORG:a\\nb\r\nTITLE:${'t'.repeat(300)}\r\nNOTE:${'n'.repeat(10_050)}\r\n${many}\r\nTEL:${'9'.repeat(60)}`))
  const r = await s.importFile(f)
  assert.deepEqual(r.apply.counts, { new: 1, merged: 0, unchanged: 0, invalid: 0, warnings: 1 }, "the 5 addresses over the limit are a warning")
  const p = s.people.exportPeople()[0]
  assert.equal(p.displayName.length, 200)
  assert.equal(p.org, 'a b')
  assert.equal(p.title.length, 200)
  assert.equal(p.note.length, 10_000)
  assert.equal(p.emails.length, 20)
  assert.equal(p.phones[0].number.length, 50)
  // the person can be saved unchanged in the editor
  assert.equal(s.people.save({ ...p, id: p.id }), p.id)
})

test('the N with a middle name, prefix, suffix: kept on import, back on export, once', async t => {
  const s = setup(t)
  await s.importFile(s.file('n.vcf', vcard('FN:Dr. Kovács Péter János PhD\r\nN:Kovács;Péter;János;Dr.;PhD\r\nEMAIL:kp@example.invalid')))
  assert.deepEqual(await s.call('contacts:export', { all: true, format: 'vcf' }), { ok: true, saved: true, count: 1 })
  const text = fs.readFileSync(path.join(s.dir, s.dialog.saved[0]), 'utf8')
  assert.deepEqual(text.split('\r\n').filter(l => /^N[;:]/.test(l)), ['N:Kovács;Péter;János;Dr.;PhD'])
})

test('export: vCard and CSV of all or some, the file name with the local date, atomic, round trip unchanged', async t => {
  const s = setup(t)
  await s.importFile(s.file('src.vcf', fs.readFileSync(new URL('./fixtures/contacts/iphone-3.0.vcf', import.meta.url))))
  const a = s.people.save({ displayName: 'Kézi Béla', org: '=1+1', emails: ['bela@example.invalid'], phones: ['+36 1 234 5678'] })
  s.people.save({ displayName: 'Harmadik', emails: ['h@example.invalid'] })
  const vcf = await s.call('contacts:export', { all: true, format: 'vcf' })
  assert.deepEqual(vcf, { ok: true, saved: true, count: 3 })
  assert.equal(s.dialog.saved[0], exportFileName(Date.UTC(2026, 10, 13, 12), 'vcf', hu.contactsExportBase))
  assert.match(s.dialog.saved[0], /^ShadowMail-cimlista-2026-11-13\.vcf$/)
  const csv = await s.call('contacts:export', { ids: [a, a], format: 'csv' })
  assert.deepEqual(csv, { ok: true, saved: true, count: 1 })
  const csvText = fs.readFileSync(path.join(s.dir, s.dialog.saved[1]), 'utf8')
  assert.ok(csvText.startsWith('﻿Name,') && csvText.includes("'=1+1") && csvText.includes(',+36 1 234 5678'), csvText)
  assert.deepEqual(fs.readdirSync(s.dir).filter(n => n.endsWith('.tmp')), [], 'no temporary file left')
  // both files back: nothing new, every one unchanged
  const back = await s.preview(path.join(s.dir, s.dialog.saved[0]))
  assert.deepEqual(back.counts, { new: 0, merged: 0, unchanged: 3, invalid: 0, warnings: 0 })
  const backCsv = await s.preview(path.join(s.dir, s.dialog.saved[1]))
  assert.deepEqual(backCsv.counts, { new: 0, merged: 0, unchanged: 1, invalid: 0, warnings: 0 })
  // the export overwrites an existing file atomically
  fs.writeFileSync(path.join(s.dir, s.dialog.saved[0]), 'régi')
  await s.call('contacts:export', { all: true, format: 'vcf' })
  assert.equal(readVcards(fs.readFileSync(path.join(s.dir, s.dialog.saved[0]))).cards.length, 3)
  // a canceled dialog writes nothing
  s.dialog.cancelSave = true
  assert.deepEqual(await s.call('contacts:export', { all: true, format: 'csv' }), { ok: true, saved: false })
  // bad requests and an empty selection
  for (const bad of [null, 'x', { all: true }, { all: true, format: 'xml' }, { ids: [], format: 'vcf' }, { ids: [0], format: 'vcf' }, { ids: [1], all: true, format: 'vcf' }, { format: 'vcf' }]) {
    assert.deepEqual(await s.call('contacts:export', bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
  }
  assert.deepEqual(await s.call('contacts:export', { ids: [9999], format: 'vcf' }), { ok: false, error: 'nothing_to_export' })
  // CSV read back gives the same handled fields
  assert.equal(readCsv(fs.readFileSync(path.join(s.dir, s.dialog.saved[1]))).cards[0].org, '=1+1')
})

test('a failing export write leaves no temporary file and keeps the old file', async t => {
  const s = setup(t)
  s.people.save({ displayName: 'A', emails: ['a@example.invalid'] })
  const target = path.join(s.dir, exportFileName(Date.UTC(2026, 10, 13, 12), 'vcf', hu.contactsExportBase))
  fs.mkdirSync(target) // a folder where the file would go: the rename fails
  const r = await s.call('contacts:export', { all: true, format: 'vcf' })
  assert.deepEqual(r, { ok: false, error: 'write_failed' })
  assert.deepEqual(fs.readdirSync(s.dir).filter(n => n.endsWith('.tmp')), [])
  assert.ok(fs.statSync(target).isDirectory())
})

test('the import preview: canceled, unsupported file, too large, too many, the dialog filter; the answer has no path', async t => {
  const s = setup(t)
  assert.deepEqual(await s.preview(null), { ok: true, canceled: true })
  assert.deepEqual(s.dialog.openOpts.filters, [{ name: 'Névjegyek (.vcf, .csv)', extensions: ['vcf', 'vcard', 'csv'] }])
  assert.deepEqual(s.dialog.openOpts.properties, ['openFile', 'dontAddToRecent'], 'no Recent shortcut')
  assert.deepEqual(await s.preview(s.file('a.txt', 'x')), { ok: false, error: 'unsupported_file' })
  assert.deepEqual(await s.preview(path.join(s.dir, 'nincs.vcf')), { ok: false, error: 'read_failed' })
  fs.mkdirSync(path.join(s.dir, 'mappa.vcf'))
  assert.deepEqual(await s.preview(path.join(s.dir, 'mappa.vcf')), { ok: false, error: 'unsupported_file' })
  assert.deepEqual(await s.preview(s.file('big.csv', Buffer.alloc(10 * 1024 * 1024 + 1, 0x41))), { ok: false, error: 'too_large' })
  const many = 'Name,E-mail 1 - Value\r\n' + Array.from({ length: 10_001 }, (_, i) => `N${i},n${i}@example.invalid`).join('\r\n')
  assert.deepEqual(await s.preview(s.file('many.csv', many)), { ok: false, error: 'too_many' })
  const ok = await s.preview(s.file('Titkos Név.vcard', vcard('FN:Titkos Ember\r\nEMAIL:titkos@example.invalid')))
  assert.deepEqual(Object.keys(ok).sort(), ['counts', 'format', 'invalid', 'ok', 'sample', 'token', 'warnings'])
  assert.equal(ok.format, 'vcf')
  assert.ok(!JSON.stringify(ok).includes(s.dir) && !JSON.stringify(ok).includes('Titkos Név'), 'no path, no file name')
  // a CSV with an unknown header: every row invalid with its reason
  const u = await s.preview(s.file('u.csv', 'Foo,Bar\r\n1,2\r\n3,4\r\n'))
  assert.deepEqual(u.counts, { new: 0, merged: 0, unchanged: 0, invalid: 2, warnings: 0 })
  assert.deepEqual(u.invalid, [{ row: 2, reason: 'unknown_header' }, { row: 3, reason: 'unknown_header' }])
})

test('at most 50 invalid rows and 20 samples in the preview; at most 3 previews held (the oldest goes)', async t => {
  const s = setup(t)
  const rows = Array.from({ length: 60 }, (_, i) => `N${i},x`).concat(Array.from({ length: 30 }, (_, i) => `M${i},m${i}@example.invalid`))
  const p = await s.preview(s.file('l.csv', 'Name,E-mail 1 - Value\r\n' + rows.join('\r\n')))
  assert.deepEqual(p.counts, { new: 90, merged: 0, unchanged: 0, invalid: 0, warnings: 60 }, 'a name without a valid address is a new person, its "x" a warning')
  assert.equal(p.warnings.length, 50)
  assert.deepEqual(p.warnings[0], { row: 2, reason: 'invalid_address', dropped: 1 })
  const bad = await s.preview(s.file('b.csv', 'Name,E-mail 1 - Value\r\n' + Array.from({ length: 60 }, () => ',x').join('\r\n')))
  assert.equal(bad.counts.invalid, 60)
  assert.equal(bad.counts.warnings, 0, 'a row without a name and with only a bad address is invalid, not a warning')
  assert.equal(bad.invalid.length, 50)
  assert.equal(p.sample.length, 20)
  const t3 = await s.preview(s.file('c.csv', 'Name\r\nC'))
  const t4 = await s.preview(s.file('d.csv', 'Name\r\nD'))
  assert.equal(t3.ok && t4.ok, true)
  assert.deepEqual(await s.call('contacts:importApply', p.token), { ok: false, error: 'preview_expired' }, 'the oldest of four was dropped')
  assert.equal((await s.call('contacts:importApply', t4.token)).ok, true)
})

test('the log: counts and codes only, no name, no address, no file name', async t => {
  const s = setup(t)
  await s.importFile(s.file('Titkos Fájl.vcf', vcard('FN:Titkos Ember\r\nEMAIL:titkos@example.invalid')))
  await s.call('contacts:export', { all: true, format: 'csv' })
  await s.preview(s.file('x.txt', 'x'))
  const all = s.logs.join('\n')
  assert.ok(s.logs.length >= 3, all)
  for (const secret of ['Titkos', 'titkos@', 'example.invalid', s.dir]) assert.ok(!all.includes(secret), `${secret} in the log:\n${all}`)
})

test('without a dialog (not wired): not_available, nothing read or written', async t => {
  const { db, index } = memoryIndex(t)
  const handlers = new Map()
  registerContactsIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, people: new People(db), index, isTrustedSender: () => true })
  new People(db).save({ displayName: 'A', emails: ['a@example.invalid'] })
  assert.deepEqual(await handlers.get('contacts:importPreview')({}), { ok: false, error: 'not_available' })
  assert.deepEqual(await handlers.get('contacts:export')({}, { all: true, format: 'vcf' }), { ok: false, error: 'not_available' })
})

test('a person without a name: the vCard export puts the address in FN, the re-import does not make it a name', async t => {
  const s = setup(t)
  const id = s.people.save({ emails: ['csakcim@example.invalid'] })
  s.people.save({ displayName: 'Névvel', emails: ['nev@example.invalid'] })
  await s.call('contacts:export', { all: true, format: 'vcf' })
  const file = path.join(s.dir, s.dialog.saved[0])
  assert.ok(fs.readFileSync(file, 'utf8').includes('FN:csakcim@example.invalid'))
  const back = await s.importFile(file)
  assert.deepEqual(back.preview.counts, { new: 0, merged: 0, unchanged: 2, invalid: 0, warnings: 0 })
  assert.equal(s.people.get(id).displayName, '')
  // a new person from such a card has no name either (the list shows the address)
  const n = await s.importFile(s.file('n.vcf', vcard('FN:Uj@Example.invalid\r\nEMAIL:uj@example.invalid')))
  assert.deepEqual(n.apply.counts, { new: 1, merged: 0, unchanged: 0, invalid: 0, warnings: 0 })
  assert.equal(s.people.exportPeople().find(p => p.emails[0].address === 'uj@example.invalid').displayName, '')
})

test('nothing is left out silently: address_limit and invalid_address warnings, the contact still imported', async t => {
  const s = setup(t)
  const emails = n => Array.from({ length: n }, (_, i) => `EMAIL:e${i}@example.invalid`).join('\r\n')
  const tels = n => Array.from({ length: n }, (_, i) => `TEL:+36 1 ${100 + i}`).join('\r\n')
  const f = s.file('w.vcf', vcard(
    `FN:Sok cím\r\n${emails(23)}`,
    `FN:Sok telefon\r\nEMAIL:tel@example.invalid\r\n${tels(25)}`,
    'FN:Rossz címmel\r\nEMAIL:nem-cim\r\nEMAIL:jo@example.invalid',
    'EMAIL:nem-cim',
  ))
  const p = await s.preview(f)
  assert.deepEqual(p.counts, { new: 3, merged: 0, unchanged: 0, invalid: 1, warnings: 3 }, 'counts.invalid holds only the not imported one')
  const rowOf = name => fs.readFileSync(f, 'utf8').split('\r\n').findIndex(l => l === `FN:${name}`) // the FN line is BEGIN + 2
  assert.deepEqual(p.warnings, [
    { row: rowOf('Sok cím') - 1, reason: 'address_limit', dropped: 3 },
    { row: rowOf('Sok telefon') - 1, reason: 'address_limit', dropped: 5 },
    { row: rowOf('Rossz címmel') - 1, reason: 'invalid_address', dropped: 1 },
  ])
  assert.deepEqual(p.invalid.map(i => i.reason), ['no_name_or_address'])
  const a = await s.call('contacts:importApply', p.token)
  assert.deepEqual(a.counts, { new: 3, merged: 0, unchanged: 0, invalid: 1, warnings: 3 })
  const byName = n => s.people.exportPeople().find(x => x.displayName === n)
  assert.equal(byName('Sok cím').emails.length, 20)
  assert.deepEqual(byName('Sok cím').emails.slice(-1)[0].address, 'e19@example.invalid', 'the first 20, in the file order')
  assert.equal(byName('Sok telefon').phones.length, 20)
  assert.deepEqual(byName('Rossz címmel').emails, [{ address: 'jo@example.invalid', label: null, isPrimary: true }])
  // imported twice: the second preview is new 0, with the same warnings; nothing changes
  const before = dumpAll(s.db)
  const q = await s.preview(f)
  assert.deepEqual(q.counts, { new: 0, merged: 0, unchanged: 3, invalid: 1, warnings: 3 })
  assert.deepEqual(q.warnings, p.warnings)
  await s.call('contacts:importApply', q.token)
  assert.equal(dumpAll(s.db), before)
  // a merge into a person that is already full warns too
  const full = s.people.save({ displayName: 'Tele', emails: Array.from({ length: 20 }, (_, i) => `t${i}@example.invalid`) })
  const m = await s.preview(s.file('m.vcf', vcard('FN:Tele\r\nEMAIL:t0@example.invalid\r\nEMAIL:plusz1@example.invalid\r\nEMAIL:plusz2@example.invalid')))
  assert.deepEqual(m.counts, { new: 0, merged: 0, unchanged: 1, invalid: 0, warnings: 1 })
  assert.deepEqual(m.warnings, [{ row: 1, reason: 'address_limit', dropped: 2 }])
  assert.equal(s.people.get(full).emails.length, 20)
})

test('the import composes the shown name from the given and family name, as a manual save does', async t => {
  const s = setup(t)
  // Outlook EN CSV and a new Google CSV: no Name column
  const o = await s.importFile(s.file('o.csv', 'First Name,Last Name,E-mail Address\r\nPéter,Kovács,p@k.example.invalid\r\n'))
  assert.deepEqual(o.preview.sample, [{ kind: 'new', name: 'Péter Kovács', address: 'p@k.example.invalid' }])
  await s.importFile(s.file('g.csv', 'First Name,Last Name,E-mail 1 - Value\r\nAnna,Nagy,anna@n.example.invalid\r\n'))
  // a vCard with N and no FN
  await s.importFile(s.file('n.vcf', 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Kiss;Éva;;;\r\nEMAIL:eva@k.example.invalid\r\nEND:VCARD\r\n'))
  const manual = s.people.save({ givenName: 'Béla', familyName: 'Tóth', emails: ['bela@t.example.invalid'] })
  const list = s.people.list({}).items
  const nameOf = a => list.find(i => i.address === a).name
  assert.equal(nameOf('p@k.example.invalid'), 'Péter Kovács')
  assert.equal(nameOf('anna@n.example.invalid'), 'Anna Nagy')
  assert.equal(nameOf('eva@k.example.invalid'), 'Éva Kiss')
  assert.equal(s.people.get(manual).displayName, 'Béla Tóth', 'the same rule as the manual save')
  assert.equal(s.people.suggest('Kov', 5)[0].name, 'Péter Kovács')
  // a nameless automatic person + an import with a given / family name: the shown name is composed too
  s.people.autoAdd([{ address: 'auto@example.invalid', name: '' }])
  const m = await s.importFile(s.file('m.csv', 'First Name,Last Name,E-mail Address\r\nZoltán,Szabó,auto@example.invalid\r\n'))
  assert.deepEqual(m.preview.counts, { new: 0, merged: 1, unchanged: 0, invalid: 0, warnings: 0 })
  assert.deepEqual(m.preview.sample, [{ kind: 'merged', name: 'Zoltán Szabó', address: 'auto@example.invalid' }])
  const auto = s.people.list({ q: 'auto@' }).items[0]
  assert.equal(auto.name, 'Zoltán Szabó')
  assert.equal(auto.source, 'import', 'an automatic person changed by an import is an imported one')
  // a re-import of the same files changes nothing
  const before = dumpAll(s.db)
  for (const f of ['o.csv', 'g.csv', 'n.vcf', 'm.csv']) assert.deepEqual((await s.importFile(path.join(s.dir, f))).apply.counts.new, 0)
  assert.equal(dumpAll(s.db), before)
})

test('merge: a person with a given name only gets the family name and the whole composed name', async t => {
  const s = setup(t)
  s.people.autoAdd([{ address: 'x@example.invalid', name: '' }])
  await s.importFile(s.file('a.csv', 'First Name,Last Name,E-mail Address\r\nPéter,,x@example.invalid\r\n'))
  assert.equal(s.people.list({}).items[0].name, 'Péter')
  // the shown name is no longer empty, so it stays; the family name fills
  await s.importFile(s.file('b.csv', 'First Name,Last Name,E-mail Address\r\n,Kovács,x@example.invalid\r\n'))
  const p = s.people.get(s.people.list({}).items[0].id)
  assert.deepEqual([p.displayName, p.givenName, p.familyName], ['Péter', 'Péter', 'Kovács'])
  // a person with given + family stored and no shown name (an older row): the merge composes it
  const id = s.people.save({ displayName: 'tmp', emails: ['y@example.invalid'] })
  s.db.prepare("UPDATE people SET display_name = '', given_name = 'Anna', family_name = NULL WHERE id = ?").run(id)
  const r = await s.importFile(s.file('c.vcf', 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Nagy;;;;\r\nEMAIL:y@example.invalid\r\nEND:VCARD\r\n'))
  assert.deepEqual(r.apply.counts, { new: 0, merged: 1, unchanged: 0, invalid: 0, warnings: 0 })
  assert.equal(s.people.get(id).displayName, 'Anna Nagy')
})

test('the source: auto -> import only when the import really changes it; manual and import stay', async t => {
  const s = setup(t)
  s.people.autoAdd([{ address: 'auto1@example.invalid', name: '' }, { address: 'auto2@example.invalid', name: 'Már Van' }])
  const manual = s.people.save({ displayName: 'Kézi', emails: ['kezi@example.invalid'] })
  const sourceOf = a => s.people.list({ q: a }).items[0].source
  // the second automatic one gets nothing new (its name is there, no other field): unchanged, stays auto
  const f = s.file('a.csv', 'First Name,Last Name,E-mail Address,Mobile Phone\r\nPéter,Kovács,auto1@example.invalid,\r\n,,auto2@example.invalid,\r\nÚj,Név,kezi@example.invalid,+36 1\r\n')
  const r = await s.importFile(f)
  assert.deepEqual(r.apply.counts, { new: 0, merged: 2, unchanged: 1, invalid: 0, warnings: 0 })
  assert.equal(sourceOf('auto1@'), 'import')
  assert.equal(s.people.list({ q: 'auto1@' }).items[0].name, 'Péter Kovács', 'the name save() would give')
  assert.equal(sourceOf('auto2@'), 'auto', 'unchanged: nothing written, the source stays')
  assert.equal(s.people.get(manual).source, 'manual', 'a changed manual person stays manual')
  assert.deepEqual(s.people.get(manual).phones, [{ number: '+36 1', label: 'cell' }])
  // the second import of the file writes nothing
  const before = dumpAll(s.db)
  const again = await s.importFile(f)
  assert.deepEqual(again.apply.counts, { new: 0, merged: 0, unchanged: 3, invalid: 0, warnings: 0 })
  assert.equal(dumpAll(s.db), before)
  // the sample and the written name agree (Outlook EN CSV and a vCard 3.0 without FN)
  for (const [name, content, want] of [
    ['o.csv', 'First Name,Last Name,E-mail Address\r\nAnna,Nagy,anna@example.invalid\r\n', 'Anna Nagy'],
    ['v.vcf', 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Kiss;Éva;;;\r\nEMAIL:eva@example.invalid\r\nEND:VCARD\r\n', 'Éva Kiss'],
  ]) {
    const p = await s.importFile(s.file(name, content))
    assert.equal(p.preview.sample[0].name, want)
    const addr = p.preview.sample[0].address
    assert.equal(s.people.list({ q: addr }).items[0].name, want)
    assert.equal(s.people.suggest(addr.slice(0, 4), 5)[0].name, want)
  }
})

test('the export file name is the interface language\'s: ShadowMail-contacts-<date> in English; no base throws', () => {
  const ms = Date.UTC(2026, 10, 13, 12)
  assert.equal(exportFileName(ms, 'vcf', hu.contactsExportBase), 'ShadowMail-cimlista-2026-11-13.vcf')
  assert.equal(exportFileName(ms, 'vcf', en.contactsExportBase), 'ShadowMail-contacts-2026-11-13.vcf')
  assert.equal(exportFileName(ms, 'csv', en.contactsExportBase), 'ShadowMail-contacts-2026-11-13.csv')
  assert.throws(() => exportFileName(ms, 'vcf'), TypeError)
})
