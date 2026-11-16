// The interface language: the dictionaries' parity, the i18n module, the language file in the data folder, the
// outgoing quote byte for byte as before (in Hungarian), and the grid: accented text only in the dictionaries.
process.env.TZ = 'Europe/Budapest' // the golden quote dates; set before any formatter is made
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAst } from 'vite'
import { hu } from '../app/renderer/i18n/hu.js'
import { en } from '../app/renderer/i18n/en.js'
import * as i18n from '../app/renderer/i18n/index.js'
import { LANGUAGES, LOCALES, languageOf } from '../core/ui-language.js'
import { readLanguage, writeLanguage, UI_FILE } from '../core/ui-language-file.js'
import { quoteHtml, forwardHtml } from '../core/smtp/compose.js'
import { tempDir } from './helpers/tmp.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// --- parity ---------------------------------------------------------------------------------------------------------

/** Every difference of keys and types between two dictionaries, as readable lines (a function: its parameter count). */
export function parityProblems(a, b, where = '') {
  const out = []
  const kind = v => (typeof v === 'function' ? `function/${v.length}` : Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const p = where ? `${where}.${k}` : k
    if (!(k in a)) out.push(`${p}: only in the second`)
    else if (!(k in b)) out.push(`${p}: only in the first`)
    else if (kind(a[k]) !== kind(b[k])) out.push(`${p}: ${kind(a[k])} vs ${kind(b[k])}`)
    else if (kind(a[k]) === 'object') out.push(...parityProblems(a[k], b[k], p))
  }
  return out
}

test('en and hu: the same keys, nested too, with the same types; a function has the same parameter count', () => {
  assert.deepEqual(parityProblems(hu, en), [])
  assert.ok(Object.keys(hu).length > 250) // top-level keys; the nested ones are compared too
})

test('the parity check itself: a missing key, a type change and a parameter count are found', () => {
  const { contacts, ...noContacts } = en
  assert.deepEqual(parityProblems(hu, noContacts), ['contacts: only in the first'])
  assert.deepEqual(parityProblems(hu, { ...en, appTitle: () => 'x' }), ['appTitle: string vs function/0'])
  assert.deepEqual(parityProblems(hu, { ...en, listCount: (n, x) => n + x }), ['listCount: function/1 vs function/2'])
  assert.deepEqual(parityProblems(hu, { ...en, outgoingQuote: { ...en.outgoingQuote, labels: { ...en.outgoingQuote.labels, cc: undefined } } }), ['outgoingQuote.labels.cc: string vs undefined'])
})

// --- the module and the language file -------------------------------------------------------------------------------

test('the i18n module: Hungarian without a language from the preload; setLanguage switches t, lang and locale (live)', () => {
  assert.deepEqual([...LANGUAGES], ['hu', 'en'])
  assert.equal(i18n.lang, 'hu')
  assert.equal(i18n.t, hu)
  assert.equal(i18n.locale, 'hu-HU')
  assert.equal(i18n.setLanguage('en'), 'en')
  assert.equal(i18n.t, en)
  assert.equal(i18n.locale, 'en-GB')
  assert.equal(i18n.setLanguage('fr'), 'hu') // unknown: the default
  assert.equal(i18n.t, hu)
  assert.deepEqual({ ...LOCALES }, { hu: 'hu-HU', en: 'en-GB' })
  for (const v of [undefined, null, '', 'HU', 'en-GB', 1, {}]) assert.equal(languageOf(v), 'hu')
})

test('the language file: missing, damaged, unknown -> hu; hu and en as written; written atomically, nothing left over', t => {
  const dir = tempDir(t)
  const file = path.join(dir, UI_FILE)
  assert.equal(readLanguage(dir), 'hu') // no file
  assert.equal(readLanguage(path.join(dir, 'nincs-ilyen-mappa')), 'hu') // no folder
  for (const [raw, want] of [['{"language":"en"}', 'en'], ['{"language":"hu"}', 'hu'], ['{"language":"de"}', 'hu'], ['{"language":["en"]}', 'hu'], ['{', 'hu'], ['', 'hu'], ['null', 'hu'], ['"en"', 'hu'], ['﻿{"language":"en"}', 'hu']]) {
    fs.writeFileSync(file, raw)
    assert.equal(readLanguage(dir), want, raw)
  }
  fs.rmSync(file)
  fs.mkdirSync(file) // a folder in its place: unreadable
  assert.equal(readLanguage(dir), 'hu')
  fs.rmdirSync(file)
  assert.equal(writeLanguage(dir, 'en'), 'en')
  assert.equal(readLanguage(dir), 'en')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { language: 'en' })
  writeLanguage(dir, 'hu')
  assert.equal(readLanguage(dir), 'hu')
  assert.throws(() => writeLanguage(dir, 'de'), /bad_language/)
  assert.equal(readLanguage(dir), 'hu') // a refused write changes nothing
  assert.deepEqual(fs.readdirSync(dir), [UI_FILE]) // no temporary file left
  assert.throws(() => writeLanguage(path.join(dir, 'nincs'), 'en')) // a missing folder: an error, not a silent pass
})

