// SPDX-License-Identifier: GPL-3.0-or-later
// The recovery code: 25 characters of Crockford base32 (125 random bits), shown in five
// groups of five: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX. Typing it, case, spaces and hyphens do not matter,
// I and L read as 1, O as 0. The program never stores the code, only the vault slot it opens.
import crypto from 'node:crypto'

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // no I, L, O, U
export const CODE_CHARS = 25
const GROUP = 5

/** A new code, grouped for display. */
export function generateRecoveryCode() {
  const bytes = crypto.randomBytes(16) // 128 bits, the top 125 are used
  let bits = 0n
  for (const b of bytes) bits = (bits << 8n) | BigInt(b)
  bits >>= 3n
  let out = ''
  for (let i = CODE_CHARS - 1; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)]
  return groupCode(out)
}

export function groupCode(code) {
  return code.match(new RegExp(`.{1,${GROUP}}`, 'g')).join('-')
}

/** The canonical 25 characters of a typed code, or null when it cannot be one. */
export function normalizeRecoveryCode(input) {
  if (typeof input !== 'string' || input.length > 200) return null
  const s = input
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
  if (s.length !== CODE_CHARS) return null
  for (const c of s) if (!CROCKFORD.includes(c)) return null
  return s
}

/** One typed group of the code (the code screen's check): 5 characters, the same tolerance; or null. */
export function normalizeRecoveryGroup(input) {
  if (typeof input !== 'string' || input.length > 40) return null
  const s = input.normalize('NFKC').toUpperCase().replace(/[\s-]+/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  if (s.length !== GROUP) return null
  for (const c of s) if (!CROCKFORD.includes(c)) return null
  return s
}
