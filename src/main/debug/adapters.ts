import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { DebugAdapterDTO } from '../../shared/types'

/**
 * Debug adapter registry.
 *
 * An adapter descriptor knows how to detect its DAP server binary on this
 * host and how to shape launch/attach request arguments for it. P0 ships
 * lldb-dap, debugpy and delve; users add their own through
 * `~/.pi/agent/debug-adapters.json` (global) or `.pi/debug.json` (project):
 *
 * ```json
 * {
 *   "adapters": [
 *     {
 *       "id": "netcoredbg",
 *       "label": ".NET Core",
 *       "languages": ["csharp"],
 *       "command": "netcoredbg",
 *       "args": ["--interpreter=vscode"],
 *       "launch": { "stopAtEntry": false },
 *       "attach": {}
 *     }
 *   ]
 * }
 * ```
 *
 * Templates merge UNDER the standard program/args/cwd parameters, so a custom
 * adapter only has to declare what differs from a vanilla launch.
 */

export interface DebugLaunchParams {
  program: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  stopOnEntry?: boolean
}

export interface DebugAttachParams {
  pid?: number
}

export interface DebugAdapterSpec {
  id: string
  label: string
  languages: string[]
  /** Resolve the adapter invocation; null means unavailable on this host. */
  detect: (cwd: string) => Promise<{ command: string; args: string[] } | null>
  /** Short machine-readable hint when detection fails ('missing-binary', …). */
  unavailableHint: string
  launchArguments: (params: DebugLaunchParams) => Record<string, unknown>
  attachArguments: (params: DebugAttachParams) => Record<string, unknown>
}

const DETECT_TIMEOUT_MS = 5000

/** Run a probe command; resolves trimmed stdout, or null on any failure. */
function probe(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: DETECT_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(null); return }
      const text = String(stdout).trim()
      resolve(text || null)
    })
  })
}

