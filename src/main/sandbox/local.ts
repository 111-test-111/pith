/**
 * Port of DSH's local sandbox provider. It preserves DSH's runner chain and
 * file-effect profiles behind a small seam: pick a backend, then wrap an argv.
 *
 * Runner chain, in DSH's order:
 *   macOS   seatbelt (`sandbox-exec`)                     — full
 *   Linux   bubblewrap, else the Landlock launcher         — full / partial
 *   Windows the ACL helper                                 — partial
 *   other   none → `dependencies-missing`, confined calls fail closed
 *
 * The Landlock and Windows-ACL helpers are optional native packages: they are
 * resolved lazily through a computed specifier so a bundle on another platform
 * never tries to statically resolve a package that only exists on Linux or
 * Windows.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { writableRoots } from './policy'
import {
  SandboxUnavailableError,
  type ConfinedArgv,
  type ConfinedSandboxMode,
  type RunnerFailureRule,
  type SandboxBackend,
  type SandboxEnforcement,
  type SandboxPolicy
} from './types'

const require = createRequire(import.meta.url)
const PROBE_TIMEOUT_MS = 5_000

const DENIAL_SIGNATURES: Record<SandboxBackend, readonly string[]> = {
  bubblewrap: ['read-only file system'],
  landlock: ['permission denied'],
  seatbelt: ['operation not permitted'],
  'windows-acl': ['access is denied', 'access to the path', 'permission denied']
}

const RUNNER_FAILURE_RULES: Record<SandboxBackend, readonly RunnerFailureRule[]> = {
  bubblewrap: [{ fatalSignatures: ['bwrap: '] }],
  landlock: [
    {
      allowedExitCodes: [125],
      fatalSignatures: ['landlock-run: '],
      informationalLines: ['landlock-run: partial enforcement (older Landlock ABI)']
    }
  ],
  seatbelt: [{ fatalSignatures: ['sandbox-exec: '] }],
  'windows-acl': [{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }]
}

/** Build a Seatbelt profile string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--unshare-pid',
    '--proc',
    '/proc',
    '--die-with-parent'
  ]
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp', '--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') readWrite.push('/tmp', policy.workspaceRoot)
  return ['--ro', '/', ...readWrite.flatMap((path) => ['--rw', path])]
}

/**
 * `read-only` still allows reads everywhere and denies file writes, so the
 * profile starts from `(allow default)` and removes exactly one class of
 * operation — it is a read-only filesystem effect, not a read-only workspace.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal ${sbplString('/dev/null')}))`
  ]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(
      `(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(' ')})`
    )
  }
  return ['-p', forms.join(' ')]
}

function probeBubblewrap(): boolean {
  const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/' }
  return (
    spawnSync('bwrap', [...bwrapProfileArgs(policy), '--', 'true'], {
      timeout: PROBE_TIMEOUT_MS,
      stdio: 'ignore'
    }).status === 0
  )
}

/** Resolve an optional native helper without letting a bundler require it. */
function resolveOptionalRunner(packageName: string): string | null {
  try {
    // A computed specifier keeps this a runtime lookup on every platform.
    return require.resolve(packageName)
  } catch {
    return null
  }
}

type LandlockLauncher = {
  launcherPath(): string
  probe(launcher: string, options?: { timeoutMs?: number }): string
}

function loadLandlockRunner(): LandlockLauncher | null {
  try {
    return require(['@deepseek-ai', 'node-addon-landlock-run'].join('/')) as LandlockLauncher
  } catch {
    return null
  }
}

interface SelectedRunner {
  backend: SandboxBackend
  enforcement: SandboxEnforcement
  program: string
}

export class LocalSandboxProvider {
  private selected: SelectedRunner | null | undefined

  private select(): SelectedRunner | null {
    if (this.selected !== undefined) return this.selected

    if (process.platform === 'linux') {
      if (probeBubblewrap()) {
        this.selected = { backend: 'bubblewrap', enforcement: 'full', program: 'bwrap' }
        return this.selected
      }
      const runner = loadLandlockRunner()
      if (runner) {
        try {
          const launcher = runner.launcherPath()
          const verdict = runner.probe(launcher, { timeoutMs: PROBE_TIMEOUT_MS })
          // Landlock can report partial enforcement on an older ABI.
          const enforcement: SandboxEnforcement | null = verdict === 'unusable' ? null : (verdict as SandboxEnforcement)
          this.selected = enforcement
            ? { backend: 'landlock', enforcement, program: launcher }
            : null
          return this.selected
        } catch {
          this.selected = null
          return this.selected
        }
      }
      this.selected = null
      return this.selected
    }

    if (process.platform === 'darwin') {
      // Seatbelt ships with macOS; there is nothing to probe.
      this.selected = { backend: 'seatbelt', enforcement: 'full', program: 'sandbox-exec' }
      return this.selected
    }

    if (process.platform === 'win32') {
      const runner = resolveOptionalRunner(['@deepseek-ai', 'dsh-sandbox-windows-acl', 'runner'].join('/'))
      this.selected = runner
        ? { backend: 'windows-acl', enforcement: 'partial', program: runner }
        : null
      return this.selected
    }

    this.selected = null
    return null
  }

  selection(): Omit<SelectedRunner, 'program'> | null {
    const selected = this.select()
    return selected ? { backend: selected.backend, enforcement: selected.enforcement } : null
  }

  /** Wrap `argv` in the selected runner. Throws when no backend is usable. */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    const mode = policy.mode as ConfinedSandboxMode
    const selected = this.select()
    if (!selected) throw new SandboxUnavailableError(mode)

    let prefix: string[]
    if (selected.backend === 'bubblewrap') {
      prefix = [selected.program, ...bwrapProfileArgs(policy)]
    } else if (selected.backend === 'landlock') {
      prefix = [selected.program, ...landlockProfileArgs(policy)]
    } else if (selected.backend === 'seatbelt') {
      prefix = [selected.program, ...seatbeltProfileArgs(policy)]
    } else {
      prefix = [
        process.execPath,
        selected.program,
        '--workspace',
        policy.workspaceRoot,
        '--temp',
        tmpdir(),
        '--mode',
        mode
      ]
    }

    return {
      argv: [...prefix, '--', ...argv],
      backend: selected.backend,
      enforcement: selected.enforcement,
      denialSignatures: DENIAL_SIGNATURES[selected.backend],
      runnerFailureRules: RUNNER_FAILURE_RULES[selected.backend]
    }
  }
}

let provider: LocalSandboxProvider | undefined

export function localSandboxProvider(): LocalSandboxProvider {
  provider ??= new LocalSandboxProvider()
  return provider
}

export function resetLocalSandboxProvider(): void {
  provider = undefined
}
