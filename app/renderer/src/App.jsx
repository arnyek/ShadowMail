// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react'
import { t, lang } from '../i18n/index.js'
import { LANGUAGES } from '../../../core/ui-language.js'
import { ClaudeConfirm } from './ClaudeConfirm.jsx'
import { ClaudeAccess } from './ClaudeAccess.jsx'
import { VaultCreate, VaultUnlock, VaultChange, RecoveryCodeScreen, RecoveryNew } from './Vault.jsx'
import { Accounts } from './Accounts.jsx'
import { Mail } from './Mail.jsx'
import { Contacts } from './Contacts.jsx'
import { ReaderPaneButton, READER_PANES, readerPaneOf } from './ReaderPaneButton.jsx'
import { Icon } from './Icon.jsx'
import { Banner, Button, Checkbox, IconButton, PageHeader, Select, SettingList, SettingRow, Splitter } from './ui/index.js'
import { getPref, setPref } from './prefs.js'
import { THEMES, applyTheme, themeOf } from './themes.js'

// the room the settings content keeps besides the menu (paddings, the gap and the cards' own minimum)
const SETTINGS_CONTENT_MIN = 480

const api = window.shadowMail

// a change of the interface language reloads the window, which then opens Beállítások / Megjelenés again (read once, at load)
const REOPEN_KEY = 'shadowMail.reopenSettings'
const REOPEN_TAB = (() => {
  try {
    const v = sessionStorage.getItem(REOPEN_KEY)
    sessionStorage.removeItem(REOPEN_KEY)
    return v === 'appearance' ? v : null
  } catch {
    return null
  }
})()

/** Settings / Névjegy: asked again when shown (the SQLite version needs the open database). */
function About() {
  const [info, setInfo] = useState(null)
  useEffect(() => {
    api.hello().then(setInfo, () => {})
  }, [])
  if (!info) return null
  return (
    <dl className="about">
      <dt>{t.helloDataDir}</dt>
      <dd>{info.dataDir}</dd>
      <dt>{t.helloSqlite}</dt>
      <dd>{info.sqliteVersion}</dd>
      <dt>{t.helloVersion}</dt>
      <dd>{info.appVersion}</dd>
    </dl>
  )
}

/**
 * The interface language: picked from the menu it is stored at once (data\ui.json, through the main process, which
 * also saves and closes the open composers), then the window reloads in it, back on this tab; the vault stays open.
 */
function LanguageSetting() {
  const [state, setState] = useState(null) // null | 'applying' | 'failed'
  const choose = async v => {
    if (v === lang || state === 'applying') return
    setState('applying')
    try {
      sessionStorage.setItem(REOPEN_KEY, 'appearance')
    } catch {
      // without it the window reloads into the mail view
    }
    // on success the main process reloads this window (the request may not even answer before that)
    const res = await api.setLanguage(v).catch(() => null)
    if (res && res.ok) return
    try {
      sessionStorage.removeItem(REOPEN_KEY)
    } catch {
      // nothing to undo
    }
    setState('failed')
  }
  return (
    <SettingRow className="setting-language" label={t.languageLabel} description={t.settingDesc.language}>
      <Select
        id="ui-language"
        label={t.languageLabel}
        value={lang}
        disabled={state === 'applying'}
        options={LANGUAGES.map(v => ({ value: v, label: t.languageOptions[v] }))}
        onChange={choose}
      />
      {state === 'applying' && <p className="setting-note" role="status">{t.languageApplying}</p>}
      {state === 'failed' && <p className="error" role="alert">{t.languageFailed}</p>}
    </SettingRow>
  )
}

/** The interface theme: applied at once (no reload) and stored; main.jsx puts it on the page before the first render. */
// a classic style also sets the reading pane, once, when it is chosen here (never at start, never for another theme)
function ThemeSetting({ onReaderPane }) {
  const [theme, setTheme] = useState(() => themeOf(getPref('theme', null)).id)
  const choose = v => {
    const id = applyTheme(v)
    setPref('theme', id)
    setTheme(id)
    const pane = themeOf(id).readerPane
    if (pane) onReaderPane(pane)
  }
  return (
    <SettingRow className="setting-theme" label={t.themeLabel} description={t.settingDesc.theme}>
      <Select id="ui-theme" label={t.themeLabel} value={theme} options={THEMES.map(x => ({ value: x.id, label: t.themes[x.id] }))} onChange={choose} />
    </SettingRow>
  )
}

