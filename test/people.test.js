// the address book. Migration 5 from the contacts, the
// contacts:* IPC with its checks, the Hungarian order of the list, the completion over every address of a person, and a
// log that holds no address and no name. (The automatic adding on a real send: test/compose.test.js, "C1: ...".)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from './helpers/tmp.js'
import { memoryIndex, addAccount, addMessage } from './helpers/fixtures.js'
import { openDatabase, openMailDatabase } from '../core/db/index.js'
import { migrate, currentVersion, backupPath } from '../core/db/migrate.js'
import { MIGRATIONS } from '../core/db/schema.js'
import { People, PeopleError, LIMITS, cleanName } from '../core/db/people.js'
import { Contacts } from '../core/db/contacts.js'
import { addrKey } from '../core/db/addr-key.js'
import { registerContactsIpc, CONTACTS_CHANNELS } from '../app/main/ipc/contacts.js'

const dump = (db, table) => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())

test('migration 4 -> 5: the contacts become automatic people; contacts and settings unchanged; the .bak-4 is made', t => {
  const file = path.join(tempDir(t), 'mail.sqlite')
  const key = Buffer.alloc(32, 9)
  const old = openDatabase(file, key)
  migrate(old, MIGRATIONS.slice(0, 4))
  const ins = old.prepare('INSERT INTO contacts (address, name, last_used, use_count) VALUES (?, ?, ?, ?)')
  ins.run('anna@example.invalid', 'Anna Ács', 1_700_000_000_000, 5)
  ins.run('bela@example.invalid', '', 1_700_000_100_000, 1)
  ins.run('cecil@example.invalid', null, null, 2)
  ins.run('dora@example.invalid', `Dóra${String.fromCharCode(1)}vezérlő`, 1, 1)
  ins.run('emil@example.invalid', 'E'.repeat(201), 1, 1)
  old.prepare("INSERT INTO settings (key, value) VALUES ('claude_access', 'on')").run()
  const before = { contacts: dump(old, 'contacts'), settings: dump(old, 'settings') }
  old.close()
  const { db, migration } = openMailDatabase(file, { key })
  try {
    assert.deepEqual(migration, { from: 4, to: MIGRATIONS.length, backup: backupPath(file, 4) }) // 5 and every later migration
    assert.ok(fs.existsSync(`${file}.bak-4`))
    assert.equal(dump(db, 'contacts'), before.contacts, 'contacts byte for byte')
    assert.equal(dump(db, 'settings'), before.settings, 'settings byte for byte')
    const rows = db.prepare('SELECT p.display_name, p.source, p.created_at, e.address, e.is_primary FROM people p JOIN person_emails e ON e.person_id = p.id ORDER BY e.address').all()
    assert.equal(rows.length, 5)
    // a name with a control character or over 200 characters is cleaned, as the automatic adding does
    assert.deepEqual(rows.map(r => [r.display_name, r.source, r.address, r.is_primary]), [
      ['Anna Ács', 'auto', 'anna@example.invalid', 1],
      ['', 'auto', 'bela@example.invalid', 1],
      ['', 'auto', 'cecil@example.invalid', 1],
      ['Dóra vezérlő', 'auto', 'dora@example.invalid', 1],
      ['E'.repeat(200), 'auto', 'emil@example.invalid', 1],
    ])
    assert.equal(rows[0].created_at, 1_700_000_000_000, 'the last use is the creation time')
    assert.equal(db.prepare('SELECT count(*) AS n FROM contact_suppressed').get().n, 0)
  } finally {
    db.close()
  }
  const bak = openDatabase(`${file}.bak-4`, key)
  try {
    assert.equal(currentVersion(bak), 4)
    assert.equal(bak.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'people'").get().n, 0)
  } finally {
    bak.close()
  }
})

function ipcSetup(t) {
  const { db, index } = memoryIndex(t)
  const people = new People(db)
  const handlers = new Map()
  const logs = []
  registerContactsIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, people, index, isTrustedSender: e => e.trusted, log: m => logs.push(m) })
  const call = (channel, ...args) => handlers.get(channel)({ trusted: true }, ...args)
  return { db, index, people, handlers, call, logs }
}

