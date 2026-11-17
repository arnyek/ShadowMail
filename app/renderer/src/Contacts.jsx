// SPDX-License-Identifier: GPL-3.0-or-later
// The address book view: on the left a search field and
// the people in Hungarian order (200 a page, more on scrolling), on the right the chosen person, its editor, and the
// dialogs for delete, import preview and export. The divider between them is the Splitter (--contacts-list-w).
// Everything goes through window.shadowMail.contacts (contacts:* IPC); the page never sees a file path.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n/index.js'
import { Avatar, Banner, Button, Checkbox, FormActions, FormRow, FormSection, IconButton, MenuButton, Modal, PageHeader, SearchField, Splitter, TextField } from './ui/index.js'
import { Icon } from './Icon.jsx'

const api = () => window.shadowMail
const PAGE = 200

/**
 * The link of an address on the details: the whole address percent-encoded, so a "?", "&", "," or "%" in its local
 * part (an import lets them through) stays part of the one recipient when the browser itself opens the link (middle
 * or Shift+click -> the composer's mailto: path) and cannot add a recipient, a subject or a body.
 */
export const mailtoHref = address => `mailto:${encodeURIComponent(String(address))}`
const emptyForm = () => ({ id: null, displayName: '', givenName: '', familyName: '', org: '', title: '', note: '', emails: [{ address: '', label: '', isPrimary: true }], phones: [] })

/** A person from contacts:get -> the editor's form (strings everywhere). */
function formOf(p) {
  return {
    id: p.id,
    displayName: p.displayName || '',
    givenName: p.givenName || '',
    familyName: p.familyName || '',
    org: p.org || '',
    title: p.title || '',
    note: p.note || '',
    emails: p.emails.length ? p.emails.map(e => ({ address: e.address, label: e.label || '', isPrimary: e.isPrimary })) : [],
    phones: p.phones.map(ph => ({ number: ph.number, label: ph.label || '' })),
  }
}

/** The form -> what contacts:save takes (empty rows out, empty strings null). */
function personOf(f) {
  const t = v => (v.trim() ? v : null)
  const emails = f.emails.filter(e => e.address.trim()).map(e => ({ address: e.address.trim(), label: t(e.label), isPrimary: e.isPrimary }))
  if (emails.length && !emails.some(e => e.isPrimary)) emails[0].isPrimary = true
  return {
    ...(f.id ? { id: f.id } : {}),
    displayName: f.displayName.trim(),
    givenName: t(f.givenName),
    familyName: t(f.familyName),
    org: t(f.org),
    title: t(f.title),
    note: t(f.note),
    emails,
    phones: f.phones.filter(p => p.number.trim()).map(p => ({ number: p.number.trim(), label: t(p.label) })),
  }
}

