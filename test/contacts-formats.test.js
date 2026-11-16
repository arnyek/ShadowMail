// the vCard and CSV readers and
// writers. Fixtures: test/fixtures/contacts (made from the standards by make-fixtures.py, byte-exact); the hostile
// inputs are generated here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { readVcards, writeVcards, foldLine } from '../core/contacts/vcard.js'
import { readCsv, writeCsv, csvCell } from '../core/contacts/csv.js'
import { IMPORT_LIMITS } from '../core/contacts/limits.js'

const here = dirname(fileURLToPath(import.meta.url))
const fx = name => readFileSync(join(here, 'fixtures', 'contacts', name))
const NAME = 'Árvíztűrő Tükörfúrógép'
const fields = c => ({
  displayName: c.displayName,
  givenName: c.givenName,
  familyName: c.familyName,
  org: c.org,
  title: c.title,
  note: c.note,
  emails: c.emails,
  phones: c.phones,
})
const em = (address, label = null, isPrimary = false) => ({ address, label, isPrimary })
const ph = (number, label = null) => ({ number, label })
const extraNames = c => (c.vcardExtra || '').split('\r\n').filter(Boolean).map(l => l.split(/[;:]/)[0])
const withoutN = x => (x || '').split('\r\n').filter(l => l && !/^N[;:]/.test(l)).join('\r\n')
// the five N components of the saved N line (missing ones as '')
const nParts = x => {
  const l = (x || '').split('\r\n').find(y => /^N[;:]/.test(y))
  if (!l) return null
  const parts = l.slice(l.indexOf(':') + 1).split(/(?<!\\);/)
  return [0, 1, 2, 3, 4].map(i => parts[i] ?? '')
}

test('Gmail vCard 3.0: fields, item groups, folding, escapes; ADR/BDAY kept, the URL dropped', () => {
  const { cards, errors } = readVcards(fx('gmail-3.0.vcf'))
  assert.deepEqual(errors, [])
  assert.equal(cards.length, 2)
  assert.deepEqual(fields(cards[0]), {
    displayName: NAME,
    givenName: 'Tükörfúrógép',
    familyName: 'Árvíztűrő',
    org: 'Példa Kft.',
    title: 'Ügyvezető',
    note: 'Első sor\nMásodik sor, vesszővel',
    emails: [em('arviz@example.hu', 'home'), em('tukor@ceg.example.hu', 'work')],
    phones: [ph('+36 30 123 4567', 'cell')],
  })
  assert.deepEqual(extraNames(cards[0]), ['N', 'ADR', 'BDAY', 'item1.X-ABLabel', 'CATEGORIES'])
  assert.ok(!cards[0].vcardExtra.includes('example.hu'), 'the URL is not kept')
  assert.equal(cards[1].note, 'Nagyon hosszú megjegyzés, amely biztosan átlépi a hetvenöt bájtos sorhatárt, ezért a Gmail tördelve írja ki, és az olvasónak össze kell raknia.')
  assert.deepEqual(cards[1].emails, [em('kiss.eva@example.com')])
})

test('iPhone vCard 3.0: type=pref -> primary, ORG units joined, PHOTO ENCODING=b dropped, groups kept', () => {
  const { cards, errors } = readVcards(fx('iphone-3.0.vcf'))
  assert.deepEqual(errors, [])
  assert.equal(cards.length, 1)
  assert.deepEqual(fields(cards[0]), {
    displayName: NAME,
    givenName: 'Tükörfúrógép',
    familyName: 'Árvíztűrő',
    org: 'Példa Kft., Fejlesztés',
    title: 'Mérnök',
    note: null,
    emails: [em('arviz@example.hu', 'home', true), em('tukor@ceg.example.hu', 'work')],
    phones: [ph('+36 30 123 4567', 'cell'), ph('+36 1 234 5678', 'work')],
  })
  assert.deepEqual(extraNames(cards[0]), ['PRODID', 'N', 'item1.ADR', 'item1.X-ABADR', 'BDAY'])
  assert.ok(!/PHOTO/.test(cards[0].vcardExtra))
})

