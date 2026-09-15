import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { SandboxMode, SandboxPolicy } from './types'

/** Resolve the identity consumed by Seatbelt and the in-process path fence. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

export function buildSandboxPolicy(mode: SandboxMode, workspaceRoot: string): SandboxPolicy {
  return { mode, workspaceRoot: canonicalPath(workspaceRoot) }
}

/** DSH workspace-write means the workspace plus the host temp areas. */
export function writableRoots(policy: SandboxPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath))]
}
