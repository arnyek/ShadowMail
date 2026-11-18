// SPDX-License-Identifier: GPL-3.0-or-later
// "Küldés később": the time picker (today 18:00, tomorrow 8:00, Monday 8:00 or a custom date and time, in the
// computer's local time). The composer schedules with it, the "Időzített" list moves a message's time with it.
import { useState } from 'react'
import { t } from '../i18n/index.js'
import { Button, Modal } from './ui/index.js'
import { quickTimes, localTime, customDefaults } from './schedule-times.js'

export function ScheduleDialog({ onPick, onCancel, now = Date.now(), title = null, okLabel = null, className = '' }) {
  const quick = quickTimes(now)
  const [choice, setChoice] = useState(quick[0].key)
  const [custom, setCustom] = useState(() => customDefaults(now))
  const [bad, setBad] = useState(false)
  const pick = () => {
    const at = choice === 'custom' ? localTime(custom.date, custom.time) : quick.find(q => q.key === choice).at
    if (at === null) return setBad(true)
    onPick(at)
  }
  const ts = t.schedule
  return (
    <Modal
      title={title || ts.title}
      className={`compose-schedule-modal${className ? ` ${className}` : ''}`}
      onClose={onCancel}
      onSubmit={pick}
      actions={[
        <Button key="cancel" variant="text" onClick={onCancel}>{ts.cancel}</Button>,
        <Button key="ok" variant="primary" type="submit" className="compose-schedule-ok">{okLabel || ts.ok}</Button>,
      ]}
    >
      <fieldset className="compose-schedule-choices">
        <legend className="sr-only">{ts.title}</legend>
        {[...quick.map(q => q.key), 'custom'].map(key => (
          <label key={key} className="radio compose-schedule-choice" data-choice={key}>
            <input type="radio" name="compose-schedule" value={key} checked={choice === key} onChange={() => (setChoice(key), setBad(false))} />
            {ts[key]}
          </label>
        ))}
      </fieldset>
      {choice === 'custom' && (
        <div className="compose-schedule-custom">
          <label>
            {ts.date}
            <input type="date" className="compose-schedule-date" value={custom.date} onChange={e => (setCustom(c => ({ ...c, date: e.target.value })), setBad(false))} />
          </label>
          <label>
            {ts.time}
            <input type="time" className="compose-schedule-time" value={custom.time} onChange={e => (setCustom(c => ({ ...c, time: e.target.value })), setBad(false))} />
          </label>
        </div>
      )}
      {bad && <p className="error" role="alert">{ts.badTime}</p>}
      <p className="hint compose-schedule-note">{ts.note}</p>
    </Modal>
  )
}
