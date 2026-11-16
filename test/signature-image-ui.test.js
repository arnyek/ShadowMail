// The account editor's signature image (jsdom): a new account waits for its save; a saved one shows the stored image
// from the preview call, uploads and replaces through the main process, shows a refusal with its numbers, removes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'

setupDom()
const calls = []
let stored = null // the main process's stored image
let nextPick = null // what the next pick answers
window.shadowMail = {
  accounts: {
    signatureImage: async id => (calls.push(['preview', id]), { ok: true, image: stored }),
    signatureImagePick: async id => {
      calls.push(['pick', id])
      const r = nextPick
      if (r && r.ok && !r.canceled) stored = { type: 'image/png', dataUrl: 'data:image/png;base64,QUJD' }
      return r
    },
    signatureImageRemove: async id => (calls.push(['remove', id]), (stored = null), { ok: true, account: { id } }),
    save: async () => ({ ok: true }),
    test: async () => ({ ok: true }),
  },
}
const { createElement: h } = await import('react')
const { AccountEditor } = await import('../app/renderer/src/Accounts.jsx')
const { t } = await import('../app/renderer/i18n/index.js')
const wait = ms => new Promise(r => setTimeout(r, ms))
const click = el => inAct(async () => {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(20)
})
const account = { id: 7, name: 'Munka', email: 'a@example.invalid', type: 'imap', in_host: 'h', in_port: 993, in_security: 'tls', in_user: 'u', body_index_days: 1095, sync_interval_min: 5, save_sent_to_server: 1, smtp_same_password: 1, tls_verify: 1, signature: 'Szia' }

test('a new account: no upload yet, a note to save first; no call to the main process', async t2 => {
  calls.length = 0
  const v = await mount(h(AccountEditor, { account: null, onSaved() {}, onCancel() {} }))
  t2.after(v.unmount)
  assert.equal(v.container.querySelector('.signature-image-later').textContent, t.signatureImage.saveFirst)
  assert.equal(v.container.querySelector('.signature-image-pick'), null)
  assert.deepEqual(calls, [])
})

test('a saved account: upload, the preview from the stored bytes, a refusal with its numbers, replace, remove', async t2 => {
  calls.length = 0
  stored = null
  const v = await mount(h(AccountEditor, { account, onSaved() {}, onCancel() {} }))
  t2.after(v.unmount)
  await inAct(() => wait(20))
  const box = () => v.container.querySelector('.signature-image')
  assert.equal(box().dataset.hasImage, 'false')
  assert.equal(v.container.querySelector('.signature-image-none').textContent, t.signatureImage.none)
  assert.equal(v.container.querySelector('.signature-image-pick').textContent, t.signatureImage.upload)
  // refused: the numbers in the text, nothing stored
  nextPick = { ok: false, error: 'too_large', width: 1920, height: 1080, bytes: 500000, maxWidth: 800, maxHeight: 400, maxBytes: 153600 }
  await click(v.container.querySelector('.signature-image-pick'))
  assert.equal(v.container.querySelector('.signature-image-error').textContent, t.signatureImage.error(nextPick))
  assert.match(v.container.querySelector('.signature-image-error').textContent, /1920 x 1080/)
  assert.equal(box().dataset.hasImage, 'false')
  // stored: the preview shows the main process's data: URL, the button says replace, the error is gone
  nextPick = { ok: true, account: { id: 7 }, image: { type: 'image/png', width: 10, height: 10, bytes: 3 } }
  await click(v.container.querySelector('.signature-image-pick'))
  const img = v.container.querySelector('img.signature-image-preview')
  assert.equal(img.getAttribute('src'), 'data:image/png;base64,QUJD')
  assert.equal(img.getAttribute('alt'), t.signatureImage.alt)
  assert.equal(v.container.querySelector('.signature-image-error'), null)
  assert.equal(v.container.querySelector('.signature-image-pick').textContent, t.signatureImage.replace)
  // a cancelled dialog changes nothing
  nextPick = { ok: true, canceled: true }
  await click(v.container.querySelector('.signature-image-pick'))
  assert.equal(box().dataset.hasImage, 'true')
  // remove
  await click(v.container.querySelector('.signature-image-remove'))
  assert.equal(box().dataset.hasImage, 'false')
  assert.deepEqual(calls.map(c => c[0]), ['preview', 'pick', 'pick', 'preview', 'pick', 'remove', 'preview'])
  assert.ok(calls.every(c => c[1] === 7))
})