test('contacts:* channels; save: address_taken with the owner id, bad_request on lengths and bad input; get / count / delete', async t => {
  const { handlers, call } = ipcSetup(t)
  assert.deepEqual([...handlers.keys()].sort(), [...CONTACTS_CHANNELS].sort())
  assert.deepEqual(await handlers.get('contacts:count')({ trusted: false }), { ok: false, error: 'untrusted_sender' })
  const a = await call('contacts:save', { displayName: 'Kiss Anna', org: 'Cég Kft.', emails: [{ address: 'Anna@Example.invalid', label: 'munka' }, 'anna2@example.invalid'], phones: [{ number: '+36 1 234 5678', label: 'mobil' }], note: `két${String.fromCharCode(10)}sor` })
  assert.equal(a.ok, true)
  const got = await call('contacts:get', a.id)
  assert.equal(got.person.displayName, 'Kiss Anna')
  assert.deepEqual(got.person.emails, [{ address: 'anna@example.invalid', label: 'munka', isPrimary: true }, { address: 'anna2@example.invalid', label: null, isPrimary: false }])
  assert.deepEqual(got.person.phones, [{ number: '+36 1 234 5678', label: 'mobil' }])
  assert.equal(got.person.source, 'manual')
  // another person with one of these addresses
  assert.deepEqual(await call('contacts:save', { displayName: 'Másik', emails: ['ANNA2@example.invalid'] }), { ok: false, error: 'address_taken', personId: a.id })
  // the same person may keep its own addresses on a change
  assert.equal((await call('contacts:save', { ...got.person, displayName: 'Kiss Anna Mária' })).ok, true)
  const bad = [
    { displayName: 'x'.repeat(LIMITS.name + 1) },
    { displayName: 'ok', note: 'n'.repeat(LIMITS.note + 1) },
    { emails: Array.from({ length: 21 }, (_, i) => `a${i}@example.invalid`) },
    { displayName: 'ok', phones: Array.from({ length: 21 }, () => '1') },
    { emails: ['nem-cim'] },
    { emails: ['a@example.invalid', 'A@example.invalid'] },
    { displayName: `sor${String.fromCharCode(10)}törés` },
    {},
    { displayName: '   ' },
    { id: -1, displayName: 'x' },
  ]
  for (const b of bad) assert.deepEqual(await call('contacts:save', b), { ok: false, error: 'bad_request' }, JSON.stringify(b).slice(0, 60))
  assert.deepEqual(await call('contacts:save', 'x'), { ok: false, error: 'bad_request' })
  assert.deepEqual(await call('contacts:save', { id: 9999, displayName: 'nincs' }), { ok: false, error: 'not_found' })
  for (const q of [null, 'x', { limit: 201 }, { offset: -1 }, { q: 5 }]) assert.equal((await call('contacts:list', q)).error, 'bad_request')
  assert.deepEqual(await call('contacts:get', 0), { ok: false, error: 'bad_request' })
  assert.deepEqual(await call('contacts:count'), { ok: true, count: 1 })
  assert.deepEqual(await call('contacts:delete', [a.id]), { ok: true, removed: 1 })
  assert.deepEqual(await call('contacts:get', a.id), { ok: false, error: 'not_found' })
  for (const ids of [[], 'x', [0], [1.5]]) assert.equal((await call('contacts:delete', ids)).error, 'bad_request')
})