/** Resolve a binary on PATH (or an absolute path) to an executable file. */
async function which(binary: string): Promise<string | null> {
  if (isAbsolute(binary)) return existsSync(binary) ? binary : null
  const pathExt = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of pathExt) {
      const candidate = join(dir, binary + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const lldbDap: DebugAdapterSpec = {
  id: 'lldb-dap',
  label: 'LLDB (lldb-dap)',
  languages: ['c', 'cpp', 'objective-c', 'rust', 'swift', 'assembly'],
  unavailableHint: 'missing-binary: install Xcode Command Line Tools or LLVM (lldb-dap)',
  async detect() {
    if (process.platform === 'darwin') {
      const resolved = await probe('xcrun', ['-f', 'lldb-dap'])
      if (resolved && existsSync(resolved)) return { command: resolved, args: [] }
    }
    const onPath = await which('lldb-dap')
    return onPath ? { command: onPath, args: [] } : null
  },
  launchArguments: (params) => ({
    program: params.program,
    args: params.args,
    cwd: params.cwd,
    ...(params.stopOnEntry ? { stopOnEntry: true } : {}),
    ...(params.env ? { env: params.env } : {})
  }),
  attachArguments: (params) => ({ pid: params.pid })
}

const debugpy: DebugAdapterSpec = {
  id: 'debugpy',
  label: 'Python (debugpy)',
  languages: ['python'],
  unavailableHint: 'missing-module: pip install debugpy (workspace venv is preferred)',
  async detect(cwd) {
    const candidates = [
      join(cwd, '.venv', 'bin', 'python'),
      join(cwd, 'venv', 'bin', 'python'),
      join(cwd, '.venv', 'Scripts', 'python.exe'),
      join(cwd, 'venv', 'Scripts', 'python.exe')
    ]
    let python: string | null = candidates.find((candidate) => existsSync(candidate)) ?? null
    python ??= await which('python3') ?? await which('python')
    if (!python) return null
    // The adapter module must be importable by THAT interpreter.
    const ok = await probe(python, ['-c', 'import debugpy'])
    if (ok === null) return null
    return { command: python, args: ['-m', 'debugpy.adapter'] }
  },
  launchArguments: (params) => ({
    program: params.program,
    args: params.args,
    cwd: params.cwd,
    // integratedTerminal routes the debuggee through runInTerminal, which this
    // app answers with a real sidebar terminal tab.
    console: 'integratedTerminal',
    stopOnEntry: params.stopOnEntry === true,
    justMyCode: true,
    ...(params.env ? { env: params.env } : {})
  }),
  attachArguments: (params) => ({ processId: params.pid, justMyCode: true })
}

const delve: DebugAdapterSpec = {
  id: 'dlv',
  label: 'Go (delve)',
  languages: ['go'],
  unavailableHint: 'missing-binary: go install github.com/go-delve/delve/cmd/dlv@latest',
  async detect() {
    const onPath = await which('dlv')
    return onPath ? { command: onPath, args: ['dap'] } : null
  },
  launchArguments: (params) => ({
    // 'debug' builds the package at program; use 'exec' (custom template) for
    // a prebuilt binary.
    mode: 'debug',
    program: params.program,
    args: params.args,
    cwd: params.cwd,
    ...(params.stopOnEntry ? { stopOnEntry: true } : {}),
    ...(params.env ? { env: params.env } : {})
  }),
  attachArguments: (params) => ({ mode: 'local', processId: params.pid })
}

const BUILTIN_ADAPTERS: DebugAdapterSpec[] = [lldbDap, debugpy, delve]

interface CustomAdapterEntry {
  id?: unknown
  label?: unknown
  languages?: unknown
  command?: unknown
  args?: unknown
  launch?: unknown
  attach?: unknown
}

function customAdapterFrom(entry: CustomAdapterEntry, source: string): DebugAdapterSpec | null {
  if (typeof entry.id !== 'string' || !/^[\w.-]{1,60}$/.test(entry.id)) return null
  if (typeof entry.command !== 'string' || !entry.command) return null
  if (BUILTIN_ADAPTERS.some((spec) => spec.id === entry.id)) return null // no shadowing built-ins
  const template = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const launch = template(entry.launch)
  const attach = template(entry.attach)
  const id = entry.id
  return {
    id,
    label: typeof entry.label === 'string' && entry.label ? entry.label : id,
    languages: Array.isArray(entry.languages) ? entry.languages.filter((item): item is string => typeof item === 'string') : [],
    unavailableHint: `missing-binary: ${entry.command} not found (declared in ${source})`,
    async detect() {
      const resolved = await which(entry.command as string)
      if (!resolved) return null
      const extra = Array.isArray(entry.args) ? entry.args.filter((item): item is string => typeof item === 'string') : []
      return { command: resolved, args: extra }
    },
    launchArguments: (params) => ({
      ...launch,
      program: params.program,
      args: params.args,
      cwd: params.cwd,
      ...(params.stopOnEntry ? { stopOnEntry: true } : {}),
      ...(params.env ? { env: params.env } : {})
    }),
    attachArguments: (params) => ({ ...attach, ...(params.pid !== undefined ? { processId: params.pid, pid: params.pid } : {}) })
  }
}

function readCustomAdapters(path: string): DebugAdapterSpec[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const list = raw && typeof raw === 'object' ? (raw as { adapters?: unknown }).adapters : undefined
    if (!Array.isArray(list)) return []
    return list
      .map((entry) => customAdapterFrom(entry as CustomAdapterEntry, path))
      .filter((spec): spec is DebugAdapterSpec => spec !== null)
  } catch {
    return [] // A missing or malformed file means no custom adapters.
  }
}

/** Every adapter spec in effect for a workspace: built-ins plus user config. */
export function debugAdapterSpecs(cwd: string): DebugAdapterSpec[] {
  return [
    ...BUILTIN_ADAPTERS,
    ...readCustomAdapters(join(getAgentDir(), 'debug-adapters.json')),
    ...readCustomAdapters(join(cwd, '.pi', 'debug.json'))
  ]
}

export function debugAdapterSpec(cwd: string, id: string): DebugAdapterSpec | undefined {
  return debugAdapterSpecs(cwd).find((spec) => spec.id === id)
}

/** Probe every known adapter; reports availability without throwing. */
export async function detectDebugAdapters(cwd: string): Promise<DebugAdapterDTO[]> {
  const specs = debugAdapterSpecs(cwd)
  const results = await Promise.all(specs.map(async (spec) => {
    let available = false
    try { available = (await spec.detect(cwd)) !== null } catch { available = false }
    return {
      id: spec.id,
      label: spec.label,
      languages: spec.languages,
      available,
      ...(available ? {} : { detail: spec.unavailableHint })
    } satisfies DebugAdapterDTO
  }))
  return results
}