test('Android vCard 2.1: QUOTED-PRINTABLE + UTF-8 with a soft line break, bare TYPE params, BASE64 photo dropped', () => {
  const { cards, errors } = readVcards(fx('android-2.1.vcf'))
  assert.deepEqual(errors, [])
  assert.equal(cards.length, 2)
  assert.deepEqual(fields(cards[0]), {
    displayName: NAME,
    givenName: 'Tükörfúrógép',
    familyName: 'Árvíztűrő',
    org: null,
    title: null,
    note: 'Első sor\nMásodik sor, ékezettel: őű',
    emails: [em('arviz@example.hu', 'home')],
    phones: [ph('+36301234567', 'cell'), ph('+3612345678', 'home')],
  })
  // the 2.1 N and ADR in 3.0 form: decoded, without ENCODING/CHARSET
  assert.equal(cards[0].vcardExtra, 'N:Árvíztűrő;Tükörfúrógép;;;\r\nADR;TYPE=HOME:;;Fő utca 1.;Budapest;;1011;Magyarország')
  assert.deepEqual(fields(cards[1]), { displayName: 'Nagy Anna', givenName: 'Anna', familyName: 'Nagy', org: null, title: null, note: null, emails: [], phones: [ph('+36209876543', 'cell')] })
})

test('Outlook vCard 2.1: CHARSET=Windows-1250 (plain and QP), bare PREF -> primary, X-MS lines kept', () => {
  const buf = fx('outlook-2.1.vcf')
  assert.ok(buf.includes(Buffer.from([0xfb])) && !buf.includes(Buffer.from('ű')), 'the fixture is Windows-1250')
  const { cards, errors } = readVcards(buf)
  assert.deepEqual(errors, [])
  assert.deepEqual(fields(cards[0]), {
    displayName: NAME,
    givenName: 'Tükörfúrógép',
    familyName: 'Árvíztűrő',
    org: 'Példa Kft.',
    title: 'Ügyvezető',
    note: 'Megjegyzés első sora\nmásodik sora',
    emails: [em('arviz@example.hu', null, true)],
    phones: [ph('+36 1 234 5678', 'work'), ph('+36 30 123 4567', 'cell')],
  })
  assert.deepEqual(extraNames(cards[0]), ['N', 'ADR', 'LABEL', 'X-MS-OL-DEFAULT-POSTAL-ADDRESS', 'X-MS-OL-DESIGN', 'REV'])
  assert.ok(cards[0].vcardExtra.startsWith('N;LANGUAGE=hu:Árvíztűrő;Tükörfúrógép\r\n'))
  assert.ok(cards[0].vcardExtra.includes('LABEL;TYPE=WORK,PREF:Fő utca 1.\\n1011 Budapest'))
})

test('Thunderbird vCard 4.0: PREF=1, VALUE=TEXT and tel: URI; URL, PHOTO and LOGO by URI dropped', () => {
  const { cards, errors } = readVcards(fx('thunderbird-4.0.vcf'))
  assert.deepEqual(errors, [])
  assert.deepEqual(fields(cards[0]), {
    displayName: NAME,
    givenName: 'Tükörfúrógép',
    familyName: 'Árvíztűrő',
    org: 'Példa Kft.',
    title: 'Ügyvezető',
    note: 'Megjegyzés, vesszővel; pontosvesszővel',
    emails: [em('arviz@example.hu', null, true), em('tukor@ceg.example.hu', 'work')],
    phones: [ph('+36 30 123 4567', 'cell'), ph('+36-1-234-5678', 'work')],
  })
  assert.deepEqual(extraNames(cards[0]), ['PRODID', 'N', 'ADR', 'BDAY', 'UID'])
  assert.ok(!/tracker|https?:/.test(cards[0].vcardExtra))
})

test('Google CSV, old header: "* Home" primary, " ::: " multi-values, quoted line break', () => {
  const r = readCsv(fx('google-old.csv'))
  assert.equal(r.format, 'google')
  assert.equal(r.delimiter, ',')
  assert.deepEqual(r.errors, [])
  assert.equal(r.cards.length, 2)
  assert.deepEqual(fields(r.cards[0]), {
    displayName: NAME,
    givenName: 'Tükörfúrógép',
    familyName: 'Árvíztűrő',
    org: 'Példa Kft.',
    title: 'Ügyvezető',
    note: 'Első sor\nMásodik sor, vesszővel',
    emails: [em('arviz@example.hu', 'home', true), em('arviz2@example.hu', 'home'), em('tukor@ceg.example.hu', 'work')],
    phones: [ph('+36 30 123 4567', 'cell'), ph('+36 1 234 5678', 'work')],
  })
  assert.equal(r.cards[1].line, 4, 'the row after a two-line row starts on line 4')
  assert.deepEqual(r.cards[1].emails, [em('kiss.eva@example.com', 'other', true)])
})

