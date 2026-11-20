// The label group's form by the width of the row's text cell (0.17.0): the three thresholds stand in app.css's
// @container conditions (a var() cannot) and in label-chips.js LABEL_FIT; this checks the two agree and the form rule.
// 52, not 44: 1 dot + "+3" is 26 px, so the subject keeps half of the cell from 52 px on (the planner's decision).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { LABEL_FIT, labelFit } from '../app/renderer/src/label-chips.js'

const css = fs.readFileSync(new URL('../app/renderer/src/app.css', import.meta.url), 'utf8')

test('the @container msg-text conditions of app.css are exactly LABEL_FIT (240 / 90 / 52), each once', () => {
  const found = [...css.matchAll(/@container\s+msg-text\s*\(\s*width\s*<\s*(\d+)px\s*\)/g)].map(m => Number(m[1]))
  assert.deepEqual(found, [LABEL_FIT.chips, LABEL_FIT.dots, LABEL_FIT.dot])
  assert.deepEqual(LABEL_FIT, { chips: 240, dots: 90, dot: 52 })
  assert.match(css, /\.col-main \{[^}]*container: msg-text \/ inline-size;/, 'the labels, subject and preview box of the list row and the search hit')
})

test('labelFit: the form for a cell width, at and around each threshold', () => {
  const cases = [[0, 'none'], [44, 'none'], [51, 'none'], [51.9, 'none'], [52, 'dot'], [89, 'dot'], [90, 'dots'], [239, 'dots'], [240, 'chips'], [600, 'chips']]
  for (const [w, form] of cases) assert.equal(labelFit(w), form, String(w))
})
