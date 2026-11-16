// The classic styles are ShadowMail's own drawing: in the theme scope (the theme list, the token and component CSS, the
// icon set, the theme names in both languages) none of the four protected names appears, in any case or spelling
// with spaces or hyphens between the letters. A file format named as such elsewhere (a CSV header, a vCard fixture)
// is not the theme scope.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { THEMES } from '../app/renderer/src/themes.js'
import { hu } from '../app/renderer/i18n/hu.js'
import { en } from '../app/renderer/i18n/en.js'

const FILES = ['app/renderer/src/themes.js', 'app/renderer/src/theme.css', 'app/renderer/src/app.css', 'app/renderer/src/ui/ui.css', 'app/renderer/src/Icon.jsx']
const NAMES = ['microsoft', 'outlook', 'mozilla', 'thunderbird']
// a name with anything that is not a letter or digit between its letters: "Thunder-bird", "out look", "M i c r o s o f t"
const PROTECTED = new RegExp(NAMES.map(n => [...n].join('[^\\p{L}\\p{N}]*')).join('|'), 'iu')

export function protectedNames(text) {
  return text.split('\n').flatMap((line, i) => (PROTECTED.test(line) ? [`${i + 1}: ${line.trim().slice(0, 120)}`] : []))
}

test('the theme scope names none of the protected products', () => {
  const found = FILES.flatMap(f => protectedNames(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).map(l => `${f}:${l}`))
  assert.deepEqual(found, [])
})

test('no theme id, name or setting label in either language names a protected product', () => {
  const texts = [...THEMES.map(t => t.id), ...[hu, en].flatMap(d => [d.themeLabel, ...Object.values(d.themes)])]
  assert.equal(texts.length, THEMES.length + 2 * (1 + THEMES.length), 'every theme has a name in both languages')
  assert.deepEqual(texts.filter(x => PROTECTED.test(x)), [])
})

test('the check itself: the names in any case and with separators are found, ordinary words are not', () => {
  for (const bad of ['Thunderbird', 'thunder-bird', 'OUTLOOK', 'Out look', 'microsoft', 'Mozilla', '/* like Thunderbird */']) {
    assert.ok(PROTECTED.test(bad), bad)
  }
  for (const ok of ['Klasszikus kék', 'Classic light', 'outline', 'look', 'bird', 'border-bottom', '--c-surface']) assert.ok(!PROTECTED.test(ok), ok)
})