test('the list: Hungarian order by the shown name (Intl.Collator hu), a nameless person by its address; search; paging', async t => {
  const { call } = ipcSetup(t)
  for (const n of ['Béla', 'Ábel', 'Adam', 'Csaba', 'Cecília', 'Zoé', 'Ödön', 'Olga']) await call('contacts:save', { displayName: n, emails: [`${n.normalize('NFD').replace(/[^a-z]/gi, '').toLowerCase()}@example.invalid`] })
  await call('contacts:save', { emails: ['nevtelen@example.invalid'] })
  const all = await call('contacts:list', {})
  const names = all.items.map(i => i.name || i.address)
  const want = [...names].sort(new Intl.Collator('hu', { sensitivity: 'base' }).compare)
  assert.deepEqual(names, want)
  // Intl.Collator('hu') (ICU 78): á is a variant of a, so Ábel (a-b) comes BEFORE Adam (a-d); cs is a letter after c, ö after o
  assert.ok(names.indexOf('Ábel') < names.indexOf('Béla') && names.indexOf('Cecília') < names.indexOf('Csaba') && names.indexOf('Olga') < names.indexOf('Ödön'), names.join(','))
  assert.equal(all.total, 9)
  assert.deepEqual((await call('contacts:list', { q: 'ödön' })).items.map(i => i.name), ['Ödön'])
  // no case, no accents (SQLite's LIKE would fold ASCII only)
  assert.deepEqual((await call('contacts:list', { q: 'ODON' })).items.map(i => i.name), ['Ödön'])
  assert.deepEqual((await call('contacts:list', { q: 'abel' })).items.map(i => i.name), ['Ábel'])
  assert.deepEqual((await call('contacts:list', { q: 'zoe@' })).items.map(i => i.name), ['Zoé'])
  const page = await call('contacts:list', { offset: 2, limit: 3 })
  assert.deepEqual(page.items.map(i => i.name || i.address), names.slice(2, 5))
  assert.equal(page.total, 9)
})

test('the completion finds the SECOND address of a person by the name; people first, then the contacts, then the senders', t => {
  const { db, index } = memoryIndex(t)
  const people = new People(db)
  const contacts = new Contacts(db, { people })
  people.save({ displayName: 'Tóth Gizella', emails: ['giza@example.invalid', 'gizella.toth@example.invalid'] })
  const acc = addAccount(db)
  addMessage(index, acc.id, { uid: 1, fromAddr: 'gizi.felado@example.invalid', fromName: 'Gizi Feladó', subject: 's', date: 1 })
  const got = contacts.suggest('Gizel')
  assert.deepEqual(got.slice(0, 2).map(r => r.address).sort(), ['giza@example.invalid', 'gizella.toth@example.invalid'])
  assert.ok(got.every(r => r.address !== 'gizi.felado@example.invalid'), 'the sender does not match "Gizel"')
  const giz = contacts.suggest('Gizi')
  assert.deepEqual(giz.map(r => r.address), ['gizi.felado@example.invalid'], 'the senders as before')
  // the more used address of a person comes first
  db.prepare("INSERT INTO contacts (address, name, last_used, use_count) VALUES ('gizella.toth@example.invalid', 'Tóth Gizella', 5, 9)").run()
  assert.equal(contacts.suggest('Tóth')[0].address, 'gizella.toth@example.invalid')
  // the completion ignores case and accents in the names too
  assert.equal(contacts.suggest('toth gi')[0].address, 'gizella.toth@example.invalid')
  assert.ok(contacts.suggest('TÓTH').length >= 2)
})

test('addFromMessage: the sender by hand (manual), an address already there gives that person; no sender: no_sender', async t => {
  const { db, index, call } = ipcSetup(t)
  const acc = addAccount(db)
  const m1 = addMessage(index, acc.id, { uid: 1, fromAddr: 'Felado@Example.invalid', fromName: 'Feladó Ferenc', subject: 's', date: 1 })
  const m2 = addMessage(index, acc.id, { uid: 2, subject: 's', date: 2 })
  db.prepare("UPDATE messages SET from_addr = '', from_name = NULL WHERE id = ?").run(m2)
  const r = await call('contacts:addFromMessage', m1)
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  const p = (await call('contacts:get', r.id)).person
  assert.deepEqual([p.displayName, p.source, p.emails[0].address], ['Feladó Ferenc', 'manual', 'felado@example.invalid'])
  assert.deepEqual(await call('contacts:addFromMessage', m1), { ok: true, id: r.id, created: false })
  assert.deepEqual(await call('contacts:addFromMessage', m2), { ok: false, error: 'no_sender' })
  assert.deepEqual(await call('contacts:addFromMessage', 99999), { ok: false, error: 'not_found' })
})

