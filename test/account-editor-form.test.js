// SPDX-License-Identifier: GPL-3.0-or-later
// The account editor on the shared form base (jsdom): a page header above one card, the sections in order (the folder
// role picker as its own section after the incoming server), no native field or check box left, every #acc-* id of
// the old editor still there, the widths, the new labels with their hints, the no-encryption notice under the
// security control of its own server, the units, the sticky action bar; the saved values and the errors as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'

setupDom()
const saved = []
let nextSave = null
let nextTest = null
const folderRows = [
  { path: 'INBOX', delimiter: '/', special_use: null, is_local: 0, role: 'inbox', role_manual: 0, count: 0, unread: 0 },
  { path: 'Sent', delimiter: '/', special_use: null, is_local: 0, role: 'sent', role_manual: 0, count: 0, unread: 0 },
]
window.shadowMail = {
  accounts: {
    save: async form => {
      saved.push(form)
      return nextSave || { ok: true, account: { id: 7, ...form } }
    },
    test: async () => nextTest || { ok: true, incoming: { ok: true }, smtp: { ok: true } },
    signatureImage: async () => ({ ok: true, image: null }),
  },
  mail: { folders: async () => ({ ok: true, accounts: [{ id: 7, folders: folderRows }] }) },
  folders: { setRole: async () => ({ ok: true }) },
  onStatus: () => () => {},
}
const { createElement: h } = await import('react')
const { AccountEditor } = await import('../app/renderer/src/Accounts.jsx')
const { t } = await import('../app/renderer/i18n/index.js')
const wait = ms => new Promise(r => setTimeout(r, ms))
const click = el => inAct(async () => {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(20)
})
const typeInto = (el, value) => inAct(async () => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
  await wait(10)
})
const submit = form => inAct(async () => {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await wait(20)
})
const A = t.accountForm
const F = t.accountFields
const base = {
  id: 7, name: 'Munka', email: 'a@example.invalid', display_name: '', in_host: 'imap.example.invalid', in_port: 993, in_security: 'tls', in_user: 'u',
  smtp_host: 'smtp.example.invalid', smtp_port: 465, smtp_security: 'tls', smtp_user: '', smtp_same_password: 1, tls_verify: 1, index_years: 3,
  sync_interval_min: 5, save_sent_to_server: 1, pop3_delete_after_days: null, signature: '', archive_mode: '', has_incoming_password: 1, has_smtp_password: 1,
}
const editor = async account => {
  const v = await mount(h(AccountEditor, { account, onSaved() {}, onCancel() {} }))
  await inAct(() => wait(40))
  return v
}
const titles = c => [...c.querySelectorAll('section.form-section > h2.form-section-title')].map(e => e.textContent)
const sectionOf = el => el.closest('section.form-section').querySelector('h2').textContent
const boxOf = (c, id) => c.querySelector(`#${id}`).closest('.text-field')
const ids = c => [...c.querySelectorAll('[id^="acc-"]')].map(e => e.id).filter(id => !/-(label|message|error)$/.test(id)).sort()

