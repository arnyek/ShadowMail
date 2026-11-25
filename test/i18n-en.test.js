// The English dictionary: every function key evaluated with 0, 1, 2 and 1000 (and, where it takes a code, with every code
// of its table and an unknown one) gives a finished English text: a string, no undefined / NaN / [object …], no Hungarian
// accented letter, the noun after a number in the right number (1 message, 2 messages). The sample table covers EVERY
// function key, so a new key without samples is red. The same samples run on hu.js too (only: a string, nothing undefined).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hu } from '../app/renderer/i18n/hu.js'
import { en } from '../app/renderer/i18n/en.js'
import { SAMPLES, NS } from './helpers/i18n-samples.js'

/** Every function key of a dictionary, as a path, with the function. */
function functions(dict) {
  const out = []
  ;(function walk(o, path) {
    for (const [k, v] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k
      if (typeof v === 'function') out.push([p, v])
      else if (v && typeof v === 'object') walk(v, p)
    }
  })(dict, '')
  return out
}

// a noun after a number: [singular, plural]
const NOUNS = [
  ['message', 'messages'], ['contact', 'contacts'], ['character', 'characters'], ['draft', 'drafts'], ['result', 'results'],
  ['folder', 'folders'], ['link', 'links'], ['request', 'requests'], ['address', 'addresses'], ['second', 'seconds'],
  ['invisible character', 'invisible characters'], ['control character', 'control characters'], ['new result', 'new results'],
]
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** What is wrong with an English text made for the number n (null when nothing). */
export function englishProblem(text, n) {
  if (typeof text !== 'string') return `not a string: ${typeof text}`
  if (/undefined|NaN|\[object |\bnull\b/.test(text)) return `a missing value: ${text}`
  if (/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/.test(text)) return `a Hungarian letter: ${text}`
  if (typeof n === 'number') {
    const shown = n.toLocaleString('en-GB')
    for (const [one, many] of NOUNS) {
      if (n === 1 && new RegExp(`(^|[\\s(])1 (more )?${esc(many)}\\b`).test(text)) return `"${one}" should be singular after 1: ${text}`
      if (n !== 1 && new RegExp(`(^|[\\s(])${esc(shown)} (more )?${esc(one)}\\b`).test(text)) return `"${many}" should be plural after ${shown}: ${text}`
    }
  }
  return null
}

test('the sample table covers every function key of the English dictionary, and nothing else', () => {
  const keys = functions(en).map(([p]) => p).sort()
  assert.deepEqual(Object.keys(SAMPLES).sort(), keys)
  assert.equal(keys.length, 148)
})

test('every function key with 0, 1, 2 and 1000 (and every code): finished English, the right number', () => {
  const problems = []
  let calls = 0
  for (const [path, fn] of functions(en)) {
    for (const n of NS) {
      for (const args of SAMPLES[path](n)) {
        calls++
        let text
        try {
          text = fn(...args)
        } catch (e) {
          problems.push(`${path}(${JSON.stringify(args)}): throws ${e.message}`)
          continue
        }
        // the number check always runs: a code's text has no number, so it cannot trip it
        const p = englishProblem(text, n)
        if (p) problems.push(`${path}(${JSON.stringify(args)}): ${p}`)
      }
    }
  }
  assert.deepEqual(problems, [])
  assert.ok(calls > 1000, `${calls} calls`)
})

test('the same samples on the Hungarian dictionary: a string every time, nothing undefined', () => {
  const problems = []
  for (const [path, fn] of functions(hu)) {
    for (const n of NS) {
      for (const args of SAMPLES[path](n)) {
        const text = fn(...args)
        if (typeof text !== 'string' || /undefined|NaN|\[object /.test(text)) problems.push(`${path}(${JSON.stringify(args)}): ${text}`)
      }
    }
  }
  assert.deepEqual(problems, [])
})

test('the plural check itself: a wrong number is found', () => {
  assert.match(englishProblem('2 message', 2), /plural/)
  assert.match(englishProblem('1 messages', 1), /singular/)
  assert.match(englishProblem('1,000 contact deleted.', 1000), /plural/)
  assert.match(englishProblem('… and 1 more requests', 1), /singular/)
  assert.match(englishProblem('A levél', null), /Hungarian/)
  assert.match(englishProblem('x undefined', null), /missing/)
  assert.equal(englishProblem('2 addresses', 2), null)
  assert.equal(englishProblem('1 address', 1), null)
})

test('a search is not retried: neither dictionary leaves its "retrying" ending on the search text', () => {
  for (const code of Object.keys(en.syncErrors)) {
    assert.doesNotMatch(en.searchError(code), /retrying/, code)
    assert.doesNotMatch(hu.searchError(code), /újrapróbálom/, code)
  }
  assert.match(en.syncError('timeout'), /retrying…$/) // the sync itself does say it
})

test('English sizes and dates: a decimal point, day/month/year', () => {
  assert.equal(en.sizeKb(2.5 * 1024 * 1024), '2.5 MB')
  assert.equal(hu.sizeKb(2.5 * 1024 * 1024), '2,5 MB')
  assert.equal(en.searchDateRange('2026-03-05', '2026-04-01'), '05/03/2026 – 01/04/2026')
  assert.equal(en.listCount(1000), '1,000 messages')
  assert.equal(en.listCount(1), '1 message')
})

test('en.js holds no Hungarian accented letter at all (text values, comments and code alike)', async () => {
  const fs = await import('node:fs')
  const text = fs.readFileSync(new URL('../app/renderer/i18n/en.js', import.meta.url), 'utf8')
  const hits = text.split('\n').flatMap((l, i) => (/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/.test(l) ? [`${i + 1}: ${l.trim()}`] : []))
  assert.deepEqual(hits, [])
  // and every plain text value of the dictionary (the deep walk: nothing hides in a nested table)
  const strings = []
  ;(function walk(o, p) {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string') strings.push([`${p}${k}`, v])
      else if (v && typeof v === 'object') walk(v, `${p}${k}.`)
    }
  })(en, '')
  assert.ok(strings.length > 550)
  assert.deepEqual(strings.filter(([, v]) => englishProblem(v, null)), [])
})

test('the reset word and the outgoing quote in English', () => {
  assert.equal(en.resetConfirmWord, 'DELETE')
  assert.match(en.vaultResetConfirmLabel, /DELETE$/)
  assert.match(en.vaultErrors.confirm_word, /DELETE$/)
  assert.equal(en.outgoingQuote.wrote('05/03/2026, 09:07, Anna <a@example.invalid>'), '05/03/2026, 09:07, Anna <a@example.invalid> wrote:')
  assert.deepEqual(Object.keys(en.outgoingQuote.labels), Object.keys(hu.outgoingQuote.labels))
})

// --- the review table (docs/i18n-review.csv) ---------------------------------------------------------------------------

/** RFC 4180 with ";": rows of cells (quoted cells may hold ";", quotes and line breaks). */
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ';') {
      row.push(cell)
      cell = ''
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else cell += c
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

test('the review table is up to date, opens in Excel (BOM, ";", CRLF, quoting) and has every key, a function twice', async () => {
  const { reviewCsv, REVIEW_FILE } = await import('../scripts/i18n-review.mjs')
  const fs = await import('node:fs')
  const file = fs.readFileSync(REVIEW_FILE, 'utf8')
  assert.equal(file, reviewCsv(), 'run node scripts/i18n-review.mjs')
  assert.ok(file.startsWith('﻿kulcs;magyar;angol\r\n'))
  const rows = parseCsv(file.slice(1))
  assert.ok(rows.every(r => r.length === 3), 'three cells in every row')
  const keys = new Set(rows.slice(1).map(r => r[0]))
  const want = []
  ;(function walk(o, p) {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k
      if (typeof v === 'function') want.push(`${key} (1)`, `${key} (2)`)
      else if (v && typeof v === 'object') walk(v, key)
      else want.push(key)
    }
  })(hu, '')
  assert.deepEqual(want.filter(k => !keys.has(k)), [], 'a key missing from the table')
  assert.equal(rows.length - 1, want.length)
  // a cell Excel would take for a formula is made harmless, a multi-line text survives the quoting
  const row = k => rows.find(r => r[0] === k)
  assert.equal(row('outgoingQuote.forwarded')[2], "'---------- Forwarded message ----------")
  assert.equal(row('recoveryFileText (1)')[2], en.recoveryFileText(...SAMPLES.recoveryFileText(1)[0]))
  assert.equal(row('listCount (1)')[2], '1 message')
  assert.equal(row('listCount (2)')[1], '2 levél')
})
