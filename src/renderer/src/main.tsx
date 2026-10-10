import React from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import App from './App'
import { initFonts } from './lib/fonts'
import { initFontSizes } from './lib/typography'
import { initReduceMotion } from './lib/reduce-motion'
import { initCompactTools } from './lib/compact-tools'
import { isLocale } from './i18n'
import './styles.css'

document.documentElement.dataset.platform = window.pi.platform
if (new URLSearchParams(window.location.search).get('view') === 'pip') {
  document.documentElement.dataset.pip = 'true'
}

// Apply the persisted accent before first paint to avoid a flash.
const accent = window.localStorage.getItem('pi-app:accent')
if (accent) document.documentElement.dataset.accent = accent

// Same for the interface/monospace typefaces (Settings → Appearance).
initFonts()
initFontSizes()

// Same for reduced motion: motion reads the flag when an animation is created, so
// setting it before the first render is what keeps the boot free of entrance
// animations.
initReduceMotion()

// Same for compact tool-call display: the transcript's row spacing is styled off
// this attribute, so setting it before the first render avoids a re-spacing
// flash on an opened session.
initCompactTools()

// Same for the interface language on <html lang>.
const locale = window.localStorage.getItem('pi-app:locale')
if (isLocale(locale)) document.documentElement.lang = locale

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <App />
    </ThemeProvider>
  </React.StrictMode>
)