test('the log of a whole round holds counts only: no address, no name', async t => {
  const { db, index, call, logs } = ipcSetup(t)
  const acc = addAccount(db)
  const m = addMessage(index, acc.id, { uid: 1, fromAddr: 'titok-felado@example.invalid', fromName: 'Titkos Feladó', subject: 's', date: 1 })
  const a = await call('contacts:save', { displayName: 'Titkos Név', emails: ['titok-cim@example.invalid'] })
  await call('contacts:save', { displayName: 'Másik', emails: ['titok-cim@example.invalid'] })
  await call('contacts:addFromMessage', m)
  await call('contacts:delete', [a.id])
  await call('contacts:list', { q: 'Titkos' })
  const text = logs.join(' | ')
  assert.ok(logs.length >= 3, text)
  for (const w of ['titok', 'Titkos', 'example.invalid', 'Másik', 'Feladó']) assert.ok(!text.includes(w), `${w} in the log: ${text}`)
})

test('PeopleError and the automatic adding: a bad address is skipped, an over-long name cut, nothing thrown', t => {
  const { db } = memoryIndex(t)
  const people = new People(db)
  assert.equal(people.autoAdd([{ address: 'nem-cim', name: 'x' }, { address: 'ok@example.invalid', name: 'n'.repeat(LIMITS.name + 1) }, { address: 'OK@example.invalid', name: 'dupla' }]), 1)
  assert.equal(people.list().items[0].name, 'n'.repeat(LIMITS.name))
  assert.ok(new PeopleError('address_taken', { personId: 3 }).personId === 3)
})

test('a deleted person id is never given again (AUTOINCREMENT)', t => {
  const { db } = memoryIndex(t)
  const people = new People(db)
  const a = people.save({ displayName: 'Első', emails: ['elso@example.invalid'] })
  people.delete([a])
  const b = people.addSender({ address: 'masik@example.invalid', name: 'Második' }).id
  assert.notEqual(b, a)
  assert.ok(b > a)
})

// one name cleaning for the migration and the automatic adding; save() unchanged
const CTL1 = String.fromCharCode(1)
const SMILE = String.fromCodePoint(0x1f600)

test('migration 5 cleans a control-character and a 500-character name; both save back unchanged', t => {
  const file = path.join(tempDir(t), 'mail.sqlite')
  const key = Buffer.alloc(32, 7)
  const old = openDatabase(file, key)
  migrate(old, MIGRATIONS.slice(0, 4))
  const ins = old.prepare('INSERT INTO contacts (address, name, last_used, use_count) VALUES (?, ?, ?, ?)')
  ins.run('kis@example.invalid', `Kis${CTL1}Pál\r\nJr`, 1, 1)
  ins.run('hosszu@example.invalid', 'H'.repeat(500), 1, 1)
  old.close()
  const { db } = openMailDatabase(file, { key })
  try {
    const people = new People(db)
    const byAddr = Object.fromEntries(people.list().items.map(i => [i.address, i]))
    assert.equal(byAddr['kis@example.invalid'].name, 'Kis Pál Jr')
    assert.equal(byAddr['hosszu@example.invalid'].name, 'H'.repeat(200))
    for (const a of ['kis@example.invalid', 'hosszu@example.invalid']) {
      const p = people.get(byAddr[a].id)
      assert.equal(people.save(p), p.id, `${a} saves back without a change`)
      assert.equal(people.get(p.id).displayName, p.displayName)
    }
  } finally {
    db.close()
  }
})

