import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { DebugAdapterDTO } from '../../shared/types'
import { ToolFailure } from '../pi/tool-result'

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
  program?: string
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
  detect: (cwd: string, signal?: AbortSignal) => Promise<{ command: string; args: string[] } | null>
  /** Short machine-readable hint when detection fails ('missing-binary', …). */
  unavailableHint: string
  /** TCP listen mode: the client connects over a socket instead of stdio.
   * spawn=true starts the process (with ${port} substituted into its args)
   * and waits for the port; spawn=false expects an external listener. */
  listen?: { host: string; port: number; spawn: boolean }
  /** Standalone js-debug asks the client to open target connections. */
  childSessions?: boolean
  /** Validate the final request, after imported adapter-specific arguments. */
  validateLaunch: (args: Record<string, unknown>) => void
  launchArguments: (params: DebugLaunchParams) => Record<string, unknown>
  attachArguments: (params: DebugAttachParams) => Record<string, unknown>
}

const DETECT_TIMEOUT_MS = 5000

function requireProgram(args: Record<string, unknown>): void {
  if (typeof args.program !== 'string' || !args.program.trim()) throw new Error('program is required for launch')
}

/** Only file-based local launches can be checked by this host. Python modules,
 * Go packages, remote mappings and adapter-defined launch commands keep their
 * adapter semantics; an arbitrary program string is not always a local file. */
export function validateLocalDebugProgram(args: Record<string, unknown>): void {
  requireProgram(args)
  if (args.remoteRoot || args.host || args.connect || args.platform || args.targetCreateCommands || args.initCommands) return
  const program = args.program as string
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(program) && !program.startsWith('file://')) return
  const path = program.startsWith('file://') ? fileURLToPath(program) : resolve(typeof args.cwd === 'string' ? args.cwd : process.cwd(), program)
  try {
    if (!statSync(path).isFile()) throw new ToolFailure('DEBUG_PROGRAM_NOT_FILE', `Debug program is not a regular file: ${path}`)
  } catch (error) {
    if (error instanceof ToolFailure) throw error
    const code = (error as NodeJS.ErrnoException).code
    throw new ToolFailure(code === 'ENOENT' ? 'DEBUG_PROGRAM_NOT_FOUND' : 'DEBUG_PROGRAM_UNREADABLE', `Cannot read local debug program ${path} (${code ?? 'unknown error'})`)
  }
}