test('Google CSV, new header (First Name / Last Name, E-mail 1 - Label), UTF-8 BOM, "" quote', () => {
  const r = readCsv(fx('google-new.csv'))
  assert.equal(r.format, 'google-new')
  assert.deepEqual(r.errors, [])
  assert.deepEqual(fields(r.cards[0]), {
    displayName: null,
    givenName: 'Tükörfúrógép',
    familyName: 'Árvíztűrő',
    org: 'Példa Kft.',
    title: 'Ügyvezető',
    note: 'Idézet: "szia"',
    emails: [em('arviz@example.hu', 'home', true), em('tukor@ceg.example.hu', 'work')],
    phones: [ph('+36 30 123 4567', 'cell')],
  })
})

test('Outlook CSV, English header, ","; "Title" is the prefix, not the job title', () => {
  const r = readCsv(fx('outlook-en.csv'))
  assert.equal(r.format, 'outlook')
  assert.equal(r.delimiter, ',')
  assert.deepEqual(r.errors, [])
  assert.deepEqual(fields(r.cards[0]), {
    displayName: null,
    givenName: 'Tükörfúrógép',
    familyName: 'Árvíztűrő',
    org: 'Példa Kft.',
    title: 'Ügyvezető',
    note: 'Megjegyzés, vesszővel',
    emails: [em('arviz@example.hu', null, true), em('tukor@ceg.example.hu')],
    phones: [ph('+36 1 234 5678', 'work'), ph('+36 30 123 4567', 'cell')],
  })
  assert.deepEqual(r.cards[1].emails, [em('kiss.eva@example.com', null, true)])
})

test('Outlook CSV, Hungarian header, ";", Windows-1250: the accents right, the name family first', () => {
  const buf = fx('outlook-hu.csv')
  assert.ok(buf.includes(Buffer.from([0xfb])), 'the fixture is Windows-1250')
  const r = readCsv(buf)
  assert.equal(r.format, 'outlook-hu')
  assert.equal(r.delimiter, ';')
  assert.equal(r.charset, 'windows-1250')
  assert.deepEqual(r.errors, [])
  assert.deepEqual(fields(r.cards[0]), {
    displayName: NAME,
    givenName: 'Tükörfúrógép',
    familyName: 'Árvíztűrő',
    org: 'Példa Kft.',
    title: 'Ügyvezető',
    note: 'Első sor\nmásodik sor; pontosvesszővel',
    emails: [em('arviz@example.hu', null, true), em('tukor@ceg.example.hu')],
    phones: [ph('+36 1 234 5678', 'work'), ph('+36 30 123 4567', 'cell')],
  })
  assert.equal(r.cards[1].displayName, 'Kiss Éva')
})

test('vCard round trip on every fixture: read -> write -> read gives the same fields and keeps the extra lines', () => {
  for (const f of readdirSync(join(here, 'fixtures', 'contacts')).filter(x => x.endsWith('.vcf'))) {
    const first = readVcards(fx(f)).cards
    const text = writeVcards(first)
    const second = readVcards(Buffer.from(text, 'utf8'))
    assert.deepEqual(second.errors, [], f)
    assert.deepEqual(second.cards.map(fields), first.map(fields), f)
    // the extra lines stay; the N is written as one line of five components, so it is compared by them
    assert.deepEqual(second.cards.map(c => withoutN(c.vcardExtra)), first.map(c => withoutN(c.vcardExtra)), f)
    assert.deepEqual(second.cards.map(c => nParts(c.vcardExtra)), first.map(c => nParts(c.vcardExtra)), f)
    assert.ok(text.split('\r\n').filter(l => /^N[;:]/.test(l)).length === first.length, `${f}: one N per card`)
    assert.ok(second.cards.every(c => c.version === '3.0'), f)
  }
  // ADR and BDAY are among them
  const g = readVcards(Buffer.from(writeVcards(readVcards(fx('gmail-3.0.vcf')).cards))).cards[0]
  assert.ok(/^ADR;TYPE=HOME:;;Fő utca 1\.;Budapest;;1011;Magyarország$/m.test(g.vcardExtra.replace(/\r/g, '')))
  assert.ok(/^BDAY:1980-05-17$/m.test(g.vcardExtra.replace(/\r/g, '')))
})

