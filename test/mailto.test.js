// mailto: links: parsing, and the composer session they open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMailto, mailtoBodyHtml, MAILTO_MAX } from '../core/smtp/compose.js'
import { Composer } from '../app/main/compose.js'
import { registerComposeIpc } from '../app/main/ipc/compose.js'
import { tempDir } from './helpers/tmp.js'

test('parseMailto: the path and the to / cc / subject / body fields, percent-decoded (RFC 6068)', () => {
  const href =
    'mailto:anna@example.invalid,bela@example.invalid?cc=cili@example.invalid&subject=%C3%81rv%C3%ADz%20k%C3%A9rd%C3%A9s&body=Els%C5%91%20sor%0D%0AM%C3%A1sodik&to=dora@example.invalid'
  assert.deepEqual(parseMailto(href), {
    to: 'anna@example.invalid,bela@example.invalid, dora@example.invalid',
    cc: 'cili@example.invalid',
    subject: 'Árvíz kérdés',
    body: 'Első sor\nMásodik',
  })
})

test('parseMailto: Bcc and the other fields are dropped; a link cannot add a recipient the form does not show', () => {
  const r = parseMailto('mailto:a@example.invalid?bcc=rejtett@example.invalid&BCC=x@example.invalid&in-reply-to=%3Cx%40y%3E&x-foo=1')
  assert.deepEqual(r, { to: 'a@example.invalid', cc: '', subject: '', body: '' })
  assert.ok(!JSON.stringify(r).includes('rejtett'))
})

test('parseMailto: CR / LF and other control characters in a one-line field become a space (no header lines)', () => {
  const r = parseMailto('mailto:a@example.invalid%0D%0ABcc:%20b@example.invalid?subject=Szia%0D%0ABcc:%20c@example.invalid&cc=d@example.invalid%00')
  assert.equal(r.to, 'a@example.invalid Bcc: b@example.invalid')
  assert.equal(r.subject, 'Szia Bcc: c@example.invalid')
  assert.equal(r.cc, 'd@example.invalid')
  for (const v of [r.to, r.cc, r.subject]) assert.doesNotMatch(v, /[\r\n\0]/)
})

test('parseMailto: "+" stays "+", field names and the scheme in any case, the fragment is not part of it', () => {
  assert.deepEqual(parseMailto('MAILTO:a+b@example.invalid?SUBJECT=1+1&Body=x+y#top'), { to: 'a+b@example.invalid', cc: '', subject: '1+1', body: 'x+y' })
  assert.deepEqual(parseMailto('mailto:?to=a@example.invalid&subject=&cc'), { to: 'a@example.invalid', cc: '', subject: '', body: '' })
  assert.deepEqual(parseMailto('mailto:'), { to: '', cc: '', subject: '', body: '' })
})

test('parseMailto: not mailto:, broken percent-encoding or too long -> null', () => {
  for (const bad of [null, 42, 'https://example.invalid/', 'javascript:alert(1)', 'mailto:a%ZZ@example.invalid', 'mailto:a@b?subject=%E0%A4%A']) {
    assert.equal(parseMailto(bad), null, String(bad))
  }
  assert.equal(parseMailto(`mailto:a@example.invalid?subject=${'x'.repeat(MAILTO_MAX.subject + 1)}`), null)
  assert.equal(parseMailto(`mailto:a@example.invalid?body=${'x'.repeat(MAILTO_MAX.body + 1)}`), null)
  assert.equal(parseMailto(`mailto:${'a'.repeat(MAILTO_MAX.address)}@example.invalid`), null)
  assert.equal(parseMailto(`mailto:a@example.invalid?x=${'y'.repeat(MAILTO_MAX.href)}`), null)
  assert.ok(parseMailto(`mailto:a@example.invalid?subject=${'x'.repeat(MAILTO_MAX.subject)}`))
})

