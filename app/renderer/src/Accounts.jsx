// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n/index.js'
import { defaultPort, newAccountDefaults, MAX_INDEX_YEARS, accountEditorForm } from '../../../core/accounts/defaults.js'
import { assignRoles } from '../../../core/imap/folders.js'
import { Avatar, Button, Checkbox, FormActions, FormRow, FormSection, IconButton, Modal, PageHeader, ReadOnlyField, Select, TextField } from './ui/index.js'
import { Icon } from './Icon.jsx'

const api = window.shadowMail
const F = t.accountFields
const cx = (...parts) => parts.filter(Boolean).join(' ')

// The stored row -> the editor's fields (passwords are never sent back, only "stored" flags).
// MCP prepare_account: the fields Claude may fill in; never a password
const PREFILL_FIELDS = ['name', 'email', 'display_name', 'in_host', 'in_port', 'in_security', 'in_user', 'smtp_host', 'smtp_port', 'smtp_security', 'smtp_user']
// A new account starts WITHOUT a type: the user picks IMAP or POP3 (Save and the connection test refuse until then),
// and the incoming port comes with the choice. Claude's prefill brings its type (prepare_account requires one).
function newForm(type) {
  const known = type === 'imap' || type === 'pop3'
  return { ...newAccountDefaults(known ? type : 'imap'), type: known ? type : '', in_port: known ? defaultPort(type, 'tls') : '', in_password: '', smtp_password: '' }
}
function toForm(account) {
  if (!account) return newForm('')
  if (account.prefill) {
    const p = account.prefill
    const form = newForm(p.type)
    for (const k of PREFILL_FIELDS) if (p[k] !== undefined && p[k] !== null) form[k] = p[k]
    return form
  }
  return accountEditorForm(account)
}

// Number inputs: '' stays '' (rejected by the main process with a clear message), "2,5" stays a string.
const numberOrRaw = raw => (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw.trim())

/** A Select with its label above and its error below (the shared form look; the Select names itself with `label`). */
function SelectField({ id, label, error, width = 'm', className, box = null, ...select }) {
  const messageId = `${id}-message`
  return (
    <div className={cx('text-field', `w-${width}`, error && 'text-field-error', className)} {...box}>
      <span className="text-field-label" id={`${id}-label`}>{label}</span>
      <Select id={id} label={label} describedBy={error ? messageId : undefined} invalid={Boolean(error)} {...select} />
      {error && (
        <span className="text-field-message error" role="alert" id={messageId}>
          <Icon name="error" />
          {error}
        </span>
      )}
    </div>
  )
}

