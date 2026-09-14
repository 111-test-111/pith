import type { App, WebContents } from 'electron'

/** A broken extension/tool must not keep the desktop process alive forever. */
export const QUIT_TIMEOUT_MS = 5_000
export const SESSION_DISPOSE_TIMEOUT_MS = 2_500

/** Observe every rejection, including work that finishes after the deadline. */
export async function settleWithin(work: Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.allSettled(work).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
    ])
  } finally { clearTimeout(timer) }
}

export function registerQuitHandler(
  target: Pick<App, 'on' | 'quit' | 'exit'>,
  cleanup: (() => Promise<unknown>)[],
  timeoutMs = QUIT_TIMEOUT_MS
): () => boolean {
  let phase: 'running' | 'cleaning' | 'ready' = 'running'
  let deadline: ReturnType<typeof setTimeout> | undefined
  target.on('before-quit', (event) => {
    if (phase === 'ready') return
    event.preventDefault()
    if (phase === 'cleaning') return
    phase = 'cleaning'
    deadline = setTimeout(() => target.exit(0), timeoutMs)
    // Defer invocation too: a synchronous throw must not skip other owners.
    void Promise.allSettled(cleanup.map((dispose) => Promise.resolve().then(dispose))).then(() => {
      phase = 'ready'
      target.quit()
      // Keep the deadline through renderer beforeunload / will-quit handlers.
    })
  })
  target.on('quit', () => { clearTimeout(deadline) })
  return () => phase !== 'running'
}

/** Window-local, so this does not steal shortcuts from other applications. */
export function registerQuitShortcut(contents: WebContents, quit: () => void): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key.toLowerCase() !== 'q' ||
      (!input.control && !input.meta) || input.alt || input.shift || input.isAutoRepeat) return
    event.preventDefault()
    quit()
  })
}
