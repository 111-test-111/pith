import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm'

/** Mode 2031: let supporting TUIs adapt their own RGB themes. OSC 10/11 color
 * queries are already handled by xterm using the current terminal theme.
 * https://contour-terminal.org/vt-extensions/color-palette-update-notifications/ */
export class TerminalColorSchemeAddon implements ITerminalAddon {
  private reporting = false
  private handlers: IDisposable[] = []

  constructor(private dark: boolean, private send: (data: string) => void) {}

  activate(terminal: Terminal): void {
    const parser = terminal.parser
    this.handlers.push(
      parser.registerCsiHandler({ prefix: '?', final: 'n' }, params => {
        if (params.length !== 1 || params[0] !== 996) return false
        this.report()
        return true
      }),
      ...(['h', 'l'] as const).map(final => parser.registerCsiHandler({ prefix: '?', final }, params => {
        if (params.includes(2031)) this.reporting = final === 'h'
        // Let xterm handle other modes in a combined DECSET/DECRST sequence.
        return false
      })),
      parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, params => {
        if (params.length !== 1 || params[0] !== 2031) return false
        this.send(`\x1b[?2031;${this.reporting ? 1 : 2}$y`)
        return true
      }),
      parser.registerEscHandler({ final: 'c' }, () => { this.reporting = false; return false }),
      parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => { this.reporting = false; return false })
    )
  }

  update(dark: boolean): void {
    if (dark === this.dark) return
    this.dark = dark
    if (this.reporting) this.report()
  }

  private report(): void { this.send(`\x1b[?997;${this.dark ? 1 : 2}n`) }

  dispose(): void { this.handlers.forEach(handler => handler.dispose()); this.handlers = [] }
}
