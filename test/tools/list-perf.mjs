#!/usr/bin/env node
// Message list speed in the real app ("10 000 messages, scrolling stays smooth"),
// headless Electron + Playwright. Not part of `npm test`.
//
//   node test/tools/list-perf.mjs [--repo <app checkout>] [--count 10000] [--runs 3] [--filter unread,hasAttachment]
//
// --repo: the checkout whose built renderer (out/renderer) is measured, default this one; the data
// is always seeded with THIS checkout's seed tool (same data for an old and a new build).
// Measures per run: opening the INBOX from another folder (click -> first row), and scrolling the
// whole folder top to bottom by 10 rows per animation frame (frame intervals: median, p95, max,
// frames over 20 ms). Prints one JSON line per run and the medians.
// --filter: also times the filtered folder through the app's own IPC bridge, as the list
// asks for it: mail:list (filtered count + folder count + first page) and mail:ids (the "select all"),
// and the UI: a click on the "Olvasatlan" chip without a search until the filtered list shows.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { repo: { type: 'string' }, count: { type: 'string', default: '10000' }, runs: { type: 'string', default: '3' }, filter: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const repo = path.resolve(values.repo || here)
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-perf-'))
const dataDir = path.join(work, 'data')
const seed = JSON.parse(execFileSync(process.execPath, [path.join(here, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', values.count, '--previews'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))

const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const results = []
for (let run = 0; run < Number(values.runs); run++) {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.locator('#vault-unlock').fill(seed.master)
    await page.getByRole('button', { name: 'Feloldás', exact: true }).click()
    await page.locator('.msg-row[data-id]').first().waitFor()
    await page.locator('.folder[data-path="Sent"]').click()
    await page.waitForTimeout(300)
    const t0 = Date.now()
    await page.locator('.folder[data-path="INBOX"]').click()
    await page.waitForFunction(n => document.querySelectorAll('.msg-row[data-id]').length > 0 && document.querySelector('.msg-canvas')?.style.height && parseFloat(document.querySelector('.msg-canvas').style.height) > n, Number(values.count) * 20)
    const openMs = Date.now() - t0
    const scroll = await page.evaluate(
      () =>
        new Promise(resolve => {
          const el = document.querySelector('.msg-viewport')
          const row = document.querySelector('.msg-row[data-id]').getBoundingClientRect().height
          const step = row * 10
          const times = []
          let last = null
          const tick = ts => {
            if (last !== null) times.push(ts - last)
            last = ts
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1 || times.length > 2000) {
              const s = [...times].sort((a, b) => a - b)
              resolve({ frames: times.length, rowPx: row, median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], over20: times.filter(x => x > 20).length, emptyAtEnd: document.querySelectorAll('.msg-row.loading').length })
              return
            }
            el.scrollTop += step
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }),
    )
    let filtered = {}
    if (values.filter) {
      const filter = Object.fromEntries(values.filter.split(',').map(k => [k, true]))
      filtered = await page.evaluate(async filter => {
        const { accounts } = await window.shadowMail.mail.folders()
        const q = { accountId: accounts[0].id, folder: 'INBOX', sort: 'date', dir: 'desc', offset: 0, limit: 200, filter }
        const listMs = []
        const idsMs = []
        let res, ids
        for (let i = 0; i < 5; i++) {
          let t = performance.now()
          res = await window.shadowMail.mail.list(q)
          listMs.push(performance.now() - t)
          t = performance.now()
          ids = await window.shadowMail.mail.ids({ accountId: q.accountId, folder: q.folder, sort: q.sort, dir: q.dir, filter })
          idsMs.push(performance.now() - t)
        }
        const med = a => [...a].sort((x, y) => x - y)[2]
        return { filterListMs: med(listMs), filterIdsMs: med(idsMs), filterTotal: res.total, folderTotal: res.folderTotal, idsCount: ids.ids.length }
      }, filter)
      for (const k of ['filterListMs', 'filterIdsMs']) filtered[k] = Math.round(filtered[k] * 10) / 10
      // the same from the UI, without a search: a click on the "Olvasatlan" chip until the list shows
      // the filtered count and its first row
      await page.getByRole('button', { name: 'Szűrők', exact: true }).click()
      const chip = page.locator('.search-chips').getByRole('button', { name: 'Olvasatlan', exact: true })
      await chip.waitFor()
      const t1 = Date.now()
      await chip.click()
      await page.waitForFunction(() => document.querySelector('.list-count')?.innerText.includes('szűrve') && document.querySelectorAll('.msg-row.unread[data-id]').length > 0)
      filtered.uiUnreadMs = Date.now() - t1
    }
    const r = { run: run + 1, openMs, ...scroll, ...filtered }
    for (const k of ['median', 'p95', 'max']) r[k] = Math.round(r[k] * 10) / 10
    results.push(r)
    console.log(JSON.stringify(r))
  } finally {
    await app.close().catch(() => {})
  }
}
fs.rmSync(work, { recursive: true, force: true })
const pick = k => median(results.map(r => r[k]))
console.log(JSON.stringify({ repo, count: Number(values.count), runs: results.length, openMs: pick('openMs'), frameMedian: pick('median'), frameP95: pick('p95'), frameMax: pick('max'), over20: pick('over20'), ...(values.filter ? { filter: values.filter, filterListMs: pick('filterListMs'), filterIdsMs: pick('filterIdsMs'), uiUnreadMs: pick('uiUnreadMs'), filterTotal: pick('filterTotal'), folderTotal: pick('folderTotal'), idsCount: pick('idsCount') } : {}) }))
