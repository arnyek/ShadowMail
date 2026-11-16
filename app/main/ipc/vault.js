// SPDX-License-Identifier: GPL-3.0-or-later
// IPC for the vault. Every handler answers { ok: true, status } or { ok: false, error: <code> };
// the renderer maps the code to Hungarian text. No handler returns a key or an account password. The one
// secret that does go to the renderer is a NEW recovery code (create, recover, reset, newRecoveryCode):
// it is shown once on the code screen and never logged or stored by the program.
import { VaultError, MAX_PASSWORD_CHARS } from '../../../core/vault/vault.js'
import { errCode } from '../../../core/log-safe.js'
import { t } from '../../renderer/i18n/index.js'

export const VAULT_CHANNELS = Object.freeze([
  'vault:status', 'vault:create', 'vault:unlock', 'vault:lock', 'vault:change', 'vault:reset', 'vault:lockNotice',
  'vault:recover', 'vault:newRecoveryCode', 'vault:confirmRecovery', 'vault:saveRecoveryCode',
  'vault:finishReset', 'vault:copyRecoveryCode',
])

// the word the user types to confirm a full reset (every local data goes): the interface language's (TÖRLÉS in
// Hungarian), read at the call, since the main process sets its language after the modules load
export const resetConfirmWord = () => t.resetConfirmWord

// Generous upper bound on the raw string; the real rule (10..1024 characters) is in core/vault.
const isPasswordArg = v => typeof v === 'string' && v.length > 0 && v.length <= 4 * MAX_PASSWORD_CHARS
const isCodeArg = v => typeof v === 'string' && v.length > 0 && v.length <= 200

/**
 * @param ipcMain   electron ipcMain (or a stand-in with handle(channel, fn) in tests)
 * @param vault     core Vault instance
 * @param isTrustedSender (event) => boolean, only our own renderer page may call
 * @param log       optional (message) => void; never receives a password or a code
 * @param onUnlocked optional ({ created }) => void | Promise after create / reset (created: true) or unlock / recover (the sync starts;
 *                  awaited, a schema upgrade may run first); locking is vault.onLock
 * @param beforeLock optional async () => number of drafts not saved (the composers save first)
 * @param saveCodeFile optional async (code, event) => { saved } "Mentés fájlba" on the code screen (the main process asks where)
 * @param copyCode optional async (code) => void "Másolás" on the code screen (the clipboard guard clears it after 60 s)
 */
