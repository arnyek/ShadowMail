// SPDX-License-Identifier: GPL-3.0-or-later
// The label picker (0.17.0), shared by the list (right-click menu, the selection's toolbar) and the reader. A dialog with
// a filter field and one checkbox per label: over several messages each label is all / some (indeterminate) / none of
// them, a click puts it on every one or takes it off every one. A typed name that is not a label offers "Új címke: <név>"
// (made and put on in one step). Keyboard: the arrows move between the checkboxes, Space or Enter toggles, Enter in the
// filter takes the only match or makes the new label, Esc closes (the caller gives the focus back).
import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n/index.js'
import { Button, Checkbox, Modal, TextField } from './ui/index.js'
import { LABEL_PALETTE, chipTextColor, pickToggle } from './label-chips.js'

const api = () => window.shadowMail

const stateOf = (counts, total, id) => {
  const n = counts.get(id) || 0
  return n === 0 ? 'none' : n >= total ? 'all' : 'some'
}

/**
 * @param ids       the chosen messages' row ids
 * @param list      the label list ([{ id, name, color }] in its order)
 * @param onToggle  (labelId, 'add' | 'remove') => Promise<boolean>: the caller's (optimistic) change; false = failed
 * @param onCreate  (name) => Promise<{ label } | { error }>: makes a label (the caller then puts it on with onToggle)
 * @param onManage  opens Beállítások / Címkék, or null (no button)
 * @param onClose   closes the picker
 */
export function LabelPicker({ ids, list, onToggle, onCreate, onManage = null, onClose }) {
  const [query, setQuery] = useState('')
  const [counts, setCounts] = useState(null) // Map(label id -> rows) over `ids`; null while loading
  const [total, setTotal] = useState(ids.length)
  const [error, setError] = useState(null)
  const listRef = useRef(null)

  // the state over the chosen messages; asked again after a failed change (a batch before the failure may be stored)
  const live = useRef(true)
  const loadState = () =>
    api()
      .mail.labelState(ids)
      .then(res => {
        if (!live.current) return
        if (res && res.ok) {
          setCounts(new Map(res.counts))
          setTotal(res.total || ids.length)
        } else {
          setCounts(c => c || new Map())
          setError(t.labels.error(res && res.error))
        }
      })
  useEffect(() => {
    live.current = true
    loadState()
    return () => {
      live.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids])

  const q = query.trim()
  const shown = useMemo(() => {
    const k = q.toLocaleLowerCase()
    return k ? list.filter(l => l.name.toLocaleLowerCase().includes(k)) : list
  }, [list, q])
  const exact = q && list.some(l => l.name.toLocaleLowerCase() === q.toLocaleLowerCase())

  const toggle = async label => {
    if (!counts) return
    const action = pickToggle(stateOf(counts, total, label.id))
    const before = counts
    // the picker follows at once; a failure puts it back
    setCounts(new Map(counts).set(label.id, action === 'add' ? total : 0))
    setError(null)
    const ok = await onToggle(label.id, action)
    if (!ok) {
      setCounts(before)
      loadState()
    }
  }

  const create = async () => {
    if (!q || exact) return
    setError(null)
    const res = await onCreate(q)
    if (!res || !res.label) {
      setError(t.labels.error(res && res.error))
      return
    }
    setQuery('')
    setCounts(c => new Map(c || []).set(res.label.id, 0))
    // the "New label" button goes away with the typed name: the focus back in the filter (else it falls to the page and
    // Esc no longer reaches the dialog)
    listRef.current?.closest('.label-picker')?.querySelector('.label-picker-filter input')?.focus()
    await toggle(res.label)
  }

  const boxes = () => [...(listRef.current?.querySelectorAll('input[type=checkbox]') || [])]
  const onListKey = e => {
    const all = boxes()
    const i = all.indexOf(document.activeElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!all.length) return
      const next = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length
      all[next].focus()
    } else if (e.key === 'Enter' && i >= 0) {
      e.preventDefault()
      all[i].click()
    }
  }
  const onFilterKey = e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      boxes()[0]?.focus()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (shown.length === 1 && exact) toggle(shown[0])
      else create()
    }
  }

  return (
    <Modal
      title={t.labels.pickerTitle}
      className="label-picker"
      onClose={onClose}
      actions={
        <>
          {onManage ? (
            <Button className="label-picker-manage" onClick={onManage}>
              {t.labels.manage}
            </Button>
          ) : null}
          <Button variant="filled" className="label-picker-close" onClick={onClose}>
            {t.close}
          </Button>
        </>
      }
    >
      <TextField
        label={t.labels.filter}
        className="label-picker-filter"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={onFilterKey}
        autoComplete="off"
        data-autofocus
      />
      <ul className="label-picker-list" ref={listRef} onKeyDown={onListKey} aria-busy={counts ? undefined : 'true'}>
        {shown.map(l => {
          const state = counts ? stateOf(counts, total, l.id) : 'none'
          return (
            <li key={l.id} className="label-picker-item" data-label-id={l.id} data-state={state}>
              <span className="label-swatch" style={{ backgroundColor: l.color, borderColor: chipTextColor(l.color) }} aria-hidden="true" />
              <Checkbox
                label={l.name}
                checked={state === 'all'}
                indeterminate={state === 'some'}
                disabled={!counts}
                onChange={() => toggle(l)}
              />
            </li>
          )
        })}
      </ul>
      {!list.length && !q ? <p className="hint label-picker-empty">{t.labels.none}</p> : null}
      {q && !shown.length ? <p className="hint label-picker-nomatch">{t.labels.noMatch}</p> : null}
      {q && !exact ? (
        <Button className="label-picker-create" icon="tag" onClick={create}>
          {t.labels.create(q)}
        </Button>
      ) : null}
      {error ? (
        <p className="field-error label-picker-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  )
}

/** A color for a new label: the palette in turn by the list's length (the user changes it in Beállítások / Címkék). */
export function nextLabelColor(list) {
  return LABEL_PALETTE[list.length % LABEL_PALETTE.length]
}
