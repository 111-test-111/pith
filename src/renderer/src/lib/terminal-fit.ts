import type { Terminal, IDisposable } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

/** Resizing a WebGL canvas clears it immediately; xterm paints on a later rAF.
 * Keep the last completed frame over that gap, without preserving the WebGL
 * drawing buffer (which would tax every output frame). Copy only on resize,
 * inside onRender, before the browser discards the WebGL back buffer. */
export class TerminalFit {
  private frame = 0
  private pending = false
  private generation = 0
  private cover: HTMLCanvasElement | undefined
  private rendered: IDisposable

  constructor(private terminal: Terminal, private fit: FitAddon, private element: HTMLElement,
    private hasWebgl: () => boolean) {
    this.rendered = terminal.onRender(() => {
      this.cover?.remove()
      if (!this.pending) return
      this.pending = false
      const dimensions = this.dimensions()
      if (!dimensions) return
      this.snapshot()
      const generation = this.generation
      // Finish the current render before requesting the next one. A resize
      // from inside xterm's render callback would overwrite its redraw flags.
      queueMicrotask(() => {
        if (generation !== this.generation || !this.element.isConnected) return
        this.terminal.resize(dimensions.cols, dimensions.rows)
        this.terminal.refresh(0, this.terminal.rows - 1)
      })
    })
  }

  schedule(): void {
    if (this.frame || !this.element.isConnected) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      const dimensions = this.dimensions()
      if (!dimensions) return
      if (this.hasWebgl()) {
        this.pending = true
        this.terminal.refresh(0, this.terminal.rows - 1)
      } else {
        // The DOM renderer retains its rows until the next paint. Avoid
        // FitAddon.fit(), whose explicit clear would blank even those rows.
        this.terminal.resize(dimensions.cols, dimensions.rows)
      }
    })
  }

  private dimensions(): { cols: number; rows: number } | undefined {
    if (!this.element.isConnected || this.element.clientWidth <= 0 || this.element.clientHeight <= 0) return
    const dimensions = this.fit.proposeDimensions()
    if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return
    if (dimensions.cols === this.terminal.cols && dimensions.rows === this.terminal.rows) return
    return dimensions
  }

  private snapshot(): void {
    const screen = this.element.querySelector<HTMLElement>('.xterm-screen')
    const layers = Array.from(screen?.querySelectorAll<HTMLCanvasElement>('canvas') ?? [])
      .sort((a, b) => Number(a.style.zIndex || 0) - Number(b.style.zIndex || 0))
    if (!screen || !layers.length) return
    const base = layers[0]
    const cover = this.cover ??= document.createElement('canvas')
    cover.width = base.width
    cover.height = base.height
    cover.style.cssText = `position:absolute;left:0;top:0;z-index:3;pointer-events:none;width:${base.style.width};height:${base.style.height}`
    cover.dataset.terminalResizeCover = ''
    cover.setAttribute('aria-hidden', 'true')
    const context = cover.getContext('2d')!
    for (const layer of layers) context.drawImage(layer, 0, 0)
    screen.append(cover)
  }

  cancel(): void {
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.pending = false
    this.generation++
    this.cover?.remove()
    this.cover = undefined
  }

  dispose(): void { this.cancel(); this.rendered.dispose() }
}