// the ids of the editor before the form base (measured on the old editor in jsdom), per state
const OLD_IDS = {
  imap: ['acc-archive_mode', 'acc-display_name', 'acc-email', 'acc-in_host', 'acc-in_password', 'acc-in_port', 'acc-in_security', 'acc-in_user', 'acc-index-help',
    'acc-index_all', 'acc-index_years', 'acc-name', 'acc-role-archive', 'acc-role-drafts', 'acc-role-junk', 'acc-role-sent', 'acc-role-trash', 'acc-save_sent_to_server',
    'acc-signature', 'acc-smtp_host', 'acc-smtp_password', 'acc-smtp_port', 'acc-smtp_same_password', 'acc-smtp_security', 'acc-smtp_user', 'acc-sync_interval_min',
    'acc-tls_verify', 'acc-type'],
  pop3: ['acc-display_name', 'acc-email', 'acc-in_host', 'acc-in_password', 'acc-in_port', 'acc-in_security', 'acc-in_user', 'acc-index-help', 'acc-index_all',
    'acc-index_years', 'acc-name', 'acc-pop3-seen-help', 'acc-pop3_delete_after_days', 'acc-signature', 'acc-smtp_host', 'acc-smtp_port', 'acc-smtp_same_password',
    'acc-smtp_security', 'acc-smtp_user', 'acc-sync_interval_min', 'acc-tls_verify', 'acc-type'],
  new: ['acc-display_name', 'acc-email', 'acc-in_host', 'acc-in_password', 'acc-in_port', 'acc-in_security', 'acc-in_user', 'acc-index-help', 'acc-index_all',
    'acc-index_years', 'acc-name', 'acc-signature', 'acc-smtp_host', 'acc-smtp_port', 'acc-smtp_same_password', 'acc-smtp_security', 'acc-smtp_user',
    'acc-sync_interval_min', 'acc-tls_verify', 'acc-type-imap', 'acc-type-pop3'],
}

test('a saved IMAP account: header, one card, the sections in order, no native field or check box, every old id', async tc => {
  const v = await editor({ ...base, type: 'imap', smtp_same_password: 0 })
  tc.after(v.unmount)
  const c = v.container
  assert.equal(c.querySelector('.page-head h1').textContent, A.editTitle)
  assert.equal(c.querySelector('.page-head .page-sub').textContent, 'Munka · a@example.invalid')
  assert.equal(c.querySelectorAll('form.account-editor').length, 1)
  assert.ok(!c.querySelector('.page-head').closest('form'), 'the header is above the card')
  assert.deepEqual(titles(c), [A.sections.account, A.sections.incomingImap, A.sections.folders, A.sections.smtp, A.sections.sync, A.sections.signature])
  assert.equal(c.querySelectorAll('.check').length, 0, 'no native .check')
  assert.equal(c.querySelectorAll('.field').length, 0, 'no .field')
  assert.equal([...c.querySelectorAll('input[type="checkbox"]')].filter(i => !i.classList.contains('checkbox-input')).length, 0, 'every box is a Checkbox')
  assert.deepEqual(ids(c), OLD_IDS.imap)
  // the fieldset frames are gone (only the folder roles' group remains, without a visible legend)
  assert.deepEqual([...c.querySelectorAll('fieldset')].map(f => f.className), ['folder-roles'])
  assert.ok(c.querySelector('fieldset.folder-roles legend').classList.contains('sr-only'))
})

test('a saved POP3 and a new account keep their old ids; the incoming section names the type', async tc => {
  const p = await editor({ ...base, type: 'pop3', in_port: 995 })
  tc.after(p.unmount)
  assert.deepEqual(ids(p.container), OLD_IDS.pop3)
  assert.deepEqual(titles(p.container), [A.sections.account, A.sections.incomingPop3, A.sections.smtp, A.sections.sync, A.sections.signature])
  const n = await editor(null)
  tc.after(n.unmount)
  assert.deepEqual(ids(n.container), OLD_IDS.new)
  assert.equal(n.container.querySelector('.page-head h1').textContent, t.accountNew)
  assert.equal(n.container.querySelector('.page-head .page-sub'), null)
  assert.equal(titles(n.container)[1], A.sections.incoming, 'no type yet: no type in the title')
  await click(n.container.querySelector('#acc-type-pop3'))
  assert.equal(titles(n.container)[1], A.sections.incomingPop3)
  // the type group is the account section's first element, its options a bold name and a grey line
  const first = n.container.querySelector('section.form-section .form-section-body').firstElementChild
  assert.ok(first.matches('fieldset.account-type'))
  assert.equal(first.querySelector('legend').textContent, F.type)
  assert.deepEqual([...first.querySelectorAll('.account-type-option strong')].map(e => e.textContent), Object.values(t.typeLabels))
})