function Editor({ initial, onSaved, onCancel, onOpenOther }) {
  const [f, setF] = useState(initial)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const C = t.contacts
  const set = (k, v) => setF(x => ({ ...x, [k]: v }))
  const setRow = (list, i, k, v) => setF(x => ({ ...x, [list]: x[list].map((r, n) => (n === i ? { ...r, [k]: v } : r)) }))
  // removing the primary address hands the primary to the first one left (the save did the same: exactly one is chosen)
  const removeEmail = i =>
    setF(x => {
      const emails = x.emails.filter((_, n) => n !== i)
      return { ...x, emails: emails.length && !emails.some(e => e.isPrimary) ? emails.map((e, n) => ({ ...e, isPrimary: n === 0 })) : emails }
    })
  const save = async () => {
    setBusy(true)
    setError(null)
    const r = await api().contacts.save(personOf(f))
    setBusy(false)
    if (r.ok) onSaved(r.id)
    else setError({ code: r.error, personId: r.personId })
  }
  const field = (k, width) => <TextField label={C.fields[k]} name={k} width={width} value={f[k]} maxLength={200} onChange={e => set(k, e.target.value)} />
  return (
    <form
      className="contact-editor"
      onSubmit={e => {
        e.preventDefault()
        save()
      }}
    >
      <PageHeader title={f.id ? C.editTitle : C.newTitle} subtitle={initial.displayName || null} />
      {error && (
        <Banner kind="error" className="contact-error" role="alert">
          {C.error(error.code)}
          {error.personId ? (
            <Button variant="text" className="contact-open-other" onClick={() => onOpenOther(error.personId)}>
              {C.openOther}
            </Button>
          ) : null}
        </Banner>
      )}
      <div className="form-card">
        <FormSection className="contact-name-section" title={C.sectionName}>
          {/* the family name first; the composed display name stays "given family" (people.js) */}
          <FormRow>
            {field('familyName', 'm')}
            {field('givenName', 'm')}
          </FormRow>
          {field('displayName', 'l')}
        </FormSection>
        <FormSection className="contact-work-section" title={C.sectionWork}>
          <FormRow>
            {field('org', 'm')}
            {field('title', 'm')}
          </FormRow>
        </FormSection>
        <FormSection className="contact-rows contact-emails" title={C.emails}>
          <div className="repeat" role="group" aria-label={C.emails}>
            <span className="repeat-head">{C.headAddress}</span>
            <span className="repeat-head">{C.label}</span>
            <span className="repeat-head">{C.primaryTag}</span>
            <span />
            {f.emails.map((e, i) => (
              <div className="repeat-row contact-row" key={`e${i}`}>
                <input className="text-field-input" name={`email-${i}`} type="email" aria-label={C.emailRow(i + 1)} value={e.address} maxLength={320} onChange={ev => setRow('emails', i, 'address', ev.target.value)} />
                <input className="text-field-input" name={`email-label-${i}`} aria-label={C.emailLabelRow(i + 1)} value={e.label} maxLength={50} onChange={ev => setRow('emails', i, 'label', ev.target.value)} />
                <span className="repeat-radio">
                  <input type="radio" name="contact-primary" aria-label={C.primaryRow(i + 1)} checked={e.isPrimary}
                    onChange={() => setF(x => ({ ...x, emails: x.emails.map((r, n) => ({ ...r, isPrimary: n === i })) }))} />
                </span>
                <IconButton icon="close" label={C.removeEmail(i + 1)} onClick={() => removeEmail(i)} />
              </div>
            ))}
          </div>
          <Button variant="text" icon="plus" className="contact-add-email" onClick={() => setF(x => ({ ...x, emails: [...x.emails, { address: '', label: '', isPrimary: !x.emails.length }] }))}>
            {C.addEmail}
          </Button>
        </FormSection>
        <FormSection className="contact-rows contact-phones" title={C.phones}>
          {f.phones.length > 0 && (
            <div className="repeat repeat-phones" role="group" aria-label={C.phones}>
              <span className="repeat-head">{C.headNumber}</span>
              <span className="repeat-head">{C.label}</span>
              <span />
              {f.phones.map((p, i) => (
                <div className="repeat-row contact-row" key={`p${i}`}>
                  <input className="text-field-input" name={`phone-${i}`} type="tel" aria-label={C.phoneRow(i + 1)} value={p.number} maxLength={50} onChange={ev => setRow('phones', i, 'number', ev.target.value)} />
                  <input className="text-field-input" name={`phone-label-${i}`} aria-label={C.phoneLabelRow(i + 1)} value={p.label} maxLength={50} onChange={ev => setRow('phones', i, 'label', ev.target.value)} />
                  <IconButton icon="close" label={C.removePhone(i + 1)} onClick={() => setF(x => ({ ...x, phones: x.phones.filter((_, n) => n !== i) }))} />
                </div>
              ))}
            </div>
          )}
          <Button variant="text" icon="plus" className="contact-add-phone" onClick={() => setF(x => ({ ...x, phones: [...x.phones, { number: '', label: '' }] }))}>
            {C.addPhone}
          </Button>
        </FormSection>
        <FormSection className="contact-note-section" title={C.fields.note}>
          <label className="text-field w-full contact-note">
            <span className="sr-only">{C.fields.note}</span>
            <textarea className="text-field-input" name="note" rows={4} maxLength={10_000} value={f.note} onChange={e => set('note', e.target.value)} />
          </label>
        </FormSection>
        <FormActions sticky className="contact-editor-actions">
          <Button variant="primary" type="submit" disabled={busy}>
            {C.save}
          </Button>
          <Button variant="text" onClick={onCancel}>
            {C.cancel}
          </Button>
        </FormActions>
      </div>
    </form>
  )
}

