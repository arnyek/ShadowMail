// SPDX-License-Identifier: GPL-3.0-or-later
// IPC for accounts. Replies never carry a password: the editor gets has_*_password flags,
// and a blank password field on save/test means "use the stored one" (decrypted here, in main).
import { AccountError, validateAccount } from '../../../core/accounts/model.js'
import { probeAccount } from '../../../core/accounts/probe.js'
import { applyBodyLimit } from '../../../core/db/body-limit.js'
import { VaultError } from '../../../core/vault/vault.js'
import { errCode } from '../../../core/log-safe.js'
import { prepareSignatureImage, SignatureImageError } from '../../../core/accounts/signature-image.js'
import { noRecent } from '../dialog-options.js'
import fs from 'node:fs'

export const ACCOUNT_CHANNELS = Object.freeze(['accounts:list', 'accounts:save', 'accounts:delete', 'accounts:reorder', 'accounts:test', 'accounts:signatureImagePick', 'accounts:signatureImageRemove', 'accounts:signatureImage'])

// a chosen file is read only up to this size (a larger one is refused by its size, unread): its metadata could make it
// bigger than the 150 KB stored limit, so the read limit is above it
export const SIGNATURE_READ_MAX = 10 * 1024 * 1024

/** A chosen file, through one descriptor: a regular file of at most SIGNATURE_READ_MAX bytes. */
function readImageFile(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    throw new SignatureImageError('read_failed')
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) throw new SignatureImageError('unsupported_image')
    if (st.size > SIGNATURE_READ_MAX) throw new SignatureImageError('too_large', { width: null, height: null, bytes: st.size })
    const buf = Buffer.alloc(st.size)
    let got = 0
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got)
      if (n === 0) break
      got += n
    }
    return buf.subarray(0, got)
  } catch (err) {
    if (err instanceof SignatureImageError) throw err
    throw new SignatureImageError('read_failed')
  } finally {
    fs.closeSync(fd)
  }
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const isId = v => Number.isInteger(v) && v > 0

/**
 * "Kapcsolat próbája" (accounts:test) as a function, for the IPC and MCP test_account: the stored
 * passwords are used only when the server settings are the saved ones. Returns { incoming, smtp }.
 */
export async function testAccountConnection(input, { store, probe = probeAccount, log = () => {} }) {
  if (!isPlainObject(input)) throw new AccountError('invalid', { form: 'bad_form' })
  const existing = isId(input.id) ? store.getRow(input.id) : null
  const stored = existing ? store.passwordsFor(existing.id) : { incoming: null, smtp: null }
  // first pass: the normalized values, to compare them with the saved server settings
  const draft = validateAccount(input, existing, { hasIncoming: true, hasSmtp: true }).values
  const same = (keys, a, b) => keys.every(k => a[k] === b[k])
  const smtpUserOf = r => r.smtp_user || r.in_user
  const sameIncoming = Boolean(existing) && same(['type', 'in_host', 'in_port', 'in_security', 'in_user'], draft, existing)
  const sameSmtp = Boolean(existing) && same(['smtp_host', 'smtp_port', 'smtp_security'], draft, existing) && smtpUserOf(draft) === smtpUserOf(existing)
  // with "same password for SMTP" the incoming password goes to the SMTP server too
  const incomingUsable = Boolean(stored.incoming) && sameIncoming && (!draft.smtp_same_password || sameSmtp)
  const smtpUsable = Boolean(existing && !existing.smtp_same_password && stored.smtp) && sameSmtp
  const { values, errors, passwords } = validateAccount(input, existing, { hasIncoming: incomingUsable, hasSmtp: smtpUsable })
  if (Object.keys(errors).length) throw new AccountError('invalid', errors)
  const incomingPassword = passwords.incoming || (incomingUsable ? stored.incoming : null)
  const smtpPassword = values.smtp_same_password ? incomingPassword : passwords.smtp || (smtpUsable ? stored.smtp : null)
  const result = await probe(values, { incomingPassword, smtpPassword })
  // 0.17.0: the IMAP server's custom-keyword answer (where the account's labels are kept); no host, no user
  const kw = result.incoming && result.incoming.ok && result.incoming.keywords
  if (kw) log(`imap probe: custom keywords ${kw.custom === true ? 'yes' : kw.custom === false ? 'no' : 'unknown'}, permanentflags=(${(kw.flags || []).join(' ')})`)
  return { incoming: result.incoming, smtp: result.smtp }
}

/**
 * "Mentés" of the account editor (accounts:save), for the IPC and MCP update_account: the same
 * store write, the same re-index after a limit change and the same sync restart. Returns the saved account.
 */
export function saveAccount(input, { store, index, notify = () => {}, log = () => {}, now = () => Date.now(), onSaved = () => {} }) {
  const { account, limitChanged } = store.save(input)
  log(`account ${account.id} saved${limitChanged ? ', index limit changed' : ''}`)
  if (limitChanged) {
    // In the background right after the reply: the UI stays usable, the status line follows.
    setTimeout(() => {
      try {
        const result = applyBodyLimit(index, store.getRow(account.id), now())
        notify({ kind: 'reindex', accountId: account.id, ...result })
      } catch (err) {
        log(`reindex of account ${account.id} failed: ${errCode(err)}`)
      }
      // after the reconciler: the restarted sync fetches the re-queued texts
      Promise.resolve(onSaved(account.id)).catch(err => log(`sync restart of account ${account.id} failed: ${errCode(err)}`))
    }, 0)
  } else {
    Promise.resolve(onSaved(account.id)).catch(err => log(`sync restart of account ${account.id} failed: ${errCode(err)}`))
  }
  return account
}