/**
 * The unread badge on the taskbar button: the main process holds the switch (encrypted settings, ON by default), so it
 * is asked, not read from the view prefs. Shown only once the answer is in: no flash of a wrong state.
 */
function TaskbarUnreadSetting() {
  const [enabled, setEnabled] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let alive = true
    api.taskbar.status().then(r => alive && r && r.ok && setEnabled(r.enabled), () => {})
    return () => {
      alive = false
    }
  }, [])
  if (enabled === null) return null
  const toggle = async on => {
    setError(null)
    const r = await api.taskbar.setEnabled(on).catch(() => null)
    if (r && r.ok) setEnabled(r.enabled)
    else setError(t.taskbarUnreadFailed)
  }
  return (
    <SettingRow className="setting-taskbar" label={t.taskbarUnreadLabel} description={t.settingDesc.taskbar}>
      <Checkbox id="taskbar-unread-switch" switch hideLabel checked={enabled} onChange={e => toggle(e.target.checked)} label={t.taskbarUnreadLabel} />
      {error && <p className="error" role="alert">{error}</p>}
    </SettingRow>
  )
}

/** Where a message opens: the App's value, the same one the header's quick switch changes. The language, the theme, the taskbar badge. */
function AppearanceSettings({ readerPane, onReaderPane }) {
  return (
    <section className="settings-appearance">
      <PageHeader title={t.settingsAppearance} />
      <div className="form-card">
        <SettingList>
          <LanguageSetting />
          <ThemeSetting onReaderPane={onReaderPane} />
          <SettingRow className="setting-reader-pane" label={t.readerPaneLabel} description={t.settingDesc.readerPane} labelId="reader-pane-label">
            <Select
              id="reader-pane"
              label={t.readerPaneLabel}
              value={readerPane}
              options={READER_PANES.map(v => ({ value: v, label: t.readerPaneOptions[v] }))}
              onChange={onReaderPane}
            />
          </SettingRow>
          <TaskbarUnreadSetting />
        </SettingList>
      </div>
    </section>
  )
}

// an editor outside the mail view whose input would be lost by a view change: the Címlista
// editor, the account editor, or any typed password (Beállítások / Biztonság)
function hasOpenEditor() {
  if (document.querySelector('form.contact-editor, form.account-editor')) return true
  return [...document.querySelectorAll('section.settings input[type="password"]')].some(i => i.value !== '')
}

