/**
 * Builds the command line typed into a sidebar terminal for a DAP
 * runInTerminal reverse request. The adapter speaks in argv form; the
 * terminal is a login shell, so every argument is POSIX single-quoted and
 * environment overrides ride an `env` prefix (null means unset).
 */

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export function buildDebugCommandLine(args: string[], env?: Record<string, string | null>): string {
  const parts: string[] = []
  const entries = Object.entries(env ?? {})
  if (entries.length > 0) {
    parts.push('env', ...entries.map(([key, value]) => value === null ? `-u ${key}` : `${key}=${shellQuote(value)}`))
  }
  parts.push(...args.map(shellQuote))
  return parts.join(' ')
}