/** The account's "Törlés" (accounts:delete), for the IPC and MCP delete_account (M3B). */
export async function deleteAccount(id, { store, onDeleted = async () => {}, log = () => {} }) {
  if (!store.getRow(id)) throw new AccountError('not_found')
  await onDeleted(id) // stop its sync first, so nothing writes rows for a deleted account
  store.remove(id)
  log(`account ${id} deleted`)
}

/**
 * @param store   AccountStore
 * @param index   MailIndex (for the body-limit reconciler after a limit change)
 * @param notify  (event) => void, sends a status event to the window (e.g. the re-index line)
 * @param probe   injectable connection test (tests use a stub)
 * @param onSaved / onDeleted  (id) => void|Promise (the sync manager restarts / stops the account)
 */
export function registerAccountIpc({ ipcMain, store, index, isTrustedSender, notify = () => {}, log = () => {}, probe = probeAccount, now = () => Date.now(), onSaved = () => {}, onDeleted = async () => {}, onTested = () => {}, dialog = null, getWindow = () => null, decodeImage = null, uprightImage = null }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        return { ok: true, ...(await fn(...args)) }
      } catch (err) {
        if (err instanceof AccountError) return { ok: false, error: err.code, fields: err.fields }
        if (err instanceof VaultError) return { ok: false, error: err.code }
        if (err instanceof SignatureImageError) {
          log(`${channel}: refused, ${err.code}${err.info.bytes ? ` (${err.info.bytes} B${err.info.width ? `, ${err.info.width}x${err.info.height}` : ''})` : ''}`)
          return { ok: false, error: err.code, ...err.info }
        }
        log(`${channel} failed: ${errCode(err)}`)
        return { ok: false, error: 'internal' }
      }
    })

  handle('accounts:list', async () => ({ accounts: store.list() }))

  handle('accounts:save', async input => {
    if (!isPlainObject(input)) throw new AccountError('invalid', { form: 'bad_form' })
    return { account: saveAccount(input, { store, index, notify, log, now, onSaved }) }
  })

  // the accounts' order: exactly the existing ids, each once; the window reloads the sidebar on the event
  handle('accounts:reorder', async ids => {
    store.reorder(Array.isArray(ids) ? [...ids] : ids)
    notify({ kind: 'accounts' })
    return { accounts: store.list() }
  })

  handle('accounts:delete', async id => {
    if (!isId(id)) throw new AccountError('not_found')
    await deleteAccount(id, { store, onDeleted, log })
    return {}
  })

  // Tests the form as it is (unsaved changes included). A blank password field falls back to the stored
  // password ONLY for the server it was saved for: same host, port, security and user.
  // Otherwise an unsaved (mistyped, or a compromised page's) host would get the stored password, even
  // in plain text; then the form must carry the password.
  // The signature image (the account editor): the main process's open dialog (the renderer never sees a path), the
  // type from the file's header, the metadata removed, the limits, and the decoder's check; the log has only the
  // type, the size and the error code.
  handle('accounts:signatureImagePick', async id => {
    if (!isId(id) || !store.getRow(id)) throw new AccountError('not_found')
    if (!dialog || typeof decodeImage !== 'function') throw new AccountError('not_available')
    const win = getWindow()
    const opts = { properties: ['openFile'], filters: [{ name: 'PNG, JPEG', extensions: ['png', 'jpg', 'jpeg'] }] }
    const res = await (win ? dialog.showOpenDialog(win, noRecent(opts)) : dialog.showOpenDialog(noRecent(opts)))
    if (!res || res.canceled || !res.filePaths || !res.filePaths.length) return { canceled: true }
    const image = prepareSignatureImage(readImageFile(res.filePaths[0]), { decode: decodeImage, upright: uprightImage })
    store.setSignatureImage(id, image)
    log(`account ${id} signature image stored: ${image.type} ${image.bytes.length} B, ${image.width}x${image.height}, ${image.removed} metadata part(s) removed`)
    return { account: store.get(id), image: { type: image.type, width: image.width, height: image.height, bytes: image.bytes.length } }
  })

  handle('accounts:signatureImageRemove', async id => {
    if (!isId(id)) throw new AccountError('not_found')
    store.removeSignatureImage(id)
    log(`account ${id} signature image removed`)
    return { account: store.get(id) }
  })

  // the stored image for the editor's preview, as a data: URL (the page's CSP allows data: images, nothing remote)
  handle('accounts:signatureImage', async id => {
    if (!isId(id) || !store.getRow(id)) throw new AccountError('not_found')
    const image = store.signatureImage(id)
    return { image: image ? { type: image.type, dataUrl: `data:${image.type};base64,${image.bytes.toString('base64')}` } : null }
  })

  handle('accounts:test', async input => {
    const result = await testAccountConnection(input, { store, probe, log })
    log(`connection test: incoming ${result.incoming.ok ? 'ok' : result.incoming.error}, smtp ${result.smtp.ok ? 'ok' : result.smtp.error}`)
    if (isId(input.id)) onTested(input.id, result) // a successful test by the user unlocks MCP test_account
    return result
  })
}