test('the automatic adding cleans the same bad name to the same name as the migration (not empty)', t => {
  const { db } = memoryIndex(t)
  const people = new People(db)
  const bad = `  Kis${CTL1}${CTL1}Pál\r\n\tJr  `
  people.autoAdd([{ address: 'kis@example.invalid', name: bad }, { address: 'hosszu@example.invalid', name: 'H'.repeat(500) }])
  const byAddr = Object.fromEntries(people.list().items.map(i => [i.address, i.name]))
  assert.equal(byAddr['kis@example.invalid'], 'Kis Pál Jr')
  assert.equal(byAddr['kis@example.invalid'], cleanName(bad))
  assert.equal(byAddr['hosszu@example.invalid'], 'H'.repeat(200))
  // a name typed by hand is not cleaned: save() still refuses it
  assert.throws(() => people.save({ displayName: `Kis${CTL1}Pál`, emails: ['kezi@example.invalid'] }), e => e.code === 'bad_request')
})

test('the cut never splits a surrogate pair, and the cut emoji name saves back unchanged', t => {
  for (const name of [`a${SMILE.repeat(100)}`, SMILE.repeat(150), `${'b'.repeat(199)}${SMILE}`]) {
    const c = cleanName(name)
    assert.ok(c.length <= LIMITS.name, `${c.length}`)
    assert.ok(c.isWellFormed(), 'no lone surrogate')
    assert.ok(name.startsWith(c))
  }
  const { db } = memoryIndex(t)
  const people = new People(db)
  people.autoAdd([{ address: 'emoji@example.invalid', name: `a${SMILE.repeat(100)}` }])
  const p = people.get(people.list().items[0].id)
  assert.equal(p.displayName, `a${SMILE.repeat(99)}`)
  assert.equal(people.save(p), p.id)
  assert.equal(cleanName(null), '')
  assert.equal(cleanName(42), '')
})

test('after delete(id) every new person (addFromMessage, save) gets a bigger id; a save with the old id is not_found and changes nobody', async t => {
  const { db, index } = memoryIndex(t)
  const people = new People(db)
  const ids = [people.save({ displayName: 'Első', emails: ['elso@example.invalid'] }), people.save({ displayName: 'Második', emails: ['masodik@example.invalid'] })]
  const gone = ids[1]
  people.delete([gone])
  const handlers = new Map()
  registerContactsIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, people, index, isTrustedSender: () => true })
  const acc = addAccount(db)
  const m = addMessage(index, acc.id, { uid: 1, fromAddr: 'felado@example.invalid', fromName: 'Feladó', subject: 's', date: 1 })
  const viaMessage = await handlers.get('contacts:addFromMessage')({}, m)
  assert.equal(viaMessage.ok, true, JSON.stringify(viaMessage))
  const viaSave = people.save({ displayName: 'Harmadik', emails: ['harmadik@example.invalid'] })
  const newIds = [viaMessage.id, viaSave]
  for (const id of newIds) assert.ok(id > Math.max(...ids), `${id} > ${Math.max(...ids)}`)
  const before = dump(db, 'people') + dump(db, 'person_emails')
  assert.throws(() => people.save({ id: gone, displayName: 'Elavult', emails: ['elavult@example.invalid'] }), e => e.code === 'not_found')
  assert.equal(dump(db, 'people') + dump(db, 'person_emails'), before, 'nobody changed')
})

test('addFromMessage of a sender named "Kis\\u0001Pál" gives a person named "Kis Pál" (not empty), and it saves back', async t => {
  const { db, index } = memoryIndex(t)
  const people = new People(db)
  const handlers = new Map()
  registerContactsIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, people, index, isTrustedSender: () => true })
  const acc = addAccount(db)
  const m = addMessage(index, acc.id, { uid: 1, fromAddr: 'kis@example.invalid', fromName: `Kis${CTL1}Pál`, subject: 's', date: 1 })
  const r = await handlers.get('contacts:addFromMessage')({}, m)
  assert.equal(r.ok, true, JSON.stringify(r))
  const p = people.get(r.id)
  assert.equal(p.displayName, 'Kis Pál')
  assert.equal(people.save(p), p.id)
  assert.equal(people.get(p.id).displayName, 'Kis Pál')
})

// the completion does not suggest a deleted person's address until it is taken back by hand
const suggested = (contacts, term, limit = 8) => contacts.suggest(term, limit).map(s => s.address.toLowerCase())

