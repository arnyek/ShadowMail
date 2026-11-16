// The list's date, range and preview format, in the installation's time zone.
process.env.TZ = 'Europe/Budapest'
const { test } = await import('node:test')
const assert = (await import('node:assert/strict')).default
const { formatListDate, formatRange, previewLine, formatFullDate } = await import('../app/renderer/src/list-format.js')

// 2026-11-12 15:30 in Budapest (CET, UTC+1)
const now = new Date(Date.UTC(2026, 10, 12, 14, 30))

test('today: hour:minute (Budapest time, also just after midnight)', () => {
  assert.equal(formatListDate(Date.UTC(2026, 10, 12, 13, 5), now), '14:05')
  assert.equal(formatListDate(Date.UTC(2026, 10, 11, 23, 30), now), '00:30', '23:30 UTC is already the 12th in Budapest')
})

test('this year: "nov. 12." style', () => {
  assert.equal(formatListDate(Date.UTC(2026, 10, 11, 9, 0), now), 'nov. 11.')
  assert.equal(formatListDate(Date.UTC(2026, 2, 5, 9, 0), now), 'márc. 5.')
  assert.equal(formatListDate(Date.UTC(2026, 0, 1, 9, 0), now), 'jan. 1.')
})

test('an older year: "2024. 03. 05."; a future year the same way; no date: empty', () => {
  assert.equal(formatListDate(Date.UTC(2024, 2, 5, 9, 0), now), '2024. 03. 05.')
  assert.equal(formatListDate(Date.UTC(2025, 11, 31, 22, 59), now), '2025. 12. 31.')
  assert.equal(formatListDate(Date.UTC(2025, 11, 31, 23, 30), now), 'jan. 1.', 'UTC new year eve 23:30 is 2026 in Budapest')
  assert.equal(formatListDate(Date.UTC(2027, 0, 2, 9, 0), now), '2027. 01. 02.')
  assert.equal(formatListDate(null, now), '')
  assert.equal(formatListDate(0, now), '')
})

test('range, preview line, tooltip date', () => {
  assert.equal(formatRange(1, 50, 1234), '1–50 / 1234')
  assert.equal(formatRange(1, 50, 12345), '1–50 / 12\u00a0345', 'Hungarian grouping: a no-break space')
  assert.equal(formatRange(0, 0, 0), '0 / 0')
  assert.equal(previewLine('  Kedves\r\n\r\nBence,\tköszönöm  '), 'Kedves Bence, köszönöm')
  assert.equal(previewLine(null), '')
  assert.equal(previewLine(''), '')
  assert.match(formatFullDate(Date.UTC(2026, 10, 12, 13, 5)), /^2026\. november 12\.,? 14:05$/)
})
