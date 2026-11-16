#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The bilingual review table of the interface texts: docs/i18n-review.csv, one row per key (in hu.js's order), with the
// Hungarian and the English text side by side. A function key gets two rows, evaluated with 1 and with 2 (the samples of
// test/helpers/i18n-samples.js), so the singular and the plural can both be read.
// For Excel: UTF-8 with a BOM, ";" between the columns (what a Hungarian Excel splits on), CRLF, every cell quoted when it
// holds a ";", a quote or a line break, and a leading = + - @ made harmless with "'" (core/contacts/csv.js csvCell).
//
//   node scripts/i18n-review.mjs           write docs/i18n-review.csv
//   node scripts/i18n-review.mjs --check   exit 1 when the file is not up to date (test/i18n-en.test.js runs this)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hu } from '../app/renderer/i18n/hu.js'
import { en } from '../app/renderer/i18n/en.js'
import { csvCell } from '../core/contacts/csv.js'
import { SAMPLES } from '../test/helpers/i18n-samples.js'

export const REVIEW_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'i18n-review.csv')
const BOM = '﻿'

/** The rows: [key, Hungarian, English], the header first. */
export function reviewRows() {
  const rows = [['kulcs', 'magyar', 'angol']]
  ;(function walk(h, e, p) {
    for (const [k, hv] of Object.entries(h)) {
      const key = p ? `${p}.${k}` : k
      const ev = e[k]
      if (typeof hv === 'function') {
        for (const n of [1, 2]) {
          const args = SAMPLES[key](n)[0]
          rows.push([`${key} (${n})`, hv(...args), ev(...args)])
        }
      } else if (hv && typeof hv === 'object') walk(hv, ev, key)
      else rows.push([key, hv, ev])
    }
  })(hu, en, '')
  return rows
}

export function reviewCsv() {
  return BOM + reviewRows().map(r => r.map(c => csvCell(c)).join(';')).join('\r\n') + '\r\n'
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const text = reviewCsv()
  if (process.argv.includes('--check')) {
    const now = fs.existsSync(REVIEW_FILE) ? fs.readFileSync(REVIEW_FILE, 'utf8') : null
    if (now !== text) {
      console.error('docs/i18n-review.csv is not up to date: run node scripts/i18n-review.mjs')
      process.exit(1)
    }
    console.log('docs/i18n-review.csv is up to date')
  } else {
    fs.writeFileSync(REVIEW_FILE, text, 'utf8')
    console.log(`docs/i18n-review.csv: ${reviewRows().length - 1} rows`)
  }
}
