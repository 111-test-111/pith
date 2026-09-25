import React from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import App from './App'
import { initFonts } from './lib/fonts'
import { initReduceMotion } from './lib/reduce-motion'
import { initCompactTools } from './lib/compact-tools'
import './styles.css'

document.documentElement.dataset.platform = window.pi.platform

// Apply the persisted accent before first paint to avoid a flash.
const accent = window.localStorage.getItem('pi-app:accent')
if (accent) document.documentElement.dataset.accent = accent

// Same for the interface/monospace typefaces (Settings → Appearance).
initFonts()

// Same for 「关闭动效」: motion reads the flag when an animation is created, so
// setting it before the first render is what keeps the boot free of entrance
// animations.
initReduceMotion()

// Same for 「紧凑显示连续工具调用」: the transcript's row spacing is styled off
// this attribute, so setting it before the first render avoids a re-spacing
// flash on an opened session.
initCompactTools()

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
