// SPDX-License-Identifier: GPL-3.0-or-later
// MCP: the "Claude-hozzáférés" settings page. The switch (OFF by default), the state
// (Kikapcsolva / Várakozik / Kapcsolódva: N), the config snippets with the program's CURRENT path (the app never writes
// a Claude config; Másolás puts the snippet the main process makes on the clipboard), the last 20 Claude calls (in
// memory only: time, tool, result, count; never an argument) and what Claude can and cannot do. The confirmation
// switches (one per confirmed action, all ON by default): turning one OFF asks first, in a Modal of its own, and an OFF
// switch keeps a red warning below it; the main process (confirm-policy.js) holds them, no MCP tool can change them.
import { useCallback, useEffect, useState } from 'react'
import { t } from '../i18n/index.js'
import { Button, Checkbox, Modal, PageHeader, SettingList, SettingRow } from './ui/index.js'

const api = window.shadowMail
const ca = t.claudeAccess
export const POLL_MS = 1000

const timeOf = ms => {
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function stateText(status) {
  if (!status || !status.enabled) return ca.stateOff
  if (!status.running) return ca.stateStarting
  return status.connections > 0 ? ca.stateConnected(status.connections) : ca.stateWaiting
}

function Snippet({ id, title, text, copied, onCopy }) {
  return (
    <div className="claude-snippet" data-snippet={id}>
      <div className="claude-snippet-head">
        <h3>{title}</h3>
        <Button variant="tonal" icon="copy" className="claude-copy" onClick={onCopy}>
          {copied ? ca.copied : ca.copy}
        </Button>
      </div>
      <pre className="claude-snippet-text">{text}</pre>
    </div>
  )
}

/** The confirmation switches (mcp:confirmSettings / mcp:setConfirm). */
export function ConfirmSettings() {
  const [settings, setSettings] = useState(null)
  const [asking, setAsking] = useState(null) // the op whose OFF waits for the second confirmation
  const [error, setError] = useState(null)
  useEffect(() => {
    api.mcp.confirmSettings().then(r => (r && r.ok ? setSettings(r.settings) : setError(ca.confirmLoadFailed)), () => setError(ca.confirmLoadFailed))
  }, [])
  const set = async (op, on) => {
    setError(null)
    const r = await api.mcp.setConfirm(op, on)
    if (r && r.ok) setSettings(r.settings)
    else setError(ca.confirmSwitchFailed)
  }
  // turning OFF a switch that starts ON asks first; a switch that starts OFF (editing a draft: it sends nothing) does not
  const change = (op, on, defaultOn) => (on || !defaultOn ? set(op, on) : setAsking(op))
  return (
    <section className="settings-card claude-confirms">
      <h2>{ca.confirmsTitle}</h2>
      <p>{ca.confirmsIntro}</p>
      {settings && (
        <SettingList>
          {settings.map(({ op, on, defaultOn }) => (
            <SettingRow key={op} label={ca.confirmOps[op]} labelId={`claude-confirm-${op}-label`} description={ca.confirmOpDesc[op]} className="claude-confirm-row">
              <Checkbox id={`claude-confirm-${op}`} switch hideLabel checked={on} onChange={e => change(op, e.target.checked, defaultOn)} label={ca.confirmOps[op]} />
              {!on && defaultOn && (
                <p className="danger claude-confirm-off" data-op={op}>
                  {ca.confirmOffWarning(op)}
                </p>
              )}
            </SettingRow>
          ))}
        </SettingList>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {asking && (
        <Modal
          title={ca.confirmOffTitle(ca.confirmOps[asking])}
          role="alertdialog"
          className="claude-confirm-off-modal"
          onClose={() => setAsking(null)}
          actions={[
            <Button key="no" variant="text" data-autofocus onClick={() => setAsking(null)}>{ca.confirmOffCancel}</Button>,
            <Button
              key="yes"
              variant="danger"
              className="claude-confirm-off-yes"
              onClick={() => {
                const op = asking
                setAsking(null)
                set(op, false)
              }}
            >
              {ca.confirmOffYes}
            </Button>,
          ]}
        >
          <p className="danger">{ca.confirmOffWarning(asking)}</p>
          <p>{ca.confirmOffNoUndo}</p>
        </Modal>
      )}
    </section>
  )
}

export function ClaudeAccess() {
  const [status, setStatus] = useState(null)
  const [info, setInfo] = useState(null)
  const [calls, setCalls] = useState([])
  const [copied, setCopied] = useState(null)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    const [s, r] = await Promise.all([api.mcp.status(), api.mcp.recent()])
    if (s && s.ok) setStatus(s)
    if (r && r.ok) setCalls(r.calls)
  }, [])
  useEffect(() => {
    refresh().catch(() => {})
    api.mcp.connectInfo().then(r => r && r.ok && setInfo(r), () => {})
    const timer = setInterval(() => refresh().catch(() => {}), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const toggle = async on => {
    setError(null)
    const r = await api.mcp.setEnabled(on)
    if (r && r.ok) setStatus(r)
    else setError(ca.switchFailed)
  }
  const copy = async which => {
    const r = await api.mcp.copy(which)
    if (r && r.ok) {
      setCopied(which)
      setTimeout(() => setCopied(c => (c === which ? null : c)), 3000)
    } else setError(ca.copyFailed)
  }

  return (
    <div className="settings-cards claude-access">
      <PageHeader title={ca.title} />
      <section className="settings-card">
        <p>{ca.intro}</p>
        <SettingList>
          <SettingRow label={ca.switchLabel}>
            <Checkbox id="claude-access-switch" switch hideLabel checked={Boolean(status && status.enabled)} onChange={e => toggle(e.target.checked)} label={ca.switchLabel} />
          </SettingRow>
        </SettingList>
        <p className="claude-state" role="status" data-state={!status || !status.enabled ? 'off' : status.connections > 0 ? 'connected' : 'waiting'}>
          {ca.stateLabel} <strong>{stateText(status)}</strong>
        </p>
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <section className="settings-card">
        <h2>{ca.connectTitle}</h2>
        <p>{ca.connectIntro}</p>
        {info && (
          <>
            <Snippet id="desktop" title={ca.desktopTitle} text={info.desktop} copied={copied === 'desktop'} onCopy={() => copy('desktop')} />
            <p className="hint">{ca.desktopHint}</p>
            <Snippet id="code" title={ca.codeTitle} text={info.code} copied={copied === 'code'} onCopy={() => copy('code')} />
            <p className="hint">{info.powershell ? ca.codeHintPowershell : ca.codeHint}</p>
          </>
        )}
        <p className="claude-moved">{ca.moved}</p>
      </section>

      <section className="settings-card">
        <h2>{ca.rulesTitle}</h2>
        <p><strong>{ca.freeTitle}</strong> {ca.free}</p>
        <p><strong>{ca.confirmTitle}</strong> {ca.confirm}</p>
        <p><strong>{ca.neverTitle}</strong> {ca.never}</p>
        <p>{ca.threat}</p>
        <p>{ca.webTools}</p>
      </section>

      <ConfirmSettings />

      <section className="settings-card">
        <h2>{ca.recentTitle}</h2>
        {calls.length === 0 ? (
          <p className="hint claude-recent-empty">{ca.recentEmpty}</p>
        ) : (
          <table className="claude-recent">
            <thead>
              <tr>
                <th>{ca.colTime}</th>
                <th>{ca.colTool}</th>
                <th>{ca.colResult}</th>
                <th>{ca.colItems}</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c, i) => (
                <tr key={`${c.at}-${i}`} data-tool={c.tool} data-result={c.result} data-kind={c.kind}>
                  <td>{timeOf(c.at)}</td>
                  <td>{c.tool}</td>
                  <td>{c.kind === 'confirm' ? ca.confirmResult(c.result) : c.kind === 'auto' ? ca.autoResult(c.result) : ca.result(c.result)}</td>
                  <td>{c.items}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">{ca.recentHint}</p>
      </section>
    </div>
  )
}