function Details({ person, onWrite, onEdit, onDelete }) {
  const C = t.contacts
  const primary = person.emails.find(e => e.isPrimary) || person.emails[0]
  const name = person.displayName || [person.givenName, person.familyName].filter(Boolean).join(' ')
  const link = address => e => {
    e.preventDefault()
    onWrite(address)
  }
  return (
    <section className="contact-details" data-person-id={person.id}>
      <header className="contact-head contact-hero">
        <Avatar name={name} address={primary?.address} />
        <div className="contact-hero-text">
          <h2 className="contact-name">{name || primary?.address || C.noName}</h2>
          {(person.title || person.org) && <p className="contact-org contact-sub">{[person.title, person.org].filter(Boolean).join(' \u00b7 ')}</p>}
        </div>
      </header>
      <div className="contact-actions contact-toolbar">
        <Button variant="primary" icon="compose" className="contact-write" disabled={!primary} onClick={() => onWrite(primary.address)}>
          {C.write}
        </Button>
        <Button variant="outlined" icon="edit" className="contact-edit" onClick={onEdit}>
          {C.edit}
        </Button>
        <span className="spacer" />
        <Button variant="text" icon="trash" className="contact-delete" onClick={onDelete}>
          {C.delete}
        </Button>
      </div>
      <div className="form-card contact-data">
        <dl className="detail-list contact-fields">
          {person.emails.length > 0 && (
            <>
              <dt>{C.detailEmail}</dt>
              <dd className="detail-values">
                {person.emails.map(e => (
                  <div key={e.address} className="detail-value contact-email">
                    <a href={mailtoHref(e.address)} onClick={link(e.address)}>{e.address}</a>
                    {e.label ? <span className="contact-label">{e.label}</span> : null}
                    {e.isPrimary ? <span className="tag tag-accent contact-primary">{C.primaryTag}</span> : null}
                  </div>
                ))}
              </dd>
            </>
          )}
          {person.phones.length > 0 && (
            <>
              <dt>{C.detailPhone}</dt>
              <dd className="detail-values">
                {person.phones.map((p, i) => (
                  <div key={`${p.number}-${i}`} className="detail-value contact-phone">
                    {p.number}
                    {p.label ? <span className="contact-label">{p.label}</span> : null}
                  </div>
                ))}
              </dd>
            </>
          )}
          {person.org && (
            <>
              <dt>{C.fields.org}</dt>
              <dd className="contact-org-value">{person.org}</dd>
            </>
          )}
          {person.title && (
            <>
              <dt>{C.fields.title}</dt>
              <dd className="contact-title-value">{person.title}</dd>
            </>
          )}
          {person.note && (
            <>
              <dt>{C.fields.note}</dt>
              <dd className="contact-note-text">{person.note}</dd>
            </>
          )}
          {person.source && (
            <>
              <dt>{C.detailSource}</dt>
              <dd>
                <span className={`contact-source source-${person.source}`} title={C.sourceHint[person.source]}>{C.source[person.source]}</span>
              </dd>
            </>
          )}
        </dl>
      </div>
    </section>
  )
}

