// SPDX-License-Identifier: GPL-3.0-or-later
// A test whose result rests on core/mime/visible-text.js's wall-clock net (TIME_LIMIT_MS, 1500 ms): on a loaded machine
// (`npm test` runs its files in parallel) the honest work on the 404 KB newsletter passes the net, the text comes back
// empty and the visible word is not found. The product keeps the net (a CPU-time net is a later card); the test tells a
// loaded machine from a broken build: after a failure it times the same extraction once, and runs the scenario again
// ONLY if that took over LOADED_MS. On a quiet machine the first failure is thrown at once, so a real regression (the
// visible text never found) still fails.
import { visibleTextInfo } from '../../core/mime/visible-text.js'
import { newsletterHtml } from './newsletter.js'

export const LOADED_MS = 1000 // the extraction on a quiet machine: 0.7-0.8 s, the net 1500

/** The wall-clock time of one visible-text extraction of the 404 KB newsletter now. */
export function extractionMs(html = newsletterHtml({ blocks: 2000 })) {
  const t0 = performance.now()
  visibleTextInfo(html)
  return performance.now() - t0
}

/**
 * Runs `run(attempt)`; on a failure, again only while the machine measures as loaded, at most `tries` runs in all.
 * @param t        the node:test context (its diagnostic tells every retry and why)
 * @param measure  () => ms of the calibration (injectable for the helper's own test)
 */
export async function retryWhenLoaded(t, run, { tries = 3, measure = extractionMs } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(attempt)
    } catch (err) {
      if (attempt >= tries) throw err
      const ms = measure()
      if (ms < LOADED_MS) throw err
      t.diagnostic(`attempt ${attempt} failed on a loaded machine (the newsletter's extraction took ${Math.round(ms)} ms): again`)
    }
  }
}