/** Run a probe command; resolves trimmed stdout, or null on any failure. */
function probe(command: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: DETECT_TIMEOUT_MS, windowsHide: true, signal }, (error, stdout) => {
      if (error) { resolve(null); return }
      const text = String(stdout).trim()
      resolve(text)
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
  validateLaunch: validateLocalDebugProgram,
  async detect(_cwd, signal) {
    if (process.platform === 'darwin') {
      const resolved = await probe('xcrun', ['-f', 'lldb-dap'], signal)
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
  validateLaunch(args) {
    if (args.module === undefined) { validateLocalDebugProgram(args); return }
    if (typeof args.module !== 'string' || !args.module.trim()) throw new Error('module must be a non-empty Python module name')
    if (args.program !== undefined) throw new Error('Python launch requires either program or module, not both')
  },
  async detect(cwd, signal) {
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
    const ok = await probe(python, ['-c', 'import debugpy'], signal)
    if (ok === null) return null
    return { command: python, args: ['-m', 'debugpy.adapter'] }
  },
  launchArguments: (params) => ({
    type: 'python',
    request: 'launch',
    name: 'Pith',
    ...(params.program !== undefined ? { program: params.program } : {}),
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
  validateLaunch: args => { requireProgram(args); if (args.mode === 'exec') validateLocalDebugProgram(args) },
  async detect() {
    const onPath = await which('dlv')
    return onPath ? { command: onPath, args: ['dap', '--listen=127.0.0.1:${port}'] } : null
  },
  listen: { host: '127.0.0.1', port: 0, spawn: true },
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

/** Well-known js-debug install locations (VS Code's DAP server for JS/TS). */
function jsDebugServers(): string[] {
  const standalone = join(getAgentDir(), 'debug-adapters', 'js-debug', 'src', 'dapDebugServer.js')
  const roots = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.vscode-oss']
    .map((dir) => join(homedir(), dir, 'extensions'))
  const servers: string[] = []
  for (const root of roots) {
    let entries: string[]
    try { entries = readdirSync(root) } catch { continue }
    for (const entry of entries) {
      if (!/^ms-vscode\.js-debug(-nightly)?-\d/.test(entry)) continue
      const server = join(root, entry, 'src', 'dapDebugServer.js')
      if (existsSync(server)) servers.push(server)
    }
  }
  // Version-sorted directory names put the newest install first when reversed.
  return [...(existsSync(standalone) ? [standalone] : []), ...servers.sort().reverse()]
}

const jsDebug: DebugAdapterSpec = {
  id: 'js-debug',
  label: 'JavaScript (js-debug)',
  listen: { host: '127.0.0.1', port: 0, spawn: true },
  childSessions: true,
  validateLaunch: validateLocalDebugProgram,
  languages: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'],
  unavailableHint: `missing-adapter: extract Microsoft's js-debug-dap release into ${join(getAgentDir(), 'debug-adapters')} (js-debug/src/dapDebugServer.js); VS Code extension bundles may omit the standalone server`,
  async detect() {
    const server = jsDebugServers()[0]
    if (!server) return null
    const node = await which('node')
    return node ? { command: node, args: [server, '${port}', '127.0.0.1'] } : null
  },
  launchArguments: (params) => ({
    type: 'pwa-node',
    request: 'launch',
    name: 'Pith',
    program: params.program,
    args: params.args,
    cwd: params.cwd,
    // integratedTerminal routes the debuggee through runInTerminal, which this
    // app answers with a real sidebar terminal tab.
    console: 'integratedTerminal',
    stopOnEntry: params.stopOnEntry === true,
    sourceMaps: true,
    ...(params.env ? { env: params.env } : {})
  }),
  attachArguments: (params) => ({ type: 'pwa-node', request: 'attach', name: 'Pith', processId: params.pid, sourceMaps: true })
}

const BUILTIN_ADAPTERS: DebugAdapterSpec[] = [lldbDap, debugpy, delve, jsDebug]

interface CustomAdapterEntry {
  id?: unknown
  label?: unknown
  languages?: unknown
  command?: unknown
  args?: unknown
  launch?: unknown
  attach?: unknown
  listen?: unknown
}

function customAdapterFrom(entry: CustomAdapterEntry, source: string): DebugAdapterSpec | null {
  if (typeof entry.id !== 'string' || !/^[\w.-]{1,60}$/.test(entry.id)) return null
  const listenRaw = entry.listen && typeof entry.listen === 'object' ? entry.listen as Record<string, unknown> : undefined
  const listenPort = listenRaw && typeof listenRaw.port === 'number' && Number.isInteger(listenRaw.port) && listenRaw.port > 0 && listenRaw.port < 65536
    ? listenRaw.port : undefined
  const listen: DebugAdapterSpec['listen'] | undefined = listenPort !== undefined
    ? {
      host: typeof listenRaw!.host === 'string' && listenRaw!.host ? listenRaw!.host : '127.0.0.1',
      port: listenPort,
      spawn: listenRaw!.spawn !== false
    }
    : undefined
  // A pure-connect adapter (listen with spawn:false) needs no local binary.
  const hasCommand = typeof entry.command === 'string' && entry.command.length > 0
  if (!hasCommand && (!listen || listen.spawn)) return null
  if (BUILTIN_ADAPTERS.some((spec) => spec.id === entry.id)) return null // no shadowing built-ins
  const template = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const launch = template(entry.launch)
  const attach = template(entry.attach)
  const id = entry.id
  return {
    id,
    validateLaunch: requireProgram,
    label: typeof entry.label === 'string' && entry.label ? entry.label : id,
    languages: Array.isArray(entry.languages) ? entry.languages.filter((item): item is string => typeof item === 'string') : [],
    unavailableHint: listen && !listen.spawn
      ? `unreachable: expected a DAP listener at ${listen.host}:${listen.port} (declared in ${source})`
      : `missing-binary: ${entry.command} not found (declared in ${source})`,
    async detect() {
      if (listen && !listen.spawn) return { command: '', args: [] }
      const resolved = await which(entry.command as string)
      if (!resolved) return null
      const extra = Array.isArray(entry.args) ? entry.args.filter((item): item is string => typeof item === 'string') : []
      return { command: resolved, args: extra }
    },
    ...(listen ? { listen } : {}),
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
export async function detectDebugAdapters(cwd: string, signal?: AbortSignal): Promise<DebugAdapterDTO[]> {
  signal?.throwIfAborted()
  const specs = debugAdapterSpecs(cwd)
  const results = await Promise.all(specs.map(async (spec) => {
    let available = false
    try { available = (await spec.detect(cwd, signal)) !== null } catch { available = false }
    return {
      id: spec.id,
      label: spec.label,
      languages: spec.languages,
      available,
      ...(available ? {} : { detail: spec.unavailableHint })
    } satisfies DebugAdapterDTO
  }))
  signal?.throwIfAborted()
  return results
}

/* ------------------------------------------------------------------ */
/* .vscode/launch.json import                                          */
/* ------------------------------------------------------------------ */

/** One launch.json configuration, mapped onto an adapter and its request. */
export interface DebugLaunchConfiguration {
  name: string
  adapterId: string
  kind: 'launch' | 'attach' | 'core'
  coreFile?: string
  program?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  stopOnEntry?: boolean
  pid?: number
  /** Adapter-specific request keys the generic templates don't know
   * (sourceMaps, justMyCode, mode, …), merged into the DAP request last. */
  extraArguments: Record<string, unknown>
}

/** launch.json type → adapter id. A configuration's own `adapter` key (our
 * extension) always wins over this table. */
const LAUNCH_TYPE_ADAPTERS: Record<string, string> = {
  lldb: 'lldb-dap',
  'lldb-dap': 'lldb-dap',
  cppdbg: 'lldb-dap',
  python: 'debugpy',
  debugpy: 'debugpy',
  go: 'dlv',
  delve: 'dlv',
  node: 'js-debug',
  'pwa-node': 'js-debug',
  'node-terminal': 'js-debug',
  chrome: 'js-debug',
  'pwa-chrome': 'js-debug'
}

/** Generic keys consumed by the mapping; everything else passes through. */
const LAUNCH_CONSUMED_KEYS = new Set([
  'name', 'type', 'request', 'adapter', 'program', 'args', 'cwd', 'env', 'environment',
  'stopOnEntry', 'stopAtEntry', 'coreFile', 'processId', 'pid', 'preLaunchTask', 'postDebugTask',
  // cppdbg keys that never translate to lldb-dap (GDB-flavored).
  'MIMode', 'miDebuggerPath', 'miDebuggerArgs', 'setupCommands', 'externalConsole',
  'customLaunchSetupCommands', 'targetArchitecture', 'visualizerFile', 'showDisplayString'
])

/** A parsed JSON/JSONC value (launch.json's domain). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Tolerate JSONC: comments and trailing commas are both legal in launch.json.
 * Malformed input throws a SyntaxError the caller can surface verbatim. */
export function parseJsonc(text: string): JsonValue {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue }
    out += c
  }
  try {
    let cleaned = '', quoted = false, escape = false
    for (let i = 0; i < out.length; i++) {
      const c = out[i]
      if (quoted) {
        cleaned += c
        if (escape) escape = false
        else if (c === '\\') escape = true
        else if (c === '"') quoted = false
      } else if (c === '"') { quoted = true; cleaned += c }
      else if (c !== ',' || !/^\s*[}\]]/.test(out.slice(i + 1))) cleaned += c
    }
    return JSON.parse(cleaned) as JsonValue
  } catch (error) {
    throw new SyntaxError(`malformed JSONC: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** `${workspaceFolder}`-style substitution for program/cwd/args strings. */
const substituteWorkspace = (value: string, workspace: string): string =>
  value.replaceAll('${workspaceFolder}', workspace).replaceAll('${workspaceRoot}', workspace)

function launchEnv(env: unknown, environment: unknown): Record<string, string> | undefined {
  // env: object form (everyone); environment: cppdbg's [{name, value}] array.
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    const entries = Object.entries(env as Record<string, unknown>).map(([key, value]) => [key, String(value)] as const)
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }
  if (Array.isArray(environment)) {
    const entries = environment
      .filter((item): item is { name?: unknown; value?: unknown } => Boolean(item) && typeof item === 'object')
      .filter((item) => typeof item.name === 'string' && item.name.length > 0)
      .map((item) => [item.name as string, String(item.value)] as const)
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }
  return undefined
}

/** Read <cwd>/.vscode/launch.json. Missing file means []; an existing file
 * that cannot be parsed throws with the parse error. */
export function readLaunchConfigurations(cwd: string): DebugLaunchConfiguration[] {
  const path = join(cwd, '.vscode', 'launch.json')
  if (!existsSync(path)) return []
  let raw: unknown
  try {
    raw = parseJsonc(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot parse .vscode/launch.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  const configurations = raw && typeof raw === 'object' ? (raw as { configurations?: unknown }).configurations : undefined
  if (!Array.isArray(configurations)) return []
  return configurations.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const config = item as Record<string, unknown>
    const name = typeof config.name === 'string' && config.name ? config.name : `configuration ${index + 1}`
    const type = typeof config.type === 'string' ? config.type : ''
    const adapterId = typeof config.adapter === 'string' && config.adapter
      ? config.adapter
      : LAUNCH_TYPE_ADAPTERS[type]
    if (!adapterId) return []
    const kind = typeof config.coreFile === 'string' ? 'core' : config.request === 'attach' ? 'attach' : 'launch'
    const pid = typeof config.processId === 'number' ? config.processId
      : typeof config.processId === 'string' && /^\d+$/.test(config.processId) ? Number(config.processId)
      : typeof config.pid === 'number' ? config.pid : undefined
    const extraArguments: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(config)) {
      if (!LAUNCH_CONSUMED_KEYS.has(key)) extraArguments[key] = value
    }
    if (adapterId === 'js-debug') extraArguments.type = type === 'node' ? 'pwa-node' : type === 'chrome' ? 'pwa-chrome' : type
    const env = launchEnv(config.env, config.environment)
    return [{
      name,
      adapterId,
      kind,
      ...(typeof config.coreFile === 'string' ? { coreFile: substituteWorkspace(config.coreFile, cwd) } : {}),
      ...(typeof config.program === 'string' ? { program: substituteWorkspace(config.program, cwd) } : {}),
      ...(Array.isArray(config.args) ? { args: config.args.filter((a): a is string => typeof a === 'string').map((a) => substituteWorkspace(a, cwd)) } : {}),
      ...(typeof config.cwd === 'string' ? { cwd: substituteWorkspace(config.cwd, cwd) } : {}),
      ...(env ? { env } : {}),
      ...(config.stopOnEntry === true || config.stopAtEntry === true ? { stopOnEntry: true } : {}),
      ...(pid !== undefined ? { pid } : {}),
      extraArguments
    }]
  })
}
