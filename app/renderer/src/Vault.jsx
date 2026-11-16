// SPDX-License-Identifier: GPL-3.0-or-later
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n/index.js'
import { Banner, Button, IconButton } from './ui/index.js'

const api = window.shadowMail
const MIN = 10

// Clears the password fields as soon as a call returns: the plain text should not linger in the page.
function usePasswordForm(fields) {
  const empty = Object.fromEntries(fields.map(f => [f, '']))
  const [values, setValues] = useState(empty)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const bind = name => ({
    value: values[name],
    onChange: e => setValues(v => ({ ...v, [name]: e.target.value })),
  })
  const run = async call => {
    setBusy(true)
    setMessage(null)
    try {
      return await call(values)
    } finally {
      setValues(empty)
      setBusy(false)
    }
  }
  return { values, bind, busy, message, setMessage, run, clear: () => setValues(empty) }
}

/**
 * A password field with the eye button: hidden by default; shown only while asked, and hidden
 * again when the field is cleared (after every call).
 */
function PasswordField({ id, label, autoFocus, autoComplete = 'off', ...rest }) {
  const [shown, setShown] = useState(false)
  const input = useRef(null)
  useEffect(() => {
    if (!rest.value) setShown(false)
  }, [rest.value])
  // the password never leaves as a text field: back to "password" in the DOM before the submit is
  // handled (a capture listener on the form), so no text-field form history could keep it
  useEffect(() => {
    const form = input.current && input.current.form
    if (!form) return undefined
    const hide = () => {
      if (input.current) input.current.type = 'password'
      setShown(false)
    }
    form.addEventListener('submit', hide, true)
    return () => form.removeEventListener('submit', hide, true)
  }, [])
  return (
    <div className="field password-field">
      <label htmlFor={id}>{label}</label>
      <span className="password-wrap">
        <input ref={input} id={id} type={shown ? 'text' : 'password'} autoFocus={autoFocus} autoComplete={autoComplete} spellCheck={false} {...rest} />
        <IconButton icon={shown ? 'hide' : 'show'} size="s" className="password-eye" label={shown ? t.passwordHide : t.passwordShow} pressed={shown} onClick={() => setShown(v => !v)} />
      </span>
    </div>
  )
}

/** A warning with the recovery / reset texts word for word (as a Banner). */
function Warn({ id, role = 'note', children }) {
  return (
    <Banner kind="warning" id={id} role={role} className="warning vault-warning">
      {children}
    </Banner>
  )
}

export function VaultCreate({ onDone }) {
  const f = usePasswordForm(['password', 'again'])
  const submit = async e => {
    e.preventDefault()
    if (f.values.password !== f.values.again) {
      f.clear()
      f.setMessage(t.vaultMismatch)
      return
    }
    const res = await f.run(v => api.vault.create(v.password))
    if (res.ok) onDone(res.status, res.recoveryCode)
    else f.setMessage(t.vaultError(res.error, res.info))
  }
  return (
    <form onSubmit={submit} className="vault">
      <h1>{t.vaultCreateHeading}</h1>
      <p>{t.vaultCreateIntro}</p>
      <Warn>{t.vaultForgetWarning}</Warn>
      <PasswordField id="vault-new" label={t.vaultPassword} autoFocus autoComplete="new-password" {...f.bind('password')} />
      <PasswordField id="vault-new-again" label={t.vaultPasswordAgain} autoComplete="new-password" {...f.bind('again')} />
      <p className="hint">{t.vaultMinLength(MIN)}</p>
      {f.message && <p className="error" role="alert">{f.message}</p>}
      <Button type="submit" variant="primary" disabled={f.busy}>{f.busy ? t.vaultWorking : t.vaultCreateButton}</Button>
    </form>
  )
}


