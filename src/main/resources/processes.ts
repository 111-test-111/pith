import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface NativeProcess {
  pid: number
  parentPid: number
  creationTime: number
  identity: string
  name: string
  cpuSeconds: number | null
  residentBytes: number | null
}

function command(file: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; pid: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 8 * 1024 ** 2, signal,
      windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
      if (error) reject(error)
      else resolve({ stdout, pid: child.pid! })
    })
  })
}

/** BSD ps reports cumulative user + system CPU time to centiseconds. */
export function parseCpuTime(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value)
  if (!match) return null
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4])
}

export function parsePs(stdout: string): NativeProcess[] {
  const rows: NativeProcess[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const creationTime = Date.parse(match[5])
    if (!Number.isFinite(creationTime)) continue
    rows.push({ pid: Number(match[1]), parentPid: Number(match[2]), residentBytes: Number(match[3]) * 1024,
      cpuSeconds: parseCpuTime(match[4]), creationTime, identity: match[5], name: match[6].split(/[\\/]/).at(-1)! })
  }
  return rows
}

export function parseWindowsProcesses(stdout: string): NativeProcess[] {
  const data = JSON.parse(stdout.replace(/^\uFEFF/, ''))
  return (Array.isArray(data) ? data : [data]).filter(row => row && Number.isInteger(row.pid) && row.pid > 0)
    .map(row => ({ pid: row.pid, parentPid: row.parentPid, creationTime: row.creationTime,
      identity: String(row.creationTime), name: row.name,
      cpuSeconds: typeof row.cpuSeconds === 'number' && Number.isFinite(row.cpuSeconds) ? row.cpuSeconds : null,
      residentBytes: typeof row.residentBytes === 'number' && Number.isFinite(row.residentBytes) ? row.residentBytes : null }))
}

/** Exclude the census helper itself and deduplicate Electron's own processes. */
export function descendants(rows: NativeProcess[], roots: ReadonlySet<number>, helperPid: number): NativeProcess[] {
  const byParent = new Map<number, NativeProcess[]>()
  for (const row of rows) {
    const children = byParent.get(row.parentPid) ?? []
    children.push(row); byParent.set(row.parentPid, children)
  }
  const seen = new Set(roots), pending = [...roots], result: NativeProcess[] = []
  for (let index = 0; index < pending.length; index++) {
    for (const row of byParent.get(pending[index]) ?? []) {
      if (row.pid === helperPid || seen.has(row.pid)) continue
      seen.add(row.pid); pending.push(row.pid); result.push(row)
    }
  }
  return result
}

/** /proc stat contains spaces/parentheses in comm. Only split after its last
 * closing parenthesis; CPU ticks exclude child counters to avoid double count. */
export function linuxCpu(stat: string, ticksPerSecond: number): { cpuSeconds: number; identity: string } {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  const user = Number(fields[11]), system = Number(fields[12]), start = fields[19]
  if (!start || !Number.isFinite(user) || !Number.isFinite(system) || ticksPerSecond <= 0) throw new Error('process-stat')
  return { cpuSeconds: (user + system) / ticksPerSecond, identity: start }
}

let clockTicks: Promise<number> | null = null
export async function collectProcessTree(roots: ReadonlySet<number>, signal?: AbortSignal): Promise<{ processes: NativeProcess[]; partial: boolean }> {
  const platform = process.platform
  if (platform === 'win32') {
    const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); "
      + "@(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -gt 0 -and $null -ne $_.CreationDate} | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},"
      + "@{n='creationTime';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}},@{n='name';e={$_.Name}},"
      + "@{n='cpuSeconds';e={if($null -ne $_.UserModeTime -and $null -ne $_.KernelModeTime){([double]$_.UserModeTime+[double]$_.KernelModeTime)/10000000}else{$null}}},"
      + "@{n='residentBytes';e={if($null -ne $_.WorkingSetSize){[double]$_.WorkingSetSize}else{$null}}}) | ConvertTo-Json -Compress"
    const census = await command(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script], signal)
    const rows = parseWindowsProcesses(census.stdout)
    if (!rows.some(row => roots.has(row.pid))) throw new Error('process-census')
    const processes = [...rows.filter(row => roots.has(row.pid)), ...descendants(rows, roots, census.pid)]
    return { processes, partial: processes.some(row => row.cpuSeconds === null || row.residentBytes === null) }
  }
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('process-platform')
  const census = await command('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time=,lstart=,comm='], signal)
  const rows = parsePs(census.stdout)
  if (!rows.some(row => roots.has(row.pid))) throw new Error('process-census')
  const processes = [...rows.filter(row => roots.has(row.pid)), ...descendants(rows, roots, census.pid)]
  if (platform === 'darwin') return { processes, partial: processes.some(row => row.cpuSeconds === null) }
  clockTicks ??= command('getconf', ['CLK_TCK'], signal).then(result => {
    const value = Number(result.stdout.trim())
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('clock-ticks')
    return value
  }).catch(error => { clockTicks = null; throw error })
  const ticks = await clockTicks
  let partial = false, cursor = 0
  await Promise.all(Array.from({ length: Math.min(8, processes.length) }, async () => {
    while (cursor < processes.length) {
      const row = processes[cursor++]
      try {
        const [stat, status] = await Promise.all([readFile(`/proc/${row.pid}/stat`, 'utf8'), readFile(`/proc/${row.pid}/status`, 'utf8')])
        Object.assign(row, linuxCpu(stat, ticks))
        const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
        row.residentBytes = rss ? Number(rss[1]) * 1024 : null
        if (row.residentBytes === null) partial = true
      } catch { row.cpuSeconds = null; row.residentBytes = null; partial = true }
    }
  }))
  return { processes, partial }
}
