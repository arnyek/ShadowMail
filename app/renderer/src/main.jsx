// SPDX-License-Identifier: GPL-3.0-or-later
import { createRoot } from 'react-dom/client'
import { applyTheme } from './themes.js'
import { getPref } from './prefs.js'
import { App } from './App.jsx'
import { Composer } from './Composer.jsx'
import { lang } from '../i18n/index.js'
import './theme.css'
import './ui/ui.css'
import './app.css'

// the page's language (index.html says hu; the interface language comes from the preload)
document.documentElement.lang = lang
// the theme before the first render, from the stored choice (no flash of the default look)
applyTheme(getPref('theme', null))
performance.mark('shadowmail-theme-applied')

// The composer window loads the same page with #compose=<session id>.
const compose = /^#compose=([0-9a-f-]{36})$/.exec(window.location.hash)
createRoot(document.getElementById('root')).render(compose ? <Composer sessionId={compose[1]} /> : <App />)
