// SPDX-License-Identifier: GPL-3.0-or-later
// The subscriptions dialog of an IMAP account: every folder the server lists, ticked when it
// shows in the app (subscribed, or kept from before 0.15.0); a tick subscribes it on the server, an untick unsubscribes
// it (and drops the kept flag). Role folders always show and cannot be unticked (with the reason as a tooltip). The
// main process does the server work and a full sync after it (folders:subscriptions, folders:setSubscribed).
import { useEffect, useState } from 'react'
import { t } from '../i18n/index.js'
import { Banner, Button, Checkbox, Modal } from './ui/index.js'

const api = window.shadowMail

const depthOf = f => (f.delimiter ? f.path.split(f.delimiter).length - 1 : 0)
const nameOf = f => (f.delimiter ? f.path.split(f.delimiter).pop() : f.path)

export function SubscriptionsDialog({ accountId, accountName, onClose }) {
  const [folders, setFolders] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null) // the path being changed

  useEffect(() => {
    let alive = true
    api.folders.subscriptions({ accountId }).then(res => {
      if (!alive) return
      if (res.ok) setFolders([...res.folders].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
      else setError(t.folderError(res.error))
    })
    return () => {
      alive = false
    }
  }, [accountId])

  const toggle = async (f, on) => {
    setError(null)
    setBusy(f.path)
    const res = await api.folders.setSubscribed({ accountId, path: f.path, subscribed: on })
    setBusy(null)
    if (!res.ok) return setError(t.folderError(res.error))
    setFolders(list => list.map(x => (x.path === f.path ? { ...x, shown: on, subscribed: on, kept: false } : x)))
  }

  return (
    <Modal
      title={t.subscriptions.title(accountName)}
      className="subscriptions-dialog"
      onClose={onClose}
      actions={[<Button key="close" variant="primary" data-autofocus onClick={onClose}>{t.subscriptions.close}</Button>]}
    >
      <p className="hint">{t.subscriptions.help}</p>
      {error && <Banner kind="error" className="subscriptions-error">{error}</Banner>}
      {!folders && !error && <p className="hint subscriptions-loading">{t.subscriptions.loading}</p>}
      {folders && (
        <ul className="subscriptions-list">
          {folders.map(f => {
            const locked = Boolean(f.role)
            return (
              <li key={f.path} data-path={f.path} style={{ '--depth': depthOf(f) }} title={locked ? t.subscriptions.roleLocked : f.path}>
                <Checkbox
                  label={nameOf(f)}
                  checked={f.shown}
                  disabled={locked || busy !== null}
                  onChange={e => toggle(f, e.target.checked)}
                />
                {f.kept && <span className="subscriptions-kept">{t.subscriptions.kept}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