// --- the outgoing quote, byte for byte as before ----------------------------------------------------------------------

const long = Array.from({ length: 6 }, (_, i) => `${i}. sor: ${'árvíztűrő tükörfúrógép '.repeat(60)}`).join('\n')
const ORIGINALS = {
  full: {
    from: [{ name: 'Kovács Ilona', address: 'ilona@example.invalid' }],
    to: [{ name: 'Nagy Péter', address: 'peter@example.invalid' }, { name: '', address: 'masik@example.invalid' }],
    cc: [{ name: 'Szabó, Éva "Évi"', address: 'eva@example.invalid' }],
    date: '2026-03-05T08:07:00Z',
    subject: 'Árvíztűrő <tükör> & fúrógép',
    text: 'első sor\nmásodik <b>sor</b>\r\nharmadik',
  },
  bare: { from: [], to: [], cc: [], date: null, subject: '', html: '<p>hello <b>világ</b></p>' },
  summer: {
    from: [{ name: '', address: 'csak@example.invalid' }],
    to: [{ name: 'X', address: 'x@example.invalid' }],
    date: '2026-07-31T22:30:00Z',
    subject: 'nyári idő',
    text: '',
  },
  long: { from: [{ name: 'Hosszú Levél', address: 'h@example.invalid' }], to: [], date: '2026-11-15T05:00:00Z', subject: 'hosszú', text: long },
}

// made by the code BEFORE the quote's words became a parameter (TZ Europe/Budapest); long ones as sha256 + length
const GOLDEN = {
  "full": {
    "quote": "<p>2026. 03. 05. 09:07, Kovács Ilona &lt;ilona@example.invalid&gt; írta:</p><blockquote><p>első sor<br>második &lt;b&gt;sor&lt;/b&gt;<br>harmadik</p></blockquote>",
    "forward": "<p>-------- Továbbított üzenet --------<br>Feladó: Kovács Ilona &lt;ilona@example.invalid&gt;<br>Dátum: 2026. 03. 05. 09:07<br>Tárgy: Árvíztűrő &lt;tükör&gt; &amp; fúrógép<br>Címzett: Nagy Péter &lt;peter@example.invalid&gt;, masik@example.invalid<br>Másolat: Szabó, Éva &quot;Évi&quot; &lt;eva@example.invalid&gt;</p><p>első sor<br>második &lt;b&gt;sor&lt;/b&gt;<br>harmadik</p>"
  },
  "bare": {
    "quote": "<p> írta:</p><blockquote><p>hello <b>világ</b></p></blockquote>",
    "forward": "<p>-------- Továbbított üzenet --------<br></p><p>hello <b>világ</b></p>"
  },
  "summer": {
    "quote": "<p>2026. 08. 01. 00:30, csak@example.invalid írta:</p><blockquote><p></p></blockquote>",
    "forward": "<p>-------- Továbbított üzenet --------<br>Feladó: csak@example.invalid<br>Dátum: 2026. 08. 01. 00:30<br>Tárgy: nyári idő<br>Címzett: X &lt;x@example.invalid&gt;</p><p></p>"
  },
  "long": {
    "quoteSha": "4cce4011c4a75a11365cc56aac580ba208568e6d1da1c817dec2adb3d21d6b96",
    "quoteLen": 8502,
    "forwardSha": "3af0413321b1304ea94f405e14bfec4ceee673e26be08364f7db623e4917a58e",
    "forwardLen": 8545
  }
}

test('the outgoing reply and forward HTML in Hungarian: byte for byte the output of before', () => {
  const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
  for (const [name, o] of Object.entries(ORIGINALS)) {
    const q = quoteHtml(o, hu.outgoingQuote, 'hu-HU')
    const f = forwardHtml(o, hu.outgoingQuote, 'hu-HU')
    const g = GOLDEN[name]
    if (g.quote !== undefined) {
      assert.equal(q, g.quote, `${name}: quote`)
      assert.equal(f, g.forward, `${name}: forward`)
    } else {
      assert.equal(q.length, g.quoteLen, `${name}: quote length`)
      assert.equal(sha(q), g.quoteSha, `${name}: quote`)
      assert.equal(f.length, g.forwardLen, `${name}: forward length`)
      assert.equal(sha(f), g.forwardSha, `${name}: forward`)
    }
  }
})

