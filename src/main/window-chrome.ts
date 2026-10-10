import { nativeTheme, type BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import type { WindowTheme } from '../shared/types'

/** Keep the real OS controls; the renderer paints the entire 52px title row. */
export function windowChromeOptions(): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? {
          trafficLightPosition: { x: 16, y: 19 },
          // Real under-window transparency for the glass title row/sidebar:
          // the whole window is a vibrancy surface, and content regions paint
          // their own opaque backgrounds. The material shows through the two
          // translucent chrome regions (styles.css gates the page
          // background on data-platform='darwin'). 'active' keeps the effect
          // from dimming when the window loses focus.
          vibrancy: 'under-window',
          visualEffectState: 'active'
        }
      : { titleBarOverlay: { color: '#00000000', symbolColor: symbolColor(), height: 52 } }),
    autoHideMenuBar: true
  }
}

function symbolColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#eeeeef' : '#24262b'
}

export function setWindowTheme(win: BrowserWindow, theme: WindowTheme): void {
  if (theme !== 'light' && theme !== 'dark' && theme !== 'system') return
  nativeTheme.themeSource = theme
  if (process.platform !== 'darwin') win.setTitleBarOverlay({ symbolColor: symbolColor() })
}