export function registerVaultIpc({ ipcMain, vault, isTrustedSender, log = () => {}, onUnlocked = () => {}, beforeLock = async () => 0, saveCodeFile = async () => ({ saved: false }), copyCode = () => {} }) {
  let lockNotice = 0 // drafts the last lock could not save; told once after the next unlock
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        const extra = await fn(...args, event)
        if (extra && extra.__error) {
          const { __error, ...rest } = extra
          return { ...rest, status: vault.status() }
        }
        return { ok: true, status: vault.status(), ...(extra || {}) }
      } catch (err) {
        // info: what the text needs (db_no_space: { needMb, freeMb }), never a key or a path
        if (err instanceof VaultError) return { ok: false, error: err.code, ...(err.info ? { info: err.info } : {}) }
        log(`${channel} failed: ${errCode(err)}`)
        return { ok: false, error: 'internal' }
      }
    })

  handle('vault:status', async () => {})
  handle('vault:create', async password => {
    if (typeof password !== 'string') throw new VaultError('bad_password')
    const { code } = await vault.create(password)
    log('vault created')
    await onUnlocked({ created: true })
    return { recoveryCode: code }
  })
  handle('vault:unlock', async password => {
    if (!isPasswordArg(password)) throw new VaultError('bad_password')
    await vault.unlock(password)
    log('vault unlocked')
    await onUnlocked({ created: false })
  })
  handle('vault:lock', async () => {
    // never throws, bounded in time: the lock always comes
    if (vault.isUnlocked()) {
      try {
        lockNotice += await beforeLock()
      } catch {
        lockNotice += 1
      }
    }
    vault.lock()
    log('vault locked')
  })
  // forgotten master password with the recovery code; nothing is lost, a new code comes
  handle('vault:recover', async (code, newPassword) => {
    if (!isCodeArg(code)) throw new VaultError('wrong_recovery_code')
    if (typeof newPassword !== 'string') throw new VaultError('bad_password')
    const res = await vault.recover(code, newPassword)
    log('vault recovered with the recovery code')
    try {
      await onUnlocked({ created: false })
    } catch (err) {
      // the new code is already in vault.json: it goes to the page with the error, or it would be lost
      if (err instanceof VaultError) return { ok: false, error: err.code, ...(err.info ? { info: err.info } : {}), recoveryCode: res.code, __error: true }
      throw err
    }
    return { recoveryCode: res.code }
  })
  // forgotten master password without the code: a full reset, only with the confirmation word
  handle('vault:reset', async (confirmWord, newPassword) => {
    if (typeof confirmWord !== 'string' || confirmWord.normalize('NFC').trim() !== resetConfirmWord()) throw new VaultError('confirm_word')
    if (typeof newPassword !== 'string') throw new VaultError('bad_password')
    const res = await vault.reset(newPassword)
    log('vault reset: the data folder starts over')
    await onUnlocked({ created: true })
    return { recoveryCode: res.code }
  })
  // the way out of 'reset_pending' (an interrupted reset that cannot be decided): the same confirmation
  // as the plain reset; the vault runs it only in that state
  handle('vault:finishReset', async (confirmWord, newPassword) => {
    if (typeof confirmWord !== 'string' || confirmWord.normalize('NFC').trim() !== resetConfirmWord()) throw new VaultError('confirm_word')
    if (typeof newPassword !== 'string') throw new VaultError('bad_password')
    const res = await vault.finishReset(newPassword)
    log('vault reset: an interrupted reset was finished, the data folder starts over')
    await onUnlocked({ created: true })
    return { recoveryCode: res.code }
  })
  handle('vault:newRecoveryCode', async password => {
    if (!isPasswordArg(password)) throw new VaultError('bad_password')
    const res = await vault.newRecoveryCode(password)
    log('new recovery code made')
    return { recoveryCode: res.code }
  })
  // the typed group is checked here, against the code the main process handed out
  handle('vault:confirmRecovery', async (n, typed) => {
    await vault.confirmRecovery(n, typed)
  })
  // "Mentés fájlba": only while unlocked (the code screen comes right after create / recover / reset / new code)
  handle('vault:saveRecoveryCode', async (code, event) => {
    if (!vault.isUnlocked()) throw new VaultError('locked')
    // only the code just handed out: not any text the page sends
    if (!isCodeArg(code) || !vault.isPendingCode(code)) throw new VaultError('bad_recovery_code')
    return saveCodeFile(code, event)
  })
  // "Másolás": the main process writes the clipboard, only the code just handed out
  handle('vault:copyRecoveryCode', async code => {
    if (!vault.isUnlocked()) throw new VaultError('locked')
    if (!isCodeArg(code) || !vault.isPendingCode(code)) throw new VaultError('bad_recovery_code')
    await copyCode(code)
  })
  // after an unlock: how many drafts the last lock could not save (the page shows a bar), once
  ipcMain.handle('vault:lockNotice', event => {
    if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
    if (!vault.isUnlocked()) return { ok: false, error: 'locked' }
    const failedDrafts = lockNotice
    lockNotice = 0
    return { ok: true, failedDrafts }
  })
  handle('vault:change', async (oldPassword, newPassword) => {
    if (!isPasswordArg(oldPassword) || typeof newPassword !== 'string') throw new VaultError('bad_password')
    await vault.change(oldPassword, newPassword)
    log('master password changed')
  })
}