test('a deleted person (address also in contacts and as a sender) is suggested by neither name nor address; taken back by save or addFromMessage, it is again', async t => {
  const { db, index } = memoryIndex(t)
  const people = new People(db)
  const contacts = new Contacts(db, { people })
  const handlers = new Map()
  registerContactsIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, people, index, isTrustedSender: () => true })
  const acc = addAccount(db)
  contacts.recordSent([{ address: 'kis.pal@pelda.example', name: 'Kis Pál' }]) // contacts row + automatic person
  const m = addMessage(index, acc.id, { uid: 1, fromAddr: 'kis.pal@pelda.example', fromName: 'Kis Pál', subject: 's', date: 1 })
  const id = people.list().items.find(i => i.address === 'kis.pal@pelda.example').id
  assert.deepEqual(suggested(contacts, 'Kis'), ['kis.pal@pelda.example'], 'before the delete')
  people.delete([id])
  assert.deepEqual(suggested(contacts, 'Kis'), [], 'by name')
  assert.deepEqual(suggested(contacts, 'kis.pal'), [], 'by address')
  people.save({ displayName: 'Kis Pál', emails: ['kis.pal@pelda.example'] })
  assert.deepEqual(suggested(contacts, 'kis.pal'), ['kis.pal@pelda.example'], 'taken back by save')
  people.delete([people.list().items.find(i => i.address === 'kis.pal@pelda.example').id])
  assert.deepEqual(suggested(contacts, 'kis.pal'), [])
  assert.equal((await handlers.get('contacts:addFromMessage')({}, m)).ok, true)
  assert.deepEqual(suggested(contacts, 'kis.pal'), ['kis.pal@pelda.example'], 'taken back by addFromMessage')
})

test('10 suppressed and 10 allowed matching addresses: suggest(limit 8) gives 8, none suppressed (the filter is before the LIMIT)', t => {
  const { db } = memoryIndex(t)
  const people = new People(db)
  const contacts = new Contacts(db, { people })
  // the suppressed ones are the most used: a filter after the LIMIT would leave fewer than 8
  for (let i = 0; i < 10; i++) for (let k = 0; k < 5; k++) contacts.recordSent([{ address: `tiltott${i}@cim.example`, name: '' }], 1000 + k)
  for (let i = 0; i < 10; i++) contacts.recordSent([{ address: `szabad${i}@cim.example`, name: '' }], 1000)
  people.delete(people.list({ limit: 200 }).items.filter(i => i.address.startsWith('tiltott')).map(i => i.id))
  db.prepare('DELETE FROM people WHERE id IN (SELECT person_id FROM person_emails WHERE address LIKE ?)').run('szabad%') // only the contacts branch
  const got = suggested(contacts, 'cim.example', 8)
  assert.equal(got.length, 8, JSON.stringify(got))
  assert.ok(got.every(a => a.startsWith('szabad')), JSON.stringify(got))
})

test('a send to a suppressed address: the use count grows, but the address stays out of the suggestions and the people', t => {
  const { db } = memoryIndex(t)
  const people = new People(db)
  const contacts = new Contacts(db, { people })
  contacts.recordSent([{ address: 'torolt@pelda.example', name: 'Törölt' }])
  people.delete([people.list().items[0].id])
  const before = db.prepare('SELECT use_count FROM contacts WHERE address = ?').get('torolt@pelda.example').use_count
  contacts.recordSent([{ address: 'torolt@pelda.example', name: 'Törölt' }])
  assert.equal(db.prepare('SELECT use_count FROM contacts WHERE address = ?').get('torolt@pelda.example').use_count, before + 1)
  assert.deepEqual(suggested(contacts, 'torolt'), [])
  assert.equal(people.count(), 0)
})

