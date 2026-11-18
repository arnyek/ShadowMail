// "Küldés később": the quick choices and the custom time in local time (Europe/Budapest here), summer time included.
process.env.TZ = 'Europe/Budapest'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quickTimes, localTime, customDefaults } from '../app/renderer/src/schedule-times.js'

const local = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const show = list => list.map(x => [x.key, new Date(x.at).toString().slice(0, 21)])

test('quick choices: this evening only if a minute ahead; tomorrow 8:00; the next Monday 8:00 (not when it is tomorrow)', () => {
  // Wednesday 2026-11-18 09:00
  assert.deepEqual(show(quickTimes(local(2026, 11, 18, 9))), [
    ['today18', 'Wed Nov 18 2026 18:00'],
    ['tomorrow8', 'Thu Nov 19 2026 08:00'],
    ['monday8', 'Mon Nov 23 2026 08:00'],
  ])
  assert.deepEqual(quickTimes(new Date(2026, 10, 18, 17, 59, 30).getTime()).map(x => x.key), ['tomorrow8', 'monday8'], '17:59:30: 18:00 is under a minute ahead')
  // Sunday: tomorrow is Monday, one choice for it
  assert.deepEqual(show(quickTimes(local(2026, 11, 22, 9))), [['today18', 'Sun Nov 22 2026 18:00'], ['tomorrow8', 'Mon Nov 23 2026 08:00']])
  // Monday: the NEXT Monday
  assert.equal(new Date(quickTimes(local(2026, 11, 23, 9)).find(x => x.key === 'monday8').at).getDate(), 30)
})

test('summer time: 8:00 local on the days of the change is 8:00 on the clock (UTC 6:00 or 7:00)', () => {
  // 2026-03-29: the clock jumps from 2:00 to 3:00; the day before at 9:00, "tomorrow 8:00" is 06:00 UTC
  assert.equal(new Date(quickTimes(local(2026, 3, 28, 9))[1].at).toISOString(), '2026-03-29T06:00:00.000Z')
  // 2026-10-25: back from 3:00 to 2:00; "tomorrow 8:00" is 07:00 UTC
  assert.equal(new Date(quickTimes(local(2026, 10, 24, 9))[1].at).toISOString(), '2026-10-25T07:00:00.000Z')
})

test('the custom time: the inputs\' forms in local time; a day that does not exist or a bad form is null', () => {
  assert.equal(new Date(localTime('2026-11-20', '07:30')).toISOString(), '2026-11-20T06:30:00.000Z')
  assert.equal(new Date(localTime('2026-07-01', '12:00')).toISOString(), '2026-07-01T10:00:00.000Z', 'summer: UTC+2')
  for (const [d, h] of [['2026-11-31', '08:00'], ['2026-02-29', '08:00'], ['2026-13-01', '08:00'], ['2026-11-20', '24:00'], ['2026-11-20', '7:30'], ['20.11.2026', '08:00'], ['', ''], [null, null]]) {
    assert.equal(localTime(d, h), null, `${d} ${h}`)
  }
  assert.deepEqual(customDefaults(local(2026, 12, 31, 22)), { date: '2027-01-01', time: '08:00' })
})