test('the widths: port xs; name, user, password, selects m; server and address l; the signature full; the pairs in a row', async tc => {
  const v = await editor({ ...base, type: 'imap', smtp_same_password: 0 })
  tc.after(v.unmount)
  const c = v.container
  const width = id => [...boxOf(c, id).classList].find(k => /^w-/.test(k))
  const expect = { 'acc-in_port': 'w-xs', 'acc-smtp_port': 'w-xs', 'acc-name': 'w-m', 'acc-display_name': 'w-m', 'acc-in_user': 'w-m', 'acc-in_password': 'w-m',
    'acc-smtp_user': 'w-m', 'acc-smtp_password': 'w-m', 'acc-in_security': 'w-m', 'acc-smtp_security': 'w-m', 'acc-archive_mode': 'w-m', 'acc-role-sent': 'w-m',
    'acc-in_host': 'w-l', 'acc-smtp_host': 'w-l', 'acc-email': 'w-l', 'acc-signature': 'w-full' }
  for (const [id, w] of Object.entries(expect)) assert.equal(width(id), w, id)
  const rowOf = id => boxOf(c, id).parentElement
  assert.ok(rowOf('acc-in_host').classList.contains('form-row') && rowOf('acc-in_host') === rowOf('acc-in_port'))
  assert.ok(rowOf('acc-in_user') === rowOf('acc-in_password'))
  assert.ok(rowOf('acc-smtp_host') === rowOf('acc-smtp_port'))
  // the number fields with a unit: 96 px inputs by the stylesheet (.with-unit), the unit text after
  assert.equal(c.querySelector('#acc-index_years').closest('.with-unit').querySelector('.unit').textContent, A.yearsUnit)
  assert.equal(c.querySelector('#acc-sync_interval_min').closest('.with-unit').querySelector('.unit').textContent, A.minutesUnit)
})

test('the labels: optional user name with its hint, "Indexelt levelek" + years + All, "Frissítés" + minutes, the type read-only', async tc => {
  const v = await editor({ ...base, type: 'imap' })
  tc.after(v.unmount)
  const c = v.container
  const user = c.querySelector('#acc-smtp_user')
  assert.equal(user.labels[0].querySelector('.text-field-label').textContent, `${A.smtpUser} ${t.optionalField}`)
  assert.equal(document.getElementById(user.getAttribute('aria-describedby')).textContent, A.smtpUserHint)
  assert.equal(c.querySelector('label[for="acc-index_years"]').textContent, A.indexYears)
  assert.equal(c.querySelector('#acc-index_all').labels[0].textContent, A.indexAll)
  assert.match(c.querySelector('#acc-index_years').getAttribute('aria-describedby'), /\bacc-index-help\b/)
  assert.equal(c.querySelector('label[for="acc-sync_interval_min"]').textContent, A.syncInterval)
  const type = c.querySelector('#acc-type')
  assert.equal(type.getAttribute('aria-readonly'), 'true')
  assert.equal(type.textContent, t.typeLabels.imap)
  assert.equal(document.getElementById(type.getAttribute('aria-describedby')).textContent, A.typeLocked)
  assert.equal(c.querySelector('select, button.select-trigger[disabled]#acc-type'), null, 'no greyed-out menu')
})

