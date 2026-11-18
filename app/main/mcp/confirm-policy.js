// SPDX-License-Identifier: GPL-3.0-or-later
// MCP: which of Claude's confirmed actions still ask the user (Settings / Claude access / Confirmations).
//
// One switch per action that asks today (confirm.js): send, delete messages for good, delete a folder, change an
// account, delete an account, restart a stopped account's login; and editing a draft (update_draft), which starts OFF.
// Stored in the encrypted settings as `mcp_confirm:<op>` = 'on' | 'off'; for the others anything but 'off' (missing,
// damaged) is ON, so they start ON and nothing damaged turns one off; for a DEFAULT_OFF_OPS op only 'on' is ON. Only the user changes them, in the main window (ipc mcp:setConfirm); no MCP tool reaches them.
//
// The send switch off does not open sending to anyone: a message goes without the Modal only when EVERY recipient
// (to, cc, bcc) is in the address book (manual, import or auto; case-free address, the name does not count). Any
// other address brings the Modal as before, which names the unknown ones. An MCP send never adds its recipients to
// the address book (compose.js sendNow addPeople: false), so the book grows only from the user's own decisions.

export const CONFIRM_OPS = Object.freeze(['send', 'deleteMessages', 'deleteFolder', 'updateAccount', 'deleteAccount', 'restartLogin', 'updateDraft'])
// the ops whose switch starts OFF: editing a draft sends nothing (it asks only when the user turns it on); for these
// only 'on' is ON, so a missing or damaged value keeps the default
export const DEFAULT_OFF_OPS = Object.freeze(['updateDraft'])
// the tools of each op (tools.js askConfirm's first argument)
export const TOOL_OPS = Object.freeze({
  send_message: 'send',
  send_draft: 'send',
  trash_messages: 'deleteMessages',
  delete_folder: 'deleteFolder',
  update_account: 'updateAccount',
  delete_account: 'deleteAccount',
  sync_account: 'restartLogin',
  update_draft: 'updateDraft',
})
export const confirmKey = op => `mcp_confirm:${op}`

/**
 * @param settings  { get(key), set(key, value) } (the session's encrypted settings)
 * @param people    People (unknownOf), for the send rule; without it a send always asks
 * @param log       (line): the op and on/off only
 */
export function createConfirmPolicy({ settings, people = null, log = () => {} }) {
  const isOn = op => (DEFAULT_OFF_OPS.includes(op) ? settings.get(confirmKey(op)) === 'on' : settings.get(confirmKey(op)) !== 'off')
  return {
    /** [{ op, on, defaultOn }] in CONFIRM_OPS order. */
    list: () => CONFIRM_OPS.map(op => ({ op, on: isOn(op), defaultOn: !DEFAULT_OFF_OPS.includes(op) })),
    isOn,
    /** The user's switch (main window only). An unknown op is refused. */
    set(op, on) {
      if (!CONFIRM_OPS.includes(op) || typeof on !== 'boolean') throw Object.assign(new Error('bad op'), { code: 'bad_request' })
      if (isOn(op) === on) return { op, on }
      settings.set(confirmKey(op), on ? 'on' : 'off')
      log(`mcp confirm setting ${op} ${on ? 'on' : 'off'}`)
      return { op, on }
    },
    /**
     * Must this request ask? -> { ask, unknown }. An unknown tool always asks. A send with its switch off asks only
     * when a recipient is not in the address book; `unknown` names them (the Modal shows them).
     */
    decide(tool, { recipients = [] } = {}) {
      const op = TOOL_OPS[tool]
      if (!op || isOn(op)) return { ask: true, unknown: [] }
      if (op !== 'send') return { ask: false, unknown: [] }
      if (!people || !recipients.length) return { ask: true, unknown: [] }
      const unknown = people.unknownOf(recipients)
      return { ask: unknown.length > 0, unknown }
    },
  }
}