function ImportPreview({ preview, onApply, onClose }) {
  const [busy, setBusy] = useState(false)
  const c = preview.counts
  return (
    <Modal
      title={t.contacts.importTitle}
      className="import-preview"
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {t.contacts.cancel}
          </Button>
          <Button
            variant="primary"
            className="import-apply"
            disabled={busy || c.new + c.merged === 0}
            onClick={async () => {
              setBusy(true)
              await onApply()
            }}
          >
            {t.contacts.doImport}
          </Button>
        </>
      }
    >
      <p className="import-counts" data-new={c.new} data-merged={c.merged} data-unchanged={c.unchanged} data-invalid={c.invalid} data-warnings={c.warnings}>
        {t.contacts.importCounts(c)}
      </p>
      {preview.sample.length > 0 && (
        <>
          <h3>{t.contacts.importSample}</h3>
          <ul className="import-sample">
            {preview.sample.map((s, i) => (
              <li key={i}>
                {s.name || s.address || t.contacts.noName}
                {s.address && s.name ? <span className="contact-label"> &lt;{s.address}&gt;</span> : null} · {t.contacts.importKind[s.kind]}
              </li>
            ))}
          </ul>
        </>
      )}
      {c.warnings > 0 && (
        <>
          <h3>{t.contacts.importWarnings(c.warnings)}</h3>
          <ul className="import-warnings">
            {preview.warnings.map((w, i) => (
              <li key={i} data-reason={w.reason}>
                {t.contacts.row(w.row)}: {t.contacts.reason(w.reason, w.dropped)}
              </li>
            ))}
          </ul>
        </>
      )}
      {c.invalid > 0 && (
        <>
          <h3>{t.contacts.importInvalid}</h3>
          <ul className="import-invalid">
            {preview.invalid.map((w, i) => (
              <li key={i} data-reason={w.reason}>
                {t.contacts.row(w.row)}: {t.contacts.reason(w.reason)}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  )
}

export function Contacts() {
  const [q, setQ] = useState('')
  const [list, setList] = useState({ items: [], total: 0 })
  const [selection, setSelection] = useState(() => new Set())
  const [openId, setOpenId] = useState(null)
  const [person, setPerson] = useState(null)
  const [editing, setEditing] = useState(null) // the editor's starting form
  const [confirm, setConfirm] = useState(null) // ids to delete
  const [preview, setPreview] = useState(null)
  const [notice, setNotice] = useState(null) // { kind, text }
  const [version, setVersion] = useState(0)
  const searchRef = useRef(null)
  const listRef = useRef(null)
  const bodyRef = useRef(null)
  const loading = useRef(false)

  const load = useCallback(async (offset = 0) => {
    loading.current = true
    const r = await api().contacts.list({ q, offset, limit: PAGE })
    loading.current = false
    if (!r.ok) return setNotice({ kind: 'error', text: t.contacts.error(r.error) })
    setList(l => (offset === 0 ? { items: r.items, total: r.total } : { items: [...l.items, ...r.items], total: r.total }))
  }, [q])
  useEffect(() => {
    const t = setTimeout(() => load(0), q ? 200 : 0)
    return () => clearTimeout(t)
  }, [load, version, q])
  useEffect(() => {
    let live = true
    if (!openId) return setPerson(null)
    api().contacts.get(openId).then(r => live && setPerson(r.ok ? r.person : null))
    return () => {
      live = false
    }
  }, [openId, version])
  // the selection is always within the listed people (a search must not hide a selection that a Delete or
  // an export of "the selected" would then take; the same rule as the mail list's)
  useEffect(() => {
    setSelection(s => {
      if (!s.size) return s
      const listed = new Set(list.items.map(x => x.id))
      const kept = [...s].filter(id => listed.has(id))
      return kept.length === s.size ? s : new Set(kept)
    })
  }, [list.items])
  const nameOf = id => {
    const it = list.items.find(x => x.id === id)
    return it ? it.name || it.address || t.contacts.noName : person && person.id === id ? person.displayName || t.contacts.noName : t.contacts.noName
  }
  // Ctrl+F: the search field
  useEffect(() => {
    const onKey = e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const reload = () => setVersion(v => v + 1)
  const open = id => {
    setEditing(null)
    setOpenId(id)
  }
  const onScroll = e => {
    const el = e.currentTarget
    if (!loading.current && list.items.length < list.total && el.scrollTop + el.clientHeight > el.scrollHeight - 200) load(list.items.length)
  }
  const onListKey = e => {
    const i = list.items.findIndex(x => x.id === openId)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = list.items[Math.max(0, Math.min(list.items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) {
        open(next.id)
        listRef.current?.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' })
      }
    } else if (e.key === 'Enter' && i >= 0) {
      e.preventDefault()
      open(list.items[i].id)
    } else if (e.key === 'Delete') {
      e.preventDefault()
      const ids = selection.size ? [...selection] : openId ? [openId] : []
      if (ids.length) setConfirm(ids)
    }
  }
  const toggle = id =>
    setSelection(s => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const doDelete = async () => {
    const ids = confirm
    setConfirm(null)
    const r = await api().contacts.delete(ids)
    if (!r.ok) return setNotice({ kind: 'error', text: t.contacts.error(r.error) })
    setNotice({ kind: 'info', text: t.contacts.deleted(r.removed) })
    setSelection(new Set())
    if (ids.includes(openId)) setOpenId(null)
    reload()
  }
  const doImport = async () => {
    setNotice(null)
    const r = await api().contacts.importPreview()
    if (!r.ok) return setNotice({ kind: 'error', text: t.contacts.error(r.error) })
    if (r.canceled) return
    setPreview(r)
  }
  const applyImport = async () => {
    const r = await api().contacts.importApply(preview.token)
    setPreview(null)
    if (!r.ok) return setNotice({ kind: 'error', text: t.contacts.error(r.error) })
    setNotice({ kind: 'info', text: t.contacts.imported(r.counts) })
    reload()
  }
  const doExport = async (format, onlySelected) => {
    setNotice(null)
    const r = await api().contacts.export(onlySelected ? { ids: [...selection], format } : { all: true, format })
    if (!r.ok) return setNotice({ kind: 'error', text: t.contacts.error(r.error) })
    if (r.saved) setNotice({ kind: 'info', text: t.contacts.exported(r.count) })
  }
  const write = address => api().compose.open({ mode: 'to', to: address })
  const exportItems = useMemo(
    () => [
      { key: 'vcf', label: t.contacts.exportAllVcf, onSelect: () => doExport('vcf', false) },
      { key: 'csv', label: t.contacts.exportAllCsv, onSelect: () => doExport('csv', false) },
      { key: 'vcf-sel', label: t.contacts.exportSelVcf, disabled: !selection.size, onSelect: () => doExport('vcf', true) },
      { key: 'csv-sel', label: t.contacts.exportSelCsv, disabled: !selection.size, onSelect: () => doExport('csv', true) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection],
  )
  const listMeasure = useCallback(() => listRef.current?.parentElement?.getBoundingClientRect().width ?? 0, [])
  const listMax = useCallback(() => (bodyRef.current?.clientWidth ?? 0) - 360, [])

  return (
    <section className="contacts" aria-label={t.contacts.title}>
      {notice && (
        <Banner kind={notice.kind} className="contacts-notice" onClose={() => setNotice(null)} closeLabel={t.close}>
          {notice.text}
        </Banner>
      )}
      <div className="contacts-body" ref={bodyRef}>
        <div className="contacts-list-pane">
          <div className="contacts-tools">
            <Button variant="tonal" icon="addContact" className="contact-new" onClick={() => setEditing(emptyForm())}>
              {t.contacts.newContact}
            </Button>
            <span className="spacer" />
            {selection.size > 0 && <IconButton icon="trash" label={t.contacts.deleteSelected} className="contacts-delete-selected" onClick={() => setConfirm([...selection])} />}
            <IconButton icon="upload" label={t.contacts.import} className="contacts-import" onClick={doImport} />
            <MenuButton label={t.contacts.export} icon="download" className="contacts-export" items={exportItems} />
          </div>
          <SearchField label={t.contacts.search} clearLabel={t.contacts.searchClear} value={q} onChange={e => setQ(e.target.value)} onClear={() => setQ('')} ref={searchRef} placeholder={t.contacts.search} className="contacts-search" />
          <p className="contacts-count" data-total={list.total}>
            {t.contacts.count(list.total)}
            {selection.size > 0 ? ` · ${t.contacts.selected(selection.size)}` : ''}
          </p>
          <ul className="contacts-list" role="listbox" aria-label={t.contacts.listLabel} tabIndex={0} ref={listRef} onScroll={onScroll} onKeyDown={onListKey}>
            {list.items.map(it => (
              <li
                key={it.id}
                role="option"
                aria-selected={it.id === openId}
                data-id={it.id}
                data-source={it.source}
                className={`contact-item${it.id === openId ? ' open' : ''}`}
                onClick={() => open(it.id)}
              >
                <Checkbox label={t.contacts.select(it.name || it.address || t.contacts.noName)} hideLabel checked={selection.has(it.id)} onChange={() => toggle(it.id)} onClick={e => e.stopPropagation()} />
                <Avatar name={it.name} address={it.address} />
                <span className="contact-item-text">
                  <span className="contact-item-name">{it.name || it.address || t.contacts.noName}</span>
                  {it.name && it.address ? <span className="contact-item-address">{it.address}</span> : null}
                </span>
                <span className={`contact-source source-${it.source}`} title={t.contacts.sourceHint[it.source]}>
                  {t.contacts.source[it.source]}
                </span>
              </li>
            ))}
          </ul>
          {list.items.length === 0 && <p className="hint pad">{q ? t.contacts.noMatch : t.contacts.empty}</p>}
        </div>
        <Splitter name="contacts" cssVar="--contacts-list-w" label={t.splitterContacts} min={280} max={listMax} measure={listMeasure} observe={bodyRef} />
        <div className="contacts-detail-pane">
          {editing ? (
            <Editor
              key={editing.id || 'new'}
              initial={editing}
              onCancel={() => setEditing(null)}
              onOpenOther={id => open(id)}
              onSaved={id => {
                setEditing(null)
                setNotice({ kind: 'info', text: t.contacts.saved })
                setOpenId(id)
                reload()
              }}
            />
          ) : person ? (
            <Details person={person} onWrite={write} onEdit={() => setEditing(formOf(person))} onDelete={() => setConfirm([person.id])} />
          ) : (
            <div className="empty-state contacts-choose">
              <span className="empty-icon">
                <Icon name="contacts" />
              </span>
              <h2>{t.contacts.emptyTitle}</h2>
              <p>{t.contacts.emptyText}</p>
              <Button variant="primary" icon="addContact" className="contacts-empty-new" onClick={() => setEditing(emptyForm())}>
                {t.contacts.newContact}
              </Button>
            </div>
          )}
        </div>
      </div>
      {confirm && (
        <Modal
          title={t.contacts.deleteTitle(confirm.length)}
          className="contacts-delete-confirm"
          onClose={() => setConfirm(null)}
          actions={
            <>
              <Button variant="text" onClick={() => setConfirm(null)}>
                {t.contacts.cancel}
              </Button>
              <Button variant="danger" className="contacts-delete-ok" onClick={doDelete}>
                {t.contacts.delete}
              </Button>
            </>
          }
        >
          {confirm.length <= 5 ? (
            <ul className="contacts-delete-names">
              {confirm.map(id => (
                <li key={id}>{nameOf(id)}</li>
              ))}
            </ul>
          ) : null}
          <p>{t.contacts.deleteText}</p>
        </Modal>
      )}
      {preview && <ImportPreview preview={preview} onApply={applyImport} onClose={() => setPreview(null)} />}
    </section>
  )
}