// a typed group of the code, compared as the vault compares the whole code (case, I/L = 1, O = 0)
const normGroup = s => String(s).toUpperCase().replace(/[\s-]+/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')

/**
 * The recovery code screen (after the first start, a recovery, a reset, a new code). The code, Copy,
 * Save to file, the warning; then one random group typed back: until it is right, there is no way on.
 */
export function RecoveryCodeScreen({ code, onConfirmed }) {
  const groups = code.split('-')
  const n = useMemo(() => 1 + Math.floor(Math.random() * groups.length), [code])
  const [typed, setTyped] = useState('')
  const [note, setNote] = useState(null)
  const [error, setError] = useState(null)
  const ok = normGroup(typed) === groups[n - 1]
  const copy = async () => {
    // the main process writes the clipboard and clears it after 60 s, on lock and on quit
    const res = await api.vault.copyRecoveryCode(code)
    if (res.ok) setNote(t.recoveryCopied)
    else setError(t.vaultError(res.error, res.info))
  }
  const save = async () => {
    const res = await api.vault.saveRecoveryCode(code)
    if (res.ok && res.saved) setNote(t.recoverySaved)
    else if (!res.ok) setError(t.vaultError(res.error, res.info))
  }
  const done = async e => {
    e.preventDefault()
    if (!ok) {
      setError(t.recoveryCheckWrong)
      return
    }
    const res = await api.vault.confirmRecovery(n, typed)
    if (res.ok) onConfirmed(res.status)
    else setError(t.vaultError(res.error, res.info))
  }
  return (
    <form onSubmit={done} className="vault recovery">
      <h1>{t.recoveryHeading}</h1>
      <p>{t.recoveryIntro}</p>
      {/* five groups, big and monospace; the text stays "XXXXX-XXXXX-…" (copied by hand, read by the tests) */}
      <p className="recovery-code" id="recovery-code" aria-label={t.recoveryHeading}>
        {groups.map((g, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="code-sep">-</span>}
            <span className="code-group">{g}</span>
          </Fragment>
        ))}
      </p>
      <div className="vault-buttons">
        <Button variant="outlined" icon="copy" onClick={copy}>{t.recoveryCopy}</Button>
        <Button variant="outlined" icon="download" onClick={save}>{t.recoverySave}</Button>
      </div>
      <p className="hint" id="recovery-clipboard-note">{t.recoveryClipboardNote}</p>
      {note && <p className="ok" role="status">{note}</p>}
      <Warn>{t.recoveryWarning}</Warn>
      <label htmlFor="recovery-check" className="field">
        <span>{t.recoveryCheck(n)}</span>
        <input id="recovery-check" type="text" value={typed} onChange={e => (setTyped(e.target.value), setError(null))} autoComplete="off" spellCheck={false} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <Button type="submit" variant="primary" disabled={!ok}>{t.recoveryDone}</Button>
    </form>
  )
}