// a notice right under the control it is about (no encryption)
function FieldNotice({ children }) {
  return (
    <div className="field-notice warning" role="note">
      <Icon name="warning" />
      <span>{children}</span>
    </div>
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
    <div className="text-field signature-image" data-has-image={image ? 'true' : 'false'}>
      <span className="text-field-label">{S.label}</span>
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

// the roles the picker offers (INBOX is always the inbox); the same list as ipc/folders.js CHOOSABLE_ROLES
const PICKABLE_ROLES = ['drafts', 'sent', 'trash', 'junk', 'archive']

/**
 * The role picker of a saved IMAP account: for each role "Automatic" (the server's flag, the role the folder already
 * had, the usual names, the bigger folder) or one of the account's server folders. Stored at once, apart from the
 * editor's Save (folders:setRole); the folder tree follows through the usual mail change event.
 */
function FolderRoles({ accountId }) {
  const R = t.folderRolePicker
  const [folders, setFolders] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const res = await api.mail.folders()
    const account = res.ok !== false ? (res.accounts || []).find(a => a.id === accountId) : null
    setFolders(account ? account.folders.filter(f => !f.is_local) : [])
  }, [accountId])
  useEffect(() => {
    load()
    return api.onStatus(e => {
      if (e && (e.kind === 'mail' || e.kind === 'accounts')) load()
    })
  }, [load])
  if (!folders) return null
  const choose = async (role, path) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.folders.setRole({ accountId, role, path })
      if (!res.ok) setError(t.folderError(res.error))
      await load()
    } finally {
      setBusy(false)
    }
  }
  const choices = folders.filter(f => f.path.toUpperCase() !== 'INBOX').map(f => ({ value: f.path, label: f.path }))
  // the folder each role goes to now (the stored roles, or before the first full sync the usual rule), and the chosen ones
  const now = new Map([...assignRoles(folders)].map(([p, r]) => [r, p]))
  const chosen = new Map(folders.filter(f => f.role && f.role_manual).map(f => [f.role, f.path]))
  return (
    <FormSection className="folder-roles-section" title={t.accountForm.sections.folders} description={R.help}>
      <fieldset className="folder-roles">
        <legend className="sr-only">{R.label}</legend>
        <FormRow>
          {PICKABLE_ROLES.map(role => {
            const value = chosen.get(role) ?? ''
            const auto = { value: '', label: !chosen.has(role) && now.has(role) ? R.autoNow(now.get(role)) : R.auto }
            return (
              <SelectField key={role} id={`acc-role-${role}`} className="folder-role" box={{ 'data-role': role }} label={t.folderRoles[role]} value={value} disabled={busy}
                options={[auto, ...choices]} onChange={v => choose(role, v === '' ? null : v)} />
            )
          })}
        </FormRow>
      </fieldset>
      {error && <p className="text-field-message error folder-roles-error" role="alert">{error}</p>}
    </FormSection>
  )
}

const securityOptions = () => Object.entries(t.securityLabels).map(([k, l]) => ({ value: k, label: l }))