export function App() {
  const [info, setInfo] = useState(null)
  const [vault, setVault] = useState(null) // { exists, unlocked }
  const [error, setError] = useState(null)
  const [view, setView] = useState(REOPEN_TAB ? 'settings' : 'mail')
  useEffect(() => {
    viewRef.current = view
  }, [view])
  // the settings menu's divider (180-400 px, and at most what leaves the content SETTINGS_CONTENT_MIN: in a small window
  // a wide menu would push the cards out; measured: the Megjelenés tab needs ~450 px besides the menu)
  const settingsRef = useRef(null)
  const settingsNavRef = useRef(null)
  const settingsNavMeasure = useCallback(() => settingsNavRef.current?.getBoundingClientRect().width ?? 0, [])
  const settingsNavMax = useCallback(() => Math.min(400, (settingsRef.current?.clientWidth ?? 0) - SETTINGS_CONTENT_MIN), [])
  const [settingsTab, setSettingsTab] = useState(REOPEN_TAB || 'accounts') // Fiókok | Megjelenés | Biztonság | Névjegy
  const openSettings = tab => {
    setSettingsTab(tab)
    setView('settings')
  }
  // the sidebar folded to icons, kept over restarts
  const [collapsed, setCollapsed] = useState(() => getPref('sidebarCollapsed', false) === true)
  const [searchSlot, setSearchSlot] = useState(null) // the header's place for the search field
  const toggleSidebar = () =>
    setCollapsed(c => {
      setPref('sidebarCollapsed', !c)
      return !c
    })
  // where a message opens: ONE value for the mail view, the header's quick switch and Beállítások / Megjelenés,
  // kept over restarts (a damaged stored value: the default)
  const [readerPane, setReaderPane] = useState(() => readerPaneOf(getPref('readerPane', 'none')))
  const chooseReaderPane = useCallback(v => {
    const pane = readerPaneOf(v)
    setPref('readerPane', pane)
    setReaderPane(pane)
  }, [])

  const refresh = useCallback(async () => {
    const res = await api.vault.status()
    if (res.ok) setVault(res.status)
    else setError(t.vaultError(res.error, res.info))
  }, [])

  useEffect(() => {
    api.hello().then(setInfo, err => setError(String(err)))
    refresh().catch(err => setError(String(err)))
  }, [refresh])

  // Claude's prepare_account opens the filled-in "Új fiók" editor here
  const [prefillAccount, setPrefillAccount] = useState(null)
  // "Claude piszkozatot készített: <tárgy>" + Megnyitás (the draft in the composer)
  const [claudeDraft, setClaudeDraft] = useState(null)
  // Claude's latest request for the mail view: open_message ({ type: 'open', messageId, accountId, folder }: the message
  // opens as a click would) or show_search ({ type: 'search', conditions }). ONE state, so of two requests arriving at
  // once the later one is what the view shows (with two states the first one's taking would clear the second).
  const [claudeRequest, setClaudeRequest] = useState(null)
  // with an editor open outside the mail view the message (or the search) is only offered (a
  // banner): { type: 'open' | 'search', ...the request }
  const [claudeOffer, setClaudeOffer] = useState(null)
  // the mail view has taken THIS request: it is not applied again when the view mounts again (back from Beállítások); a
  // newer request set meanwhile stays
  const takeClaude = useCallback(taken => setClaudeRequest(cur => (cur === taken ? null : cur)), [])
  // the offer accepted, or Claude's request with no editor in the way: the mail view takes it (a new object: a new request)
  const showClaude = req => {
    setClaudeOffer(null)
    setView('mail')
    setClaudeRequest({ ...req })
  }
  const viewRef = useRef('mail')
  const openClaudeDraft = async () => {
    if (!claudeDraft) return
    const res = await api.compose.open({ mode: 'draft', accountId: claudeDraft.accountId, draftMessageId: claudeDraft.messageId })
    if (res && res.ok) setClaudeDraft(null)
    else setClaudeDraft(d => d && { ...d, error: t.claudeDraftNotYet })
  }
  const takePrefill = useCallback(() => setPrefillAccount(null), [])
  // Claude's requests waiting for the user, oldest first; one Modal at a time
  const [confirms, setConfirms] = useState([])
  const [dbUpgrade, setDbUpgrade] = useState(false) // the schema upgrade runs (lock screen notice)
  const addConfirm = useCallback(r => setConfirms(list => (list.some(x => x.id === r.id) ? list : [...list, r])), [])
  const decide = (id, approve) => {
    setConfirms(list => list.filter(x => x.id !== id))
    api.mcp.confirm(id, approve).catch(() => {})
  }
  useEffect(
    () =>
      api.onStatus(e => {
        if (e && e.kind === 'dbUpgrade') setDbUpgrade(e.phase === 'start')
        if (e && e.kind === 'confirm' && e.request) addConfirm(e.request)
        if (e && e.kind === 'confirmSettled') setConfirms(list => list.filter(x => x.id !== e.id))
        if (e && e.kind === 'claudeDraft') setClaudeDraft({ accountId: e.accountId, subject: e.subject || '', messageId: e.messageId, error: null })
        const req =
          e && e.kind === 'claudeOpen' && Number.isInteger(e.messageId)
            ? { type: 'open', messageId: e.messageId, accountId: e.accountId, folder: e.folder }
            : e && e.kind === 'claudeSearch' && e.conditions && typeof e.conditions === 'object'
              ? { type: 'search', conditions: e.conditions }
              : null
        if (req) {
          const offered = viewRef.current !== 'mail' && hasOpenEditor()
          if (offered) setClaudeOffer(req)
          else showClaude(req)
          if (Number.isInteger(e.seq)) api.mcp.openAck?.(e.seq, offered ? 'offered' : 'opened').catch(() => {})
        }
        if (e && e.kind === 'prefillAccount' && e.values) {
          setSettingsTab('accounts')
          setView('settings')
          setPrefillAccount({ ...e.values })
        }
      }),
    [],
  )
  const [lockNotice, setLockNotice] = useState(null) // drafts the last lock could not save
  const [pendingCode, setPendingCode] = useState(null) // a new recovery code waiting on its screen
  const onStatus = (status, recoveryCode = null) => {
    setVault(status)
    if (recoveryCode) setPendingCode(recoveryCode)
    if (status && status.unlocked) {
      api.vault.lockNotice().then(r => setLockNotice(r && r.ok && r.failedDrafts ? t.lockDraftsFailed(r.failedDrafts) : null), () => {})
      // a request made before this page listened (a reload): the main process still holds it
      api.mcp.confirmations().then(r => r && r.ok && r.requests.forEach(addConfirm), () => {})
    }
  }
  const lock = async () => {
    const res = await api.vault.lock()
    if (res.ok) setClaudeDraft(null)
    if (res.ok) setConfirms([]) // the main process rejected them all with the lock
    if (res.ok) setVault(res.status)
  }

  const errorLine = error && <p className="error" role="alert">{error}</p>

  if (!vault || !vault.exists || !vault.unlocked) {
    let screen = <p>{t.loading}</p>
    if (vault && !vault.exists) screen = <VaultCreate onDone={onStatus} />
    else if (vault) screen = <VaultUnlock onDone={onStatus} />
    return (
      <main className="lock-screen">
        <div className="lock-card">
          <div className="lock-brand">
            <Icon name="brand" size="m" className="brand-icon" />
            <span>{t.appTitle}</span>
          </div>
          {errorLine}
          {dbUpgrade && (
            <Banner kind="warning" id="vault-db-upgrade" role="status">
              {t.vaultDbUpgrade}
            </Banner>
          )}
          {screen}
        </div>
        {/* only the version here; the data folder and SQLite are under Beállítások / Névjegy */}
        {info && <p className="lock-version hint">{t.helloVersion}: {info.appVersion}</p>}
      </main>
    )
  }

  // a new code is shown before anything else; the page holds it only until it is confirmed
  if (pendingCode)
    return (
      <main className="lock-screen">
        <div className="lock-card lock-card-wide">
        <RecoveryCodeScreen
          code={pendingCode}
          onConfirmed={status => {
            setPendingCode(null)
            setVault(status)
          }}
        />
        </div>
      </main>
    )

  return (
    <main className="app">
      <header className="app-header">
        <div className="app-header-start">
          {view === 'mail' && (
            <IconButton icon="menu" label={collapsed ? t.sidebarExpand : t.sidebarCollapse} aria-expanded={!collapsed} onClick={toggleSidebar} />
          )}
          <span className="brand">
            <Icon name="brand" size="m" className="brand-icon" />
            <span className="brand-name">{t.appTitle}</span>
          </span>
        </div>
        <div className="app-header-search" ref={setSearchSlot} />
        <div className="app-header-end">
          {/* the address book, next to Settings; a second press goes back to the mail */}
          <IconButton icon="contacts" label={t.viewContacts} pressed={view === 'contacts'} onClick={() => setView(view === 'contacts' ? 'mail' : 'contacts')} />
          {/* the reader-pane layout, one click to the next; only where it shows (the mail view) */}
          {view === 'mail' && <ReaderPaneButton value={readerPane} onChange={chooseReaderPane} />}
          <IconButton icon="settings" label={t.viewSettings} pressed={view === 'settings'} onClick={() => (view === 'settings' ? setView('mail') : openSettings('accounts'))} />
          <IconButton icon="lock" label={t.vaultLockButton} onClick={lock} />
        </div>
      </header>
      {errorLine}
      {vault.recoveryConfirmed === false && (
        <Banner kind="warning" className="notice" actions={<Button variant="text" onClick={() => openSettings('security')}>{t.recoveryGoSettings}</Button>}>
          <p>{t.recoveryUnconfirmed}</p>
        </Banner>
      )}
      <ClaudeConfirm
        request={confirms[0] || null}
        waiting={confirms.length}
        onDecide={decide}
        onLock={lock}
        onRejectAllOff={() => {
          // the main process rejects every waiting request (access_off); each confirmSettled removes its Modal, so a
          // failed switch-off leaves them on the screen
          api.mcp.setEnabled(false).then(r => r && r.ok === false && setError(t.claudeConfirm.offFailed), () => setError(t.claudeConfirm.offFailed))
        }}
      />
      {claudeDraft && (
        <Banner kind="info" className="notice claude-draft-notice" onClose={() => setClaudeDraft(null)} closeLabel={t.close}
          actions={<Button variant="text" onClick={openClaudeDraft}>{t.claudeDraftOpen}</Button>}>
          <p>{t.claudeDraftNotice(claudeDraft.subject)}</p>
          {claudeDraft.error && <p className="hint">{claudeDraft.error}</p>}
        </Banner>
      )}
      {lockNotice && (
        <Banner kind="warning" className="notice" onClose={() => setLockNotice(null)} closeLabel={t.close}>
          <p>{lockNotice}</p>
        </Banner>
      )}
      {claudeOffer && (
        <Banner
          kind="info"
          className="claude-offer"
          onClose={() => setClaudeOffer(null)}
          closeLabel={t.close}
          actions={
            <Button variant="text" className="claude-offer-open" onClick={() => showClaude(claudeOffer)}>
              {claudeOffer.type === 'search' ? t.claudeOfferSearchOpen : t.claudeOfferOpen}
            </Button>
          }
        >
          <p>{claudeOffer.type === 'search' ? t.claudeOfferSearch : t.claudeOffer}</p>
        </Banner>
      )}
      {view === 'mail' ? (
        <Mail collapsed={collapsed} readerPane={readerPane} searchSlot={searchSlot} claudeRequest={claudeRequest} onClaudeTaken={takeClaude} />
      ) : view === 'contacts' ? (
        <Contacts />
      ) : (
        <section className="settings" ref={settingsRef}>
          <nav className="settings-nav" aria-label={t.settingsNavLabel} ref={settingsNavRef}>
            <Button variant="text" icon="back" className="settings-back" onClick={() => setView('mail')}>{t.backToMail}</Button>
            {[
              ['accounts', 'account'],
              ['appearance', 'settings'],
              ['security', 'lock'],
              ['claude', 'link'],
              ['about', 'info'],
            ].map(([tab, icon]) => (
              <button
                key={tab}
                type="button"
                className={`settings-tab${settingsTab === tab ? ' selected' : ''}`}
                aria-current={settingsTab === tab ? 'page' : undefined}
                onClick={() => setSettingsTab(tab)}
              >
                <Icon name={icon} size="m" />
                <span>{t.settingsNav[tab]}</span>
              </button>
            ))}
          </nav>
          <Splitter name="settings" cssVar="--settings-nav-w" label={t.splitters.settings} min={180} max={settingsNavMax} measure={settingsNavMeasure} observe={settingsRef} />
          <div className="settings-content">
            {settingsTab === 'accounts' && <Accounts prefill={prefillAccount} onPrefillTaken={takePrefill} />}
            {settingsTab === 'appearance' && <AppearanceSettings readerPane={readerPane} onReaderPane={chooseReaderPane} />}
            {settingsTab === 'security' && (
              <div className="settings-cards settings-security">
                <PageHeader title={t.settingsNav.security} />
                <VaultChange />
                <RecoveryNew onCode={setPendingCode} />
              </div>
            )}
            {settingsTab === 'claude' && <ClaudeAccess />}
            {settingsTab === 'about' && (
              <div className="settings-cards settings-about">
                <PageHeader title={t.settingsNav.about} />
                <div className="settings-card">
                  <About />
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  )
}