test('mailtoBodyHtml: escaped plain text, one paragraph per line (a link cannot put markup into the body)', () => {
  assert.equal(mailtoBodyHtml(''), '')
  assert.equal(mailtoBodyHtml('Első\n\n<b onclick="x()">& nem félkövér</b>'), '<p>Első</p><p><br></p><p>&lt;b onclick=&quot;x()&quot;&gt;&amp; nem félkövér&lt;/b&gt;</p>')
})

function ipcSetup(t) {
  const composer = new Composer({ index: null, store: null, contacts: null, storeDir: tempDir(t), withConnection: async () => {} })
  const handlers = new Map()
  const opened = []
  const logged = []
  const ipc = registerComposeIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    composer,
    store: { list: () => [] },
    contacts: { suggest: () => [] },
    openWindow: id => {
      opened.push(id)
      return { on: () => {}, isDestroyed: () => false, close: () => {}, destroy: () => {} }
    },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    windowOf: () => null,
    isTrustedSender: e => e.ok,
    log: m => logged.push(m),
  })
  const call = (ch, ...args) => handlers.get(ch)({ ok: true }, ...args)
  return { composer, handlers, opened, logged, ipc, call }
}

test('openMailto: a composer window filled from the link; the page gets the form through compose:initial', async t => {
  const s = ipcSetup(t)
  assert.equal(s.ipc.openMailto('mailto:anna@example.invalid?cc=cili@example.invalid&bcc=rejtett@example.invalid&subject=K%C3%A9rd%C3%A9s&body=Szia%0A%3Cb%3Ex%3C%2Fb%3E'), true)
  assert.equal(s.opened.length, 1)
  const init = await s.call('compose:initial', s.opened[0])
  assert.deepEqual(init, {
    ok: true,
    form: { accountId: null, to: 'anna@example.invalid', cc: 'cili@example.invalid', subject: 'Kérdés', body: '<p>Szia</p><p>&lt;b&gt;x&lt;/b&gt;</p>', quote: '', inReplyTo: null, references: [] },
    attachments: [],
    archivable: false, // a new message: no original to archive
  })
  assert.ok(!JSON.stringify(init).includes('rejtett'), 'no Bcc from a link')
})

test('openMailto: a link we do not take opens nothing and is logged; a new message has no starting form', async t => {
  const s = ipcSetup(t)
  assert.equal(s.ipc.openMailto('mailto:a%ZZ@example.invalid'), false)
  assert.equal(s.ipc.openMailto('https://example.invalid/'), false)
  assert.deepEqual(s.opened, [])
  assert.equal(s.composer.sessions.size, 0, 'no session left behind')
  assert.match(s.logged.join('\n'), /mailto link not opened/)
  const { sessionId } = await s.call('compose:open')
  assert.deepEqual(await s.call('compose:initial', sessionId), { ok: true, form: null, attachments: [], archivable: false })
  assert.deepEqual(await s.call('compose:initial', 'not-a-session'), { ok: false, error: 'bad_request' })
  assert.deepEqual(await s.call('compose:initial', '00000000-0000-0000-0000-000000000000'), { ok: false, error: 'no_session', draftSaved: undefined, detail: undefined })
  assert.deepEqual(await s.handlers.get('compose:initial')({ ok: false }, sessionId), { ok: false, error: 'untrusted_sender' })
})

test("compose:open { mode: 'to', to } opens a new message to that one address; anything else is refused", async t => {
  const s = ipcSetup(t)
  const { sessionId } = await s.call('compose:open', { mode: 'to', to: 'anna@example.invalid' })
  const init = await s.call('compose:initial', sessionId)
  assert.equal(init.form.to, 'anna@example.invalid')
  assert.equal(init.form.cc, '')
  assert.equal(init.form.subject, '')
  for (const bad of [{ mode: 'to', to: '' }, { mode: 'to', to: 'a@example.invalid, c@example.invalid' }, { mode: 'to', to: 'a@example.invalid\nBcc: x@example.invalid' }, { mode: 'to', to: 'x'.repeat(321) }, { mode: 'to', to: 5 }, { mode: 'to', to: '<a@example.invalid>' }]) {
    assert.deepEqual(await s.call('compose:open', bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
  }
})