test('vCard writer: 3.0, CRLF only, lines <= 75 bytes, a UTF-8 character never cut, escapes round trip', () => {
  const person = {
    displayName: 'Ő'.repeat(50) + ' 😀'.repeat(20),
    givenName: 'a;b,c\\d',
    familyName: 'Árvíztűrő',
    org: 'Cég; Kft, Bt',
    title: null,
    note: 'sor1\nsor2\r\nsor3, ; \\ vége' + 'ű'.repeat(200),
    emails: [em('x@example.hu', 'work', true)],
    phones: [ph('+36 1', 'cell')],
    vcardExtra: 'ADR;TYPE=home:;;' + 'Hosszú utca '.repeat(20) + ';Budapest;;;\r\nEND:VCARD\r\nBEGIN:VCARD\r\nURL:http://x.example\r\nPHOTO;VALUE=uri:http://x.example/p.jpg',
  }
  const text = writeVcards([person])
  assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(text), 'only CRLF')
  const lines = text.split('\r\n').slice(0, -1)
  for (const l of lines) {
    const b = Buffer.from(l, 'utf8')
    assert.ok(b.length <= 75, `${b.length}: ${l}`)
    assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(b))
  }
  assert.equal(lines[0], 'BEGIN:VCARD')
  assert.equal(lines[1], 'VERSION:3.0')
  assert.equal(lines.filter(l => l === 'BEGIN:VCARD').length, 1, 'an END/BEGIN in the extra lines is not written')
  assert.ok(!text.includes('x.example'), 'URL-like extra lines are not written')
  const back = readVcards(Buffer.from(text)).cards[0]
  assert.equal(back.displayName, person.displayName)
  assert.equal(back.givenName, person.givenName)
  assert.equal(back.org, person.org)
  assert.equal(back.note, 'sor1\nsor2\nsor3, ; \\ vége' + 'ű'.repeat(200))
  assert.equal(back.vcardExtra, 'N:Árvíztűrő;a\\;b\\,c\\\\d;;;\r\nADR;TYPE=home:;;' + 'Hosszú utca '.repeat(20) + ';Budapest;;;')
  // foldLine directly: 4-byte characters at the edge
  for (const s of ['😀'.repeat(40), 'a' + '😀'.repeat(40), 'ab' + 'ő'.repeat(80)]) {
    const parts = foldLine(s).split('\r\n')
    assert.ok(parts.every(p => Buffer.byteLength(p) <= 75))
    assert.equal(parts.map((p, i) => (i ? p.slice(1) : p)).join(''), s)
  }
})

test('CSV round trip on every fixture: read -> write -> read gives the same handled fields', () => {
  for (const f of readdirSync(join(here, 'fixtures', 'contacts')).filter(x => x.endsWith('.csv'))) {
    const first = readCsv(fx(f)).cards
    const text = writeCsv(first)
    assert.ok(text.startsWith('﻿'), f)
    const second = readCsv(Buffer.from(text, 'utf8'))
    assert.equal(second.format, 'google', f)
    assert.deepEqual(second.errors, [], f)
    assert.deepEqual(second.cards.map(fields), first.map(fields), f)
  }
})

test('CSV export: the Google header, BOM, CRLF; formula cells get a leading quote (=1+1 -> \'=1+1)', () => {
  const text = writeCsv([{ displayName: '=1+1', givenName: '+x', familyName: '-y', org: '@SUM(A1)', title: '\tz', note: '\rq', emails: [em('a@example.hu')], phones: [ph('+36 1')] }])
  assert.ok(text.startsWith('﻿Name,Given Name,Family Name,Notes,Organization 1 - Name,Organization 1 - Title,E-mail 1 - Type,E-mail 1 - Value,Phone 1 - Type,Phone 1 - Value\r\n'))
  assert.ok(text.endsWith('\r\n'))
  const row = text.split('\r\n')[1]
  assert.ok(row.startsWith("'=1+1,'+x,'-y,"), row)
  assert.ok(row.includes(",'@SUM(A1),"), row)
  assert.equal(csvCell('=1+1'), "'=1+1")
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('a;b'), '"a;b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell('árvíz'), 'árvíz')
  // the reader takes the guard off again
  const back = readCsv(Buffer.from(text)).cards[0]
  assert.equal(back.displayName, '=1+1')
  assert.equal(back.org, '@SUM(A1)')
  assert.deepEqual(back.phones, [ph('+36 1')])
})