/** The recovery code and a new master password; nothing is lost. */
function VaultRecover({ onDone, onBack, onPending = () => {} }) {
  const f = usePasswordForm(['password', 'again'])
  const [code, setCode] = useState('')
  const submit = async e => {
    e.preventDefault()
    if (f.values.password !== f.values.again) {
      f.clear()
      f.setMessage(t.vaultMismatch)
      return
    }
    const res = await f.run(v => api.vault.recover(code, v.password))
    if (res.ok) {
      setCode('')
      onDone(res.status, res.recoveryCode)
    } else if (res.recoveryCode) {
      // the recovery worked but the database did not open: the new code must not be lost
      setCode('')
      f.setMessage(t.recoveryCodeAfterError(t.vaultError(res.error, res.info), res.recoveryCode))
    } else if (res.error === 'reset_pending') onPending()
    else f.setMessage(t.vaultError(res.error, res.info))
  }
  return (
    <form onSubmit={submit} className="vault">
      <h1>{t.vaultRecoverHeading}</h1>
      <p>{t.vaultRecoverIntro}</p>
      <label htmlFor="vault-recover-code" className="field">
        <span>{t.vaultRecoverCode}</span>
        <input id="vault-recover-code" type="text" value={code} onChange={e => setCode(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
      </label>
      <PasswordField id="vault-recover-new" label={t.vaultNewPassword} autoComplete="new-password" {...f.bind('password')} />
      <PasswordField id="vault-recover-again" label={t.vaultNewPasswordAgain} autoComplete="new-password" {...f.bind('again')} />
      <p className="hint">{t.vaultMinLength(MIN)}</p>
      {f.message && <p className="error" role="alert">{f.message}</p>}
      <div className="vault-buttons">
        <Button variant="text" onClick={onBack}>{t.vaultResetBack}</Button>
        <Button type="submit" variant="primary" disabled={f.busy}>{f.busy ? t.vaultWorking : t.vaultRecoverButton}</Button>
      </div>
    </form>
  )
}

/**
 * No code: a full reset of the local data, with the confirmation word. The same form finishes
 * an interrupted reset that cannot be decided (finish: vault:finishReset, only in that state).
 */
function VaultReset({ onDone, onBack, finish = false, onPending = () => {} }) {
  const f = usePasswordForm(['password', 'again'])
  const [word, setWord] = useState('')
  // the interface language's word (TÖRLÉS in Hungarian); the main process checks the same one
  const wordOk = word.normalize('NFC').trim() === t.resetConfirmWord
  const submit = async e => {
    e.preventDefault()
    if (!wordOk) return
    if (f.values.password !== f.values.again) {
      f.clear()
      f.setMessage(t.vaultMismatch)
      return
    }
    const res = await f.run(v => (finish ? api.vault.finishReset(word, v.password) : api.vault.reset(word, v.password)))
    if (res.ok) onDone(res.status, res.recoveryCode)
    else if (res.error === 'reset_pending' && !finish) onPending()
    else f.setMessage(t.vaultError(res.error, res.info))
  }
  return (
    <form onSubmit={submit} className="vault">
      <h1>{finish ? t.vaultFinishResetButton : t.vaultResetHeading}</h1>
      {finish && <Warn>{t.vaultResetPendingText}</Warn>}
      <Warn>{t.vaultResetWarning}</Warn>
      <label htmlFor="vault-reset-word" className="field">
        <span>{t.vaultResetConfirmLabel}</span>
        <input id="vault-reset-word" type="text" value={word} onChange={e => setWord(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
      </label>
      <PasswordField id="vault-reset-new" label={t.vaultNewPassword} autoComplete="new-password" {...f.bind('password')} />
      <PasswordField id="vault-reset-again" label={t.vaultNewPasswordAgain} autoComplete="new-password" {...f.bind('again')} />
      <p className="hint">{t.vaultMinLength(MIN)}</p>
      {f.message && <p className="error" role="alert">{f.message}</p>}
      <div className="vault-buttons">
        <Button variant="text" onClick={onBack}>{t.vaultResetBack}</Button>
        <Button type="submit" variant="danger" disabled={f.busy || !wordOk}>{f.busy ? t.vaultWorking : finish ? t.vaultFinishResetButton : t.vaultResetButton}</Button>
      </div>
    </form>
  )
}

export function VaultUnlock({ onDone }) {
  const f = usePasswordForm(['password'])
  const [forgot, setForgot] = useState(null) // null | 'choose' | 'code' | 'reset' | 'finish'
  // an interrupted reset the start could not decide; the screen offers to finish it
  const [pending, setPending] = useState(false)
  // a vault.json of an older or newer version: no password field, the explanation instead
  const [problem, setProblem] = useState(null)
  useEffect(() => {
    api.vault.status().then(res => {
      if (!res || !res.ok || !res.status) return
      setPending(Boolean(res.status.resetPending))
      setProblem(res.status.vaultProblem || null)
    }, () => {})
  }, [])
  const submit = async e => {
    e.preventDefault()
    const res = await f.run(v => api.vault.unlock(v.password))
    if (res.ok) onDone(res.status)
    else if (res.error === 'reset_pending') setPending(true)
    else if (res.error === 'vault_old_version' || res.error === 'vault_newer_version') setProblem(res.error)
    else f.setMessage(t.vaultError(res.error, res.info))
  }
  const back = () => setForgot(null)
  const toPending = () => (setForgot(null), setPending(true))
  if (forgot === 'code') return <VaultRecover onDone={onDone} onBack={back} onPending={toPending} />
  if (forgot === 'reset') return <VaultReset onDone={onDone} onBack={back} onPending={toPending} />
  if (forgot === 'finish') return <VaultReset onDone={onDone} onBack={back} finish />
  if (problem)
    return (
      <div className="vault">
        <h1>{t.vaultUnlockHeading}</h1>
        <Warn id="vault-version-problem" role="alert">{t.vaultError(problem)}</Warn>
        {problem === 'vault_old_version' && (
          <p>
            <button type="button" className="link" onClick={() => (setProblem(null), setForgot('choose'))}>{t.vaultForgot}</button>
          </p>
        )}
      </div>
    )
  if (pending)
    return (
      <div className="vault">
        <h1>{t.vaultUnlockHeading}</h1>
        <Warn id="vault-reset-pending" role="alert">{t.vaultResetPendingText}</Warn>
        <div className="vault-buttons">
          <Button variant="danger" onClick={() => setForgot('finish')}>{t.vaultFinishResetButton}</Button>
        </div>
      </div>
    )
  if (forgot === 'choose')
    return (
      <div className="vault">
        <h1>{t.vaultForgotHeading}</h1>
        <div className="vault-choices">
          <Button variant="tonal" icon="lock" onClick={() => setForgot('code')}>{t.vaultForgotHaveCode}</Button>
          <Button variant="danger" icon="warning" onClick={() => setForgot('reset')}>{t.vaultForgotNoCode}</Button>
          <Button variant="text" onClick={back}>{t.vaultResetBack}</Button>
        </div>
      </div>
    )
  return (
    <form onSubmit={submit} className="vault">
      <h1>{t.vaultUnlockHeading}</h1>
      <PasswordField id="vault-unlock" label={t.vaultPassword} autoFocus autoComplete="current-password" {...f.bind('password')} />
      {f.message && <p className="error" role="alert">{f.message}</p>}
      <Button type="submit" variant="primary" disabled={f.busy}>{f.busy ? t.vaultWorking : t.vaultUnlockButton}</Button>
      <p>
        <button type="button" className="link" onClick={() => setForgot('choose')}>{t.vaultForgot}</button>
      </p>
    </form>
  )
}

export function VaultChange() {
  const f = usePasswordForm(['old', 'password', 'again'])
  const [done, setDone] = useState(false)
  const submit = async e => {
    e.preventDefault()
    setDone(false)
    if (f.values.password !== f.values.again) {
      f.clear()
      f.setMessage(t.vaultMismatch)
      return
    }
    const res = await f.run(v => api.vault.change(v.old, v.password))
    if (res.ok) setDone(true)
    else f.setMessage(t.vaultError(res.error, res.info))
  }
  return (
    <form onSubmit={submit} className="vault">
      <h3>{t.vaultChangeHeading}</h3>
      <PasswordField id="vault-old" label={t.vaultOldPassword} autoComplete="current-password" {...f.bind('old')} />
      <PasswordField id="vault-change-new" label={t.vaultNewPassword} autoComplete="new-password" {...f.bind('password')} />
      <PasswordField id="vault-change-again" label={t.vaultNewPasswordAgain} autoComplete="new-password" {...f.bind('again')} />
      <p className="hint">{t.vaultMinLength(MIN)}</p>
      {f.message && <p className="error" role="alert">{f.message}</p>}
      {done && <p className="ok" role="status">{t.vaultChanged}</p>}
      <Button type="submit" variant="tonal" disabled={f.busy}>{f.busy ? t.vaultWorking : t.vaultChangeButton}</Button>
    </form>
  )
}

/** Settings: a new recovery code (the master password is asked); the old one stops working. */
export function RecoveryNew({ onCode }) {
  const f = usePasswordForm(['password'])
  const submit = async e => {
    e.preventDefault()
    const res = await f.run(v => api.vault.newRecoveryCode(v.password))
    if (res.ok) onCode(res.recoveryCode)
    else f.setMessage(t.vaultError(res.error, res.info))
  }
  return (
    <form onSubmit={submit} className="vault">
      <h3>{t.recoveryNewHeading}</h3>
      <p className="hint">{t.recoveryNewIntro}</p>
      <PasswordField id="recovery-new-password" label={t.vaultPassword} autoComplete="current-password" {...f.bind('password')} />
      {f.message && <p className="error" role="alert">{f.message}</p>}
      <Button type="submit" variant="tonal" disabled={f.busy}>{f.busy ? t.vaultWorking : t.recoveryNewButton}</Button>
    </form>
  )
}
