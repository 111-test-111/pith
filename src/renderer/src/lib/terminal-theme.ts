import type { ITheme } from '@xterm/xterm'

const TOKENS = {
  background: '--background', foreground: '--foreground',
  // A thin cursor must stay visible with every UI accent (including amber).
  cursor: '--foreground', cursorAccent: '--background',
  selectionBackground: '--terminal-selection-background',
  selectionForeground: '--terminal-selection-foreground',
  selectionInactiveBackground: '--terminal-selection-inactive-background',
  black: '--terminal-black', red: '--terminal-red', green: '--terminal-green',
  yellow: '--terminal-yellow', blue: '--terminal-blue', magenta: '--terminal-magenta',
  cyan: '--terminal-cyan', white: '--terminal-white',
  brightBlack: '--terminal-bright-black', brightRed: '--terminal-bright-red',
  brightGreen: '--terminal-bright-green', brightYellow: '--terminal-bright-yellow',
  brightBlue: '--terminal-bright-blue', brightMagenta: '--terminal-bright-magenta',
  brightCyan: '--terminal-bright-cyan', brightWhite: '--terminal-bright-white'
} satisfies Partial<Record<keyof ITheme, string>>

let cached: { signature: string; theme: ITheme } | undefined
let context: CanvasRenderingContext2D | undefined

/** Resolve beUI's CSS colors (including OKLCH) to the sRGB required by xterm.
 * Shared by all terminals; font changes/reattaches must not invalidate xterm's
 * glyph atlas and contrast cache when the colors haven't actually changed. */
export function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const entries = Object.entries(TOKENS).map(([key, token]) => [key, style.getPropertyValue(token).trim()] as const)
  const signature = JSON.stringify(entries)
  if (cached?.signature === signature) return cached.theme
  if (!context) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    context = canvas.getContext('2d', { willReadFrequently: true })!
  }
  const theme = Object.fromEntries(entries.map(([key, value]) => {
    context!.fillStyle = value
    context!.fillRect(0, 0, 1, 1)
    return [key, `#${Array.from(context!.getImageData(0, 0, 1, 1).data).slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('')}`]
  }))
  cached = { signature, theme }
  return theme
}
