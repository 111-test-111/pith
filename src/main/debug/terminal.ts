/**
 * Builds the command line typed into a sidebar terminal for a DAP
 * runInTerminal reverse request. The adapter speaks in argv form; the
 * POSIX shells use quoted argv and env. Windows uses a fixed PowerShell
 * launcher encoded as UTF-16LE: cmd.exe never parses adapter-supplied text.
 */

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export function buildDebugCommandLine(args: string[], env?: Record<string, string | null>, platform: NodeJS.Platform = process.platform): string {
  const parts: string[] = []
  const entries = Object.entries(env ?? {})
  if (!args.length || [...args, ...entries.flatMap(([key, value]) => [key, value ?? ''])].some(value => value.includes('\0'))) throw new Error('Invalid debug terminal arguments')
  if (entries.some(([key]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new Error('Invalid debug terminal environment key')
  if (platform === 'win32') {
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
    // Windows native argv quoting (including empty strings and trailing slashes).
    const quote = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
    const script = [
      '$ErrorActionPreference = "Stop"',
      '$p = New-Object System.Diagnostics.ProcessStartInfo', '$p.UseShellExecute = $false',
      `$p.FileName = ${literal(args[0])}`, `$p.Arguments = ${literal(args.slice(1).map(quote).join(' '))}`,
      ...entries.map(([key, value]) => value === null ? `$p.EnvironmentVariables.Remove(${literal(key)})` : `$p.EnvironmentVariables[${literal(key)}] = ${literal(value)}`),
      '$child = [System.Diagnostics.Process]::Start($p)', '$child.WaitForExit()', 'exit $child.ExitCode'
    ].join('\n')
    const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
    if (command.length > 8190) throw new Error('Debug terminal command exceeds the Windows console limit')
    return command
  }
  if (entries.length > 0) {
    parts.push('env', ...entries.filter(([, value]) => value === null).flatMap(([key]) => ['-u', shellQuote(key)]),
      ...entries.filter(([, value]) => value !== null).map(([key, value]) => shellQuote(`${key}=${value}`)))
  }
  parts.push(...args.map(shellQuote))
  return parts.join(' ')
}