test('the outgoing quote takes the given words and locale; without them it refuses', () => {
  const words = { wrote: h => `On ${h} wrote:`, forwarded: '---- Forwarded ----', labels: { from: 'From', date: 'Date', subject: 'Subject', to: 'To', cc: 'Cc' } }
  const o = ORIGINALS.full
  assert.ok(quoteHtml(o, words, 'en-GB').startsWith('<p>On 05/03/2026, 09:07, Kovács Ilona &lt;ilona@example.invalid&gt; wrote:</p><blockquote>'))
  assert.ok(forwardHtml(o, words, 'en-GB').startsWith('<p>---- Forwarded ----<br>From: Kovács Ilona'))
  assert.throws(() => quoteHtml(o), /quote text and locale needed/)
  assert.throws(() => forwardHtml(o, words), /quote text and locale needed/)
})

// --- the grid: accented text only in the dictionaries -----------------------------------------------------------------

// where Hungarian text may stay, and why: the dictionaries; the MCP texts go to Claude, not to the user; the folder
// and the CSV header names are what servers and files contain (recognised, not shown); the released migrations are
// never edited (one SQL comment in a string)
export const GRID_ALLOW = ['app/renderer/i18n/', 'app/main/mcp/', 'core/imap/folders.js', 'core/imap/client.js', 'core/contacts/csv.js', 'core/db/schema.js']
const ACCENT = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/

/** The accented string literals (string, template, JSX text; comments do not count) of the app's code outside the list. */
export function accentedLiterals(root, allow = GRID_ALLOW) {
  const out = []
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const rel = path.relative(root, p).split(path.sep).join('/')
      if (e.isDirectory()) walk(p)
      else if (/\.(m?js|cjs|jsx)$/.test(e.name) && !allow.some(a => (a.endsWith('/') ? rel.startsWith(a) : rel === a))) {
        const code = fs.readFileSync(p, 'utf8')
        const ast = parseAst(code, { lang: e.name.endsWith('.jsx') ? 'jsx' : 'js', sourceType: e.name.endsWith('.cjs') ? 'script' : 'module' }, p)
        ;(function visit(n) {
          if (!n || typeof n !== 'object') return
          if (Array.isArray(n)) return n.forEach(visit)
          const v = n.type === 'Literal' && typeof n.value === 'string' ? n.value : n.type === 'JSXText' ? n.value : n.type === 'TemplateElement' ? n.value.cooked : null
          if (v && ACCENT.test(v)) out.push(`${rel}:${code.slice(0, n.start).split('\n').length}: ${JSON.stringify(v.trim().slice(0, 60))}`)
          for (const k in n) if (typeof n[k] === 'object') visit(n[k])
        })(ast)
      }
    }
  }
  for (const d of ['app', 'core']) walk(path.join(root, d))
  return out
}

test('the grid: no accented text literal in the app outside the dictionaries (and the listed exceptions)', () => {
  assert.deepEqual(accentedLiterals(repo), [])
})

test('the grid check itself: a literal, a template and JSX text are found, a comment is not', t => {
  const dir = tempDir(t)
  fs.mkdirSync(path.join(dir, 'app', 'renderer', 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'core'))
  fs.writeFileSync(path.join(dir, 'app', 'renderer', 'src', 'X.jsx'), "// árvíztűrő\nconst a = 'Mentés'\nconst b = `${a} kész: ${1}`\nexport const C = () => <p title=\"Tükör\">Fúró</p>\n")
  assert.deepEqual(accentedLiterals(dir), ['app/renderer/src/X.jsx:2: "Mentés"', 'app/renderer/src/X.jsx:3: "kész:"', 'app/renderer/src/X.jsx:4: "Tükör"', 'app/renderer/src/X.jsx:4: "Fúró"'])
})

test("no 'hu-HU' in the interface code: the formatters take the locale", () => {
  const hits = []
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(m?js|cjs|jsx)$/.test(e.name) && /['"`]hu-HU['"`]/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(repo, p))
    }
  }
  for (const d of ['app/renderer/src', 'app/main', 'core/smtp']) walk(path.join(repo, d))
  assert.deepEqual(hits, [])
})