test('the no-encryption notice: right under the security control of its own server, and only when that side has none', async tc => {
  const notices = c => [...c.querySelectorAll('.field-notice')].map(n => [sectionOf(n), n.previousElementSibling.querySelector('.select-trigger')?.id])
  const both = await editor({ ...base, type: 'imap', in_security: 'none', smtp_security: 'none' })
  tc.after(both.unmount)
  assert.deepEqual(notices(both.container), [[A.sections.incomingImap, 'acc-in_security'], [A.sections.smtp, 'acc-smtp_security']])
  assert.ok([...both.container.querySelectorAll('.field-notice')].every(n => n.textContent === t.noSecurityWarning))
  const smtpOnly = await editor({ ...base, type: 'imap', smtp_security: 'none' })
  tc.after(smtpOnly.unmount)
  assert.deepEqual(notices(smtpOnly.container), [[A.sections.smtp, 'acc-smtp_security']])
  const none = await editor({ ...base, type: 'imap' })
  tc.after(none.unmount)
  assert.deepEqual(notices(none.container), [])
  // the certificate warning as before: only with the check off
  assert.equal(none.container.querySelector('.danger'), null)
  await click(none.container.querySelector('#acc-tls_verify'))
  assert.equal(none.container.querySelector('.danger').textContent, t.tlsVerifyOffWarning)
})

test('the sticky action bar: Save (primary), Cancel (text), the connection test on the right (outlined)', async tc => {
  const v = await editor({ ...base, type: 'imap' })
  tc.after(v.unmount)
  const bar = v.container.querySelector('form.account-editor > .form-actions.form-actions-sticky')
  assert.ok(bar, 'the bar is the last part of the form card')
  assert.equal(v.container.querySelector('form.account-editor').lastElementChild, bar)
  assert.deepEqual([...bar.children].map(e => (e.tagName === 'BUTTON' ? `${e.textContent}|${e.className.match(/btn-(\w+)/)?.[1]}` : e.className)),
    [`${t.accountSave}|primary`, `${t.accountCancel}|text`, 'form-actions-spacer', `${t.accountTest}|outlined`])
  assert.equal(bar.querySelector('button').getAttribute('type'), 'submit')
})

test('the saved values are those of the old editor: typed numbers, the checks, All, the signature', async tc => {
  saved.length = 0
  const v = await editor({ ...base, type: 'imap' })
  tc.after(v.unmount)
  const c = v.container
  await typeInto(c.querySelector('#acc-in_port'), '995')
  await typeInto(c.querySelector('#acc-smtp_user'), 'kuldo')
  await click(c.querySelector('#acc-smtp_same_password'))
  await typeInto(c.querySelector('#acc-smtp_password'), 'Jelszo-123456')
  await typeInto(c.querySelector('#acc-sync_interval_min'), '10')
  await click(c.querySelector('#acc-index_all'))
  assert.ok(c.querySelector('#acc-index_years').disabled)
  await click(c.querySelector('#acc-save_sent_to_server'))
  await typeInto(c.querySelector('#acc-signature'), 'Üdv,\nMunka')
  await submit(c.querySelector('form.account-editor'))
  const p = saved.at(-1)
  assert.deepEqual(
    { in_port: p.in_port, smtp_user: p.smtp_user, smtp_same_password: p.smtp_same_password, smtp_password: p.smtp_password, sync_interval_min: p.sync_interval_min,
      index_years: p.index_years, save_sent_to_server: p.save_sent_to_server, signature: p.signature, tls_verify: p.tls_verify, type: p.type },
    { in_port: 995, smtp_user: 'kuldo', smtp_same_password: false, smtp_password: 'Jelszo-123456', sync_interval_min: 10, index_years: 'all',
      save_sent_to_server: false, signature: 'Üdv,\nMunka', tls_verify: true, type: 'imap' })
  // the All box off again: back to 3 years, the field enabled
  await click(c.querySelector('#acc-index_all'))
  assert.equal(c.querySelector('#acc-index_years').value, '3')
  assert.ok(!c.querySelector('#acc-index_years').disabled)
})

