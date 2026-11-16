// The search text on a worker thread. The real worker (the hidden text, the same
// text as here), and with a fake worker: no key goes over, the back-pressure bound, stop() (lock) and the restart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { SearchTextService, searchTextHere } from '../core/mime/search-text-service.js'

const FIXTURES = new URL('./fixtures/', import.meta.url)
const HIDDEN = /IGNORE PREVIOUS INSTRUCTIONS|attacker@example\.invalid/i
const sleep = ms => new Promise(r => setTimeout(r, ms))

class FakeWorker extends EventEmitter {
  constructor({ delayMs = 5, answer = m => ({ seq: m.seq, ok: true, text: `t${m.bytes.length}` }) } = {}) {
    super()
    this.posted = []
    this.delayMs = delayMs
    this.answer = answer
    this.terminated = false
  }
  postMessage(msg, transfer) {
    this.posted.push({ msg, transfer })
    if (this.hold) return
    setTimeout(() => !this.terminated && this.emit('message', this.answer(msg)), this.delayMs)
  }
  terminate() {
    this.terminated = true
    return Promise.resolve(0)
  }
}

test('worker: the real worker gives the visible text of the five hiding fixtures, the same as made here', async t => {
  const svc = new SearchTextService()
  t.after(() => svc.stop())
  for (const f of fs.readdirSync(new URL('hostile/', FIXTURES)).filter(x => x.startsWith('injection-'))) {
    const bytes = fs.readFileSync(new URL(`hostile/${f}`, FIXTURES))
    assert.equal(await svc.admit(bytes.length), true)
    const r = await svc.compute(bytes)
    assert.ok(r && r.text.includes('Látható szöveg') && !HIDDEN.test(r.text), f)
    assert.equal(r.text, await searchTextHere(bytes), f)
    const m = await svc.compute(bytes, { kind: 'message' })
    assert.equal(m.text, await searchTextHere(bytes, 'message'), `${f}: message kind`)
  }
  assert.equal(svc.pendingBytes, 0)
})

test('worker: no key goes over: the worker is made without workerData, a message holds only seq, kind and the bytes (transferred)', async t => {
  const made = []
  const svc = new SearchTextService({ createWorker: (...args) => (made.push(args), new FakeWorker()) })
  t.after(() => svc.stop())
  const r = await svc.compute(Buffer.from('From: a\r\n\r\nszöveg\r\n'))
  assert.equal(r.text, `t${Buffer.byteLength('From: a\r\n\r\nszöveg\r\n')}`)
  assert.deepEqual(made, [[]], 'createWorker() with no options')
  const w = svc.worker
  assert.deepEqual(Object.keys(w.posted[0].msg).sort(), ['bytes', 'kind', 'seq'])
  assert.equal(w.posted[0].transfer.length, 1, 'the bytes are transferred, not shared')
  // the real worker's construction in the source: no workerData
  const src = fs.readFileSync(new URL('../core/mime/search-text-service.js', import.meta.url), 'utf8')
  assert.match(src, /createWorker \|\| \(\(\) => new Worker\(workerUrl\)\)/)
  assert.doesNotMatch(src, /workerData/)
})

test('worker: back-pressure: 200 x 400 KB through a 16 MB bound: the waiting bytes never go over it, every message answered', async t => {
  const max = 16 * 1024 * 1024
  let peakSeen = 0
  const svc = new SearchTextService({ maxPendingBytes: max, createWorker: () => new FakeWorker({ delayMs: 1 }) })
  t.after(() => svc.stop())
  const results = []
  for (let i = 0; i < 200; i++) {
    const bytes = Buffer.alloc(400 * 1024, i % 251)
    assert.equal(await svc.admit(bytes.length), true)
    results.push(svc.compute(bytes))
    peakSeen = Math.max(peakSeen, svc.pendingBytes)
  }
  const done = await Promise.all(results)
  assert.ok(done.every(r => r && r.text === `t${400 * 1024}`))
  assert.ok(svc.peakPendingBytes <= max && peakSeen <= max, `${svc.peakPendingBytes}`)
  assert.ok(svc.peakPendingBytes > max / 2, 'the bound was actually reached (the producer waited)')
  // one message bigger than the bound goes alone
  const big = Buffer.alloc(max + 10)
  assert.equal(await svc.admit(big.length), true)
  assert.equal((await svc.compute(big)).text, `t${max + 10}`)
})

test('worker: stop() (lock): the waiting and running messages are dropped (null), their meta returned, the copies zeroed; nothing comes after', async t => {
  const fake = new FakeWorker()
  fake.hold = true // the worker never answers by itself
  const svc = new SearchTextService({ createWorker: () => fake })
  const a = svc.compute(Buffer.from('aaaa'), { meta: { id: 1, accountId: 7, local: true } })
  const b = svc.compute(Buffer.from('bbbb'), { meta: { id: 2, accountId: 8, local: false } })
  const queuedCopy = svc.queue[0].bytes
  const metas = svc.stop()
  assert.deepEqual(metas, [{ id: 1, accountId: 7, local: true }, { id: 2, accountId: 8, local: false }])
  assert.deepEqual(await Promise.all([a, b]), [null, null])
  assert.ok(queuedCopy.every(x => x === 0), 'the waiting copy is zeroed')
  assert.equal(fake.terminated, true)
  assert.equal(svc.pendingBytes, 0)
  // a late answer of the stopped worker is thrown away; a new call gives null at once
  fake.emit('message', { seq: 1, ok: true, text: 'late' })
  assert.equal(await svc.compute(Buffer.from('c')), null)
  assert.equal(await svc.admit(1), false)
})

