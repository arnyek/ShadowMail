// SPDX-License-Identifier: GPL-3.0-or-later
// Beállítások / Címkék (0.17.0): the label list, shared by every account, only on this computer. A row: the color
// swatch, the name (renamed in place: Enter or leaving the field saves, Esc gives the old one back), the number of
// messages, the color (the 12 offered colors as the native color picker's suggestions, any other color in the picker
// itself), up / down, delete with a confirmation that names the number of messages. "New label": name + color.
// Every change goes through labels:* (only the database) and comes back as { kind: 'labels' }: the list's and the
// reader's chips draw again; this page loads again too.
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n/index.js'
import { Button, IconButton, Modal, PageHeader, TextField } from './ui/index.js'
import { LABEL_PALETTE } from './label-chips.js'
import { nextLabelColor } from './LabelPicker.jsx'

const api = () => window.shadowMail
const COLOR_DELAY_MS = 250 // the native picker sends a value at every drag step: one save after it rests

function LabelRow({ label, first, last, onMove, onDelete, onChanged }) {
  const [name, setName] = useState(label.name)
  const [error, setError] = useState(null)
  const colorTimer = useRef(null)
  const pendingColor = useRef(null) // the picker's last value while it waits COLOR_DELAY_MS
  useEffect(() => setName(label.name), [label.name])
  // leaving the page (another tab) inside the wait: the color is sent now, not dropped; the { kind: 'labels' } event
  // tells the rest of the app
  useEffect(
    () => () => {
      clearTimeout(colorTimer.current)
      if (pendingColor.current !== null) api().labels.setColor(label.id, pendingColor.current)
    },
    [label.id],
  )

  const rename = async () => {
    const next = name.trim()
    if (next === label.name) {
      setName(label.name)
      setError(null)
      return
    }
    const res = await api().labels.rename(label.id, next)
    if (res && res.ok) {
      setError(null)
      onChanged()
    } else setError(t.labels.error(res && res.error))
  }
  const color = value => {
    clearTimeout(colorTimer.current)
    pendingColor.current = value
    colorTimer.current = setTimeout(async () => {
      pendingColor.current = null
      const res = await api().labels.setColor(label.id, value)
      if (res && res.ok) onChanged()
      else setError(t.labels.error(res && res.error))
    }, COLOR_DELAY_MS)
  }
  return (
    <li className="labels-row" data-label-id={label.id} tabIndex={-1}>
      <span className="label-swatch" style={{ backgroundColor: label.color, borderColor: label.color }} aria-hidden="true" />
      <div className="labels-row-name">
        <input
          className="text-field-input labels-name"
          value={name}
          aria-label={t.labelsPage.renameOf(label.name)}
          aria-invalid={error ? 'true' : undefined}
          maxLength={200}
          onChange={e => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              rename()
            } else if (e.key === 'Escape') {
              setName(label.name)
              setError(null)
            }
          }}
        />
        {error ? (
          <p className="field-error labels-row-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <span className="labels-count">{t.labelsPage.count(label.count)}</span>
      <input
        type="color"
        className="labels-color"
        list="label-palette"
        defaultValue={label.color}
        key={label.color}
        aria-label={t.labelsPage.colorOf(label.name)}
        title={t.labelsPage.colorOf(label.name)}
        onChange={e => color(e.target.value)}
      />
      <IconButton icon="moveUp" className="labels-up" label={t.labelsPage.up(label.name)} disabled={first} onClick={() => onMove(-1)} />
      <IconButton icon="moveDown" className="labels-down" label={t.labelsPage.down(label.name)} disabled={last} onClick={() => onMove(1)} />
      <IconButton icon="trash" className="labels-delete" label={t.labelsPage.remove(label.name)} onClick={onDelete} />
    </li>
  )
}

function NewLabel({ list, onDone }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(() => nextLabelColor(list))
  const [error, setError] = useState(null)
  const submit = async e => {
    e.preventDefault()
    const res = await api().labels.create(name, color)
    if (res && res.ok) onDone(true)
    else setError(t.labels.error(res && res.error))
  }
  return (
    <form className="labels-new form-card" onSubmit={submit}>
      <TextField label={t.labelsPage.name} className="labels-new-name" value={name} onChange={e => setName(e.target.value)} error={error} width="m" autoFocus />
      <label className="labels-new-color">
        <span className="text-field-label">{t.labelsPage.color}</span>
        <input type="color" className="labels-color" list="label-palette" value={color} onChange={e => setColor(e.target.value)} />
      </label>
      <div className="labels-new-actions">
        <Button variant="filled" type="submit" className="labels-create">
          {t.labelsPage.create}
        </Button>
        <Button type="button" onClick={() => onDone(false)}>
          {t.labelsPage.cancel}
        </Button>
      </div>
    </form>
  )
}