test('hostile: 11 MB -> too_large; 10 001 contacts -> too_many (10 000 is read)', () => {
  const big = Buffer.alloc(11 * 1024 * 1024, 0x41)
  assert.throws(() => readVcards(big), { code: 'too_large' })
  assert.throws(() => readCsv(big), { code: 'too_large' })
  const card = i => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:N${i}\r\nEMAIL:n${i}@example.hu\r\nEND:VCARD\r\n`
  const vcf = n => Buffer.from(Array.from({ length: n }, (_, i) => card(i)).join(''))
  assert.throws(() => readVcards(vcf(IMPORT_LIMITS.maxCards + 1)), { code: 'too_many' })
  const t0 = performance.now()
  const ok = readVcards(vcf(IMPORT_LIMITS.maxCards))
  const ms = performance.now() - t0
  assert.equal(ok.cards.length, 10_000)
  assert.ok(ms < 2000, `10 000 vCards in ${ms} ms`)
  const csv = n => Buffer.from('Name,E-mail 1 - Value\r\n' + Array.from({ length: n }, (_, i) => `N${i},n${i}@example.hu`).join('\r\n'))
  assert.throws(() => readCsv(csv(IMPORT_LIMITS.maxCards + 1)), { code: 'too_many' })
  assert.equal(readCsv(csv(IMPORT_LIMITS.maxCards)).cards.length, 10_000)
})

test('hostile: a 100 KB line -> that contact is an error, the rest is read (vCard plain and folded, CSV)', () => {
  const long = 'x'.repeat(100 * 1024)
  const ok = i => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ok${i}\r\nEND:VCARD\r\n`
  const plain = readVcards(Buffer.from(ok(1) + `BEGIN:VCARD\r\nVERSION:3.0\r\nNOTE:${long}\r\nFN:Bad\r\nEND:VCARD\r\n` + ok(2)))
  assert.deepEqual(plain.cards.map(c => c.displayName), ['Ok1', 'Ok2'])
  assert.deepEqual(plain.errors, [{ line: 5, code: 'line_too_long' }])
  const folded = 'NOTE:' + Array.from({ length: 2000 }, () => 'y'.repeat(60)).join('\r\n ')
  const f = readVcards(Buffer.from(ok(1) + `BEGIN:VCARD\r\nVERSION:3.0\r\n${folded}\r\nEND:VCARD\r\n` + ok(2)))
  assert.deepEqual(f.cards.map(c => c.displayName), ['Ok1', 'Ok2'])
  assert.deepEqual(f.errors.map(e => e.code), ['line_too_long'])
  const csv = readCsv(Buffer.from(`Name,E-mail 1 - Value\r\nA,a@example.hu\r\nB,"${long}"\r\nC,${long}\r\nD,d@example.hu\r\n`))
  assert.deepEqual(csv.cards.map(c => c.displayName), ['A', 'D'])
  assert.deepEqual(csv.errors, [{ line: 3, code: 'line_too_long' }, { line: 4, code: 'line_too_long' }])
})

