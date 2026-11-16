// The recovery code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateRecoveryCode, normalizeRecoveryCode, CROCKFORD, CODE_CHARS } from '../core/vault/recovery-code.js'

test('a generated code: 25 Crockford base32 characters in 5 groups of 5; 1000 codes all different', () => {
  const seen = new Set()
  for (let i = 0; i < 1000; i++) {
    const code = generateRecoveryCode()
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/, code)
    assert.equal(code.replace(/-/g, '').length, CODE_CHARS)
    seen.add(code)
  }
  assert.equal(seen.size, 1000)
  assert.equal(CROCKFORD.length, 32)
  for (const c of 'ILOU') assert.ok(!CROCKFORD.includes(c), c)
})

test('typing: case, spaces, hyphens do not matter; I and L read as 1, O as 0', () => {
  const code = 'AB1CD-EF0GH-JK1MN-PQRST-VWXYZ'
  const canon = normalizeRecoveryCode(code)
  assert.equal(canon, 'AB1CDEF0GHJK1MNPQRSTVWXYZ')
  for (const typed of ['ab1cd ef0gh jk1mn pqrst vwxyz', 'ABICD-EFOGH-JKLMN-PQRST-VWXYZ', '  abLcd-ef o gh-jk1mn-pqrst-vwxyz ', 'AB1CDEF0GHJK1MNPQRSTVWXYZ']) {
    assert.equal(normalizeRecoveryCode(typed), canon, typed)
  }
  for (const bad of ['', 'AB1CD-EF0GH-JK1MN-PQRST-VWXY', 'AB1CD-EF0GH-JK1MN-PQRST-VWXYZ1', 'AB1CD-EF0GH-JK1MN-PQRST-VWXYU', null, 42]) {
    assert.equal(normalizeRecoveryCode(bad), null, String(bad))
  }
})