function ProbeResult({ result }) {
  if (!result) return null
  const row = (label, r) => (
    <li className={r.ok ? 'ok' : 'error'}>
      {label}: {r.ok ? t.probeOk : t.probeError(r.error)}
    </li>
  )
  // 0.17.0: the IMAP server's custom-keyword answer: where this account's labels are kept (POP3 has none)
  const kw = result.incoming && result.incoming.ok && result.incoming.keywords
  return (
    <ul className="probe" aria-live="polite">
      {row(t.probeIncoming, result.incoming)}
      {kw ? (
        <li className="probe-keywords" data-custom={String(kw.custom)}>
          {t.probeKeywords(kw.custom)}
        </li>
      ) : null}
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

  // Changing type or security moves the port along, unless the user typed a custom port.
  const setSecurity = (side, security) =>
    setForm(f => {
      const protocol = side === 'in' ? f.type : 'smtp'
      if (!protocol) return { ...f, [`${side}_security`]: security } // no type chosen yet: the port comes with it
      const portKey = `${side}_port`
      const wasDefault = f[portKey] === defaultPort(protocol, f[`${side}_security`])
      return { ...f, [`${side}_security`]: security, [portKey]: wasDefault ? defaultPort(protocol, security) : f[portKey] }
    })
  const setType = type =>
    setForm(f => {
      const usual = f.type ? defaultPort(f.type, f.in_security) : ''
      return { ...f, type, in_port: f.in_port === usual || f.in_port === '' ? defaultPort(type, f.in_security) : f.in_port }
    })

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
  const A = t.accountForm
  const err = name => (errors[name] ? t.accountError(errors[name]) : undefined)
  // a TextField of the form: the acc-<name> id, the value, the error
  const field = name => ({ id: `acc-${name}`, value: form[name] ?? '', onChange: e => set(name, e.target.value), error: err(name) })
  const check = name => ({ id: `acc-${name}`, checked: Boolean(form[name]), onChange: e => set(name, e.target.checked) })
  const incomingTitle = form.type === 'imap' ? A.sections.incomingImap : form.type === 'pop3' ? A.sections.incomingPop3 : A.sections.incoming
  const indexMessage = errors.index_years ? 'acc-index-error' : null

  return (
    <div className="account-editor-page">
      <PageHeader title={isNew ? t.accountNew : A.editTitle} subtitle={isNew ? null : [account.name, account.email].filter(Boolean).join(' \u00b7 ')} />
      <form className="account-editor form-card" onSubmit={save} noValidate>
        <FormSection className="account-section" title={A.sections.account}>
          {isNew ? (
            <fieldset className="account-type" aria-describedby={errors.type ? 'acc-type-error' : undefined}>
              <legend className="text-field-label">{F.type}</legend>
              {Object.entries(t.typeLabels).map(([k, l]) => (
                <label key={k} className="account-type-option" htmlFor={`acc-type-${k}`}>
                  <input type="radio" id={`acc-type-${k}`} name="acc-type" value={k} checked={form.type === k} onChange={() => setType(k)} />
                  <span className="account-type-text">
                    <strong>{l}</strong> <span className="hint">{t.accountTypeHelp[k]}</span>
                  </span>
                </label>
              ))}
              {errors.type && (
                <span className="text-field-message error" id="acc-type-error" role="alert">
                  <Icon name="error" />
                  {t.accountError(errors.type)}
                </span>
              )}
            </fieldset>
          ) : (
            <>
              <ReadOnlyField id="acc-type" label={F.type} value={<span className="tag">{t.typeLabels[form.type] || form.type}</span>} hint={A.typeLocked} />
              {errors.type && <span className="text-field-message error" role="alert">{t.accountError(errors.type)}</span>}
            </>
          )}
          <FormRow>
            <TextField label={F.name} width="m" {...field('name')} />
            <TextField label={F.display_name} width="m" optional {...field('display_name')} />
          </FormRow>
          <TextField label={F.email} width="l" type="email" {...field('email')} />
        </FormSection>

        <FormSection className="incoming-section" title={incomingTitle}>
          <FormRow>
            <TextField label={F.in_host} width="l" spellCheck={false} {...field('in_host')} />
            <TextField label={F.in_port} width="xs" inputMode="numeric" {...field('in_port')} />
          </FormRow>
          <SelectField id="acc-in_security" label={F.in_security} error={err('in_security')} value={form.in_security} options={securityOptions()} onChange={v => setSecurity('in', v)} />
          {form.in_security === 'none' && <FieldNotice>{t.noSecurityWarning}</FieldNotice>}
          <FormRow>
            <TextField label={F.in_user} width="m" spellCheck={false} {...field('in_user')} />
            <TextField label={F.in_password} width="m" type="password" autoComplete="new-password" placeholder={pwPlaceholder(account?.has_incoming_password)} {...field('in_password')} />
          </FormRow>
        </FormSection>

        {!isNew && account.type === 'imap' && <FolderRoles accountId={account.id} />}

        <FormSection className="smtp-section" title={A.sections.smtp}>
          <FormRow>
            <TextField label={F.smtp_host} width="l" spellCheck={false} {...field('smtp_host')} />
            <TextField label={F.smtp_port} width="xs" inputMode="numeric" {...field('smtp_port')} />
          </FormRow>
          <SelectField id="acc-smtp_security" label={F.smtp_security} error={err('smtp_security')} value={form.smtp_security} options={securityOptions()} onChange={v => setSecurity('smtp', v)} />
          {form.smtp_security === 'none' && <FieldNotice>{t.noSecurityWarning}</FieldNotice>}
          <TextField label={A.smtpUser} width="m" optional hint={A.smtpUserHint} spellCheck={false} {...field('smtp_user')} />
          <Checkbox label={F.smtp_same_password} {...check('smtp_same_password')} />
          {!form.smtp_same_password && (
            <TextField label={F.smtp_password} width="m" type="password" autoComplete="new-password" placeholder={pwPlaceholder(account?.has_smtp_password)} {...field('smtp_password')} />
          )}
          <Checkbox label={F.tls_verify} {...check('tls_verify')} />
          {!form.tls_verify && <p className="danger" role="alert">{t.tlsVerifyOffWarning}</p>}
        </FormSection>

        <FormSection className="sync-section" title={A.sections.sync}>
          <div className={cx('text-field', 'unit-field', errors.index_years && 'text-field-error')}>
            <label className="text-field-label" htmlFor="acc-index_years">{A.indexYears}</label>
            <div className="with-unit">
              <input id="acc-index_years" className="text-field-input" inputMode="numeric" disabled={form.index_years === 'all'}
                aria-describedby={cx(indexMessage, 'acc-index-help')} aria-invalid={errors.index_years ? true : undefined}
                value={form.index_years === 'all' ? '' : form.index_years} onChange={e => set('index_years', e.target.value)} />
              <span className="unit">{A.yearsUnit}</span>
              <Checkbox id="acc-index_all" label={A.indexAll} checked={form.index_years === 'all'} onChange={e => set('index_years', e.target.checked ? 'all' : 3)} />
            </div>
            {errors.index_years && (
              <span className="text-field-message error" role="alert" id="acc-index-error">
                <Icon name="error" />
                {t.accountError(errors.index_years)}
              </span>
            )}
            <span className="text-field-message hint" id="acc-index-help">
              {t.indexHelp} {form.type === 'imap' ? t.indexHelpImap : ''} (1–{MAX_INDEX_YEARS})
            </span>
          </div>
          <div className={cx('text-field', 'unit-field', errors.sync_interval_min && 'text-field-error')}>
            <label className="text-field-label" htmlFor="acc-sync_interval_min">{A.syncInterval}</label>
            <div className="with-unit">
              <input id="acc-sync_interval_min" className="text-field-input" inputMode="numeric"
                aria-describedby={errors.sync_interval_min ? 'acc-sync-error' : undefined} aria-invalid={errors.sync_interval_min ? true : undefined}
                value={form.sync_interval_min ?? ''} onChange={e => set('sync_interval_min', e.target.value)} />
              <span className="unit">{A.minutesUnit}</span>
            </div>
            {errors.sync_interval_min && (
              <span className="text-field-message error" role="alert" id="acc-sync-error">
                <Icon name="error" />
                {t.accountError(errors.sync_interval_min)}
              </span>
            )}
          </div>
          {form.type === 'imap' && <Checkbox label={F.save_sent_to_server} {...check('save_sent_to_server')} />}
          {form.type === 'imap' && (
            <SelectField id="acc-archive_mode" className="archive-mode" label={F.archive_mode} error={err('archive_mode')} value={form.archive_mode || ''}
              onChange={v => set('archive_mode', v)} options={['', 'single', 'yearly'].map(v => ({ value: v, label: t.archiveModes[v] }))} />
          )}
          {form.type === 'pop3' && <TextField label={F.pop3_delete_after_days} width="m" inputMode="numeric" {...field('pop3_delete_after_days')} />}
          {form.type === 'pop3' && <p className="hint" id="acc-pop3-seen-help">{t.pop3SeenHelp}</p>}
        </FormSection>

        <FormSection className="signature-section" title={A.sections.signature}>
          <label className={cx('text-field', 'w-full', errors.signature && 'text-field-error')} htmlFor="acc-signature">
            <span className="text-field-label">{A.signatureText}</span>
            <textarea className="text-field-input" rows={3} id="acc-signature" value={form.signature ?? ''} onChange={e => set('signature', e.target.value)}
              aria-describedby={errors.signature ? 'acc-signature-error' : undefined} aria-invalid={errors.signature ? true : undefined} />
            {errors.signature && (
              <span className="text-field-message error" role="alert" id="acc-signature-error">
                <Icon name="error" />
                {t.accountError(errors.signature)}
              </span>
            )}
          </label>
          <SignatureImage accountId={isNew ? null : account.id} />
        </FormSection>

        {message && <p className="error" role="alert">{message}</p>}
        <ProbeResult result={probe} />
        <FormActions sticky side={<Button variant="outlined" disabled={busy} onClick={test}>{busy ? t.accountTesting : t.accountTest}</Button>}>
          <Button type="submit" variant="primary" disabled={busy}>{t.accountSave}</Button>
          <Button variant="text" onClick={onCancel}>{t.accountCancel}</Button>
        </FormActions>
      </form>
    </div>
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
