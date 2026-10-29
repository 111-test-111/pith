import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { terminalTheme } from './terminal-theme'
import { TerminalColorSchemeAddon } from './terminal-color-scheme'
import { TerminalFit } from './terminal-fit'
import { getFontSizes, terminalFontSize } from './typography'

/** One emulator survives DOM detach/reattach. React only renders its chrome. */
export class TerminalRuntime {
  readonly element = document.createElement('div')
  readonly terminal: Terminal
  private fit = new FitAddon()
  private webgl: WebglAddon | undefined
  private sizing: TerminalFit
  private observer: ResizeObserver
  private appearance: MutationObserver
  private disposed = false
  private theme = terminalTheme()
  private colorScheme: TerminalColorSchemeAddon

  constructor(private id: string, onTitle: (title: string) => void) {
    this.element.className = 'h-full w-full min-w-0 min-h-0'
    this.terminal = new Terminal({
      cols: 80, rows: 24, fontSize: terminalFontSize(getFontSizes().code), lineHeight: 1.2,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--app-font-mono').trim(),
      theme: this.theme, scrollback: 10_000, smoothScrollDuration: 100,
      cursorBlink: true, cursorStyle: 'bar', macOptionIsMeta: true, minimumContrastRatio: 4.5,
      // Bold is weight; explicit SGR 90–97 selects the bright palette.
      drawBoldTextInBrightColors: false
    })
    this.colorScheme = new TerminalColorSchemeAddon(document.documentElement.classList.contains('dark'), data => this.input(data))
    this.terminal.loadAddon(this.colorScheme)
    this.terminal.loadAddon(this.fit)
    this.terminal.open(this.element)
    this.sizing = new TerminalFit(this.terminal, this.fit, this.element, () => Boolean(this.webgl))
    this.terminal.onData((data) => this.input(data))
    this.terminal.onBinary((data) => this.input(data, true))
    this.terminal.onResize(({ cols, rows }) => window.pi.terminalResize(id, cols, rows))
    this.terminal.onTitleChange(onTitle)
    this.terminal.attachCustomKeyEventHandler((event) => {
      const copy = event.key.toLowerCase() === 'c' && (event.metaKey || (event.ctrlKey && event.shiftKey))
      if (copy && this.terminal.hasSelection()) {
        if (event.type === 'keydown') void navigator.clipboard.writeText(this.terminal.getSelection()).catch(() => {})
        return false
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
        if (event.type === 'keydown') void navigator.clipboard.readText().then((text) => {
          if (!this.disposed) this.terminal.paste(text)
        }).catch(() => {})
        return false
      }
      return true
    })
    this.observer = new ResizeObserver(() => this.scheduleFit())
    this.appearance = new MutationObserver(() => this.refreshAppearance())
    this.appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-accent'] })
    document.fonts.addEventListener('loadingdone', this.refreshAppearance)
  }

  private input(data: string, binary = false): void {
    // Chunk large pastes without splitting UTF-16 pairs or dropping text.
    let start = 0
    while (start < data.length) {
      let end = Math.min(start + 8192, data.length)
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--
      window.pi.terminalInput(this.id, data.slice(start, end), binary)
      start = end
    }
  }

  attach(host: HTMLElement): void {
    host.append(this.element)
    this.observer.observe(host)
    this.refreshAppearance()
    // Only the visible terminal holds a GPU context. Inactive emulators retain
    // their bounded scrollback and continue parsing without a visible canvas.
    if (!this.webgl) {
      try {
        const addon = new WebglAddon()
        this.terminal.loadAddon(addon)
        this.webgl = addon
        addon.onContextLoss(() => { addon.dispose(); if (this.webgl === addon) this.webgl = undefined })
      } catch { /* DOM rendering remains available without WebGL */ }
    }
    this.scheduleFit()
  }

  detach(): void {
    this.observer.disconnect()
    this.sizing.cancel()
    this.terminal.blur()
    this.webgl?.dispose()
    this.webgl = undefined
    this.element.remove()
  }

  refreshAppearance = (): void => {
    if (this.disposed) return
    const font = getComputedStyle(document.documentElement).getPropertyValue('--app-font-mono').trim()
    if (this.terminal.options.fontFamily !== font) this.terminal.options.fontFamily = font
    const fontSize = terminalFontSize(getFontSizes().code)
    if (this.terminal.options.fontSize !== fontSize) this.terminal.options.fontSize = fontSize
    const theme = terminalTheme()
    if (theme !== this.theme) {
      this.theme = theme
      this.terminal.options.theme = theme
    }
    // Apply colors before notifying applications: their OSC queries must see
    // the new background, even for a terminal currently detached from the DOM.
    this.colorScheme.update(document.documentElement.classList.contains('dark'))
    this.scheduleFit()
  }

  private scheduleFit(): void {
    if (!this.disposed) this.sizing.schedule()
  }

  focus(): void { if (this.element.isConnected) this.terminal.focus() }
  labels(promptLabel: string, tooMuchOutput: string): void {
    Terminal.strings.promptLabel = promptLabel
    Terminal.strings.tooMuchOutput = tooMuchOutput
    this.terminal.textarea?.setAttribute('aria-label', promptLabel)
  }
  write(data: string): void {
    this.terminal.write(data, () => {
      if (!this.disposed) window.pi.terminalAck(this.id, data.length)
    })
  }
  stop(): void { this.terminal.options.disableStdin = true }
  dispose(): void {
    this.disposed = true
    this.detach()
    this.sizing.dispose()
    this.appearance.disconnect()
    document.fonts.removeEventListener('loadingdone', this.refreshAppearance)
    this.terminal.dispose()
  }
}
