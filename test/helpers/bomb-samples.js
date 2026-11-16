// the sample messages of the measurements (test/tools/bomb-measure.mjs on Linux, test/e2e/
// bomb-package-measure.mjs on the Windows package). Generated (no word of a real message), written as .eml files.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { newsletterHtml } from './newsletter.js'

const cp = n => String.fromCodePoint(n)
export const PATTERNS = Object.freeze({ heb: cp(0x5d0), emoji: cp(0x1f600) })
export const fill = (unit, bytes) => unit.repeat(Math.floor(bytes / Buffer.byteLength(unit)))

export function writer(dir, date = new Date().toUTCString()) {
  return (name, type, body) =>
    fs.writeFileSync(path.join(dir, name), Buffer.concat([Buffer.from(`From: Bomba <bomba@example.invalid>\r\nTo: v1-to@example.invalid\r\nSubject: Bomba ${name}\r\nDate: ${date}\r\nMessage-ID: <${name}@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`), Buffer.from(body)]))
}

/** (c) the normal messages: [file, description]. A big image newsletter (50 cid: images), a long HTML, a long plain text, a short one. */
export function writeNormal(dir, date = new Date().toUTCString()) {
  const eml = writer(dir, date)
  const img = i => crypto.randomBytes(18_000 + (i % 7) * 1000).toString('base64').replace(/.{76}/g, '$&\r\n')
  const cids = Array.from({ length: 50 }, (_, i) => `<p><img src="cid:kep${i}@v1" width="600"> Termék ${i}: rövid leírás a képhez.</p>`).join('')
  const related = [`--R\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n<html><body>${newsletterHtml({ blocks: 1500, rules: 40 })}${cids}</body></html>\r\n`]
  for (let i = 0; i < 50; i++) related.push(`--R\r\nContent-Type: image/jpeg\r\nContent-ID: <kep${i}@v1>\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\n${img(i)}\r\n`)
  fs.writeFileSync(path.join(dir, 'c-newsletter.eml'), Buffer.from(`From: Hirlevel <h@example.invalid>\r\nTo: v1-to@example.invalid\r\nSubject: Bomba c-newsletter\r\nDate: ${date}\r\nMessage-ID: <c-newsletter@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="R"\r\n\r\n${related.join('')}--R--\r\n`, 'utf8'))
  eml('c-long-html.eml', 'text/html', `<html><body>${newsletterHtml({ blocks: 3000, rules: 20 })}</body></html>`)
  eml('c-long-plain.eml', 'text/plain', Array.from({ length: 8000 }, (_, i) => (i % 12 === 0 ? '' : `Ez a(z) ${i}. sor egy hosszú, valódi szerkezetű sima szöveges levélben.`)).join('\r\n'))
  eml('c-short.eml', 'text/plain', 'Szia, holnap 10-kor jó?\r\nÜdv')
  return [['c-newsletter.eml', 'generated image newsletter'], ['c-long-html.eml', 'generated long HTML'], ['c-long-plain.eml', 'generated long plain text'], ['c-short.eml', 'generated short']]
}

/** (d) the 2 MB plain text samples (Hebrew, emoji): [file, description]. */
export function writeR3(dir, date = new Date().toUTCString()) {
  const eml = writer(dir, date)
  const MB2 = 2 * 1024 * 1024
  return Object.entries(PATTERNS).map(([k, ch]) => {
    eml(`p-${k}-2m.eml`, 'text/plain', fill(`x${ch}`, MB2))
    return [`p-${k}-2m.eml`, `2 MB plain ${k}`]
  })
}

/**
 * (f) the Hebrew one-paragraph HTML with EXACTLY `chars` characters (code points; the shape check still lets
 * SHAPE_LIMIT through): Válasz only. -> [[file, description, modes]]
 */
export function writeAtLimit(dir, chars, date = new Date().toUTCString()) {
  const eml = writer(dir, date)
  const name = `f-heb-${chars}.eml`
  eml(name, 'text/html', `<p>${`x${PATTERNS.heb}`.repeat(chars / 2)}</p>`)
  return [[name, `Hebrew one paragraph, ${chars} characters (N)`, ['reply']]]
}

/**
 * The "news" table: a real-looking newsletter of 400 table rows, spaced words in the cells,
 * no p / div / br: after sanitizeCompose the cells are gone and all the text is one block. ~134 000 characters. Normal mail:
 * no question.
 */
export function newsTableHtml(rows = 400) {
  const words = ['Heti', 'hírek:', 'az', 'új', 'termékek', 'ára', 'csökkent,', 'a', 'raktár', 'nyitva', 'tart', 'szombaton', 'is;', 'részletek', 'a', 'honlapon.']
  const cell = (r, c) => Array.from({ length: 18 }, (_, i) => words[(r * 3 + c + i) % words.length]).join(' ')
  return `<table>${Array.from({ length: rows }, (_, r) => `<tr><td>${cell(r, 0)}</td><td>${cell(r, 1)}</td><td>${cell(r, 2)}</td></tr>`).join('')}</table>`
}