test('worker: an error skips the message in work (failed: its code) and restarts the worker once; a second error: broken, the rest dropped (null)', async t => {
  const workers = []
  const svc = new SearchTextService({
    createWorker: () => {
      const w = new FakeWorker()
      workers.push(w)
      return w
    },
    log: () => {},
  })
  t.after(() => svc.stop())
  workers.length = 0
  const first = svc.compute(Buffer.from('x1'))
  workers[0].hold = true
  workers[0].emit('error', Object.assign(new Error('boom'), { code: 'ERR_X' }))
  assert.deepEqual(await first, { failed: 'ERR_X' }, 'the message that made the worker fail is skipped, not dropped')
  assert.equal(workers.length, 1, 'restarted lazily')
  const second = await svc.compute(Buffer.from('x22'))
  assert.equal(second.text, 't3')
  assert.equal(workers.length, 2, 'one restart')
  const third = svc.compute(Buffer.from('x333'))
  workers[1].hold = true
  workers[1].emit('error', new Error('again'))
  assert.deepEqual(await third, { failed: 'worker_error' })
  assert.equal(svc.broken, true)
  assert.equal(await svc.compute(Buffer.from('y')), null)
  assert.equal(workers.length, 2, 'no more restarts')
})

test('worker: inline (no worker): the same text, made here', async () => {
  const svc = new SearchTextService({ inline: true })
  const bytes = fs.readFileSync(new URL('hostile/injection-display-none.eml', FIXTURES))
  assert.equal((await svc.compute(bytes)).text, await searchTextHere(bytes))
  svc.stop()
  assert.equal(await svc.compute(bytes), null)
})

test('worker: a local source waits as a loader: read only when the worker takes it, outside the bound; stop and read errors', async t => {
  const calls = []
  const fake = new FakeWorker({ delayMs: 20 })
  const svc = new SearchTextService({ maxPendingBytes: 10, createWorker: () => fake, log: () => {} })
  t.after(() => svc.stop())
  const loader = (name, bytes) => async () => (calls.push(name), Buffer.from(bytes))
  const a = svc.compute(loader('a', 'aaaa'))
  const b = svc.compute(loader('b', 'bbbbbb'))
  assert.equal(svc.pendingBytes, 0, 'a loader takes no room in the bound (nothing waits for it)')
  assert.equal(await svc.admit(1_000_000), true, 'a download never waits because of local sources')
  await sleep(5)
  assert.deepEqual(calls, ['a'], 'b is read only when the worker takes it')
  assert.deepEqual([await a, await b].map(r => r.text), ['t4', 't6'])
  assert.deepEqual(calls, ['a', 'b'])
  // a read error drops only that message
  const bad = svc.compute(async () => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' })
  })
  const good = svc.compute(loader('c', 'ccc'))
  assert.deepEqual(await bad, { failed: 'ENOENT' }, 'an unreadable source: skipped')
  assert.equal((await good).text, 't3')
  // stop while a loader is in work: dropped, the read buffer zeroed
  let read = null
  let release
  const slow = svc.compute(() => new Promise(r => (release = r)))
  await sleep(5)
  svc.stop()
  read = Buffer.from('titok')
  release(read)
  assert.equal(await slow, null)
  await sleep(5)
  assert.ok(read.every(x => x === 0), 'the late read is zeroed, never handed over')
})

test('worker: the worker cannot make a message\'s text (ok: false): { failed: code }, not a drop', async t => {
  const svc = new SearchTextService({ createWorker: () => new FakeWorker({ answer: m => ({ seq: m.seq, ok: false, code: 'EMAXLEN' }) }), log: () => {} })
  t.after(() => svc.stop())
  assert.deepEqual(await svc.compute(Buffer.from('x')), { failed: 'EMAXLEN' })
  // the real worker on a message of 1200 MIME parts (mailsplit allows 1000)
  const real = new SearchTextService({ log: () => {} })
  t.after(() => real.stop())
  const parts = Array.from({ length: 1200 }, (_, i) => `--bb\r\nContent-Type: text/plain\r\n\r\nresz ${i}\r\n`).join('')
  const bytes = Buffer.from(`From: a@example.invalid\r\nSubject: sok resz\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="bb"\r\n\r\n${parts}--bb--\r\n`)
  const r = await real.compute(bytes)
  assert.ok(r && r.failed, JSON.stringify(r))
  // the worker goes on with the next one
  assert.ok((await real.compute(Buffer.from('From: a\r\n\r\nszoveg\r\n'))).text.includes('szoveg'))
})

test('worker: several producers: admit() reserves the room, the bound holds; an unused reservation is released', async t => {
  const max = 4 * 1024 * 1024
  const svc = new SearchTextService({ maxPendingBytes: max, createWorker: () => new FakeWorker({ delayMs: 15 }) })
  t.after(() => svc.stop())
  let peakSeen = 0
  const producer = async n => {
    const out = []
    for (let i = 0; i < n; i++) {
      const bytes = Buffer.alloc(900 * 1024, i)
      assert.equal(await svc.admit(bytes.length), true)
      peakSeen = Math.max(peakSeen, svc.pendingBytes)
      // the gap between the admission and the compute(): another producer runs here
      await sleep(1)
      out.push(svc.compute(bytes))
    }
    return Promise.all(out)
  }
  const all = await Promise.all([producer(8), producer(8), producer(8)])
  assert.ok(all.flat().every(r => r && r.text === `t${900 * 1024}`))
  assert.ok(svc.peakPendingBytes <= max && peakSeen <= max, `peak ${svc.peakPendingBytes}`)
  assert.equal(svc.pendingBytes, 0)
  // a reservation nobody used: released, the room comes back
  assert.equal(await svc.admit(3 * 1024 * 1024), true)
  assert.equal(svc.pendingBytes, 3 * 1024 * 1024)
  svc.release(3 * 1024 * 1024)
  assert.equal(svc.pendingBytes, 0)
})
