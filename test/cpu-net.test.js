// The visible text's time net counts this thread's CPU time, not the wall clock: on a loaded machine the work waits for
// the CPU and a message that is not complex keeps its search text (until 0.15.0 a 404 KB newsletter of 0.8 s took 3 s
// under load and came out empty). A message that is complex all the same gets ONE quiet retry, later, when the worker
// has nothing else to do.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { visibleTextInfo, threadCpuMs, TIME_LIMIT_MS, WALL_LIMIT_MS } from '../core/mime/visible-text.js'
import { searchResultHere } from '../core/mime/search-text-service.js'
import { createSearchRefiner, createFtsReindex } from '../app/main/search-index.js'
import { newsletterHtml, newsletterEml } from './helpers/newsletter.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}

// enough elements for many net checks (one every 256 styled elements)
const HTML = newsletterHtml({ blocks: 1000, visible: 'lathatoszo', hidden: 'rejtettszo' }) // under the work ceiling (2000 blocks are over it)
// clocks that move by fixed steps per reading: the net's checks are what reads them
const stepClocks = ({ cpu, wall }) => {
  let c = 0
  let w = 0
  return { cpu: () => (cpu === null ? null : (c += cpu)), wall: () => (w += wall) }
}

test('the net: a slow wall clock with little CPU time keeps the text; CPU time over the limit cuts; no CPU clock = the wall clock', () => {
  const plain = visibleTextInfo(HTML)
  assert.equal(plain.cut, null)
  assert.ok(plain.text.includes('lathatoszo') && !plain.text.includes('rejtettszo'))
  const reads = { n: 0 }
  const counting = { cpu: () => (reads.n++, 0), wall: () => 0 }
  visibleTextInfo(HTML, undefined, { clocks: counting })
  assert.ok(reads.n > 20 && reads.n < 150, `the net is read ${reads.n} times on this body`)

  // a loaded machine: 100 ms of wall time between checks (the old wall net cut after 15 of them), 1 ms of CPU; the
  // wall-clock bound (WALL_LIMIT_MS) is 200 checks away
  const loaded = visibleTextInfo(HTML, undefined, { clocks: stepClocks({ cpu: 1, wall: 100 }) })
  assert.equal(loaded.cut, null, 'not cut: the work itself took little CPU time')
  assert.equal(loaded.text, plain.text)
  // really much work: CPU time past the limit
  assert.equal(visibleTextInfo(HTML, undefined, { clocks: stepClocks({ cpu: TIME_LIMIT_MS / 10, wall: 0 }) }).cut, 'complex')
  // a runtime without a thread CPU clock: the wall clock, as before
  assert.equal(visibleTextInfo(HTML, undefined, { clocks: stepClocks({ cpu: null, wall: 200 }) }).cut, 'complex')
  // a thread starved for very long still ends
  assert.equal(visibleTextInfo(HTML, undefined, { clocks: stepClocks({ cpu: 0, wall: WALL_LIMIT_MS / 10 }) }).cut, 'complex')
})

test('threadCpuMs is this thread\'s CPU time: a worker that waits beside a spinning one gains no CPU time, the spinner does', async () => {
  assert.equal(typeof threadCpuMs(), 'number')
  const url = new URL('../core/mime/visible-text.js', import.meta.url).href
  const run = mode =>
    new Promise((resolve, reject) => {
      const w = new Worker(
        `import { threadCpuMs } from ${JSON.stringify(url)}
import { parentPort } from 'node:worker_threads'
const c0 = threadCpuMs(), w0 = Date.now()
if (${JSON.stringify(mode)} === 'wait') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
else while (Date.now() - w0 < 300) {}
parentPort.postMessage({ cpu: threadCpuMs() - c0, wall: Date.now() - w0 })`,
        { eval: true, type: 'module' },
      )
      w.once('message', resolve)
      w.once('error', reject)
    })
  // at the same time: the waiting thread's clock must not count the spinning one's CPU (a process-wide clock would)
  const [waited, spun] = await Promise.all([run('wait'), run('spin')])
  assert.ok(waited.wall >= 290 && waited.cpu < 100, JSON.stringify(waited))
  assert.ok(spun.cpu > 150, JSON.stringify(spun))
})

test('the worker\'s answer says complex: an HTML over the ceiling has no body and complex true; a normal one false', async () => {
  const ok = await searchResultHere(newsletterEml({ blocks: 50, visible: 'lathatoszo' }))
  assert.equal(ok.complex, false)
  assert.ok(ok.text.includes('lathatoszo'))
  // over MAX_MATCH_WORK: distinct rules on an element with many classes (the visible-text suite's ceiling case)
  const classes = Array.from({ length: 12 }, (_, i) => `c${i}`)
  const rules = []
  for (let m = 1; m < 4096; m++) rules.push(`${classes.filter((_, i) => m & (1 << i)).map(c => `.${c}`).join('')}{color:red}`)
  const body = `<style>${rules.join('')}</style>${`<p class="${classes.join(' ')}">x</p>`.repeat(2000)}`
  const eml = Buffer.from(`From: a@example.invalid\r\nSubject: x\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}\r\n`)
  const heavy = await searchResultHere(eml)
  assert.equal(heavy.complex, true)
  assert.equal(heavy.text, '')
})