test('a case difference (Kis.Pal@Pelda.example as the sender, kis.pal@pelda.example suppressed) is filtered too', t => {
  const { db, index } = memoryIndex(t)
  const people = new People(db)
  const contacts = new Contacts(db, { people })
  const acc = addAccount(db)
  addMessage(index, acc.id, { uid: 1, fromAddr: 'Kis.Pal@Pelda.example', fromName: 'Kis Pál', subject: 's', date: 1 })
  addMessage(index, acc.id, { uid: 2, fromAddr: 'mas@pelda.example', fromName: 'Kis Más', subject: 's', date: 1 })
  assert.deepEqual(suggested(contacts, 'Kis').sort(), ['kis.pal@pelda.example', 'mas@pelda.example'])
  const id = people.save({ displayName: 'Kis Pál', emails: ['kis.pal@pelda.example'] })
  people.delete([id])
  assert.deepEqual(suggested(contacts, 'Kis'), ['mas@pelda.example'])
})

// one address key (addrKey in JS, addr_key() in SQL): an accented capital matches too
test('an accented capital sender (ÁRVÍZ.tűrő@) with árvíz.tűrő@ suppressed is not suggested; taken back it is; the two forms give ONE suggestion', t => {
  const { db, index } = memoryIndex(t)
  const people = new People(db)
  const contacts = new Contacts(db, { people })
  const acc = addAccount(db)
  addMessage(index, acc.id, { uid: 1, fromAddr: 'ÁRVÍZ.tűrő@pelda.example', fromName: 'Árvíz Tűrő', subject: 's', date: 1 })
  addMessage(index, acc.id, { uid: 2, fromAddr: 'árvíz.tűrő@pelda.example', fromName: 'Árvíz Tűrő', subject: 's', date: 2 })
  addMessage(index, acc.id, { uid: 3, fromAddr: 'mas@pelda.example', fromName: 'Árvíz Más', subject: 's', date: 1 })
  const keys = () => contacts.suggest('Árvíz', 8).map(s => s.address.toLowerCase()).sort()
  assert.deepEqual(keys(), ['mas@pelda.example', 'árvíz.tűrő@pelda.example'], 'the two forms of the sender: one suggestion')
  assert.equal(db.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM messages WHERE from_addr LIKE '%pelda.example' GROUP BY addr_key(from_addr))").get().n, 2, 'grouped by the key in SQL')
  const id = people.save({ displayName: 'Árvíz Tűrő', emails: ['Árvíz.Tűrő@pelda.example'] })
  assert.equal(people.get(id).emails[0].address, 'árvíz.tűrő@pelda.example', 'stored by the same key')
  people.delete([id])
  assert.deepEqual(keys(), ['mas@pelda.example'], 'suppressed: neither form is suggested')
  people.save({ displayName: 'Árvíz Tűrő', emails: ['árvíz.tűrő@pelda.example'] })
  assert.deepEqual(keys(), ['mas@pelda.example', 'árvíz.tűrő@pelda.example'], 'taken back: suggested again, once')
})

test('addr_key() is registered on every connection and is the JS rule', t => {
  const { db } = memoryIndex(t)
  for (const x of ['ÁRVÍZ.Tűrő@Pelda.Example', '  Kis.Pal@x.example ', 'ascii@x.example']) assert.equal(db.prepare('SELECT addr_key(?) AS k').get(x).k, addrKey(x))
  assert.equal(db.prepare('SELECT addr_key(NULL) AS k').get().k, null)
})

test('contacts:lookup: the person of an address (no case), null when nobody has it; bad input', async t => {
  const { call } = ipcSetup(t)
  const { id } = await call('contacts:save', { displayName: 'Anna', emails: ['anna@example.invalid', 'anna2@example.invalid'] })
  assert.deepEqual(await call('contacts:lookup', 'ANNA2@example.invalid'), { ok: true, personId: id })
  assert.deepEqual(await call('contacts:lookup', 'senki@example.invalid'), { ok: true, personId: null })
  assert.deepEqual(await call('contacts:lookup', 'nem-cim'), { ok: true, personId: null })
  for (const bad of [5, null, 'x'.repeat(321)]) assert.deepEqual(await call('contacts:lookup', bad), { ok: false, error: 'bad_request' })
})
