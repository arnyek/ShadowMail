// SPDX-License-Identifier: GPL-3.0-or-later
// N, the longest unbroken run of text a composer's starting
// body may have. A Hebrew one-paragraph HTML of 43 686 characters was ready in <= 1.6 s, 54 608 in 2.1 s.
// Here (core/, packaged) and not in the renderer's compose-shape.js, because the MAIN process needs it too (its question)
// and app/renderer/src is not in the package (a package that imported it from there did not start).
export const SHAPE_LIMIT = 40_000

// B: the most direction switches one block may have (app/renderer/src/compose-shape.js counts them). Measured (Linux,
// a spaced <p> changing its bidi class at almost every character): ~58 000 switches took 1.9-2.0 s, twice that ~7 s.
export const SWITCH_LIMIT = 50_000
