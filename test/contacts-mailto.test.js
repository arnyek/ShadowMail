// SPDX-License-Identifier: GPL-3.0-or-later
// The address links of the contact details: a middle or Shift+click lets the browser open the link itself, and the
// composer reads it with parseMailto. The whole address is one recipient, whatever its local part holds (an import
// lets "?", "&", "," and "%" through): no second recipient, no Cc, subject or body. The unencoded link of before
// would have done exactly that (checked below as the control).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'
import { parseMailto } from '../core/smtp/compose.js'

setupDom()
const person = {
  id: 1, displayName: 'Furcsa', givenName: '', familyName: '', org: '', title: '', note: '', source: 'import',
  emails: [{ address: 'x?to=valaki%40pelda.invalid%2C@y.invalid', label: '', isPrimary: true }, { address: 'a,b&cc=c@d.invalid', label: '', isPrimary: false }],
  phones: [],
}
window.shadowMail = {
  contacts: {
    list: async () => ({ ok: true, items: [{ id: 1, name: 'Furcsa', address: person.emails[0].address, source: 'import' }], total: 1 }),
    get: async () => ({ ok: true, person }),
  },
  compose: { open: async () => ({ ok: true }) },
}
const { createElement: h } = await import('react')
const { Contacts, mailtoHref } = await import('../app/renderer/src/Contacts.jsx')
const wait = ms => new Promise(r => setTimeout(r, ms))

const ODD = [
  'x?to=valaki%40pelda.invalid%2C@y.invalid',
  'a,b&cc=c@d.invalid',
  'q?subject=Hi&body=pay%20now@x.invalid',
  'per%25cent@x.invalid',
  '"quoted local"@example.invalid',
  'kovacs.anna@example.invalid',
]

test('mailtoHref: parseMailto reads back exactly the one address, nothing else', () => {
  for (const address of ODD) {
    const m = parseMailto(mailtoHref(address))
    assert.deepEqual(m, { to: address, cc: '', subject: '', body: '' }, address)
  }
})

test('control: the unencoded link of before opens with another recipient or fields', () => {
  // the "?" and "%" ones (a comma alone stays in the path, but the composer would read it as two recipients)
  const risky = [ODD[0], ODD[2], ODD[3]]
  const bad = risky.filter(address => {
    const m = parseMailto(`mailto:${address}`)
    return !m || m.to !== address || m.cc || m.subject || m.body
  })
  assert.deepEqual(bad, risky, 'each of them was misread before')
})

test('the details: every address link carries the encoded href', async t => {
  const v = await mount(h(Contacts))
  t.after(v.unmount)
  await inAct(() => wait(50))
  v.container.querySelector('.contact-item').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await inAct(() => wait(50))
  const links = [...v.container.querySelectorAll('.contact-email a')]
  assert.deepEqual(links.map(a => a.getAttribute('href')), person.emails.map(e => mailtoHref(e.address)))
  assert.deepEqual(links.map(a => a.textContent), person.emails.map(e => e.address), 'the text is the plain address')
})