test('the errors of the main process: under their field, aria-invalid, the message describes the control', async tc => {
  nextSave = { ok: false, error: 'invalid', fields: { in_host: 'required', index_years: 'bad_index_years', sync_interval_min: 'bad_interval', archive_mode: 'bad_archive_mode', in_security: 'bad_security' } }
  const v = await editor({ ...base, type: 'imap' })
  tc.after(async () => {
    nextSave = null
    await v.unmount()
  })
  const c = v.container
  await submit(c.querySelector('form.account-editor'))
  const described = el => (el.getAttribute('aria-describedby') || '').split(' ').map(id => document.getElementById(id)?.textContent)
  for (const [id, code] of [['acc-in_host', 'required'], ['acc-index_years', 'bad_index_years'], ['acc-sync_interval_min', 'bad_interval'], ['acc-archive_mode', 'bad_archive_mode'], ['acc-in_security', 'bad_security']]) {
    const el = c.querySelector(`#${id}`)
    assert.equal(el.getAttribute('aria-invalid'), 'true', id)
    assert.ok(described(el).includes(t.accountError(code)), `${id}: ${described(el)}`)
    assert.ok(boxOf(c, id).classList.contains('text-field-error'), id)
  }
  assert.ok(described(c.querySelector('#acc-index_years')).some(s => s && s.startsWith(t.indexHelp)), 'the index hint stays next to the error')
})

test('the folder roles: their own section after the incoming server, the help as its description, one label per select', async tc => {
  const v = await editor({ ...base, type: 'imap' })
  tc.after(v.unmount)
  const c = v.container
  const section = c.querySelector('fieldset.folder-roles').closest('section.form-section')
  assert.equal(section.querySelector('h2').textContent, A.sections.folders)
  assert.equal(section.querySelector('.form-section-desc').textContent, t.folderRolePicker.help)
  assert.equal(section.previousElementSibling.querySelector('h2').textContent, A.sections.incomingImap)
  for (const box of c.querySelectorAll('.folder-role')) {
    assert.equal(box.querySelectorAll('.text-field-label').length, 1)
    assert.equal(box.querySelector('.text-field-label').textContent, t.folderRoles[box.dataset.role])
    assert.equal(box.querySelector('.select-trigger').getAttribute('aria-label'), t.folderRoles[box.dataset.role])
  }
})

test('0.17.0 the connection test: the IMAP server\'s custom-keyword line under Incoming (enged / nem enged / nem mérhető) with its note; none without keywords', async tc => {
  const v = await editor({ ...base, type: 'imap' })
  tc.after(v.unmount)
  const testButton = [...v.container.querySelectorAll('button')].find(b => b.textContent === t.accountTest)
  for (const custom of [true, false, null]) {
    nextTest = { ok: true, incoming: { ok: true, keywords: { custom, flags: [] } }, smtp: { ok: true } }
    await click(testButton)
    await inAct(() => wait(30))
    const line = v.container.querySelector('ul.probe .probe-keywords')
    assert.ok(line, String(custom))
    assert.equal(line.firstChild.textContent, t.probeKeywords(custom))
    assert.equal(line.querySelector('.probe-keywords-note'), null, 'no "for information only" note: the line says where the labels are kept')
    const items = [...v.container.querySelectorAll('ul.probe > li')]
    assert.equal(items.indexOf(line), 1, 'right under the incoming row')
  }
  assert.deepEqual([true, false, null].map(t.probeKeywords), [
    'Egyéni címkét a szerver: enged (a címkék ennél a fióknál a szerveren tárolódnak)',
    'Egyéni címkét a szerver: nem enged (a címkék ennél a fióknál csak ezen a gépen tárolódnak)',
    'Egyéni címkét a szerver: nem mérhető',
  ])
  assert.equal(v.container.querySelector('ul.probe .probe-keywords').textContent.includes('tájékoztató'), false)
  // POP3 / a failed login: no keywords, no line
  for (const incoming of [{ ok: true }, { ok: false, error: 'timeout', keywords: { custom: true, flags: [] } }]) {
    nextTest = { ok: true, incoming, smtp: { ok: true } }
    await click(testButton)
    await inAct(() => wait(30))
    assert.equal(v.container.querySelector('ul.probe .probe-keywords'), null, JSON.stringify(incoming))
  }
  nextTest = null
})