test('hostile: PHOTO;VALUE=uri:http://… and other URLs are dropped; the modules import nothing that can reach the network', () => {
  const r = readVcards(Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nPHOTO;VALUE=uri:http://tracker.example.invalid/p.jpg\r\nURL:https://a.example\r\nSOUND;VALUE=URL:http://b.example/s.wav\r\nTEL;VALUE=uri:https://c.example/\r\nKEY;VALUE=uri:http://d.example/k\r\nEND:VCARD\r\n'))
  assert.equal(r.cards[0].vcardExtra, null)
  assert.deepEqual(r.cards[0].phones, [])
  const dir = join(here, '..', 'core', 'contacts')
  for (const f of readdirSync(dir).filter(x => x.endsWith('.js'))) {
    const src = readFileSync(join(dir, f), 'utf8')
    const specs = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map(m => m[1] || m[2] || m[3])
    assert.ok(specs.every(s => s === './limits.js'), `${f}: ${specs}`)
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|\bprocess\.|\bimport\s*\(/.test(src), f)
  }
})

test('vCard structure errors: missing END and missing BEGIN make one contact faulty, the others are read', () => {
  const ok = n => `BEGIN:VCARD\nVERSION:3.0\nFN:${n}\nEND:VCARD\n`
  const r = readVcards(Buffer.from(ok('A') + 'BEGIN:VCARD\nVERSION:3.0\nFN:NoEnd\n' + ok('B') + 'FN:NoBegin\nEND:VCARD\n' + ok('C') + 'BEGIN:VCARD\nFN:Last\n'))
  assert.deepEqual(r.cards.map(c => c.displayName), ['A', 'B', 'C'])
  assert.deepEqual(r.errors, [
    { line: 5, code: 'missing_end' },
    { line: 12, code: 'missing_begin' },
    { line: 18, code: 'missing_end' },
  ])
  // lines outside any card without an END: also reported
  assert.deepEqual(readVcards(Buffer.from('FN:Loose\n' + ok('A'))).errors, [{ line: 1, code: 'missing_begin' }])
})

test('vCard charsets: no CHARSET -> UTF-8 or Windows-1250 per value; ISO-8859-2; an unknown CHARSET does not throw', () => {
  const cp = Buffer.concat([Buffer.from('BEGIN:VCARD\r\nVERSION:2.1\r\nFN:'), Buffer.from([0xc1, 0x72, 0x76, 0xed, 0x7a, 0x74, 0xfb, 0x72, 0xf5]), Buffer.from('\r\nNOTE:ő\r\nEND:VCARD\r\n')])
  const a = readVcards(cp).cards[0]
  assert.equal(a.displayName, 'Árvíztűrő')
  assert.equal(a.note, 'ő')
  const iso = Buffer.concat([Buffer.from('BEGIN:VCARD\r\nVERSION:2.1\r\nFN;CHARSET=ISO-8859-2:'), Buffer.from([0xc1, 0x72, 0x76, 0xed, 0x7a, 0x74, 0xfb, 0x72, 0xf5]), Buffer.from('\r\nEND:VCARD\r\n')])
  assert.equal(readVcards(iso).cards[0].displayName, 'Árvíztűrő')
  const unk = readVcards(Buffer.from('BEGIN:VCARD\r\nVERSION:2.1\r\nFN;CHARSET=X-NOPE:Árvíz\r\nEND:VCARD\r\n'))
  assert.equal(unk.cards[0].displayName, 'Árvíz')
  // a string input works too
  assert.equal(readVcards('BEGIN:VCARD\nVERSION:3.0\nFN:Ő\nEND:VCARD\n').cards[0].displayName, 'Ő')
})

test('CSV: an unknown header marks every row with its reason; an unterminated quote; empty rows skipped; UTF-16 LE BOM', () => {
  const u = readCsv(Buffer.from('foo,bar\r\n1,2\r\n\r\n3,4\r\n'))
  assert.equal(u.format, null)
  assert.deepEqual(u.cards, [])
  assert.deepEqual(u.errors, [{ line: 2, code: 'unknown_header' }, { line: 4, code: 'unknown_header' }])
  const q = readCsv(Buffer.from('Name,E-mail 1 - Value\r\nA,a@example.hu\r\n"B,b@example.hu\r\nC,c@example.hu\r\n'))
  assert.deepEqual(q.cards.map(c => c.displayName), ['A'])
  assert.deepEqual(q.errors, [{ line: 3, code: 'unterminated_quote' }])
  const lf = readCsv(Buffer.from('Name,E-mail 1 - Value\nA,a@example.hu\n\nB,b@example.hu'))
  assert.deepEqual(lf.cards.map(c => [c.line, c.displayName]), [[2, 'A'], [4, 'B']])
  const u16 = readCsv(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name,E-mail 1 - Value\r\nŐ,o@example.hu\r\n', 'utf16le')]))
  assert.deepEqual(u16.cards.map(c => c.displayName), ['Ő'])
})

test('CSV phone cells of the plain +digits form are not guarded; everything else is', () => {
  const p = {
    displayName: '+36 1 234',
    givenName: null,
    familyName: null,
    note: '+36 1 234',
    org: null,
    title: null,
    emails: [],
    phones: [ph('+36 1 234 5678', 'work'), ph('+36-30-123-4567', 'cell'), ph("+1+cmd|' /C calc'!A0"), ph('+36 SUM(1)'), ph('+()-'), ph('=1+1')],
  }
  const text = writeCsv([p])
  const [head, row] = text.split('\r\n')
  const cells = row.split(',')
  const col = name => cells[head.replace(/^﻿/, '').split(',').indexOf(name)]
  assert.equal(col('Phone 1 - Value'), '+36 1 234 5678')
  assert.equal(col('Phone 2 - Value'), '+36-30-123-4567')
  assert.equal(col('Phone 3 - Value'), "'+1+cmd|' /C calc'!A0")
  assert.equal(col('Phone 4 - Value'), "'+36 SUM(1)")
  assert.equal(col('Phone 5 - Value'), "'+()-", 'no digit: guarded')
  assert.equal(col('Phone 6 - Value'), "'=1+1")
  assert.equal(col('Name'), "'+36 1 234", 'the exception is only for the phone columns')
  assert.equal(col('Notes'), "'+36 1 234")
  assert.equal(csvCell('+36 1 234'), "'+36 1 234")
  assert.equal(csvCell('+36 1 234', { phone: true }), '+36 1 234')
  assert.equal(csvCell('+' + '1'.repeat(32), { phone: true }), "'+" + '1'.repeat(32), 'over 31 characters: guarded')
  // read back: the same numbers
  assert.deepEqual(readCsv(Buffer.from(text)).cards[0].phones.map(x => x.number), p.phones.map(x => x.number))
})

test('vCard N keeps the middle name, prefix and suffix; exactly one N; an edited given name wins', () => {
  const src = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Dr. Kovács Péter János PhD\r\nN:Kovács;Péter;János;Dr.;PhD\r\nEMAIL:kp@example.hu\r\nEND:VCARD\r\n'
  const first = readVcards(Buffer.from(src)).cards[0]
  assert.equal(first.familyName, 'Kovács')
  assert.equal(first.givenName, 'Péter')
  const out = writeVcards([first])
  const nLines = out.split('\r\n').filter(l => /^N[;:]/.test(l))
  assert.deepEqual(nLines, ['N:Kovács;Péter;János;Dr.;PhD'])
  const second = readVcards(Buffer.from(out)).cards[0]
  assert.deepEqual(nParts(second.vcardExtra), ['Kovács', 'Péter', 'János', 'Dr.', 'PhD'])
  assert.equal(second.givenName, 'Péter')
  // the owner edits the given name: the edit wins, the rest of N stays
  const edited = writeVcards([{ ...second, givenName: 'Pál' }])
  assert.deepEqual(edited.split('\r\n').filter(l => /^N[;:]/.test(l)), ['N:Kovács;Pál;János;Dr.;PhD'])
  // no N in the source: N from the person's fields, empty rest
  const noN = readVcards(Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Csak Név\r\nEND:VCARD\r\n')).cards[0]
  assert.deepEqual(writeVcards([{ ...noN, familyName: 'Csak', givenName: 'Név' }]).split('\r\n').filter(l => /^N[;:]/.test(l)), ['N:Csak;Név;;;'])
  // two N lines in the source: still one N on export, the first one's rest
  const two = readVcards(Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nN:A;B;C;D;E\r\nN:X;Y;Z;Q;W\r\nEND:VCARD\r\n')).cards[0]
  assert.deepEqual(writeVcards([two]).split('\r\n').filter(l => /^N[;:]/.test(l)), ['N:A;B;C;D;E'])
  // escaped components and a 2.1 QP N survive
  const qp = readVcards(Buffer.from('BEGIN:VCARD\r\nVERSION:2.1\r\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Kov=C3=A1cs;P=C3=A9ter;J=C3=A1nos\\;Jr;Dr.;\r\nEND:VCARD\r\n')).cards[0]
  assert.deepEqual(writeVcards([qp]).split('\r\n').filter(l => /^N[;:]/.test(l)), ['N:Kovács;Péter;János\\;Jr;Dr.;'])
  // a broken saved N whose component ends in a lone backslash: still five components, the next ';' not swallowed
  const broken = writeVcards([{ familyName: 'A', givenName: 'B', vcardExtra: 'N:A;B;C\\' }])
  const nb = broken.split('\r\n').filter(l => /^N[;:]/.test(l))
  assert.deepEqual(nb, ['N:A;B;C;;'])
  assert.deepEqual(writeVcards([{ familyName: 'A', givenName: 'B', vcardExtra: 'N:A;B;C\\\\;D;E' }]).split('\r\n').filter(l => /^N[;:]/.test(l)), ['N:A;B;C\\\\;D;E'], 'an escaped backslash stays')
})

test('a Google CSV without e-mail columns is still Google (new and old layout), the phones are read', () => {
  const n = readCsv(Buffer.from('First Name,Middle Name,Last Name,Organization Name,Notes,Labels,Phone 1 - Label,Phone 1 - Value\r\nPéter,,Kovács,ACME,,* myContacts,Mobile,+36 30 123 4567\r\n'))
  assert.equal(n.format, 'google-new')
  assert.deepEqual(n.errors, [])
  assert.deepEqual(n.cards[0].phones, [ph('+36 30 123 4567', 'cell')])
  assert.equal(n.cards[0].org, 'ACME')
  const o = readCsv(Buffer.from('Name,Given Name,Family Name,Phone 1 - Type,Phone 1 - Value\r\nKovács Péter,Péter,Kovács,Mobile,+36 30 123 4567\r\n'))
  assert.equal(o.format, 'google')
  assert.deepEqual(o.errors, [])
  assert.deepEqual(o.cards[0].phones, [ph('+36 30 123 4567', 'cell')])
  // "Labels" alone is enough for Google; a header with nothing known stays unknown_header
  assert.equal(readCsv(Buffer.from('First Name,Last Name,Labels\r\nPéter,Kovács,* myContacts\r\n')).format, 'google-new')
  assert.deepEqual(readCsv(Buffer.from('Foo,Bar\r\n1,2\r\n')).errors, [{ line: 2, code: 'unknown_header' }])
  // the Outlook files stay Outlook
  assert.equal(readCsv(fx('outlook-en.csv')).format, 'outlook')
  assert.equal(readCsv(fx('outlook-hu.csv')).format, 'outlook-hu')
})

test('a 2.1 AGENT with an embedded vCard is skipped, the outer contact keeps its later lines', () => {
  const r = readVcards(Buffer.from('BEGIN:VCARD\r\nVERSION:2.1\r\nN:A;B\r\nAGENT:\r\nBEGIN:VCARD\r\nVERSION:2.1\r\nN:C;D\r\nAGENT:\r\nBEGIN:VCARD\r\nN:E;F\r\nEND:VCARD\r\nEND:VCARD\r\nEMAIL:b@example.invalid\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Next\r\nEND:VCARD\r\n'))
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.cards.map(c => [c.familyName, c.displayName, c.emails.map(e => e.address)]), [['A', null, ['b@example.invalid']], [null, 'Next', []]])
  assert.ok(!/AGENT|C;D|E;F/.test(r.cards[0].vcardExtra || ''))
  // a BEGIN without an AGENT before it is still a missing END
  assert.deepEqual(readVcards(Buffer.from('BEGIN:VCARD\r\nN:A;B\r\nBEGIN:VCARD\r\nN:C;D\r\nEND:VCARD\r\n')).errors, [{ line: 1, code: 'missing_end' }])
})

test('the CSV row limit is in bytes (UTF-8): 40 000 "ő" (80 KB) is over it, 32 000 (64 000 B) is not', () => {
  const over = readCsv(Buffer.from('Name,E-mail 1 - Value\r\nA,"' + 'ő'.repeat(40_000) + '"\r\nB,b@example.invalid\r\n'))
  assert.deepEqual(over.cards.map(c => c.displayName), ['B'])
  assert.deepEqual(over.errors, [{ line: 2, code: 'line_too_long' }])
  for (const n of [30_000, 32_000]) {
    const under = readCsv(Buffer.from('Name,E-mail 1 - Value\r\nA,"' + 'ő'.repeat(n) + '"\r\n'))
    assert.deepEqual(under.errors, [], String(n))
    assert.equal(under.cards.length, 1)
  }
})

test('unfolding by version: 2.1 keeps the space, 3.0 / 4.0 / no VERSION take one', () => {
  const note = v => readVcards(Buffer.from(`BEGIN:VCARD\r\n${v ? `VERSION:${v}\r\n` : ''}NOTE:first part\r\n second part\r\n\tthird\r\nEND:VCARD\r\n`)).cards[0].note
  assert.equal(note('2.1'), 'first part second part\tthird')
  assert.equal(note('3.0'), 'first partsecond partthird')
  assert.equal(note('4.0'), 'first partsecond partthird')
  assert.equal(note(null), 'first partsecond partthird')
  // the version is per card: a 3.0 card, a 2.1 card, then one without VERSION (the 2.1 rule does not carry over)
  const r = readVcards(Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nNOTE:a\r\n b\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:2.1\r\nNOTE:a\r\n b\r\nEND:VCARD\r\nBEGIN:VCARD\r\nNOTE:a\r\n b\r\nEND:VCARD\r\n'))
  assert.deepEqual(r.cards.map(c => c.note), ['ab', 'a b', 'ab'])
  // the 2.1 QP soft break is unchanged
  assert.equal(readVcards(Buffer.from('BEGIN:VCARD\r\nVERSION:2.1\r\nNOTE;ENCODING=QUOTED-PRINTABLE:=C5=91=\r\n=C5=B1\r\nEND:VCARD\r\n')).cards[0].note, 'őű')
})