export function LabelsSettings() {
  const [list, setList] = useState(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [error, setError] = useState(null)
  // the deletion runs on the servers (IMAP): the dialog shows it works, and a server that failed keeps it open
  const [busy, setBusy] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  const page = useRef(null)
  const moved = useRef(null) // { id, step }: the row and the button a move started from, for the focus after it
  const load = () => api().labels.list().then(res => res && res.ok && setList(res.labels))
  // a move redraws the list: the pressed button may now be disabled (the row reached the edge) or gone; the focus
  // must not fall to the page's body
  useEffect(() => {
    const m = moved.current
    if (!m || !page.current) return
    moved.current = null
    const row = page.current.querySelector(`.labels-row[data-label-id="${m.id}"]`)
    if (!row) return
    const same = row.querySelector(m.step < 0 ? '.labels-up' : '.labels-down')
    const other = row.querySelector(m.step < 0 ? '.labels-down' : '.labels-up')
    const target = [same, other].find(b => b && !b.disabled) || row
    if (document.activeElement !== target) target.focus()
  }, [list])
  useEffect(() => {
    load()
    return api().onStatus(p => p.kind === 'labels' && load())
  }, [])

  const move = async (index, step) => {
    const ids = list.map(l => l.id)
    const [id] = ids.splice(index, 1)
    ids.splice(index + step, 0, id)
    moved.current = { id, step }
    const res = await api().labels.reorder(ids)
    if (res && res.ok) setList(res.labels)
    else {
      setError(t.labels.error(res && res.error))
      load()
    }
  }
  const closeDelete = () => {
    setDeleting(null)
    setDeleteError(null)
  }
  const remove = async () => {
    setBusy(true)
    setDeleteError(null)
    const res = await api().labels.remove(deleting.id)
    if (res && res.ok && res.deleted === false) {
      const known = await api().accounts.list().catch(() => null)
      const nameOf = id => ((known && known.accounts) || []).find(a => a.id === id)?.name || `#${id}`
      setDeleteError(t.labelsPage.deleteFailed([...new Set(res.failed.map(f => nameOf(f.accountId)))].join(', ')))
      setBusy(false)
      load()
      return
    }
    setBusy(false)
    closeDelete()
    if (!res || !res.ok) setError(t.labels.error(res && res.error))
    load()
  }

  return (
    <div className="settings-cards labels-settings" ref={page}>
      <PageHeader title={t.settingsNav.labels} subtitle={t.labelsPage.subtitle} />
      <datalist id="label-palette">
        {LABEL_PALETTE.map(c => (
          <option key={c} value={c} />
        ))}
      </datalist>
      {error ? (
        <p className="field-error labels-error" role="alert">
          {error}
        </p>
      ) : null}
      {adding ? (
        <NewLabel list={list || []} onDone={made => (setAdding(false), made && load())} />
      ) : (
        <div>
          <Button variant="outlined" icon="plus" className="labels-add" onClick={() => setAdding(true)}>
            {t.labelsPage.add}
          </Button>
        </div>
      )}
      {list && !list.length && !adding ? <p className="hint labels-empty">{t.labelsPage.empty}</p> : null}
      {list && list.length ? (
        <ul className="labels-list form-card">
          {list.map((l, i) => (
            <LabelRow key={l.id} label={l} first={i === 0} last={i === list.length - 1} onMove={step => move(i, step)} onDelete={() => setDeleting(l)} onChanged={load} />
          ))}
        </ul>
      ) : null}
      {deleting ? (
        <Modal
          title={t.labelsPage.deleteTitle}
          className="labels-delete-modal"
          role="alertdialog"
          onClose={() => !busy && closeDelete()}
          actions={
            <>
              <Button className="labels-delete-cancel" onClick={closeDelete} disabled={busy} data-autofocus>
                {t.labelsPage.cancel}
              </Button>
              <Button variant="filled" className="labels-delete-yes danger" onClick={remove} disabled={busy} aria-busy={busy || undefined}>
                {busy ? t.labelsPage.deleting : t.labelsPage.deleteYes}
              </Button>
            </>
          }
        >
          {/* the count as the list has it NOW: a label put on or taken off meanwhile (the list, Claude) reloads the list */}
          <p className="confirm-text">{t.labelsPage.deleteText(deleting.name, (list || []).find(l => l.id === deleting.id)?.count ?? deleting.count)}</p>
          {deleteError ? (
            <p className="field-error labels-delete-error" role="alert">
              {deleteError}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  )
}