// a service whose answers the test decides; idle() as the test sets it
function fakeService(answers) {
  const calls = []
  const svc = {
    quiet: true,
    admit: async () => true,
    release() {},
    idle: () => svc.quiet,
    stop() {},
    compute(source, opts) {
      calls.push({ loader: typeof source === 'function', opts })
      return Promise.resolve(answers.shift() ?? { text: 'kesz', preview: null, complex: false })
    },
  }
  return { svc, calls }
}
const fakeIndex = () => {
  const writes = []
  return { writes, setSearchBody: (id, text) => writes.push([id, text]), setLatePreview() {} }
}
const settings = { get: () => null, set() {} }

test('a complex message with a stored source is tried once more when the worker is idle; never twice; a lock drops it', async () => {
  const { svc, calls } = fakeService([{ text: '', preview: null, complex: true }, { text: 'masodszorra', preview: null, complex: false }])
  const index = fakeIndex()
  const logs = []
  const refiner = createSearchRefiner({ service: svc, index, settings, sealed: { readAsync: async () => Buffer.from('x') }, retryDelayMs: 20, log: l => logs.push(l) })
  svc.quiet = false
  await refiner.refine({ id: 7, accountId: 1, local: true, storePath: '1/a.eml' })
  await until(() => index.writes.length === 1)
  assert.deepEqual(index.writes, [[7, '']], 'the empty text is written (the old rule\'s text had the hidden words)')
  assert.deepEqual(refiner.retrying(), [7])
  // busy: the retry waits another round
  await sleep(80)
  assert.equal(calls.length, 1)
  svc.quiet = true
  await until(() => index.writes.length === 2)
  assert.deepEqual(index.writes[1], [7, 'masodszorra'])
  assert.ok(calls[1].loader, 'by its path: no bytes held while it waits')
  assert.deepEqual(logs, ['search text: 1 complex message(s) tried again'])

  // the same id complex again: no third try; a new id is taken
  assert.equal(refiner.retryLater({ id: 7, accountId: 1, storePath: '1/a.eml' }), false)
  assert.equal(refiner.retryLater({ id: 8, accountId: 1, storePath: '1/b.eml' }), true)
  // without a stored source (an IMAP message's bytes only): not taken
  assert.equal(refiner.retryLater({ id: 9, accountId: 1 }), false)
  refiner.stop()
  assert.deepEqual(refiner.retrying(), [])
  await sleep(60)
  assert.equal(calls.length, 2, 'nothing after the lock')
})

test('a retry that is complex again stays empty and is not queued again; a lost retry does not reset the account\'s re-index', async () => {
  const { svc, calls } = fakeService([{ text: '', preview: null, complex: true }, { text: '', preview: null, complex: true }])
  const index = fakeIndex()
  const cleared = []
  const refiner = createSearchRefiner({ service: svc, index, settings: { get: () => null, set: (k, v) => cleared.push([k, v]) }, sealed: { readAsync: async () => Buffer.from('x') }, retryDelayMs: 10 })
  await refiner.refine({ id: 3, accountId: 2, local: true, storePath: '2/c.eml' })
  await until(() => calls.length === 2)
  await sleep(40)
  assert.equal(calls.length, 2)
  assert.deepEqual(refiner.retrying(), [])
  // a retry dropped by a lock (null): the account's flag stays
  const dropping = fakeService([{ text: '', preview: null, complex: true }, null])
  const r2 = createSearchRefiner({ service: dropping.svc, index: fakeIndex(), settings: { get: () => null, set: (k, v) => cleared.push([k, v]) }, sealed: {}, retryDelayMs: 10 })
  await r2.refine({ id: 4, accountId: 5, local: true, storePath: '5/d.eml' })
  await until(() => dropping.calls.length === 2)
  await sleep(20)
  assert.deepEqual(cleared, [])
  r2.stop()
  refiner.stop()
})

test('the re-index hands a complex row to onComplex and goes on', async () => {
  const { svc } = fakeService([{ text: '', preview: null, complex: true }, { text: 'jo', preview: null, complex: false }])
  const rows = [
    { id: 11, date: 2, store_path: '1/x.eml' },
    { id: 12, date: 1, store_path: '1/y.eml' },
  ]
  let served = false
  const index = { ...fakeIndex(), localSourceRows: () => (served ? [] : ((served = true), rows)) }
  const flags = new Map()
  const complex = []
  const reindex = createFtsReindex({ index, store: { list: () => [{ id: 1 }] }, sealed: { readAsync: async () => Buffer.from('x') }, settings: { get: k => flags.get(k), set: (k, v) => flags.set(k, v) }, service: svc, onComplex: item => complex.push(item) })
  assert.equal(await reindex.run(), 2)
  assert.deepEqual(complex, [{ id: 11, accountId: 1, storePath: '1/x.eml' }])
})
