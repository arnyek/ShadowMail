// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n/index.js'
import { defaultPort, newAccountDefaults, MAX_INDEX_YEARS, accountEditorForm } from '../../../core/accounts/defaults.js'
import { Avatar, Button, IconButton, Modal, Select } from './ui/index.js'

const api = window.shadowMail
const F = t.accountFields

// The stored row -> the editor's fields (passwords are never sent back, only "stored" flags).
// MCP prepare_account: the fields Claude may fill in; never a password
const PREFILL_FIELDS = ['name', 'email', 'display_name', 'in_host', 'in_port', 'in_security', 'in_user', 'smtp_host', 'smtp_port', 'smtp_security', 'smtp_user']
function toForm(account) {
  if (!account) return { ...newAccountDefaults('imap'), in_password: '', smtp_password: '' }
  if (account.prefill) {
    const p = account.prefill
    const form = { ...newAccountDefaults(p.type === 'pop3' ? 'pop3' : 'imap'), in_password: '', smtp_password: '' }
    for (const k of PREFILL_FIELDS) if (p[k] !== undefined && p[k] !== null) form[k] = p[k]
    return form
  }
  return accountEditorForm(account)
}

// Number inputs: '' stays '' (rejected by the main process with a clear message), "2,5" stays a string.
const numberOrRaw = raw => (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw.trim())

function Field({ name, error, children }) {
  return (
    <label className="field" htmlFor={`acc-${name}`}>
      <span>{F[name]}</span>
      {children}
      {error && <span className="error" role="alert">{t.accountError(error)}</span>}
    </label>
  )
}

/**
 * The signature image under the text signature (a saved account only): the stored image's preview, upload or replace
 * (the main process's dialog and checks), remove. The image is stored at once, apart from the editor's Save.
 */
function SignatureImage({ accountId }) {
  const S = t.signatureImage
  const [image, setImage] = useState(null) // { type, dataUrl } | null
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const res = await api.accounts.signatureImage(accountId)
    setImage(res.ok ? res.image : null)
  }, [accountId])
  useEffect(() => {
    if (accountId) load()
  }, [accountId, load])
  if (!accountId) return <p className="hint signature-image-later">{S.saveFirst}</p>
  const run = async fn => {
    setBusy(true)
    setError(null)
    try {
      const res = await fn(accountId)
      if (!res.ok) setError(S.error(res))
      else if (!res.canceled) await load()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="field signature-image" data-has-image={image ? 'true' : 'false'}>
      <span>{S.label}</span>
      {image ? <img className="signature-image-preview" src={image.dataUrl} alt={S.alt} /> : <p className="hint signature-image-none">{S.none}</p>}
      <span className="inline">
        <Button variant="outlined" className="signature-image-pick" disabled={busy} onClick={() => run(api.accounts.signatureImagePick)}>{image ? S.replace : S.upload}</Button>
        {image && <Button variant="text" className="signature-image-remove" disabled={busy} onClick={() => run(api.accounts.signatureImageRemove)}>{S.remove}</Button>}
      </span>
      {error && <p className="error signature-image-error" role="alert">{error}</p>}
      <p className="hint">{S.help}</p>
    </div>
  )
}

function SecuritySelect({ id, label, value, onChange }) {
  return <Select id={id} label={label} value={value} onChange={onChange} options={Object.entries(t.securityLabels).map(([k, l]) => ({ value: k, label: l }))} />
}

function ProbeResult({ result }) {
  if (!result) return null
  const row = (label, r) => (
    <li className={r.ok ? 'ok' : 'error'}>
      {label}: {r.ok ? t.probeOk : t.probeError(r.error)}
    </li>
  )
  return (
    <ul className="probe" aria-live="polite">
      {row(t.probeIncoming, result.incoming)}
      {row(t.probeSmtp, result.smtp)}
    </ul>
  )
}

