import React from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import App from './App'
import { initFonts } from './lib/fonts'
import './styles.css'

document.documentElement.dataset.platform = window.pi.platform

// Apply the persisted accent before first paint to avoid a flash.
const accent = window.localStorage.getItem('pi-app:accent')
if (accent) document.documentElement.dataset.accent = accent

// Same for the interface/monospace typefaces (Settings → Appearance).
initFonts()

// Same for the interface language on <html lang>.
const locale = window.localStorage.getItem('pi-app:locale')
if (locale === 'en' || locale === 'zh-CN') document.documentElement.lang = locale

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <App />
    </ThemeProvider>
  </React.StrictMode>
)
