/**
 * App-owned `edit` and `write`, replacing the SDK built-ins so every file
 * mutation passes the DSH sandbox policy on its way to disk.
 *
 * Ported from pi-web's `lib/sandbox/file-tools-extension.ts`, minus the
 * one-shot escalation: this build has no approval gate, so the mode is the
 * whole policy and a denial is final — the model is told to ask the user to
 * change the mode rather than to retry with wider permissions.
 *
 * Reads are deliberately unrestricted, exactly as in DSH: only mutation
 * targets are checked, and they are checked immediately before each side
 * effect (never once per tool call), so a symlink swapped in between two
 * writes cannot slip through.
 */
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type EditOperations,
  type ToolDefinition,
  type WriteOperations
} from '@earendil-works/pi-coding-agent'
import { constants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { buildSandboxPolicy, writableRoots } from '../sandbox/policy'
import { isSandboxPathWithin, resolveSandboxPath } from '../sandbox/paths'
import { SandboxFileDeniedError, type SandboxMode } from '../sandbox/types'

export const APP_FILE_TOOL_NAMES = ['edit', 'write'] as const

/** Take the SDK's own definition types: they bind the parameter schema, so a
 * narrowed `ToolDefinition` here would widen `params` to `unknown`. */
type EditToolDefinition = ReturnType<typeof createEditToolDefinition>
type WriteToolDefinition = ReturnType<typeof createWriteToolDefinition>

const DENIAL_HINT =
  'Ask the user to change the sandbox mode in Settings → General (read-only refuses every file write; workspace-write allows the workspace and temp directories only). Do not retry the same path in a loop.'

function denied(mode: SandboxMode, path: string): SandboxFileDeniedError {
  return new SandboxFileDeniedError(mode, path)
}

/**
 * Resolve a mutation target against the policy. Returns the canonical path the
 * write must use, so the bytes land where the check looked.
 */
function writablePath(path: string, cwd: string, mode: SandboxMode): string {
  if (mode === 'danger-full-access') return path
  // read-only denies mutation outright: DSH's read-only is a filesystem
  // effect, not a read-only workspace.
  if (mode === 'read-only') throw denied(mode, path)

  const canonical = resolveSandboxPath(path, { cwd, homeDir: homedir() })
  if (canonical === null) throw denied(mode, path)
  const roots = writableRoots(buildSandboxPolicy(mode, cwd))
  if (!roots.some((root) => isSandboxPathWithin(canonical, root))) throw denied(mode, path)
  return canonical
}

function editOperations(cwd: string, getMode: () => SandboxMode): EditOperations {
  return {
    // The before-image is a read; it stays unrestricted.
    readFile: (path) => readFile(path),
    access: async (path) => {
      await access(writablePath(path, cwd, getMode()), constants.R_OK | constants.W_OK)
    },
    writeFile: async (path, content) => {
      await writeFile(writablePath(path, cwd, getMode()), content, 'utf8')
    }
  }
}

function writeOperations(cwd: string, getMode: () => SandboxMode): WriteOperations {
  return {
    mkdir: async (path) => {
      await mkdir(writablePath(path, cwd, getMode()), { recursive: true })
    },
    writeFile: async (path, content) => {
      await writeFile(writablePath(path, cwd, getMode()), content, 'utf8')
    }
  }
}

/**
 * Wrap a sandbox denial so the model reads the mode and the fix, instead of a
 * bare path error it will simply retry.
 */
function withHint(error: unknown): never {
  if (error instanceof SandboxFileDeniedError) {
    throw new Error(`${error.message}\n${DENIAL_HINT}`)
  }
  throw error
}

export function createSandboxFileTools(options: {
  cwd: string
  getMode: () => SandboxMode
}): ToolDefinition<any, any, any>[] {
  const { cwd, getMode } = options

  const edit: EditToolDefinition = {
    ...createEditToolDefinition(cwd),
    executionMode: 'sequential',
    async execute(toolCallId, params, signal, onUpdate, context) {
      try {
        return await createEditToolDefinition(cwd, {
          operations: editOperations(cwd, getMode)
        }).execute(toolCallId, params, signal, onUpdate, context)
      } catch (error) {
        withHint(error)
      }
    }
  }

  const write: WriteToolDefinition = {
    ...createWriteToolDefinition(cwd),
    executionMode: 'sequential',
    async execute(toolCallId, params, signal, onUpdate, context) {
      try {
        return await createWriteToolDefinition(cwd, {
          operations: writeOperations(cwd, getMode)
        }).execute(toolCallId, params, signal, onUpdate, context)
      } catch (error) {
        withHint(error)
      }
    }
  }

  return [edit, write]
}