export function AccountEditor({ account, onSaved, onCancel }) {
  const [form, setForm] = useState(() => toForm(account))
  const [errors, setErrors] = useState({})
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState(null)
  const isNew = !account || Boolean(account.prefill)

  const set = (name, value) => setForm(f => ({ ...f, [name]: value }))
  const bind = name => ({ id: `acc-${name}`, value: form[name] ?? '', onChange: e => set(name, e.target.value) })
  const check = name => ({ id: `acc-${name}`, type: 'checkbox', checked: Boolean(form[name]), onChange: e => set(name, e.target.checked) })

  // Changing type or security moves the port along, unless the user typed a custom port.
  const setSecurity = (side, security) =>
    setForm(f => {
      const protocol = side === 'in' ? f.type : 'smtp'
      const portKey = `${side}_port`
      const wasDefault = f[portKey] === defaultPort(protocol, f[`${side}_security`])
      return { ...f, [`${side}_security`]: security, [portKey]: wasDefault ? defaultPort(protocol, security) : f[portKey] }
    })
  const setType = type =>
    setForm(f => ({ ...f, type, in_port: f.in_port === defaultPort(f.type, f.in_security) ? defaultPort(type, f.in_security) : f.in_port }))

  const payload = () => ({
    ...form,
    in_port: typeof form.in_port === 'string' ? numberOrRaw(form.in_port) : form.in_port,
    smtp_port: typeof form.smtp_port === 'string' ? numberOrRaw(form.smtp_port) : form.smtp_port,
    sync_interval_min: typeof form.sync_interval_min === 'string' ? numberOrRaw(form.sync_interval_min) : form.sync_interval_min,
    index_years: form.index_years === 'all' ? 'all' : typeof form.index_years === 'string' ? numberOrRaw(form.index_years) : form.index_years,
    pop3_delete_after_days:
      form.pop3_delete_after_days === '' || form.pop3_delete_after_days === null ? null
        : typeof form.pop3_delete_after_days === 'string' ? numberOrRaw(form.pop3_delete_after_days) : form.pop3_delete_after_days,
  })

  const clearPasswords = () => setForm(f => ({ ...f, in_password: '', smtp_password: '' }))

  const save = async e => {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    setErrors({})
    try {
      const res = await api.accounts.save(payload())
      if (res.ok) {
        clearPasswords()
        onSaved(res.account)
      } else if (res.error === 'invalid') setErrors(res.fields || {})
      else setMessage(res.error === 'locked' ? t.vaultError('locked') : t.accountError(res.error))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setProbe(null)
    setErrors({})
    try {
      const res = await api.accounts.test(payload())
      if (res.ok) setProbe(res)
      else if (res.error === 'invalid') setErrors(res.fields || {})
      else setMessage(t.accountError(res.error))
    } finally {
      setBusy(false)
    }
  }

  const pwPlaceholder = flag => (flag ? t.accountPasswordUnchanged : '')

  return (
    <form className="account-editor settings-card" onSubmit={save} noValidate>
      <h3>{isNew ? t.accountNew : `${t.accountEdit}: ${account.name}`}</h3>
      <Field name="type" error={errors.type}>
        <Select id="acc-type" label={F.type} value={form.type} disabled={!isNew} onChange={setType} options={Object.entries(t.typeLabels).map(([k, l]) => ({ value: k, label: l }))} />
      </Field>
      <Field name="name" error={errors.name}><input {...bind('name')} /></Field>
      <Field name="email" error={errors.email}><input type="email" {...bind('email')} /></Field>
      <Field name="display_name" error={errors.display_name}><input {...bind('display_name')} /></Field>

      <div className="account-columns">
      <fieldset>
        <legend>{F.incoming}</legend>
        <Field name="in_host" error={errors.in_host}><input {...bind('in_host')} spellCheck={false} /></Field>
        <Field name="in_security" error={errors.in_security}>
          <SecuritySelect id="acc-in_security" label={F.in_security} value={form.in_security} onChange={v => setSecurity('in', v)} />
        </Field>
        <Field name="in_port" error={errors.in_port}><input inputMode="numeric" {...bind('in_port')} /></Field>
        <Field name="in_user" error={errors.in_user}><input {...bind('in_user')} spellCheck={false} /></Field>
        <Field name="in_password" error={errors.in_password}>
          <input type="password" autoComplete="new-password" placeholder={pwPlaceholder(account?.has_incoming_password)} {...bind('in_password')} />
        </Field>
      </fieldset>

      <fieldset>
        <legend>{F.smtp}</legend>
        <Field name="smtp_host" error={errors.smtp_host}><input {...bind('smtp_host')} spellCheck={false} /></Field>
        <Field name="smtp_security" error={errors.smtp_security}>
          <SecuritySelect id="acc-smtp_security" label={F.smtp_security} value={form.smtp_security} onChange={v => setSecurity('smtp', v)} />
        </Field>
        <Field name="smtp_port" error={errors.smtp_port}><input inputMode="numeric" {...bind('smtp_port')} /></Field>
        <Field name="smtp_user" error={errors.smtp_user}><input {...bind('smtp_user')} spellCheck={false} /></Field>
        <label className="check" htmlFor="acc-smtp_same_password"><input {...check('smtp_same_password')} /> {F.smtp_same_password}</label>
        {!form.smtp_same_password && (
          <Field name="smtp_password" error={errors.smtp_password}>
            <input type="password" autoComplete="new-password" placeholder={pwPlaceholder(account?.has_smtp_password)} {...bind('smtp_password')} />
          </Field>
        )}
      </fieldset>
      </div>
      {(form.in_security === 'none' || form.smtp_security === 'none') && <p className="warning">{t.noSecurityWarning}</p>}

      <label className="check" htmlFor="acc-tls_verify"><input {...check('tls_verify')} /> {F.tls_verify}</label>
      {!form.tls_verify && <p className="danger" role="alert">{t.tlsVerifyOffWarning}</p>}

      <div className="field">
        <label htmlFor="acc-index_years">{F.index_years}</label>
        <span className="inline">
          <input id="acc-index_years" inputMode="numeric" disabled={form.index_years === 'all'} aria-describedby="acc-index-help"
            value={form.index_years === 'all' ? '' : form.index_years} onChange={e => set('index_years', e.target.value)} />
          <label className="check" htmlFor="acc-index_all">
            <input id="acc-index_all" type="checkbox" checked={form.index_years === 'all'}
              onChange={e => set('index_years', e.target.checked ? 'all' : 3)} /> {F.index_all}
          </label>
        </span>
        {errors.index_years && <span className="error" role="alert">{t.accountError(errors.index_years)}</span>}
      </div>
      <p className="hint" id="acc-index-help">
        {t.indexHelp} {form.type === 'imap' ? t.indexHelpImap : ''} (1–{MAX_INDEX_YEARS})
      </p>

      <Field name="sync_interval_min" error={errors.sync_interval_min}><input inputMode="numeric" {...bind('sync_interval_min')} /></Field>
      {form.type === 'imap' && (
        <label className="check" htmlFor="acc-save_sent_to_server"><input {...check('save_sent_to_server')} /> {F.save_sent_to_server}</label>
      )}
      {form.type === 'pop3' && (
        <Field name="pop3_delete_after_days" error={errors.pop3_delete_after_days}><input inputMode="numeric" {...bind('pop3_delete_after_days')} /></Field>
      )}
      {form.type === 'pop3' && <p className="hint" id="acc-pop3-seen-help">{t.pop3SeenHelp}</p>}
      <Field name="signature" error={errors.signature}><textarea rows={3} {...bind('signature')} /></Field>
      <SignatureImage accountId={isNew ? null : account.id} />

      {message && <p className="error" role="alert">{message}</p>}
      <ProbeResult result={probe} />
      <div className="buttons">
        <Button type="submit" variant="primary" disabled={busy}>{t.accountSave}</Button>
        <Button variant="outlined" disabled={busy} onClick={test}>{busy ? t.accountTesting : t.accountTest}</Button>
        <Button variant="text" onClick={onCancel}>{t.accountCancel}</Button>
      </div>
    </form>
  )
}

export function Accounts({ prefill = null, onPrefillTaken = () => {} } = {}) {
  const [accounts, setAccounts] = useState([])
  const [editing, setEditing] = useState(undefined) // undefined: list, null: new, object: edit, { prefill, n }: new, filled by Claude
  const prefillCount = useRef(0)
  useEffect(() => {
    if (!prefill) return
    prefillCount.current += 1
    setEditing({ prefill, n: prefillCount.current })
    onPrefillTaken()
  }, [prefill, onPrefillTaken])
  const [status, setStatus] = useState(null)

  const load = useCallback(async () => {
    const res = await api.accounts.list()
    if (res.ok) setAccounts(res.accounts)
  }, [])

  useEffect(() => {
    load()
    return api.onStatus(e => {
      if (e && e.kind === 'reindex') setStatus(t.reindexStatus(e.cleared, e.requeued))
      if (e && e.kind === 'accounts') load() // M3B: Claude's approved update_account / delete_account
    })
  }, [load])

  const [confirming, setConfirming] = useState(null) // account awaiting delete confirmation
  const remove = async account => {
    setConfirming(null)
    const res = await api.accounts.remove(account.id)
    if (res.ok) load()
  }

  if (editing !== undefined) {
    return (
      <AccountEditor
        key={editing && editing.prefill ? `prefill-${editing.n}` : 'edit'}
        account={editing}
        onCancel={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined)
          load()
        }}
      />
    )
  }

  return (
    <section className="accounts settings-card">
      <div className="toolbar">
        <h2>{t.accountsHeading}</h2>
        <Button variant="tonal" icon="plus" onClick={() => setEditing(null)}>{t.accountNew}</Button>
      </div>
      {status && <p className="status" role="status">{status}</p>}
      {confirming && (
        <Modal
          title={t.accountDelete}
          role="alertdialog"
          onClose={() => setConfirming(null)}
          actions={[
            <Button key="no" variant="text" data-autofocus onClick={() => setConfirming(null)}>{t.accountCancel}</Button>,
            <Button key="yes" variant="danger" onClick={() => remove(confirming)}>{t.accountDeleteYes}</Button>,
          ]}
        >
          <p id="acc-confirm-text">{t.accountDeleteConfirm(confirming.name)}</p>
        </Modal>
      )}
      {accounts.length === 0 && <p>{t.accountsEmpty}</p>}
      <ul className="account-list">
        {accounts.map(a => (
          <li key={a.id}>
            <Avatar name={a.name} address={a.email} />
            <span className="account-info">
              <span className="account-title">{a.name}</span>
              <span className="account-email">{a.email}</span>
            </span>
            <span className="tag">{t.typeLabels[a.type]}</span>
            {/* after a vault reset (or an unsaved password) the account cannot log in */}
            {(!a.has_incoming_password || (!a.smtp_same_password && !a.has_smtp_password)) && (
              <span className="badge warn-badge" title={t.accountNoPasswordHint}>{t.accountNoPassword}</span>
            )}
            <IconButton icon="compose" label={t.accountEdit} onClick={() => setEditing(a)} />
            <IconButton icon="trash" label={t.accountDelete} onClick={() => setConfirming(a)} />
          </li>
        ))}
      </ul>
    </section>
  )
}
