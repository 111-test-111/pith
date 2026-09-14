import { nativeTheme, type BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import type { WindowTheme } from '../shared/types'

/** Keep the real OS controls; the renderer paints the entire 52px title row. */
export function windowChromeOptions(): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 19 } }
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