/** (e) images: 50 cid: images; one 10 MB data: image; 200 small data: images (the HTML of each is short). */
export function writeImages(dir, date = new Date().toUTCString()) {
  const head = name => `From: Bomba <bomba@example.invalid>\r\nTo: v1-to@example.invalid\r\nSubject: Bomba ${name}\r\nDate: ${date}\r\nMessage-ID: <${name}@example.invalid>\r\nMIME-Version: 1.0\r\n`
  const b64 = n => crypto.randomBytes(n).toString('base64')
  const parts = [`--R\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Ötven kép:</p>${Array.from({ length: 50 }, (_, i) => `<img src="cid:k${i}@v1">`).join('')}\r\n`]
  for (let i = 0; i < 50; i++) parts.push(`--R\r\nContent-Type: image/png\r\nContent-ID: <k${i}@v1>\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(20_000).replace(/.{76}/g, '$&\r\n')}\r\n`)
  fs.writeFileSync(path.join(dir, 'e-cid50.eml'), Buffer.from(`${head('e-cid50')}Content-Type: multipart/related; boundary="R"\r\n\r\n${parts.join('')}--R--\r\n`))
  fs.writeFileSync(path.join(dir, 'e-data10m.eml'), Buffer.from(`${head('e-data10m')}Content-Type: text/html; charset=utf-8\r\n\r\n<p>Egy nagy kép:</p><img src="data:image/png;base64,${b64(7_500_000)}"><p>vége</p>\r\n`))
  fs.writeFileSync(path.join(dir, 'e-data200.eml'), Buffer.from(`${head('e-data200')}Content-Type: text/html; charset=utf-8\r\n\r\n<p>Kétszáz kis kép:</p>${Array.from({ length: 200 }, () => `<img src="data:image/png;base64,${b64(1500)}">`).join('')}\r\n`))
  return [['e-cid50.eml', '50 cid: images'], ['e-data10m.eml', 'one 10 MB data: image'], ['e-data200.eml', '200 small data: images']]
}

// B: paragraphs that change their bidi direction class at (almost) every character, with an EXACT number of switches as
// the shape check counts them (app/renderer/src/compose-shape.js; test/compose-shape.test.js checks this helper against
// it). Words of 10 characters, spaced (a space is neutral: no switch, and no run over N).
//   HL Latin x and Hebrew alef; AL Latin x and Arabic alef; HD Hebrew alef and an ASCII digit; HN Hebrew alef and an
//   Arabic-Indic digit; BI a Latin letter in an RLI ... PDI isolate (an isolate is +2 on its own: four switches a letter)
const RLI = cp(0x2067)
const PDI = cp(0x2069)
const SWITCH_CYCLES = Object.freeze({
  HL: [['x', 'L'], [cp(0x5d0), 'R']],
  AL: [['x', 'L'], [cp(0x627), 'R']],
  HD: [[cp(0x5d0), 'R'], ['7', 'EN']],
  HN: [[cp(0x5d0), 'R'], [cp(0x663), 'AN']],
  BI: [[RLI, 'I'], ['a', 'L'], [PDI, 'I']],
})
export const SWITCH_KINDS = Object.freeze(Object.keys(SWITCH_CYCLES))
/** The text of `kind` with exactly `switches` direction switches. */
export function switchText(kind, switches) {
  const cycle = SWITCH_CYCLES[kind]
  const out = []
  let last = null
  let count = 0
  let inWord = 0
  for (let i = 0; ; i++) {
    const [ch, cls] = cycle[i % cycle.length]
    // an isolate is +2 on its own and passed over in the class sequence (compose-shape.js ISOLATE_WEIGHT)
    const adds = cls === 'I' ? 2 : last !== null && cls !== last ? 1 : 0
    if (count + adds > switches) break
    if (inWord === 10) {
      out.push(' ')
      inWord = 0
    }
    out.push(ch)
    inWord++
    count += adds
    if (cls !== 'I') last = cls
    if (count === switches && adds) break
  }
  // isolates step by two: one short (an odd count of isolate letters) ends in a letter of the other direction
  if (count === switches - 1) {
    if (last === null) out.push('a')
    out.push(last === 'R' ? 'a' : cp(0x5d0))
    count++
  }
  if (count !== switches) throw new Error(`switchText ${kind}: ${count} of ${switches}`)
  return out.join('')
}

// characters a hand-made class list passed over as neutral (or took for R), which let a 128 000-character bomb through to
// the watchdog: each pair alternates in spaced 10-character words (pairText). The check must ask for every one.
export const BYPASS_PAIRS = Object.freeze({
  RLM: ['a', cp(0x200f)],
  LRM: [cp(0x5d0), cp(0x200e)],
  SUP: [cp(0x5d0), cp(0xb2)],
  CIRC: [cp(0x5d0), cp(0x24b6)],
  MC: [cp(0x5d0), cp(0x903)],
  AN600: [cp(0x5d0), cp(0x600)],
  AN66B: [cp(0x5d0), cp(0x66b)],
  EN6F0: [cp(0x5d0), cp(0x6f0)],
  DANDA: [cp(0x5d0), cp(0x964)],
  // a Garay digit (Unicode 16, unassigned in the table's 15.0) with Hebrew; a digit in an RLE ... PDF after a Latin letter
  GARAY: [cp(0x5d0), cp(0x10d40)],
  RLEDIG: ['a', `${cp(0x202b)}1${cp(0x202c)}`],
})
/** `chars` characters (code points) of the pair [a, b] alternating, in spaced 10-character words. */
export function pairText([a, b], chars) {
  const word = `${a}${b}`.repeat(5)
  const out = []
  let n = 0
  while (n < chars) {
    out.push(word)
    n += 11
  }
  return [...out.join(' ')].slice(0, chars).join('')
}
// Latin letters and ASCII digits alternating: cheap (an EN after L is L, no switch); the same with a Hebrew letter: an EN
// after R stays EN, a switch at every character
export const DIGIT_PAIRS = Object.freeze({ LATIN: ['a', '1'], HEBREW: [cp(0x5d0), '1'] })
